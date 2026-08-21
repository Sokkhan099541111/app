"""
CRUD API for `payroll_periods` -- one row per calendar month processed for
payroll. start_date/end_date are computed here from period_year/period_month
(first and last day of that month) so the frontend only has to ask for a
year and a month, not four separate date fields.

Table schema (see app/payroll_periods.sql for the migration -- run it once
against app_hosting before using these endpoints):

    payroll_period_id   INT UNSIGNED AUTO_INCREMENT PK
    period_year           SMALLINT UNSIGNED
    period_month           TINYINT UNSIGNED
    start_date              DATE                      -- computed, see below
    end_date                DATE                      -- computed, see below
    total_working_days      TINYINT UNSIGNED   GENERATED (DAY(end_date))
    status                   ENUM('Open','Closed')
    created_at                TIMESTAMP

total_working_days is a MySQL GENERATED column -- never set it directly in
INSERT/UPDATE, it's what /api/payroll-report divides basic_salary by to get
Salary of per day.

Business rules:
  - Only one row per (period_year, period_month) -- checked on create/update,
    409 if taken.
  - DELETE is blocked with 409 if any attendance or payroll_entries rows
    still reference this period -- delete those first (or just leave the
    period as Closed instead of deleting it).
"""
import calendar
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config.database import get_db

router = APIRouter()


# --- Request bodies ----------------------------------------------------

class PayrollPeriodIn(BaseModel):
    period_year: int
    period_month: int  # 1-12
    status: str = "Open"  # 'Open' | 'Closed'


class PayrollPeriodUpdate(BaseModel):
    """All fields optional -- only columns actually sent get updated."""
    period_year: Optional[int] = None
    period_month: Optional[int] = None
    status: Optional[str] = None


# --- Helpers -------------------------------------------------------------

def _row_to_dict(row) -> dict:
    return dict(row._mapping)


def _month_bounds(period_year: int, period_month: int):
    if not 1 <= period_month <= 12:
        raise HTTPException(status_code=400, detail="period_month must be between 1 and 12")
    last_day = calendar.monthrange(period_year, period_month)[1]
    return date(period_year, period_month, 1), date(period_year, period_month, last_day)


def _fetch_period(db: Session, payroll_period_id: int) -> dict:
    row = db.execute(
        text("SELECT * FROM payroll_periods WHERE payroll_period_id = :payroll_period_id"),
        {"payroll_period_id": payroll_period_id},
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Payroll period {payroll_period_id} not found")
    return _row_to_dict(row)


def _duplicate_exists(
    db: Session, period_year: int, period_month: int, exclude_id: Optional[int] = None
) -> bool:
    params: dict = {"period_year": period_year, "period_month": period_month}
    exclude_clause = ""
    if exclude_id is not None:
        exclude_clause = "AND payroll_period_id != :exclude_id"
        params["exclude_id"] = exclude_id
    row = db.execute(
        text(
            f"""
            SELECT 1 FROM payroll_periods
            WHERE period_year = :period_year AND period_month = :period_month
            {exclude_clause}
            LIMIT 1
            """
        ),
        params,
    ).first()
    return row is not None


def _has_dependents(db: Session, payroll_period_id: int) -> bool:
    row = db.execute(
        text(
            """
            SELECT 1 FROM attendance WHERE payroll_period_id = :id
            UNION ALL
            SELECT 1 FROM payroll_entries WHERE payroll_period_id = :id
            LIMIT 1
            """
        ),
        {"id": payroll_period_id},
    ).first()
    return row is not None


# --- Routes --------------------------------------------------------------

@router.get("/payroll-periods")
def list_payroll_periods(
    period_year: Optional[int] = Query(None, description="Filter by year"),
    status: Optional[str] = Query(None, description="Filter by status: Open or Closed"),
    db: Session = Depends(get_db),
):
    clauses, params = [], {}
    if period_year is not None:
        clauses.append("period_year = :period_year")
        params["period_year"] = period_year
    if status is not None:
        clauses.append("status = :status")
        params["status"] = status
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    try:
        rows = db.execute(
            text(f"SELECT * FROM payroll_periods {where} ORDER BY period_year DESC, period_month DESC"),
            params,
        )
        return {"status": "success", "data": [_row_to_dict(r) for r in rows]}
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read payroll_periods -- has payroll_periods.sql been run yet? ({e})",
        )


@router.get("/payroll-periods/{payroll_period_id}")
def get_payroll_period(payroll_period_id: int, db: Session = Depends(get_db)):
    return {"status": "success", "data": _fetch_period(db, payroll_period_id)}


@router.post("/payroll-periods", status_code=201)
def create_payroll_period(payload: PayrollPeriodIn, db: Session = Depends(get_db)):
    if _duplicate_exists(db, payload.period_year, payload.period_month):
        raise HTTPException(
            status_code=409,
            detail=f"A payroll period already exists for {payload.period_year}-{payload.period_month:02d}.",
        )
    start_date, end_date = _month_bounds(payload.period_year, payload.period_month)
    try:
        result = db.execute(
            text(
                """
                INSERT INTO payroll_periods
                    (period_year, period_month, start_date, end_date, status)
                VALUES
                    (:period_year, :period_month, :start_date, :end_date, :status)
                """
            ),
            {
                "period_year": payload.period_year,
                "period_month": payload.period_month,
                "start_date": start_date,
                "end_date": end_date,
                "status": payload.status,
            },
        )
        db.commit()
        return {"status": "success", "data": _fetch_period(db, result.lastrowid)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create payroll period: {e}")


@router.put("/payroll-periods/{payroll_period_id}")
def update_payroll_period(
    payroll_period_id: int, payload: PayrollPeriodUpdate, db: Session = Depends(get_db)
):
    current = _fetch_period(db, payroll_period_id)  # 404 early if it doesn't exist

    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    effective_year = updates.get("period_year", current["period_year"])
    effective_month = updates.get("period_month", current["period_month"])

    if ("period_year" in updates or "period_month" in updates) and _duplicate_exists(
        db, effective_year, effective_month, exclude_id=payroll_period_id
    ):
        raise HTTPException(
            status_code=409,
            detail=f"A payroll period already exists for {effective_year}-{effective_month:02d}.",
        )

    if "period_year" in updates or "period_month" in updates:
        start_date, end_date = _month_bounds(effective_year, effective_month)
        updates["start_date"] = start_date
        updates["end_date"] = end_date

    set_clause = ", ".join(f"{col} = :{col}" for col in updates)
    updates["payroll_period_id"] = payroll_period_id

    try:
        db.execute(
            text(f"UPDATE payroll_periods SET {set_clause} WHERE payroll_period_id = :payroll_period_id"),
            updates,
        )
        db.commit()
        return {"status": "success", "data": _fetch_period(db, payroll_period_id)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update payroll period {payroll_period_id}: {e}")


@router.delete("/payroll-periods/{payroll_period_id}")
def delete_payroll_period(payroll_period_id: int, db: Session = Depends(get_db)):
    """
    Blocked with 409 if attendance or payroll_entries rows still reference
    this period -- delete those first, or just set status='Closed' instead
    of deleting the period outright.
    """
    _fetch_period(db, payroll_period_id)  # 404 early if it doesn't exist
    if _has_dependents(db, payroll_period_id):
        raise HTTPException(
            status_code=409,
            detail=(
                "This period still has attendance or payroll entry records. "
                "Delete those first, or set status to 'Closed' instead of deleting the period."
            ),
        )
    try:
        db.execute(
            text("DELETE FROM payroll_periods WHERE payroll_period_id = :payroll_period_id"),
            {"payroll_period_id": payroll_period_id},
        )
        db.commit()
        return {"status": "success", "message": f"Payroll period {payroll_period_id} deleted"}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not delete payroll period {payroll_period_id}: {e}")
