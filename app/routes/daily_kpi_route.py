"""
CRUD API for the Daily KPI module (see app/daily_kpi.sql -- run it once
against app_hosting before using these endpoints; requires app/formulas.sql
to have been run first, since Work Type reuses that table).

Table schema:

    daily_kpi_entries
        entry_id            BIGINT UNSIGNED AUTO_INCREMENT PK
        vehicles_id          INT NOT NULL        -- Wialon avl_unit id
        work_date            DATE NOT NULL
        work_type_id         INT UNSIGNED NOT NULL   -- FK -> formulas.formula_id
        daily_productivity   DECIMAL(12,2) NOT NULL  -- manually entered
        remarks              VARCHAR(500)
        created_at / updated_at TIMESTAMP

Nothing else is stored -- Code, Vehicle Type, Plate Number, and Driver Name
are all resolved live, exactly like the Vehicle Rental module already does
for vehicles_id-based lookups (see app/routes/vehicle_rental_route.py):

  - Code + Vehicle Type come from the Vehicle Unit API (the same Wialon
    fleet report GET /api/reports/vehicles already uses -- template_id=21).
  - Plate Number is the Wialon unit's name (nm).
  - Driver Name is looked up from `employees` WHERE employees.vehicles_id =
    daily_kpi_entries.vehicles_id.

Work Type is NOT its own table -- daily_kpi_entries.work_type_id is a FK
straight into the existing `formulas` table (app/formulas.sql). Quantity,
Unit, and Calculated Rate / Unit are joined in live from that row (never
duplicated onto the entry) -- formulas.unit_price is used as the
"Calculated Rate / Unit". Daily KPI is computed on every response, never
stored:

    IF quantity < daily_productivity: KPI = quantity * unit_price
    ELSE:                             KPI = daily_productivity * unit_price
    i.e. KPI = LEAST(quantity, daily_productivity) * unit_price
"""
import time
from datetime import date
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

# Same fixed resource/template the fleet mileage report (and Vehicle Rental
# module) already uses -- column 1 of this report is the vehicle's Code,
# column 2 is its Vehicle Type (English).
FLEET_RESOURCE_ID = 601651347
FLEET_TEMPLATE_ID = 21


# --- Request bodies ------------------------------------------------------

class DailyKpiIn(BaseModel):
    vehicles_id: int
    work_date: date
    work_type_id: int
    daily_productivity: float
    remarks: Optional[str] = None


class DailyKpiUpdate(BaseModel):
    """All fields optional -- only columns actually sent get updated."""
    vehicles_id: Optional[int] = None
    work_date: Optional[date] = None
    work_type_id: Optional[int] = None
    daily_productivity: Optional[float] = None
    remarks: Optional[str] = None


# --- Helpers ---------------------------------------------------------------

def _row_to_dict(row) -> dict:
    return dict(row._mapping)


ENTRY_SELECT = """
    SELECT
        e.entry_id, e.vehicles_id, e.work_date, e.work_type_id,
        e.daily_productivity, e.remarks, e.created_at, e.updated_at,
        f.description AS work_type_description,
        f.quantity AS quantity,
        f.unit AS unit,
        f.unit_price AS rate_per_unit
    FROM daily_kpi_entries e
    JOIN formulas f ON f.formula_id = e.work_type_id
"""


def _with_kpi(row: dict) -> dict:
    quantity = float(row.get("quantity") or 0)
    productivity = float(row.get("daily_productivity") or 0)
    rate = float(row.get("rate_per_unit") or 0)
    effective = quantity if quantity < productivity else productivity
    row["kpi"] = round(effective * rate, 2)
    return row


def _fetch_entry(db: Session, entry_id: int) -> dict:
    row = db.execute(
        text(f"{ENTRY_SELECT} WHERE e.entry_id = :entry_id"),
        {"entry_id": entry_id},
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Daily KPI entry {entry_id} not found")
    return _with_kpi(_row_to_dict(row))


def _fetch_work_type_or_404(db: Session, work_type_id: int) -> dict:
    """work_type_id points at formulas.formula_id -- Work Type reuses the
    existing Formula master list rather than a separate table."""
    row = db.execute(
        text("SELECT * FROM formulas WHERE formula_id = :id"),
        {"id": work_type_id},
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Work type (formula) {work_type_id} not found")
    return _row_to_dict(row)


def _driver_names_by_vehicle(db: Session, vehicle_ids: list) -> dict:
    """{vehicles_id: full_name} for whichever employee currently has each
    vehicle assigned (employees.vehicles_id) -- the entry's Driver Name."""
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
    the Vehicle Unit API (Wialon) -- returns {} on any failure so listing
    entries never hard-fails just because Wialon is down; the frontend
    just shows blank Code/Plate/Vehicle Type cells."""
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
        print(f"DEBUG: daily KPI vehicle enrichment (Code/Plate/Vehicle Type) failed: {e}")
        return {}


# --- Daily KPI entries CRUD -----------------------------------------------

@router.get("/daily-kpi-entries")
def list_daily_kpi_entries(
    vehicles_id: Optional[int] = Query(None, description="Filter by vehicle"),
    work_type_id: Optional[int] = Query(None, description="Filter by work type"),
    year: Optional[int] = Query(None, description="Filter by year (pair with month)"),
    month: Optional[int] = Query(None, ge=1, le=12, description="Filter by month (pair with year)"),
    company_id: int = Query(
        DEFAULT_COMPANY_ID, description="Company whose Wialon credentials to use for Code/Plate/Vehicle Type"
    ),
    db: Session = Depends(get_db),
):
    """List Daily KPI entries, enriched with Code/Plate Number/Vehicle Type
    (from the Vehicle Unit API) and Driver Name (from employees), plus the
    joined Quantity/Unit/Calculated Rate per Unit and computed Daily KPI."""
    clauses, params = [], {}
    if vehicles_id is not None:
        clauses.append("e.vehicles_id = :vehicles_id")
        params["vehicles_id"] = vehicles_id
    if work_type_id is not None:
        clauses.append("e.work_type_id = :work_type_id")
        params["work_type_id"] = work_type_id
    if year is not None and month is not None:
        clauses.append("YEAR(e.work_date) = :year AND MONTH(e.work_date) = :month")
        params["year"] = year
        params["month"] = month
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    try:
        rows = db.execute(
            text(f"{ENTRY_SELECT} {where} ORDER BY e.work_date DESC, e.entry_id DESC"),
            params,
        )
        entries = [_with_kpi(_row_to_dict(r)) for r in rows]
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read daily_kpi_entries -- has daily_kpi.sql been run yet? ({e})",
        )

    vehicle_ids = [e["vehicles_id"] for e in entries]
    driver_names = _driver_names_by_vehicle(db, vehicle_ids)
    vehicle_info = _enrich_with_vehicle_info(db, company_id)

    for e in entries:
        info = vehicle_info.get(e["vehicles_id"], {})
        e["plate_number"] = info.get("plate_number", "")
        e["code"] = info.get("code", "")
        e["vehicle_type"] = info.get("vehicle_type", "")
        e["driver_name"] = driver_names.get(e["vehicles_id"], "")

    return {"status": "success", "data": entries}


@router.get("/daily-kpi-entries/{entry_id}")
def get_daily_kpi_entry(entry_id: int, db: Session = Depends(get_db)):
    return {"status": "success", "data": _fetch_entry(db, entry_id)}


@router.post("/daily-kpi-entries", status_code=201)
def create_daily_kpi_entry(payload: DailyKpiIn, db: Session = Depends(get_db)):
    _fetch_work_type_or_404(db, payload.work_type_id)
    try:
        result = db.execute(
            text(
                """
                INSERT INTO daily_kpi_entries
                    (vehicles_id, work_date, work_type_id, daily_productivity, remarks)
                VALUES
                    (:vehicles_id, :work_date, :work_type_id, :daily_productivity, :remarks)
                """
            ),
            payload.model_dump(),
        )
        db.commit()
        return {"status": "success", "data": _fetch_entry(db, result.lastrowid)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create daily KPI entry: {e}")


@router.put("/daily-kpi-entries/{entry_id}")
def update_daily_kpi_entry(entry_id: int, payload: DailyKpiUpdate, db: Session = Depends(get_db)):
    _fetch_entry(db, entry_id)  # 404 early if it doesn't exist

    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "work_type_id" in updates:
        _fetch_work_type_or_404(db, updates["work_type_id"])

    set_clause = ", ".join(f"{col} = :{col}" for col in updates)
    updates["entry_id"] = entry_id

    try:
        db.execute(
            text(f"UPDATE daily_kpi_entries SET {set_clause} WHERE entry_id = :entry_id"),
            updates,
        )
        db.commit()
        return {"status": "success", "data": _fetch_entry(db, entry_id)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update daily KPI entry {entry_id}: {e}")


@router.delete("/daily-kpi-entries/{entry_id}")
def delete_daily_kpi_entry(entry_id: int, db: Session = Depends(get_db)):
    _fetch_entry(db, entry_id)  # 404 early if it doesn't exist
    try:
        db.execute(
            text("DELETE FROM daily_kpi_entries WHERE entry_id = :entry_id"),
            {"entry_id": entry_id},
        )
        db.commit()
        return {"status": "success", "message": f"Daily KPI entry {entry_id} deleted"}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not delete daily KPI entry {entry_id}: {e}")
