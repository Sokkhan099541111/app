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
from pydantic import BaseModel, Field
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
    """A new Daily KPI entry.

    mileage / amount_per_km only apply when the vehicle's Wialon
    "Vehicle Group" custom field reads "Assigned" -- see
    _resolve_mileage_amounts, which enforces that server-side regardless of
    what the client sends. total_amount is never accepted from the client;
    it is always derived.
    """
    vehicles_id: int
    work_date: date
    work_type_id: int
    daily_productivity: float
    mileage: Optional[float] = Field(None, ge=0)
    amount_per_km: Optional[float] = Field(None, ge=0)
    remarks: Optional[str] = None


class DailyKpiUpdate(BaseModel):
    """All fields optional -- only columns actually sent get updated."""
    vehicles_id: Optional[int] = None
    work_date: Optional[date] = None
    work_type_id: Optional[int] = None
    daily_productivity: Optional[float] = None
    mileage: Optional[float] = Field(None, ge=0)
    amount_per_km: Optional[float] = Field(None, ge=0)
    remarks: Optional[str] = None


# Names the "Vehicle Group" custom field might carry in Wialon. Field
# names are account-specific, so several spellings are tried; add to this
# list if the field is named differently in your account (Wialon -> Units
# -> unit -> Custom fields).
VEHICLE_GROUP_FIELD_NAMES = (
    "vehicle group",
    "vehicles group",
    "vehicle_group",
    "vehiclegroup",
    "group",
)

# The one value that unlocks the mileage fields. Compared case- and
# whitespace-insensitively so "assigned", " Assigned" and "ASSIGNED" all
# work -- custom field values are free text and get typed by hand.
ASSIGNED_GROUP_VALUE = "assigned"


def is_assigned_group(vehicle_group) -> bool:
    """True only for an exact 'Assigned'. Note that 'Not Assigned' must NOT
    match, so this is an equality check and deliberately not a substring
    test -- 'assigned' in 'not assigned' would be True."""
    return str(vehicle_group or "").strip().lower() == ASSIGNED_GROUP_VALUE


# --- Helpers ---------------------------------------------------------------

def _row_to_dict(row) -> dict:
    return dict(row._mapping)


def _lookup_vehicle_group(db: Session, vehicles_id: int, company_id: int) -> Optional[str]:
    """The vehicle's "Vehicle Group" custom field value from Wialon.

    Returns None when the field is absent, empty, or the unit cannot be
    read. None is treated as NOT assigned by is_assigned_group(), which is
    the safe direction: a Wialon outage disables the mileage fields rather
    than silently enabling earnings on a vehicle that may not be on
    mileage terms.
    """
    try:
        creds = get_wialon_credentials(db, company_id)
        service = WialonReportService(base_url=creds["base_url"])
        service.login(creds["wialon_token"])

        # get_units_summary uses flags 1049, which includes custom fields
        # ("flds") and profile fields ("pflds") -- where the Vehicle Group
        # custom field lives.
        units = service.get_units_summary([vehicles_id])
        unit = next((u for u in units if u.get("id") == vehicles_id), None)
        if not unit:
            return None

        value = service.get_custom_field(unit, *VEHICLE_GROUP_FIELD_NAMES)
        return str(value).strip() or None
    except Exception as e:  # noqa: BLE001
        print(f"DEBUG: vehicle group lookup failed for unit {vehicles_id}: {e}")
        return None


MILEAGE_COLUMNS = ("mileage", "amount_per_km", "total_amount")


def has_mileage_columns(db: Session) -> bool:
    """True once app/daily_kpi_add_mileage_amount.sql has been run.

    Every query below is built around this so the module keeps working
    BEFORE the migration is applied: selecting a column that does not exist
    is a hard SQL error, which would 500 the whole Daily KPI list rather
    than just hiding one field. Probed per request (a trivial
    information_schema read next to the Wialon calls these endpoints
    already make) so the app picks the columns up as soon as the migration
    runs, with no restart.
    """
    try:
        row = db.execute(
            text(
                """
                SELECT COUNT(*) AS present
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = 'daily_kpi_entries'
                  AND COLUMN_NAME IN ('mileage', 'amount_per_km', 'total_amount')
                """
            )
        ).first()
        return int(row.present or 0) == len(MILEAGE_COLUMNS)
    except SQLAlchemyError as e:  # noqa: BLE001
        print(f"DEBUG: could not probe daily_kpi_entries columns: {e}")
        return False


def entry_select(with_mileage: bool) -> str:
    """ENTRY_SELECT, with the mileage columns swapped for literal NULLs
    when they do not exist yet. NULL is the right stand-in: it is exactly
    what an entry with no mileage terms stores anyway, so _with_kpi and the
    frontend both handle it without a special case."""
    mileage_cols = (
        "e.mileage, e.amount_per_km, e.total_amount,"
        if with_mileage
        else "NULL AS mileage, NULL AS amount_per_km, NULL AS total_amount,"
    )
    return f"""
    SELECT
        e.entry_id, e.vehicles_id, e.work_date, e.work_type_id,
        e.daily_productivity,
        {mileage_cols}
        e.remarks, e.created_at, e.updated_at,
        f.description AS work_type_description,
        f.quantity AS quantity,
        f.unit AS unit,
        f.unit_price AS rate_per_unit
    FROM daily_kpi_entries e
    JOIN formulas f ON f.formula_id = e.work_type_id
"""


def _with_kpi(row: dict) -> dict:
    """Daily KPI = the work-type KPI, plus the mileage-based Total Amount.

        work_type_kpi = LEAST(quantity, daily_productivity) * unit_price
        Daily KPI     = work_type_kpi + total_amount

    total_amount is NULL for every vehicle that is not "Assigned" (and for
    every entry created before this feature existed), and NULL contributes
    nothing -- so historical rows report exactly the KPI they always did.

    Both components are returned separately as well, so the entry screen
    can show how the figure was reached instead of just a total.
    """
    quantity = float(row.get("quantity") or 0)
    productivity = float(row.get("daily_productivity") or 0)
    rate = float(row.get("rate_per_unit") or 0)
    effective = quantity if quantity < productivity else productivity

    work_type_kpi = round(effective * rate, 2)
    total_amount = float(row.get("total_amount") or 0)

    row["work_type_kpi"] = work_type_kpi
    row["kpi"] = round(work_type_kpi + total_amount, 2)
    return row


def _resolve_mileage_amounts(vehicle_group, mileage, amount_per_km) -> dict:
    """Decide what the mileage fields are worth, based on Vehicle Group.

      Vehicle Group = "Assigned"
        mileage and amount_per_km are kept, and
            Total Amount = Mileage x Amount per KM
        A missing half is treated as 0 rather than rejected -- an assigned
        vehicle that genuinely drove nothing that day is a real entry.

      Anything else (including NULL / "Not Assigned" / unreadable)
        All three are forced to NULL. The fields are disabled in the UI for
        these vehicles, so a value arriving here means either a stale form
        or a direct API call -- neither should be able to attach mileage
        earnings to a vehicle that is not on mileage terms.
    """
    if not is_assigned_group(vehicle_group):
        return {"mileage": None, "amount_per_km": None, "total_amount": None}

    km = float(mileage or 0)
    rate = float(amount_per_km or 0)
    return {
        "mileage": km,
        "amount_per_km": rate,
        "total_amount": round(km * rate, 2),
    }


def _fetch_entry(db: Session, entry_id: int) -> dict:
    row = db.execute(
        text(f"{entry_select(has_mileage_columns(db))} WHERE e.entry_id = :entry_id"),
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
    # start_date/end_date are the filter the UI now uses. year/month are kept
    # so existing Dashboard drill-down links keep working; if both are sent,
    # the date range wins.
    start_date: Optional[date] = Query(None, description="Filter from this work date (inclusive)"),
    end_date: Optional[date] = Query(None, description="Filter to this work date (inclusive)"),
    year: Optional[int] = Query(None, description="Deprecated: use start_date/end_date"),
    month: Optional[int] = Query(None, ge=1, le=12, description="Deprecated: use start_date/end_date"),
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
    if start_date is not None or end_date is not None:
        if start_date is not None:
            clauses.append("e.work_date >= :start_date")
            params["start_date"] = start_date
        if end_date is not None:
            clauses.append("e.work_date <= :end_date")
            params["end_date"] = end_date
    elif year is not None and month is not None:
        clauses.append("YEAR(e.work_date) = :year AND MONTH(e.work_date) = :month")
        params["year"] = year
        params["month"] = month
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    try:
        rows = db.execute(
            text(f"{entry_select(has_mileage_columns(db))} {where} ORDER BY e.work_date DESC, e.entry_id DESC"),
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


@router.get("/daily-kpi-entries/vehicle-group")
def get_vehicle_group(
    vehicles_id: int = Query(..., description="Wialon unit id of the selected vehicle"),
    company_id: int = Query(DEFAULT_COMPANY_ID, description="Company whose Wialon credentials to use"),
    db: Session = Depends(get_db),
):
    """The selected vehicle's "Vehicle Group" custom field.

    Drives whether Mileage / Amount per KM / Total Amount are enabled on
    the Daily KPI entry form. Declared ABOVE /{entry_id} deliberately --
    FastAPI matches routes in order, so the reverse would make this path
    resolve as an entry lookup with entry_id="vehicle-group".

    Always HTTP 200: an unreadable or missing field returns
    vehicle_group=null with is_assigned=false, which disables the fields.
    Failing closed is the safe direction here.
    """
    vehicle_group = _lookup_vehicle_group(db, vehicles_id, company_id)
    return {
        "status": "success",
        "vehicles_id": vehicles_id,
        "vehicle_group": vehicle_group,
        "is_assigned": is_assigned_group(vehicle_group),
    }


@router.get("/daily-kpi-entries/{entry_id}")
def get_daily_kpi_entry(entry_id: int, db: Session = Depends(get_db)):
    return {"status": "success", "data": _fetch_entry(db, entry_id)}


@router.post("/daily-kpi-entries", status_code=201)
def create_daily_kpi_entry(payload: DailyKpiIn, db: Session = Depends(get_db)):
    _fetch_work_type_or_404(db, payload.work_type_id)

    params = payload.model_dump()
    with_mileage = has_mileage_columns(db)

    if with_mileage:
        # The Vehicle Group is read from Wialon here rather than trusted
        # from the request -- the client cannot grant itself mileage
        # earnings by posting them for an unassigned vehicle.
        vehicle_group = _lookup_vehicle_group(db, payload.vehicles_id, DEFAULT_COMPANY_ID)
        params.update(
            _resolve_mileage_amounts(vehicle_group, params["mileage"], params["amount_per_km"])
        )
        columns = """
                    (vehicles_id, work_date, work_type_id, daily_productivity,
                     mileage, amount_per_km, total_amount, remarks)
                VALUES
                    (:vehicles_id, :work_date, :work_type_id, :daily_productivity,
                     :mileage, :amount_per_km, :total_amount, :remarks)"""
    else:
        # Pre-migration: save the entry without the mileage fields rather
        # than refusing the whole thing. The user is told below.
        for key in MILEAGE_COLUMNS:
            params.pop(key, None)
        columns = """
                    (vehicles_id, work_date, work_type_id, daily_productivity, remarks)
                VALUES
                    (:vehicles_id, :work_date, :work_type_id, :daily_productivity, :remarks)"""

    try:
        result = db.execute(
            text(f"INSERT INTO daily_kpi_entries {columns}"),
            params,
        )
        db.commit()
        return {"status": "success", "data": _fetch_entry(db, result.lastrowid)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create daily KPI entry: {e}")


@router.put("/daily-kpi-entries/{entry_id}")
def update_daily_kpi_entry(entry_id: int, payload: DailyKpiUpdate, db: Session = Depends(get_db)):
    current = _fetch_entry(db, entry_id)  # 404 early if it doesn't exist

    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "work_type_id" in updates:
        _fetch_work_type_or_404(db, updates["work_type_id"])

    # Re-resolve whenever the vehicle or either mileage input changes.
    # Changing the vehicle matters as much as the numbers: moving an entry
    # onto an unassigned vehicle must clear the mileage figures rather than
    # leave them attached to a vehicle that is not on mileage terms.
    if not has_mileage_columns(db):
        # Pre-migration: drop the mileage fields so the rest of the edit
        # still saves instead of erroring on unknown columns.
        for key in MILEAGE_COLUMNS:
            updates.pop(key, None)
        if not updates:
            raise HTTPException(status_code=400, detail="No fields to update")
    elif any(k in updates for k in ("vehicles_id", "mileage", "amount_per_km")):
        effective_vehicle_id = updates.get("vehicles_id", current["vehicles_id"])
        vehicle_group = _lookup_vehicle_group(db, effective_vehicle_id, DEFAULT_COMPANY_ID)
        updates.update(
            _resolve_mileage_amounts(
                vehicle_group,
                updates.get("mileage", current.get("mileage")),
                updates.get("amount_per_km", current.get("amount_per_km")),
            )
        )

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
