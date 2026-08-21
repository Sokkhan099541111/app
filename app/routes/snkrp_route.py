import time
from datetime import datetime
from typing import Optional
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from app.services.wialon_snkrp_reports import (
    WialonReportService,
    get_employees_by_vehicle_ids,
    get_operation_logs_by_vehicle_ids,
    get_wialon_credentials,
)
from app.config.database import get_db
from app.config.settings import DEFAULT_COMPANY_ID

load_dotenv()

# 1. DEFINE ROUTER FIRST
router = APIRouter()

# Fixed resource/template used for the fleet mileage/engine-hours report
# (same as run_fleet_report below). Column order for template_id=21:
# [name, col, col, distance in km, engine hours as H:MM:SS].
FLEET_RESOURCE_ID = 601651347
FLEET_TEMPLATE_ID = 21


def _date_to_unix(date_str: str, end_of_day: bool = False) -> int:
    """Convert a 'YYYY-MM-DD' string (as sent by the date picker) into a
    unix timestamp -- start of day, or end of day if end_of_day=True."""
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    if end_of_day:
        dt = dt.replace(hour=23, minute=59, second=59)
    return int(dt.timestamp())

# 2. DEFINE THE FUNCTION AFTER ROUTER
@router.get("/report/run")
def run_fleet_report(
    company_id: int = Query(DEFAULT_COMPANY_ID, description="Company whose Wialon credentials to use"),
    db: Session = Depends(get_db),
):
    creds = get_wialon_credentials(db, company_id)

    try:
        service = WialonReportService(base_url=creds["base_url"])
        service.login(creds["wialon_token"])

        end_time = int(time.time())
        start_time = end_time - 86400

        data = service.run_report(
            resource_id=601651347,
            template_id=21,
            object_id=601651433,
            start=start_time,
            end=end_time
        )
        return {"status": "success", "data": data}

    except Exception as e:
        return {"status": "error", "message": str(e)}
    
    # Add this to app/routes/reports.py

# A cleaner way to handle this
#objects_group_SNKRP
@router.get("/objects/group_snkrp")
def get_all_objects(
    company_id: int = Query(DEFAULT_COMPANY_ID, description="Company whose Wialon credentials to use"),
    db: Session = Depends(get_db),
):
    creds = get_wialon_credentials(db, company_id)

    try:
        service = WialonReportService(base_url=creds["base_url"])
        service.login(creds["wialon_token"])
        # This will now work perfectly ONLY if get_objects is indented correctly in your service file
        objects = service.get_objects()
        return {"status": "success", "objects": objects}
    except Exception as e:
        # This will show you the exact error if it's still failing
        return {"status": "error", "message": str(e)}
    
@router.get("/report/fuel")
def run_fuel_report():
    # Logic for fuel report
    return {"status": "success", "report": "fuel"}


@router.get("/reports/vehicles")
def get_vehicle_list(
    company_id: int = Query(DEFAULT_COMPANY_ID, description="Company whose Wialon credentials to use"),
    groupId: Optional[int] = Query(None, description="avl_unit_group ID to filter by"),
    start: Optional[str] = Query(None, description="Start date (currently unused, see note below)"),
    end: Optional[str] = Query(None, description="End date (currently unused, see note below)"),
    db: Session = Depends(get_db),
):
    """
    Returns a list of vehicles (units) for the Vehicle List table.

    NOTE: start/end are accepted but not yet applied to filter/compute
    anything -- this endpoint currently returns each unit's *last known*
    state (from core/search_items last message), not historical data for
    the given date range. Building true date-range activity (distance
    driven, moving/stopped time, etc.) requires running report/exec_report
    per unit, similar to run_fleet_report, and is a separate follow-up.

    Frontend expects a plain JSON array (not the {"status": ...} envelope
    used elsewhere in this file), so errors are raised as HTTPExceptions.
    """
    creds = get_wialon_credentials(db, company_id)

    try:
        service = WialonReportService(base_url=creds["base_url"])
        service.login(creds["wialon_token"])

        group_name = ""
        unit_ids = []
        if groupId:
            unit_ids = service.get_group_units(groupId)
            for group in service.get_objects():
                if group.get("id") == groupId:
                    group_name = group.get("nm", "")
                    break

        units = service.get_units_summary(unit_ids)
        rows = service.build_vehicle_rows(units, group_name=group_name)

        # Overlay assigned employee (full_name, phone_number,
        # driving_license) per vehicle, joined on employees.vehicles_id ==
        # the Wialon unit id ("key").
        try:
            employees_by_vehicle = get_employees_by_vehicle_ids(
                db, [row["key"] for row in rows]
            )
            for row in rows:
                employee = employees_by_vehicle.get(row["key"])
                if employee:
                    row["fullName"] = employee["full_name"]
                    row["phoneNumber"] = employee["phone_number"]
                    row["drivingLicense"] = employee["driving_license"]
        except Exception as employee_err:
            # Don't fail the whole vehicle list if the employees join
            # errors out -- just leave these fields blank.
            print(f"DEBUG: employee join failed: {employee_err}")

        # Overlay operation-log data (start/end time, working hours,
        # initial/final mileage, fuel filled) per vehicle for the selected
        # date range, joined on vehicle_operation_logs.vehicle_id == "key".
        if start and end:
            try:
                logs_by_vehicle = get_operation_logs_by_vehicle_ids(
                    db, [row["key"] for row in rows], start, end
                )
                for row in rows:
                    log = logs_by_vehicle.get(row["key"])
                    if log:
                        row["startTime"] = log["start_time"]
                        row["endTime"] = log["end_time"]
                        row["workingHours"] = log["working_hours"]
                        row["initialMileage"] = log["initial_mileage"]
                        row["finalMileage"] = log["final_mileage"]
                        row["totalMileage"] = log["total_mileage"]
                        row["fuelFilledLiters"] = log["fuel_filling_liters"]
                        row["remarks"] = log["remarks"]
            except Exception as log_err:
                # Don't fail the whole vehicle list if the operation logs
                # join errors out -- just leave these fields blank/0.
                print(f"DEBUG: operation logs join failed: {log_err}")

        # Overlay real mileage (km) for the selected date range from the
        # fleet report, matched back to each row by (normalized) vehicle name.
        if groupId and start and end:
            try:
                start_ts = _date_to_unix(start, end_of_day=False)
                end_ts = _date_to_unix(end, end_of_day=True)
                report_rows = service.run_report(
                    resource_id=FLEET_RESOURCE_ID,
                    template_id=FLEET_TEMPLATE_ID,
                    object_id=groupId,
                    start=start_ts,
                    end=end_ts,
                )
                metrics_by_name = service.parse_report_metrics_by_name(report_rows)
                for row in rows:
                    key = service.normalize_name(row.get("vehicle"))
                    metrics = metrics_by_name.get(key)
                    if metrics:
                        row["code"] = metrics["code"]
                        row["vehicleTypeEng"] = metrics["vehicleTypeEng"]
                        row["vehicleTypeKh"] = metrics["vehicleTypeKh"]
                        row["baseLocation"] = metrics["baseLocation"]
                        row["projectCode"] = metrics["projectCode"]
                        row["mileage"] = metrics["mileage"]
                        row["engineHours"] = metrics["engineHours"]
                        row["initialFuel"] = metrics["initialFuel"]
                        row["fuelFilling"] = metrics["fuelFilling"]
                        row["fuelConsumed"] = metrics["fuelConsumed"]
                        row["finalFuelLevel"] = metrics["finalFuelLevel"]
                        row["fuelStandard"] = metrics["fuelStandard"]
            except Exception as report_err:
                # Don't fail the whole vehicle list if the mileage report
                # errors out -- just leave mileage at 0 for this search.
                print(f"DEBUG: mileage report failed: {report_err}")

        return rows

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/debug/units")
def debug_units(
    groupId: int = Query(..., description="avl_unit_group ID to inspect"),
    company_id: int = Query(DEFAULT_COMPANY_ID, description="Company whose Wialon credentials to use"),
    db: Session = Depends(get_db),
):
    """
    TEMPORARY diagnostic route -- returns the raw Wialon unit objects
    (including flds/pflds) for a group, unprocessed. Use this to see the
    real custom/profile field names for Code, Vehicle Type Eng, and
    Vehicle Type Kh so build_vehicle_rows' get_custom_field() candidate
    lists can be corrected -- they're currently just best-effort guesses.
    Safe to delete once the real field names are confirmed.
    """
    creds = get_wialon_credentials(db, company_id)

    try:
        service = WialonReportService(base_url=creds["base_url"])
        service.login(creds["wialon_token"])
        unit_ids = service.get_group_units(groupId)
        units = service.get_units_summary(unit_ids)
        return {"status": "success", "units": units}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# NOTE: the old GET /employees (list-everything) route that used to live
# here has been superseded by the fuller CRUD API in
# app/routes/employee_route.py (same path, GET /api/employees, now with
# filtering + create/update/delete).