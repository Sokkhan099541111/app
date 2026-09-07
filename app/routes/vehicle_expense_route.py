"""
CRUD API for the Vehicle Expense module (see app/vehicle_expenses.sql --
run it once against app_hosting before using these endpoints).

Table schema:

    vendors
        vendor_id       INT UNSIGNED AUTO_INCREMENT PK
        name            VARCHAR(200)
        phone_number    VARCHAR(50)
        created_at / updated_at TIMESTAMP

    vehicle_expenses
        expense_id      BIGINT UNSIGNED AUTO_INCREMENT PK
        vehicles_id     INT NOT NULL            -- Wialon avl_unit id
        vendor_id       INT UNSIGNED NOT NULL   -- FK -> vendors
        expense_date    DATE NOT NULL
        category        ENUM('Repair Expenses / Maintenance Cost',
                              'Engine Oil, Pump & Brake', 'Diesel Fuel',
                              'Other Expense')
        amount          DECIMAL(12,2)   -- set to total_fuel_cost when both
                                        -- fuel inputs are supplied, so
                                        -- reports that SUM(amount) pick the
                                        -- fuel figure up automatically
        fuel_filling    DECIMAL(12,2)   -- litres; see
        amount_per_unit DECIMAL(12,4)   --   app/vehicle_expenses_add_fuel_filling.sql
        total_fuel_cost DECIMAL(12,2)   -- = fuel_filling * amount_per_unit
        remarks         VARCHAR(500)
        created_at / updated_at TIMESTAMP

Nothing else is stored -- Code and Plate Number are resolved live, exactly
like the Vehicle Rental and Daily KPI modules already do for vehicles_id-
based lookups (see app/routes/vehicle_rental_route.py):

  - Code comes from the Vehicle Unit API (the same Wialon fleet report GET
    /api/reports/vehicles already uses -- template_id=21).
  - Plate Number is the Wialon unit's name (nm).
  - Vendor Name + Phone Number are joined in from `vendors` by vendor_id.
"""
import time
from datetime import date, datetime
from enum import Enum
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
# / Daily KPI modules) already use -- column 1 of this report is the
# vehicle's Code.
FLEET_RESOURCE_ID = 601651347
FLEET_TEMPLATE_ID = 21


class ExpenseCategoryEnum(str, Enum):
    """Must stay in sync with the `category` ENUM on vehicle_expenses.

    Adding an option here alone is not enough -- the database column is an
    ENUM, so app/vehicle_expenses_add_other_category.sql has to be run
    before 'Other Expense' can actually be saved.
    """
    repair = "Repair Expenses / Maintenance Cost"
    engine_oil = "Engine Oil, Pump & Brake"
    diesel = "Diesel Fuel"
    other = "Other Expense"


# --- Request bodies ------------------------------------------------------

class VehicleExpenseIn(BaseModel):
    """A new expense.

    fuel_filling and amount_per_unit are the two inputs to
        Total Fuel Cost = Fuel Filling x Amount per Unit
    Both are constrained to zero or more -- negative litres or a negative
    price per litre are not meaningful, and would silently produce a
    negative expense that quietly reduces the fleet's total costs.

    total_fuel_cost is NOT accepted from the client. It is always derived
    server-side (see _fuel_totals) so the stored figure cannot disagree
    with its own inputs.
    """
    vehicles_id: int
    vendor_id: int
    expense_date: date
    category: ExpenseCategoryEnum
    amount: float = 0
    fuel_filling: Optional[float] = Field(None, ge=0)
    amount_per_unit: Optional[float] = Field(None, ge=0)
    remarks: Optional[str] = None


class VehicleExpenseUpdate(BaseModel):
    """All fields optional -- only columns actually sent get updated."""
    vehicles_id: Optional[int] = None
    vendor_id: Optional[int] = None
    expense_date: Optional[date] = None
    category: Optional[ExpenseCategoryEnum] = None
    amount: Optional[float] = None
    fuel_filling: Optional[float] = Field(None, ge=0)
    amount_per_unit: Optional[float] = Field(None, ge=0)
    remarks: Optional[str] = None


# --- Helpers ---------------------------------------------------------------

def _row_to_dict(row) -> dict:
    return dict(row._mapping)


ENTRY_SELECT = """
    SELECT
        x.expense_id, x.vehicles_id, x.vendor_id, x.expense_date,
        x.category, x.amount,
        x.fuel_filling, x.amount_per_unit, x.total_fuel_cost,
        x.remarks, x.created_at, x.updated_at,
        v.name AS vendor_name,
        v.phone_number AS vendor_phone
    FROM vehicle_expenses x
    JOIN vendors v ON v.vendor_id = x.vendor_id
"""


def _fetch_expense(db: Session, expense_id: int) -> dict:
    row = db.execute(
        text(f"{ENTRY_SELECT} WHERE x.expense_id = :expense_id"),
        {"expense_id": expense_id},
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Vehicle expense {expense_id} not found")
    return _row_to_dict(row)


def _resolve_expense_amounts(category, fuel_filling, amount_per_unit, amount) -> dict:
    """Decide what an expense actually costs, based on its CATEGORY.

    The entry form is category-conditional, and so is the stored shape:

      Diesel Fuel
        Fuel Filling and Amount per Unit are both required, and
            Total Fuel Cost = Fuel Filling x Amount per Unit
        The computed total also becomes `amount`. Every downstream report
        (Financial Report, Dashboard, expense list) sums `amount`, so
        writing the total there is what makes the fuel figure reach
        reporting instead of sitting in a column nothing reads.

      Every other category
        The fuel fields do not apply, so all three are stored as NULL and
        `amount` is taken as entered. Storing 0 instead of NULL would be a
        lie -- it would claim someone measured zero litres for a repair.

    Deciding this server-side (rather than trusting whatever the client
    sends) means the row can never end up self-contradictory: a repair with
    stray litres attached, or a diesel row whose total disagrees with its
    own inputs. Raises 400 rather than silently coercing bad input.

    Rounded to 2dp at the end only -- rounding the inputs first would drift
    the total on large litre counts.
    """
    is_diesel = category == ExpenseCategoryEnum.diesel.value

    if not is_diesel:
        if amount is None or float(amount) < 0:
            raise HTTPException(
                status_code=400,
                detail="Amount is required and cannot be negative for this expense category",
            )
        return {
            "fuel_filling": None,
            "amount_per_unit": None,
            "total_fuel_cost": None,
            "amount": float(amount),
        }

    if fuel_filling is None or amount_per_unit is None:
        raise HTTPException(
            status_code=400,
            detail="Fuel Filling and Amount per Unit are both required for a Diesel Fuel expense",
        )
    if float(fuel_filling) < 0 or float(amount_per_unit) < 0:
        raise HTTPException(
            status_code=400,
            detail="Fuel Filling and Amount per Unit cannot be negative",
        )

    total = round(float(fuel_filling) * float(amount_per_unit), 2)
    return {
        "fuel_filling": float(fuel_filling),
        "amount_per_unit": float(amount_per_unit),
        "total_fuel_cost": total,
        "amount": total,
    }


def _day_bounds_unix(day: date) -> tuple:
    """(start, end) unix timestamps covering one whole calendar day.

    Built from NAIVE datetimes so they resolve in the server's local
    timezone, exactly like snkrp_route._date_to_unix, which is what the
    Daily Machinery Operation Report uses.

    This matters: forcing UTC here (as this originally did) shifted the
    window by the server's UTC offset -- on a UTC+7 host, asking for
    31 Aug actually queried 31 Aug 07:00 through 1 Sep 06:59. The fuel
    figure then disagreed with the report for the same date, and days whose
    filling happened in the first 7 hours came back as 0.
    """
    start = int(datetime(day.year, day.month, day.day).timestamp())
    end = int(datetime(day.year, day.month, day.day, 23, 59, 59).timestamp())
    return start, end


def _fetch_vendor_or_404(db: Session, vendor_id: int) -> dict:
    row = db.execute(text("SELECT * FROM vendors WHERE vendor_id = :id"), {"id": vendor_id}).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Vendor {vendor_id} not found")
    return _row_to_dict(row)


def _enrich_with_vehicle_info(db: Session, company_id: int) -> dict:
    """{vehicles_id: {"plate_number", "code"}} pulled from the Vehicle Unit
    API (Wialon) -- returns {} on any failure so listing expenses never
    hard-fails just because Wialon is down; the frontend just shows blank
    Code/Plate Number cells."""
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
            }
        return result
    except Exception as e:
        print(f"DEBUG: vehicle expense enrichment (Code/Plate Number) failed: {e}")
        return {}


# --- Vehicle Expenses CRUD -------------------------------------------------

@router.get("/vehicle-expenses")
def list_vehicle_expenses(
    vehicles_id: Optional[int] = Query(None, description="Filter by vehicle"),
    vendor_id: Optional[int] = Query(None, description="Filter by vendor"),
    category: Optional[ExpenseCategoryEnum] = Query(None, description="Filter by category"),
    year: Optional[int] = Query(None, description="Filter by year (pair with month)"),
    month: Optional[int] = Query(None, ge=1, le=12, description="Filter by month (pair with year)"),
    start: Optional[date] = Query(None, description="expense_date range start (YYYY-MM-DD)"),
    end: Optional[date] = Query(None, description="expense_date range end (YYYY-MM-DD)"),
    company_id: int = Query(
        DEFAULT_COMPANY_ID, description="Company whose Wialon credentials to use for Code/Plate Number"
    ),
    db: Session = Depends(get_db),
):
    """List vehicle expenses, enriched with Code/Plate Number (from the
    Vehicle Unit API) and Vendor Name/Phone Number (joined from vendors)."""
    clauses, params = [], {}
    if vehicles_id is not None:
        clauses.append("x.vehicles_id = :vehicles_id")
        params["vehicles_id"] = vehicles_id
    if vendor_id is not None:
        clauses.append("x.vendor_id = :vendor_id")
        params["vendor_id"] = vendor_id
    if category is not None:
        clauses.append("x.category = :category")
        params["category"] = category.value
    if year is not None and month is not None:
        clauses.append("YEAR(x.expense_date) = :year AND MONTH(x.expense_date) = :month")
        params["year"] = year
        params["month"] = month
    if start is not None:
        clauses.append("x.expense_date >= :start")
        params["start"] = start
    if end is not None:
        clauses.append("x.expense_date <= :end")
        params["end"] = end
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    try:
        rows = db.execute(
            text(f"{ENTRY_SELECT} {where} ORDER BY x.expense_date DESC, x.expense_id DESC"),
            params,
        )
        expenses = [_row_to_dict(r) for r in rows]
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read vehicle_expenses -- has vehicle_expenses.sql been run yet? ({e})",
        )

    vehicle_info = _enrich_with_vehicle_info(db, company_id)
    for x in expenses:
        info = vehicle_info.get(x["vehicles_id"], {})
        x["plate_number"] = info.get("plate_number", "")
        x["code"] = info.get("code", "")

    return {"status": "success", "data": expenses}


@router.get("/vehicle-expenses/fuel-filling")
def get_fuel_filling(
    vehicles_id: int = Query(..., description="Wialon unit id of the selected vehicle"),
    expense_date: date = Query(..., description="Date to read fuel filling for (YYYY-MM-DD)"),
    company_id: int = Query(DEFAULT_COMPANY_ID, description="Company whose Wialon credentials to use"),
    db: Session = Depends(get_db),
):
    """Fuel Filling (litres) for one vehicle on one day, from the Units API.

    CONTRACT: `fuel_filling` is ALWAYS a number, never null and never an
    error status. Every failure path -- no unit group, vehicle absent from
    the report, unparseable value, Wialon unreachable -- returns 0.0 with
    HTTP 200. The form binds this straight into a numeric field, so a null
    or a 4xx/5xx would leave that field blank and the resulting expense
    would save with no cost at all. Returning 0 keeps the failure visible
    and harmless instead.

    `found` says WHY the number is what it is: false means "no reading
    available, this 0 is a fallback", true means "the API really did report
    this figure". The form uses it only for the hint text -- the value
    itself is applied either way.

    This is a STARTING POINT, not authoritative: the user can overwrite it,
    and whatever is in the form when they save is what gets stored. Metered
    litres and invoiced litres legitimately differ.
    """
    try:
        creds = get_wialon_credentials(db, company_id)
        service = WialonReportService(base_url=creds["base_url"])
        service.login(creds["wialon_token"])

        # Resolve the unit id -> name ACCOUNT-WIDE. The expense form's
        # vehicle dropdown is populated from /vehicle-logs/vehicle-options,
        # which uses get_all_units(); scoping this lookup to the first unit
        # group instead (as it originally did) meant every vehicle outside
        # that group was never found and silently returned 0 forever.
        all_units = service.get_all_units()
        unit = next((u for u in all_units if u.get("id") == vehicles_id), None)
        if not unit:
            return {"status": "success", "found": False, "fuel_filling": 0.0}

        # The fuel figures still come from the group-scoped fleet report --
        # that is where the template lives -- and are matched back to the
        # account-wide unit by normalized name, the same overlay the other
        # vehicle modules use.
        groups = service.get_objects()
        if not groups:
            return {"status": "success", "found": False, "fuel_filling": 0.0}
        group_id = groups[0].get("id")

        start, end = _day_bounds_unix(expense_date)
        report_rows = service.run_report(
            resource_id=FLEET_RESOURCE_ID,
            template_id=FLEET_TEMPLATE_ID,
            object_id=group_id,
            start=start,
            end=end,
        )
        metrics_by_name = service.parse_report_metrics_by_name(report_rows)
        metrics = metrics_by_name.get(service.normalize_name(unit.get("name")))
        if metrics is None:
            return {"status": "success", "found": False, "fuel_filling": 0.0}

        # Coerce defensively: the report cell is positionally parsed, so a
        # template change upstream could yield a string or None here. Any
        # non-numeric or negative reading degrades to 0.0 rather than
        # propagating something the numeric field cannot render.
        try:
            litres = float(metrics.get("fuelFilling") or 0.0)
        except (TypeError, ValueError):
            litres = 0.0
        if litres < 0:
            litres = 0.0

        return {
            "status": "success",
            "found": True,
            "fuel_filling": litres,
            "plate_number": unit.get("name") or "",
            "code": metrics.get("code", ""),
        }
    except Exception as e:  # noqa: BLE001
        # Never block expense entry on a Wialon outage -- the user can
        # always type the litres in by hand.
        print(f"DEBUG: fuel filling lookup failed: {e}")
        return {"status": "success", "found": False, "fuel_filling": 0.0}


@router.get("/vehicle-expenses/{expense_id}")
def get_vehicle_expense(expense_id: int, db: Session = Depends(get_db)):
    return {"status": "success", "data": _fetch_expense(db, expense_id)}


@router.post("/vehicle-expenses", status_code=201)
def create_vehicle_expense(payload: VehicleExpenseIn, db: Session = Depends(get_db)):
    _fetch_vendor_or_404(db, payload.vendor_id)

    params = payload.model_dump()
    # Total Fuel Cost is recomputed here, not taken from the request -- a
    # client that sent a stale or hand-edited total would otherwise write a
    # figure that contradicts its own fuel_filling / amount_per_unit.
    params.update(
        _resolve_expense_amounts(
            params["category"],
            params["fuel_filling"],
            params["amount_per_unit"],
            params["amount"],
        )
    )

    try:
        result = db.execute(
            text(
                """
                INSERT INTO vehicle_expenses
                    (vehicles_id, vendor_id, expense_date, category, amount,
                     fuel_filling, amount_per_unit, total_fuel_cost, remarks)
                VALUES
                    (:vehicles_id, :vendor_id, :expense_date, :category, :amount,
                     :fuel_filling, :amount_per_unit, :total_fuel_cost, :remarks)
                """
            ),
            params,
        )
        db.commit()
        return {"status": "success", "data": _fetch_expense(db, result.lastrowid)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create vehicle expense: {e}")


@router.put("/vehicle-expenses/{expense_id}")
def update_vehicle_expense(expense_id: int, payload: VehicleExpenseUpdate, db: Session = Depends(get_db)):
    current = _fetch_expense(db, expense_id)  # 404 early if it doesn't exist

    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "vendor_id" in updates:
        _fetch_vendor_or_404(db, updates["vendor_id"])

    # Re-resolve the amounts whenever the category or either fuel input
    # changes. Falling back to the STORED value for anything not sent means
    # editing just the price still yields a correct total, and switching a
    # row's category away from Diesel Fuel actively CLEARS its fuel columns
    # instead of leaving orphaned litres attached to a repair.
    touches_amounts = any(
        k in updates for k in ("category", "fuel_filling", "amount_per_unit", "amount")
    )
    if touches_amounts:
        category = updates.get("category", current.get("category"))
        fuel_filling = updates.get("fuel_filling", current.get("fuel_filling"))
        amount_per_unit = updates.get("amount_per_unit", current.get("amount_per_unit"))
        amount = updates.get("amount", current.get("amount"))
        updates.update(
            _resolve_expense_amounts(
                category,
                float(fuel_filling) if fuel_filling is not None else None,
                float(amount_per_unit) if amount_per_unit is not None else None,
                float(amount) if amount is not None else None,
            )
        )

    set_clause = ", ".join(f"{col} = :{col}" for col in updates)
    updates["expense_id"] = expense_id

    try:
        db.execute(
            text(f"UPDATE vehicle_expenses SET {set_clause} WHERE expense_id = :expense_id"),
            updates,
        )
        db.commit()
        return {"status": "success", "data": _fetch_expense(db, expense_id)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update vehicle expense {expense_id}: {e}")


@router.delete("/vehicle-expenses/{expense_id}")
def delete_vehicle_expense(expense_id: int, db: Session = Depends(get_db)):
    _fetch_expense(db, expense_id)  # 404 early if it doesn't exist
    try:
        db.execute(
            text("DELETE FROM vehicle_expenses WHERE expense_id = :expense_id"),
            {"expense_id": expense_id},
        )
        db.commit()
        return {"status": "success", "message": f"Vehicle expense {expense_id} deleted"}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not delete vehicle expense {expense_id}: {e}")
