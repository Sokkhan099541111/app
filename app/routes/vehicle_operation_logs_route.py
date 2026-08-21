"""
CRUD API for `vehicle_operation_logs` -- the table that /reports/vehicles
(see routes/snkrp_route.py -> get_operation_logs_by_vehicle_ids) already
reads from to overlay start/end time, mileage, and fuel data onto the
Vehicle List. This file is where that data actually gets created, edited,
and deleted from the frontend's log entry form.

Table schema (see app/vehicle_operation_logs.sql for the migration -- run
it once against app_hosting before using these endpoints; if the table
already existed before `status` was added, run
app/vehicle_operation_logs_add_status.sql instead):

    log_id              INT UNSIGNED AUTO_INCREMENT PK
    vehicle_id          INT UNSIGNED      -- Wialon avl_unit id
    operation_date      DATE
    start_time          DATETIME
    end_time            DATETIME
    working_hours       DECIMAL(5,2)   GENERATED (hours between start/end)
    initial_mileage     DECIMAL(10,2)
    final_mileage       DECIMAL(10,2)
    total_mileage       VARCHAR(50)
    distance_travelled  DECIMAL(10,2)  GENERATED (final - initial mileage)
    fuel_filling_liters DECIMAL(10,2)
    remarks             TEXT
    status              ENUM('Active','Inactive') DEFAULT 'Active'
    created_at          TIMESTAMP
    updated_at          TIMESTAMP

working_hours and distance_travelled are MySQL GENERATED columns -- never
set them directly in INSERT/UPDATE, MySQL computes them from the other
columns.

Business rules enforced here:
  - Duplicate check: only one Active log per (vehicle_id, operation_date)
    is allowed. Creating (or updating into) a second one is rejected with
    409 Conflict.
  - Soft delete: DELETE never removes a row -- it flips status to
    'Inactive' so the record is kept for audit/history. The list endpoint
    only returns Active rows unless a different `status` filter is passed.
"""
import time
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config.database import get_db
from app.config.settings import DEFAULT_COMPANY_ID
from app.services.wialon_snkrp_reports import WialonReportService, get_wialon_credentials

router = APIRouter()

# Same fixed resource/template the fleet mileage report (and the Vehicle
# Rental / Daily KPI / Vehicle Expense modules) already use -- column 2 of
# this report is the vehicle's Vehicle Type (English).
FLEET_RESOURCE_ID = 601651347
FLEET_TEMPLATE_ID = 21


# --- Request bodies ----------------------------------------------------

class VehicleOperationLogIn(BaseModel):
    vehicle_id: int
    operation_date: date
    start_time: datetime
    end_time: datetime
    initial_mileage: float = 0
    final_mileage: float = 0
    total_mileage: Optional[str] = None
    fuel_filling_liters: float = 0
    remarks: Optional[str] = None


class VehicleOperationLogUpdate(BaseModel):
    """All fields optional -- only columns actually sent get updated."""
    vehicle_id: Optional[int] = None
    operation_date: Optional[date] = None
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    initial_mileage: Optional[float] = None
    final_mileage: Optional[float] = None
    total_mileage: Optional[str] = None
    fuel_filling_liters: Optional[float] = None
    remarks: Optional[str] = None


# --- Helpers -------------------------------------------------------------

def _row_to_dict(row) -> dict:
    return dict(row._mapping)


def _fetch_log(db: Session, log_id: int) -> dict:
    row = db.execute(
        text("SELECT * FROM vehicle_operation_logs WHERE log_id = :log_id"),
        {"log_id": log_id},
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Log {log_id} not found")
    return _row_to_dict(row)


def _active_duplicate_exists(
    db: Session, vehicle_id: int, operation_date, exclude_log_id: Optional[int] = None
) -> bool:
    """
    True if an Active vehicle_operation_logs row already exists for this
    vehicle on this operation_date (optionally excluding one log_id --
    used when updating a log so it doesn't collide with itself).
    """
    params: dict = {"vehicle_id": vehicle_id, "operation_date": operation_date}
    exclude_clause = ""
    if exclude_log_id is not None:
        exclude_clause = "AND log_id != :exclude_log_id"
        params["exclude_log_id"] = exclude_log_id

    row = db.execute(
        text(
            f"""
            SELECT 1 FROM vehicle_operation_logs
            WHERE vehicle_id = :vehicle_id
              AND operation_date = :operation_date
              AND status = 'Active'
              {exclude_clause}
            LIMIT 1
            """
        ),
        params,
    ).first()
    return row is not None


# --- Routes --------------------------------------------------------------

@router.get("/vehicle-logs")
def list_vehicle_logs(
    vehicle_id: Optional[int] = Query(None, description="Filter by vehicle (Wialon unit id)"),
    start: Optional[date] = Query(None, description="operation_date range start (YYYY-MM-DD)"),
    end: Optional[date] = Query(None, description="operation_date range end (YYYY-MM-DD)"),
    status: str = Query(
        "Active",
        description="Filter by status: 'Active' (default), 'Inactive', or 'All'",
    ),
    db: Session = Depends(get_db),
):
    """List vehicle operation logs, optionally filtered by vehicle and/or
    an operation_date range (both are optional and combine with AND).

    Only Active logs are returned by default -- soft-deleted (Inactive)
    logs are hidden unless status=Inactive or status=All is passed
    explicitly.
    """
    normalized_status = (status or "Active").strip().capitalize()
    if normalized_status not in ("Active", "Inactive", "All"):
        raise HTTPException(
            status_code=400, detail="status must be one of: Active, Inactive, All"
        )

    clauses = []
    params: dict = {}
    if normalized_status != "All":
        clauses.append("status = :status")
        params["status"] = normalized_status
    if vehicle_id is not None:
        clauses.append("vehicle_id = :vehicle_id")
        params["vehicle_id"] = vehicle_id
    if start is not None:
        clauses.append("operation_date >= :start")
        params["start"] = start
    if end is not None:
        clauses.append("operation_date <= :end")
        params["end"] = end

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    try:
        rows = db.execute(
            text(
                f"SELECT * FROM vehicle_operation_logs {where} "
                "ORDER BY operation_date DESC, log_id DESC"
            ),
            params,
        )
        return {"status": "success", "data": [_row_to_dict(r) for r in rows]}
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=(
                "Could not read vehicle_operation_logs -- has "
                f"vehicle_operation_logs.sql been run yet? ({e})"
            ),
        )


@router.get("/vehicle-logs/vehicle-options")
def get_vehicle_options(
    company_id: int = Query(DEFAULT_COMPANY_ID, description="Company whose Wialon credentials to use"),
    db: Session = Depends(get_db),
):
    """{id, name} for every vehicle in the company's Wialon account --
    used to populate the vehicle_id dropdown on the log form."""
    creds = get_wialon_credentials(db, company_id)
    try:
        service = WialonReportService(base_url=creds["base_url"])
        service.login(creds["wialon_token"])
        return {"status": "success", "vehicles": service.get_all_units()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/vehicle-logs/vehicle-types")
def get_vehicle_types(
    company_id: int = Query(DEFAULT_COMPANY_ID, description="Company whose Wialon credentials to use"),
    db: Session = Depends(get_db),
):
    """{vehicle_id: vehicle_type} for every vehicle in the company's Wialon
    account -- Vehicle Type comes from the fleet report (template_id=21,
    same one the other vehicle modules use), scoped to the default unit
    group and matched back to each account-wide unit by normalized name.
    Returns {} on any failure so the log list never hard-fails just
    because Wialon is down -- the frontend just shows a blank Vehicle Type
    cell."""
    try:
        creds = get_wialon_credentials(db, company_id)
        service = WialonReportService(base_url=creds["base_url"])
        service.login(creds["wialon_token"])

        all_units = service.get_all_units()

        metrics_by_name = {}
        groups = service.get_objects()
        if groups:
            group_id = groups[0].get("id")
            now = int(time.time())
            report_rows = service.run_report(
                resource_id=FLEET_RESOURCE_ID,
                template_id=FLEET_TEMPLATE_ID,
                object_id=group_id,
                start=now - 86400,
                end=now,
            )
            metrics_by_name = service.parse_report_metrics_by_name(report_rows)

        vehicle_types = {}
        for u in all_units:
            key = service.normalize_name(u.get("name"))
            vehicle_types[u["id"]] = metrics_by_name.get(key, {}).get("vehicleTypeEng", "")

        return {"status": "success", "vehicle_types": vehicle_types}
    except Exception as e:
        print(f"DEBUG: vehicle-logs vehicle-types fetch failed: {e}")
        return {"status": "success", "vehicle_types": {}}


@router.get("/vehicle-logs/check-duplicate")
def check_duplicate_log(
    vehicle_id: int = Query(..., description="Wialon unit id to check"),
    operation_date: date = Query(..., description="Operation date to check (YYYY-MM-DD)"),
    exclude_log_id: Optional[int] = Query(
        None, description="Log id to ignore (pass the record's own id when editing)"
    ),
    db: Session = Depends(get_db),
):
    """
    Lets the frontend check for a duplicate as soon as the user picks a
    plate number + operation date, instead of waiting for the 409 on
    submit. Mirrors the same check create/update enforce.
    """
    exists = _active_duplicate_exists(db, vehicle_id, operation_date, exclude_log_id=exclude_log_id)
    return {"status": "success", "exists": exists}


@router.get("/vehicle-logs/{log_id}")
def get_vehicle_log(log_id: int, db: Session = Depends(get_db)):
    return {"status": "success", "data": _fetch_log(db, log_id)}


@router.post("/vehicle-logs", status_code=201)
def create_vehicle_log(payload: VehicleOperationLogIn, db: Session = Depends(get_db)):
    """
    Insert a new log row (status defaults to 'Active' at the DB level).
    working_hours/distance_travelled are intentionally left out of the
    INSERT -- they're MySQL GENERATED columns computed from
    start_time/end_time and initial_mileage/final_mileage.

    Rejects with 409 if an Active log already exists for this vehicle on
    this operation_date.
    """
    if _active_duplicate_exists(db, payload.vehicle_id, payload.operation_date):
        raise HTTPException(
            status_code=409,
            detail=(
                "An active operation log already exists for this vehicle on "
                f"{payload.operation_date.isoformat()}. Edit or delete that "
                "log first."
            ),
        )

    try:
        result = db.execute(
            text(
                """
                INSERT INTO vehicle_operation_logs
                    (vehicle_id, operation_date, start_time, end_time,
                     initial_mileage, final_mileage, total_mileage,
                     fuel_filling_liters, remarks)
                VALUES
                    (:vehicle_id, :operation_date, :start_time, :end_time,
                     :initial_mileage, :final_mileage, :total_mileage,
                     :fuel_filling_liters, :remarks)
                """
            ),
            payload.model_dump(),
        )
        db.commit()
        return {"status": "success", "data": _fetch_log(db, result.lastrowid)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create log: {e}")


@router.put("/vehicle-logs/{log_id}")
def update_vehicle_log(
    log_id: int, payload: VehicleOperationLogUpdate, db: Session = Depends(get_db)
):
    current = _fetch_log(db, log_id)  # 404 early if it doesn't exist

    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    # Re-run the duplicate check if this row is Active and either the
    # vehicle or the date is changing -- otherwise an edit could silently
    # create a second Active log for the same vehicle/day.
    if current["status"] == "Active" and (
        "vehicle_id" in updates or "operation_date" in updates
    ):
        effective_vehicle_id = updates.get("vehicle_id", current["vehicle_id"])
        effective_date = updates.get("operation_date", current["operation_date"])
        if _active_duplicate_exists(db, effective_vehicle_id, effective_date, exclude_log_id=log_id):
            raise HTTPException(
                status_code=409,
                detail=(
                    "An active operation log already exists for this vehicle "
                    f"on {effective_date}. Edit or delete that log first."
                ),
            )

    set_clause = ", ".join(f"{col} = :{col}" for col in updates)
    updates["log_id"] = log_id

    try:
        db.execute(
            text(f"UPDATE vehicle_operation_logs SET {set_clause} WHERE log_id = :log_id"),
            updates,
        )
        db.commit()
        return {"status": "success", "data": _fetch_log(db, log_id)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update log {log_id}: {e}")


@router.delete("/vehicle-logs/{log_id}")
def delete_vehicle_log(log_id: int, db: Session = Depends(get_db)):
    """
    Soft delete: sets status='Inactive' instead of removing the row, so
    the log stays in the database for audit/history purposes. It simply
    drops out of the default (status=Active) list view.
    """
    _fetch_log(db, log_id)  # 404 early if it doesn't exist
    try:
        db.execute(
            text("UPDATE vehicle_operation_logs SET status = 'Inactive' WHERE log_id = :log_id"),
            {"log_id": log_id},
        )
        db.commit()
        return {"status": "success", "message": f"Log {log_id} marked inactive"}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not delete log {log_id}: {e}")
