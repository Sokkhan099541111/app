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
    get_rental_attendance_by_vehicle_ids,
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


def _filter_by_vehicle_search(rows: list, keyword: Optional[str]) -> list:
    """Keep rows whose Code OR Plate Number contains `keyword`.

    Case-insensitive and whitespace-trimmed, so " abc " and "ABC" behave
    the same as "abc" -- a keyword pasted from a spreadsheet usually
    carries stray spaces, and dropping every result over one would look
    like missing data rather than a typo.

    A blank or missing keyword returns the rows untouched: "no search" is
    not the same as "search for the empty string", which would match
    everything by accident rather than by intent.

    Filtering in Python rather than SQL because these rows do not come
    from the database -- they are built from the Wialon unit list and then
    enriched. The list is one entry per vehicle in the account (hundreds,
    not millions) and is already fully in memory by this point, so this is
    a single linear pass over data that has already been paid for; pushing
    it into SQL would mean an extra round trip and still could not see
    `code`, which the fleet report supplies.
    """
    if keyword is None:
        return rows
    needle = keyword.strip().lower()
    if not needle:
        return rows

    return [
        row
        for row in rows
        if needle in str(row.get("code") or "").lower()
        or needle in str(row.get("plate") or "").lower()
    ]


@router.get("/reports/vehicles")
def get_vehicle_list(
    company_id: int = Query(DEFAULT_COMPANY_ID, description="Company whose Wialon credentials to use"),
    groupId: Optional[int] = Query(None, description="avl_unit_group ID to filter by"),
    start: Optional[str] = Query(None, description="Start date (currently unused, see note below)"),
    end: Optional[str] = Query(None, description="End date (currently unused, see note below)"),
    vehicle_search: Optional[str] = Query(
        None,
        description=(
            "Partial, case-insensitive match against the vehicle Code OR the "
            "Plate Number. Blank/omitted returns every vehicle the other "
            "filters allow."
        ),
    ),
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
        #
        # Project Code is collected into its own dict here rather than
        # written straight onto the row, and applied AFTER the fleet-report
        # block below, so nothing downstream can overwrite it. The Vehicle
        # Operation Log is the ONLY source for that column.
        project_code_from_log: dict = {}
        # Base Location is collected the same way and for the same reason:
        # the Vehicle Operation Log is now its ONLY source, so it is applied
        # after the fleet-report block rather than inside it.
        base_location_from_log: dict = {}
        # Working Hours and Total Mileage get the same treatment, and for
        # the same reason: the Vehicle Operation Log is their only source.
        # Collected here, applied after the fleet-report block, so a
        # vehicle with no log reads BLANK rather than falling back to the
        # Wialon-derived engine hours / mileage sitting in other columns.
        working_hours_from_log: dict = {}
        total_mileage_from_log: dict = {}

        if start and end:
            try:
                logs_by_vehicle = get_operation_logs_by_vehicle_ids(
                    db, [row["key"] for row in rows], start, end
                )
                for row in rows:
                    log = logs_by_vehicle.get(row["key"])
                    if log:
                        if log.get("project_code"):
                            project_code_from_log[row["key"]] = log["project_code"]
                        if log.get("base_location"):
                            base_location_from_log[row["key"]] = log["base_location"]
                        if log.get("working_hours") is not None:
                            working_hours_from_log[row["key"]] = log["working_hours"]
                        if log.get("total_mileage") is not None:
                            total_mileage_from_log[row["key"]] = log["total_mileage"]
                        row["startTime"] = log["start_time"]
                        row["endTime"] = log["end_time"]
                        row["initialMileage"] = log["initial_mileage"]
                        row["finalMileage"] = log["final_mileage"]
                        row["fuelFilledLiters"] = log["fuel_filling_liters"]
                        row["remarks"] = log["remarks"]
            except Exception as log_err:
                # Don't fail the whole vehicle list if the operation logs
                # join errors out -- just leave these fields blank/0.
                print(f"DEBUG: operation logs join failed: {log_err}")

        # Overlay the Rental Attendance Entry status per vehicle for the
        # selected date range. This drives the Status column of the Daily
        # Machinery Operation Report (renamed from "Remark" -- the column
        # always showed a status, and "Remark" is now a separate free-text
        # field carried on the operation log), so it runs for EVERY vehicle
        # in the
        # list -- independently of whether that vehicle has an operation
        # log -- and leaves the field empty when no attendance exists, which
        # the frontend renders as "No Action".
        if start and end:
            try:
                attendance_by_vehicle = get_rental_attendance_by_vehicle_ids(
                    db, [row["key"] for row in rows], start, end
                )
                for row in rows:
                    row["attendanceStatus"] = attendance_by_vehicle.get(row["key"], "")
            except Exception as attendance_err:
                # Same rule as the joins above -- never fail the whole list.
                print(f"DEBUG: rental attendance join failed: {attendance_err}")

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
                        # NOTE: baseLocation is deliberately NOT taken from the
                        # fleet report any more, for the same reason as
                        # projectCode below -- users now enter it on the
                        # Vehicle Operation Log, and that record is the single
                        # source of truth. See the block after this loop.
                        # NOTE: projectCode is deliberately NOT taken from the
                        # fleet report any more. Project Code is now entered by
                        # users on the Vehicle Operation Log, and that record is
                        # the single source of truth -- see the block after this
                        # loop. Re-adding it here would silently overwrite the
                        # value the user typed.
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

        # Project Code comes from the Vehicle Operation Log for this vehicle
        # and date range -- and from nowhere else. Assigning unconditionally
        # (rather than only when a code was found) is the point: a vehicle
        # with no operation log, or a log whose Project Code was left empty,
        # must read blank rather than falling back to some other source and
        # showing a value that does not exist on any log record.
        for row in rows:
            row["projectCode"] = project_code_from_log.get(row["key"], "")
            # Same contract for Base Location: assigned unconditionally, so a
            # vehicle with no operation log -- or a log predating the
            # base_location column -- reads blank. Blank is the honest answer;
            # falling back to the fleet report would show a location that
            # appears on no log record and cannot be corrected from the UI.
            row["baseLocation"] = base_location_from_log.get(row["key"], "")
            # Working Hours and Total Mileage: None, not 0, when no log in
            # the range recorded one. Assigned unconditionally like the two
            # above, so nothing earlier in the pipeline can leave a stale
            # or Wialon-derived number in these columns. None serialises to
            # null and the report renders it blank -- "0.00 h" against a
            # vehicle that was never logged looks like a measurement, and
            # someone will act on it.
            row["workingHours"] = working_hours_from_log.get(row["key"])
            row["totalMileage"] = total_mileage_from_log.get(row["key"])

        # Vehicle search is applied LAST, once every overlay has run.
        #
        # It has to be: `code` does not exist on the raw unit -- it is
        # overlaid from the fleet report further up -- so filtering any
        # earlier would match against an empty string and silently drop
        # every vehicle whose code the user was searching for.
        return _filter_by_vehicle_search(rows, vehicle_search)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/debug/fleet-report-columns")
def debug_fleet_report_columns(
    limit: int = Query(3, description="How many units/report rows to dump"),
    company_id: int = Query(DEFAULT_COMPANY_ID, description="Company whose Wialon credentials to use"),
    db: Session = Depends(get_db),
):
    """Dump the fleet report's RAW columns, with their index positions,
    next to each unit's custom/profile field names and values.

    Why this exists: parse_report_metrics_by_name() reads the report by
    COLUMN POSITION (index 1 = code, 2 = vehicle type, and so on). Editing
    the template in Wialon's Report Designer -- including adding a custom
    field like "Vehicle Group" -- shifts every column after the insertion
    point, and the parser then silently reports the wrong field. There is
    no error; a code just quietly becomes something else.

    Run this whenever a column looks wrong, compare the indices below with
    the map in parse_report_metrics_by_name's docstring, and correct the
    indices to match. The custom-field dump also shows exactly which field
    names this account uses, for the *_FIELD_NAMES candidate lists.
    """
    creds = get_wialon_credentials(db, company_id)
    try:
        service = WialonReportService(base_url=creds["base_url"])
        service.login(creds["wialon_token"])

        groups = service.get_objects()
        if not groups:
            return {"status": "success", "detail": "No unit groups found", "rows": []}

        group_id = groups[0].get("id")
        now = int(time.time())
        report_rows = service.run_report(
            resource_id=FLEET_RESOURCE_ID,
            template_id=FLEET_TEMPLATE_ID,
            object_id=group_id,
            start=now - 86400,
            end=now,
        )

        raw = []
        for row in (report_rows or [])[:limit]:
            cols = row.get("c", [])
            raw.append(
                {
                    "column_count": len(cols),
                    # index -> value, so a shifted column is obvious at a glance
                    "columns": {str(i): c for i, c in enumerate(cols)},
                }
            )

        unit_ids = service.get_group_units(group_id)[:limit]
        units = service.get_units_summary(unit_ids)
        unit_fields = []
        for u in units:
            def _fields(container):
                if isinstance(container, dict):
                    values = container.values()
                elif isinstance(container, list):
                    values = container
                else:
                    values = []
                return {
                    str(f.get("n", "")): f.get("v", "")
                    for f in values
                    if isinstance(f, dict)
                }

            unit_fields.append(
                {
                    "id": u.get("id"),
                    "name": u.get("nm"),
                    "custom_fields": _fields(u.get("flds")),
                    "profile_fields": _fields(u.get("pflds")),
                }
            )

        return {
            "status": "success",
            "expected_column_map": {
                "0": "vehicle name", "1": "code", "2": "vehicle type (Eng)",
                "3": "vehicle type (Kh)", "4": "base location", "5": "project code",
                "6": "mileage", "7": "engine hours", "8": "initial fuel",
                "9": "fuel filled", "10": "fuel consumed", "11": "final fuel",
                "12": "fuel standard",
            },
            "actual_report_rows": raw,
            "unit_fields": unit_fields,
        }
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