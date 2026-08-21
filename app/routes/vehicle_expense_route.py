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
                              'Engine Oil, Pump & Brake', 'Diesel Fuel')
        amount          DECIMAL(12,2)
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
from datetime import date
from enum import Enum
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
# / Daily KPI modules) already use -- column 1 of this report is the
# vehicle's Code.
FLEET_RESOURCE_ID = 601651347
FLEET_TEMPLATE_ID = 21


class ExpenseCategoryEnum(str, Enum):
    repair = "Repair Expenses / Maintenance Cost"
    engine_oil = "Engine Oil, Pump & Brake"
    diesel = "Diesel Fuel"


# --- Request bodies ------------------------------------------------------

class VehicleExpenseIn(BaseModel):
    vehicles_id: int
    vendor_id: int
    expense_date: date
    category: ExpenseCategoryEnum
    amount: float = 0
    remarks: Optional[str] = None


class VehicleExpenseUpdate(BaseModel):
    """All fields optional -- only columns actually sent get updated."""
    vehicles_id: Optional[int] = None
    vendor_id: Optional[int] = None
    expense_date: Optional[date] = None
    category: Optional[ExpenseCategoryEnum] = None
    amount: Optional[float] = None
    remarks: Optional[str] = None


# --- Helpers ---------------------------------------------------------------

def _row_to_dict(row) -> dict:
    return dict(row._mapping)


ENTRY_SELECT = """
    SELECT
        x.expense_id, x.vehicles_id, x.vendor_id, x.expense_date,
        x.category, x.amount, x.remarks, x.created_at, x.updated_at,
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


@router.get("/vehicle-expenses/{expense_id}")
def get_vehicle_expense(expense_id: int, db: Session = Depends(get_db)):
    return {"status": "success", "data": _fetch_expense(db, expense_id)}


@router.post("/vehicle-expenses", status_code=201)
def create_vehicle_expense(payload: VehicleExpenseIn, db: Session = Depends(get_db)):
    _fetch_vendor_or_404(db, payload.vendor_id)
    try:
        result = db.execute(
            text(
                """
                INSERT INTO vehicle_expenses
                    (vehicles_id, vendor_id, expense_date, category, amount, remarks)
                VALUES
                    (:vehicles_id, :vendor_id, :expense_date, :category, :amount, :remarks)
                """
            ),
            payload.model_dump(),
        )
        db.commit()
        return {"status": "success", "data": _fetch_expense(db, result.lastrowid)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create vehicle expense: {e}")


@router.put("/vehicle-expenses/{expense_id}")
def update_vehicle_expense(expense_id: int, payload: VehicleExpenseUpdate, db: Session = Depends(get_db)):
    _fetch_expense(db, expense_id)  # 404 early if it doesn't exist

    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "vendor_id" in updates:
        _fetch_vendor_or_404(db, updates["vendor_id"])

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
