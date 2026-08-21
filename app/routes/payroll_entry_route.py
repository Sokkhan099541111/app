"""
CRUD API for `payroll_entries` -- the handful of values entered manually
once per employee per payroll period: OT hours/amount and the other
allowance. Everything else in a payslip (salary/day, total amount, food
daily, total salary daily) is computed by /api/payroll-report from this
table plus employees, attendance, and food_policy_history.

Table schema (see app/payroll_entries.sql for the migration -- run it once
against app_hosting before using these endpoints; requires employees.sql and
payroll_periods.sql to have been run first):

    payroll_entry_id      INT UNSIGNED AUTO_INCREMENT PK
    employee_id             INT UNSIGNED           -- FK -> employees
    payroll_period_id       INT UNSIGNED           -- FK -> payroll_periods
    ot_hours                  DECIMAL(6,2)
    ot_amount                  DECIMAL(12,2)
    other_allowance             DECIMAL(12,2)         -- "Basic of Other Allowance"
    notes                       VARCHAR(255)
    created_at                    TIMESTAMP
    updated_at                    TIMESTAMP

Business rules:
  - Only one row per (employee_id, payroll_period_id) -- checked on
    create/update, 409 if taken.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config.database import get_db

router = APIRouter()


# --- Request bodies ----------------------------------------------------

class PayrollEntryIn(BaseModel):
    employee_id: int
    payroll_period_id: int
    ot_hours: float = 0
    ot_amount: float = 0
    other_allowance: float = 0
    notes: Optional[str] = None


class PayrollEntryUpdate(BaseModel):
    """All fields optional -- only columns actually sent get updated."""
    employee_id: Optional[int] = None
    payroll_period_id: Optional[int] = None
    ot_hours: Optional[float] = None
    ot_amount: Optional[float] = None
    other_allowance: Optional[float] = None
    notes: Optional[str] = None


# --- Helpers -------------------------------------------------------------

def _row_to_dict(row) -> dict:
    return dict(row._mapping)


def _fetch_entry(db: Session, payroll_entry_id: int) -> dict:
    row = db.execute(
        text("SELECT * FROM payroll_entries WHERE payroll_entry_id = :payroll_entry_id"),
        {"payroll_entry_id": payroll_entry_id},
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Payroll entry {payroll_entry_id} not found")
    return _row_to_dict(row)


def _duplicate_exists(
    db: Session, employee_id: int, payroll_period_id: int, exclude_id: Optional[int] = None
) -> bool:
    params: dict = {"employee_id": employee_id, "payroll_period_id": payroll_period_id}
    exclude_clause = ""
    if exclude_id is not None:
        exclude_clause = "AND payroll_entry_id != :exclude_id"
        params["exclude_id"] = exclude_id
    row = db.execute(
        text(
            f"""
            SELECT 1 FROM payroll_entries
            WHERE employee_id = :employee_id AND payroll_period_id = :payroll_period_id
            {exclude_clause}
            LIMIT 1
            """
        ),
        params,
    ).first()
    return row is not None


# --- Routes --------------------------------------------------------------

@router.get("/payroll-entries")
def list_payroll_entries(
    employee_id: Optional[int] = Query(None, description="Filter by employee"),
    payroll_period_id: Optional[int] = Query(None, description="Filter by payroll period"),
    db: Session = Depends(get_db),
):
    clauses, params = [], {}
    if employee_id is not None:
        clauses.append("employee_id = :employee_id")
        params["employee_id"] = employee_id
    if payroll_period_id is not None:
        clauses.append("payroll_period_id = :payroll_period_id")
        params["payroll_period_id"] = payroll_period_id
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    try:
        rows = db.execute(
            text(f"SELECT * FROM payroll_entries {where} ORDER BY payroll_entry_id DESC"),
            params,
        )
        return {"status": "success", "data": [_row_to_dict(r) for r in rows]}
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read payroll_entries -- has payroll_entries.sql been run yet? ({e})",
        )


@router.get("/payroll-entries/{payroll_entry_id}")
def get_payroll_entry(payroll_entry_id: int, db: Session = Depends(get_db)):
    return {"status": "success", "data": _fetch_entry(db, payroll_entry_id)}


@router.post("/payroll-entries", status_code=201)
def create_payroll_entry(payload: PayrollEntryIn, db: Session = Depends(get_db)):
    if _duplicate_exists(db, payload.employee_id, payload.payroll_period_id):
        raise HTTPException(
            status_code=409,
            detail="This employee already has a payroll entry for that period -- edit it instead.",
        )
    try:
        result = db.execute(
            text(
                """
                INSERT INTO payroll_entries
                    (employee_id, payroll_period_id, ot_hours, ot_amount, other_allowance, notes)
                VALUES
                    (:employee_id, :payroll_period_id, :ot_hours, :ot_amount, :other_allowance, :notes)
                """
            ),
            payload.model_dump(),
        )
        db.commit()
        return {"status": "success", "data": _fetch_entry(db, result.lastrowid)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create payroll entry: {e}")


@router.put("/payroll-entries/{payroll_entry_id}")
def update_payroll_entry(
    payroll_entry_id: int, payload: PayrollEntryUpdate, db: Session = Depends(get_db)
):
    current = _fetch_entry(db, payroll_entry_id)  # 404 early if it doesn't exist

    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "employee_id" in updates or "payroll_period_id" in updates:
        effective_employee_id = updates.get("employee_id", current["employee_id"])
        effective_period_id = updates.get("payroll_period_id", current["payroll_period_id"])
        if _duplicate_exists(db, effective_employee_id, effective_period_id, exclude_id=payroll_entry_id):
            raise HTTPException(
                status_code=409,
                detail="This employee already has a payroll entry for that period -- edit it instead.",
            )

    set_clause = ", ".join(f"{col} = :{col}" for col in updates)
    updates["payroll_entry_id"] = payroll_entry_id

    try:
        db.execute(
            text(f"UPDATE payroll_entries SET {set_clause} WHERE payroll_entry_id = :payroll_entry_id"),
            updates,
        )
        db.commit()
        return {"status": "success", "data": _fetch_entry(db, payroll_entry_id)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update payroll entry {payroll_entry_id}: {e}")


@router.delete("/payroll-entries/{payroll_entry_id}")
def delete_payroll_entry(payroll_entry_id: int, db: Session = Depends(get_db)):
    """Hard delete -- payroll_entries has no soft-delete flag; delete it
    and re-create when the correction is more than a field edit."""
    _fetch_entry(db, payroll_entry_id)  # 404 early if it doesn't exist
    try:
        db.execute(
            text("DELETE FROM payroll_entries WHERE payroll_entry_id = :payroll_entry_id"),
            {"payroll_entry_id": payroll_entry_id},
        )
        db.commit()
        return {"status": "success", "message": f"Payroll entry {payroll_entry_id} deleted"}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not delete payroll entry {payroll_entry_id}: {e}")
