"""
CRUD + reporting API for the Vehicle Rental Expense module.

Table schema (see app/vehicle_rentals.sql -- run it once against
app_hosting before using these endpoints):

    vehicle_rentals
        rental_id           INT UNSIGNED AUTO_INCREMENT PK
        vehicles_id         INT NOT NULL         -- Wialon avl_unit id
        arrival_date        DATE NOT NULL        -- attendance can't predate this
        monthly_rental      DECIMAL(10,2) NOT NULL
        status              ENUM('Active','Inactive') NOT NULL DEFAULT 'Active'
        created_at / updated_at TIMESTAMP

    vehicle_rental_attendance
        attendance_id       BIGINT UNSIGNED AUTO_INCREMENT PK
        rental_id           INT UNSIGNED NOT NULL   -- FK -> vehicle_rentals
        work_date           DATE NOT NULL
        status              ENUM('Working','On Standby','Broken') NOT NULL
        created_at / updated_at TIMESTAMP

Nothing else is stored -- Code, Plate Number, Vehicle Type, and Driver Name
are all resolved live, exactly like the rest of this app already does for
vehicles_id-based lookups:

  - Code + Vehicle Type come from the Vehicle Unit API (the same Wialon
    fleet report GET /api/reports/vehicles already uses -- template_id=21,
    column 1 = code, column 2 = vehicle type). See _enrich_with_vehicle_info().
  - Plate Number is the Wialon unit's name (nm) -- same convention as
    build_vehicle_rows()'s "plate" field elsewhere in this app.
  - Driver Name is looked up from `employees` WHERE employees.vehicles_id =
    vehicle_rentals.vehicles_id (a vehicle's currently assigned driver).

Business rules:
  - A vehicle can only be on one non-Inactive rental record at a time
    (checked on create/update, 409 if taken; see GET
    /vehicle-rentals/check-vehicle for the frontend's live check) -- same
    "one vehicle <-> one active record" pattern as employees.vehicles_id.
  - DELETE is blocked (409) once attendance history exists for a rental --
    mark it Inactive instead, so the monthly report's history stays intact.
  - Attendance can't be marked for a work_date earlier than the rental's
    arrival_date (400 if attempted) -- checked on create/update.
  - Total Rental Expense (computed at report time, never stored):
        (monthly_rental / days_in_selected_month) * (Total Working + Total On Standby)
"""
import calendar
import time
from datetime import date
from enum import Enum
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.config.database import get_db
from app.config.settings import DEFAULT_COMPANY_ID
from app.services.wialon_snkrp_reports import WialonReportService, get_wialon_credentials

router = APIRouter()

# Same fixed resource/template the fleet mileage report (and Vehicle List
# page) already uses -- column 1 of this report is the vehicle's Code,
# column 2 is its Vehicle Type (English). See
# WialonReportService.parse_report_metrics_by_name()'s docstring for the
# full confirmed column layout.
FLEET_RESOURCE_ID = 601651347
FLEET_TEMPLATE_ID = 21


class RentalStatusEnum(str, Enum):
    active = "Active"
    inactive = "Inactive"


class DayStatusEnum(str, Enum):
    working = "Working"
    standby = "On Standby"
    broken = "Broken"


# --- Request bodies ------------------------------------------------------

class VehicleRentalIn(BaseModel):
    vehicles_id: int
    arrival_date: date
    monthly_rental: float
    status: RentalStatusEnum = RentalStatusEnum.active


class VehicleRentalUpdate(BaseModel):
    """All fields optional -- only columns actually sent get updated."""
    vehicles_id: Optional[int] = None
    arrival_date: Optional[date] = None
    monthly_rental: Optional[float] = None
    status: Optional[RentalStatusEnum] = None


class RentalAttendanceIn(BaseModel):
    rental_id: int
    work_date: date
    status: DayStatusEnum


class RentalAttendanceUpdate(BaseModel):
    status: Optional[DayStatusEnum] = None


# --- Helpers ---------------------------------------------------------------

def _row_to_dict(row) -> dict:
    return dict(row._mapping)


def _fetch_rental(db: Session, rental_id: int) -> dict:
    row = db.execute(
        text("SELECT * FROM vehicle_rentals WHERE rental_id = :rental_id"),
        {"rental_id": rental_id},
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Rental {rental_id} not found")
    return _row_to_dict(row)


def _vehicle_already_rented(
    db: Session, vehicles_id: Optional[int], exclude_rental_id: Optional[int] = None
) -> bool:
    """True if this vehicle is already on another non-Inactive rental
    record -- keeps it one vehicle <-> one active rental, mirroring
    employees.vehicles_id's one-vehicle-one-employee rule."""
    if not vehicles_id:
        return False
    params: dict = {"vehicles_id": vehicles_id}
    exclude_clause = ""
    if exclude_rental_id is not None:
        exclude_clause = "AND rental_id != :exclude_rental_id"
        params["exclude_rental_id"] = exclude_rental_id
    row = db.execute(
        text(
            f"""
            SELECT 1 FROM vehicle_rentals
            WHERE vehicles_id = :vehicles_id AND status != 'Inactive'
            {exclude_clause}
            LIMIT 1
            """
        ),
        params,
    ).first()
    return row is not None


def _driver_names_by_vehicle(db: Session, vehicle_ids: list) -> dict:
    """{vehicles_id: full_name} for whichever employee currently has each
    vehicle assigned (employees.vehicles_id) -- the rental's Driver Name."""
    vehicle_ids = [v for v in dict.fromkeys(vehicle_ids) if v is not None]
    if not vehicle_ids:
        return {}
    placeholders = ", ".join(f":id{i}" for i in range(len(vehicle_ids)))
    params = {f"id{i}": vid for i, vid in enumerate(vehicle_ids)}
    rows = db.execute(
        text(
            f"""
            SELECT vehicles_id, CONCAT(first_name, ' ', last_name) AS full_name
            FROM employees
            WHERE vehicles_id IN ({placeholders}) AND employment_status != 'Terminated'
            """
        ),
        params,
    )
    return {row.vehicles_id: row.full_name for row in rows}


def _enrich_with_vehicle_info(db: Session, company_id: int) -> dict:
    """{vehicles_id: {"plate_number", "code", "vehicle_type"}} pulled from
    the Vehicle Unit API (Wialon) -- returns {} on any failure (no
    credentials, Wialon unreachable, no unit groups configured, etc.) so
    listing/reporting rentals never hard-fails just because Wialon is
    down; the frontend just shows blank Code/Plate/Vehicle Type cells."""
    try:
        creds = get_wialon_credentials(db, company_id)
        service = WialonReportService(base_url=creds["base_url"])
        service.login(creds["wialon_token"])

        groups = service.get_objects()
        if not groups:
            return {}
        group_id = groups[0].get("id")
        unit_ids = service.get_group_units(group_id)
        units = service.get_units_summary(unit_ids)
        rows = service.build_vehicle_rows(units)

        now = int(time.time())
        report_rows = service.run_report(
            resource_id=FLEET_RESOURCE_ID,
            template_id=FLEET_TEMPLATE_ID,
            object_id=group_id,
            start=now - 86400,
            end=now,
        )
        metrics_by_name = service.parse_report_metrics_by_name(report_rows)

        result = {}
        for row in rows:
            key = service.normalize_name(row.get("vehicle"))
            metrics = metrics_by_name.get(key, {})
            result[row["key"]] = {
                "plate_number": row.get("plate") or "",
                "code": metrics.get("code", ""),
                "vehicle_type": metrics.get("vehicleTypeEng", ""),
            }
        return result
    except Exception as e:
        print(f"DEBUG: vehicle rental enrichment (Code/Plate/Vehicle Type) failed: {e}")
        return {}


# --- Rental Vehicles CRUD ---------------------------------------------------

@router.get("/vehicle-rentals")
def list_vehicle_rentals(
    status: Optional[str] = Query(
        None, description="Filter by status: Active, Inactive, or All (default: All)"
    ),
    company_id: int = Query(
        DEFAULT_COMPANY_ID, description="Company whose Wialon credentials to use for Code/Plate/Vehicle Type"
    ),
    db: Session = Depends(get_db),
):
    """List rental vehicles, enriched with Code/Plate Number/Vehicle Type
    (from the Vehicle Unit API) and Driver Name (from employees, joined on
    vehicles_id)."""
    clauses, params = [], {}
    if status is not None and status.strip().lower() != "all":
        normalized = status.strip().capitalize()
        if normalized not in ("Active", "Inactive"):
            raise HTTPException(status_code=400, detail="status must be one of: Active, Inactive, All")
        clauses.append("status = :status")
        params["status"] = normalized
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    try:
        rows = db.execute(
            text(f"SELECT * FROM vehicle_rentals {where} ORDER BY rental_id ASC"), params
        )
        rentals = [_row_to_dict(r) for r in rows]
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read vehicle_rentals -- has vehicle_rentals.sql been run yet? ({e})",
        )

    vehicle_ids = [r["vehicles_id"] for r in rentals]
    driver_names = _driver_names_by_vehicle(db, vehicle_ids)
    vehicle_info = _enrich_with_vehicle_info(db, company_id)

    for r in rentals:
        info = vehicle_info.get(r["vehicles_id"], {})
        r["plate_number"] = info.get("plate_number", "")
        r["code"] = info.get("code", "")
        r["vehicle_type"] = info.get("vehicle_type", "")
        r["driver_name"] = driver_names.get(r["vehicles_id"], "")

    return {"status": "success", "data": rentals}


@router.get("/vehicle-rentals/check-vehicle")
def check_vehicle_rental(
    vehicles_id: int = Query(..., description="Wialon unit id to check"),
    exclude_rental_id: Optional[int] = Query(
        None, description="Rental id to ignore (pass the record's own id when editing)"
    ),
    db: Session = Depends(get_db),
):
    """Lets the frontend check as soon as a vehicle is picked whether it's
    already on another active rental record."""
    exists = _vehicle_already_rented(db, vehicles_id, exclude_rental_id=exclude_rental_id)
    return {"status": "success", "exists": exists}


@router.get("/vehicle-rentals/report")
def get_vehicle_rental_report(
    year: int = Query(..., description="Report year"),
    month: int = Query(..., ge=1, le=12, description="Report month (1-12)"),
    include_inactive: bool = Query(False, description="Include Inactive rentals"),
    company_id: int = Query(
        DEFAULT_COMPANY_ID, description="Company whose Wialon credentials to use for Code/Plate/Vehicle Type"
    ),
    db: Session = Depends(get_db),
):
    """
    The "Monthly Report Rental Expense" view -- one row per rental vehicle
    for the selected month, with a day-by-day Working/On Standby/Broken
    tick plus the computed totals and Total Rental Expense:

        Total Rental Expense = (Monthly Rental / Total Days in Month)
                                * (Total Working + Total On Standby)
    """
    days_in_month = calendar.monthrange(year, month)[1]
    status_clause = "" if include_inactive else "WHERE status != 'Inactive'"

    try:
        rentals = [
            _row_to_dict(r)
            for r in db.execute(text(f"SELECT * FROM vehicle_rentals {status_clause} ORDER BY rental_id ASC"))
        ]
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read vehicle_rentals -- has vehicle_rentals.sql been run yet? ({e})",
        )

    if not rentals:
        return {"status": "success", "year": year, "month": month, "days_in_month": days_in_month, "data": []}

    rental_ids = [r["rental_id"] for r in rentals]
    placeholders = ", ".join(f":id{i}" for i in range(len(rental_ids)))
    params = {f"id{i}": rid for i, rid in enumerate(rental_ids)}
    params["year"] = year
    params["month"] = month
    att_rows = db.execute(
        text(
            f"""
            SELECT rental_id, work_date, status FROM vehicle_rental_attendance
            WHERE rental_id IN ({placeholders}) AND YEAR(work_date) = :year AND MONTH(work_date) = :month
            """
        ),
        params,
    )

    attendance_by_rental: dict = {}
    for row in att_rows:
        attendance_by_rental.setdefault(row.rental_id, {})[row.work_date.day] = row.status

    vehicle_ids = [r["vehicles_id"] for r in rentals]
    driver_names = _driver_names_by_vehicle(db, vehicle_ids)
    vehicle_info = _enrich_with_vehicle_info(db, company_id)

    data = []
    for r in rentals:
        day_map = attendance_by_rental.get(r["rental_id"], {})
        days = [day_map.get(d) for d in range(1, days_in_month + 1)]
        total_working = sum(1 for s in days if s == "Working")
        total_on_standby = sum(1 for s in days if s == "On Standby")
        total_broken = sum(1 for s in days if s == "Broken")
        monthly_rental = float(r["monthly_rental"])
        total_rental_expense = round((monthly_rental / days_in_month) * (total_working + total_on_standby), 2)

        info = vehicle_info.get(r["vehicles_id"], {})
        data.append(
            {
                "rental_id": r["rental_id"],
                "vehicles_id": r["vehicles_id"],
                "code": info.get("code", ""),
                "plate_number": info.get("plate_number", ""),
                "vehicle_type": info.get("vehicle_type", ""),
                "driver_name": driver_names.get(r["vehicles_id"], ""),
                "monthly_rental": monthly_rental,
                "status": r["status"],
                "days": days,
                "total_working": total_working,
                "total_on_standby": total_on_standby,
                "total_broken": total_broken,
                "total_rental_expense": total_rental_expense,
            }
        )

    return {"status": "success", "year": year, "month": month, "days_in_month": days_in_month, "data": data}


@router.get("/vehicle-rentals/{rental_id}")
def get_vehicle_rental(rental_id: int, db: Session = Depends(get_db)):
    return {"status": "success", "data": _fetch_rental(db, rental_id)}


@router.post("/vehicle-rentals", status_code=201)
def create_vehicle_rental(payload: VehicleRentalIn, db: Session = Depends(get_db)):
    if _vehicle_already_rented(db, payload.vehicles_id):
        raise HTTPException(
            status_code=409, detail="This vehicle is already on another active rental record."
        )
    try:
        result = db.execute(
            text(
                """
                INSERT INTO vehicle_rentals (vehicles_id, arrival_date, monthly_rental, status)
                VALUES (:vehicles_id, :arrival_date, :monthly_rental, :status)
                """
            ),
            payload.model_dump(),
        )
        db.commit()
        return {"status": "success", "data": _fetch_rental(db, result.lastrowid)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create rental: {e}")


@router.put("/vehicle-rentals/{rental_id}")
def update_vehicle_rental(rental_id: int, payload: VehicleRentalUpdate, db: Session = Depends(get_db)):
    _fetch_rental(db, rental_id)  # 404 early if it doesn't exist

    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "vehicles_id" in updates and _vehicle_already_rented(
        db, updates["vehicles_id"], exclude_rental_id=rental_id
    ):
        raise HTTPException(
            status_code=409, detail="This vehicle is already on another active rental record."
        )

    set_clause = ", ".join(f"{col} = :{col}" for col in updates)
    updates["rental_id"] = rental_id

    try:
        db.execute(
            text(f"UPDATE vehicle_rentals SET {set_clause} WHERE rental_id = :rental_id"), updates
        )
        db.commit()
        return {"status": "success", "data": _fetch_rental(db, rental_id)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update rental {rental_id}: {e}")


@router.delete("/vehicle-rentals/{rental_id}")
def delete_vehicle_rental(rental_id: int, db: Session = Depends(get_db)):
    """Hard delete -- blocked (409) if attendance history exists for this
    rental. Mark it Inactive instead to keep the monthly report's history
    intact."""
    _fetch_rental(db, rental_id)  # 404 early if it doesn't exist
    try:
        db.execute(text("DELETE FROM vehicle_rentals WHERE rental_id = :rental_id"), {"rental_id": rental_id})
        db.commit()
        return {"status": "success", "message": f"Rental {rental_id} deleted"}
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Can't delete -- this rental already has attendance history. Mark it Inactive instead.",
        )
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not delete rental {rental_id}: {e}")


# --- Rental Attendance CRUD --------------------------------------------------

def _fetch_rental_attendance(db: Session, attendance_id: int) -> dict:
    row = db.execute(
        text("SELECT * FROM vehicle_rental_attendance WHERE attendance_id = :attendance_id"),
        {"attendance_id": attendance_id},
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Rental attendance row {attendance_id} not found")
    return _row_to_dict(row)


def _rental_attendance_duplicate(
    db: Session, rental_id: int, work_date_, exclude_id: Optional[int] = None
) -> bool:
    params: dict = {"rental_id": rental_id, "work_date": work_date_}
    exclude_clause = ""
    if exclude_id is not None:
        exclude_clause = "AND attendance_id != :exclude_id"
        params["exclude_id"] = exclude_id
    row = db.execute(
        text(
            f"""
            SELECT 1 FROM vehicle_rental_attendance
            WHERE rental_id = :rental_id AND work_date = :work_date
            {exclude_clause}
            LIMIT 1
            """
        ),
        params,
    ).first()
    return row is not None


@router.get("/vehicle-rental-attendance")
def list_rental_attendance(
    rental_id: Optional[int] = Query(None, description="Filter by rental"),
    year: Optional[int] = Query(None, description="Filter by year (pair with month)"),
    month: Optional[int] = Query(None, ge=1, le=12, description="Filter by month (pair with year)"),
    db: Session = Depends(get_db),
):
    """List rental attendance rows, optionally filtered by rental and/or a
    specific (year, month)."""
    clauses, params = [], {}
    if rental_id is not None:
        clauses.append("rental_id = :rental_id")
        params["rental_id"] = rental_id
    if year is not None and month is not None:
        clauses.append("YEAR(work_date) = :year AND MONTH(work_date) = :month")
        params["year"] = year
        params["month"] = month
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    try:
        rows = db.execute(
            text(f"SELECT * FROM vehicle_rental_attendance {where} ORDER BY work_date ASC"), params
        )
        return {"status": "success", "data": [_row_to_dict(r) for r in rows]}
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read vehicle_rental_attendance -- has vehicle_rentals.sql been run yet? ({e})",
        )


@router.get("/vehicle-rental-attendance/{attendance_id}")
def get_rental_attendance(attendance_id: int, db: Session = Depends(get_db)):
    return {"status": "success", "data": _fetch_rental_attendance(db, attendance_id)}


@router.post("/vehicle-rental-attendance", status_code=201)
def create_rental_attendance(payload: RentalAttendanceIn, db: Session = Depends(get_db)):
    rental = _fetch_rental(db, payload.rental_id)
    if payload.work_date < rental["arrival_date"]:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Can't mark attendance before the vehicle's arrival date "
                f"({rental['arrival_date'].isoformat()})."
            ),
        )
    if _rental_attendance_duplicate(db, payload.rental_id, payload.work_date):
        raise HTTPException(
            status_code=409,
            detail=(
                f"Attendance for this rental on {payload.work_date.isoformat()} already exists -- "
                "update that row instead of creating a new one."
            ),
        )
    try:
        result = db.execute(
            text(
                """
                INSERT INTO vehicle_rental_attendance (rental_id, work_date, status)
                VALUES (:rental_id, :work_date, :status)
                """
            ),
            payload.model_dump(),
        )
        db.commit()
        return {"status": "success", "data": _fetch_rental_attendance(db, result.lastrowid)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create rental attendance row: {e}")


@router.put("/vehicle-rental-attendance/{attendance_id}")
def update_rental_attendance(attendance_id: int, payload: RentalAttendanceUpdate, db: Session = Depends(get_db)):
    current = _fetch_rental_attendance(db, attendance_id)  # 404 early if it doesn't exist

    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    set_clause = ", ".join(f"{col} = :{col}" for col in updates)
    updates["attendance_id"] = attendance_id

    try:
        db.execute(
            text(f"UPDATE vehicle_rental_attendance SET {set_clause} WHERE attendance_id = :attendance_id"),
            updates,
        )
        db.commit()
        return {"status": "success", "data": _fetch_rental_attendance(db, attendance_id)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update rental attendance row {attendance_id}: {e}")


@router.delete("/vehicle-rental-attendance/{attendance_id}")
def delete_rental_attendance(attendance_id: int, db: Session = Depends(get_db)):
    """Hard delete -- removes the tick entirely (the frontend calendar
    treats a missing day as unmarked, not as any particular status)."""
    _fetch_rental_attendance(db, attendance_id)  # 404 early if it doesn't exist
    try:
        db.execute(
            text("DELETE FROM vehicle_rental_attendance WHERE attendance_id = :attendance_id"),
            {"attendance_id": attendance_id},
        )
        db.commit()
        return {"status": "success", "message": f"Rental attendance row {attendance_id} deleted"}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not delete rental attendance row {attendance_id}: {e}")
