"""
CRUD API for `employee_salary_history` -- the dated audit trail of every
basic_salary change for an employee. /api/payroll-report reads the most
recent row on or before a payroll period's start_date (falling back to
employees.basic_salary if no history row exists yet) so past periods keep
computing with the rate that was actually in effect at the time.

Table schema (see app/employee_salary_history.sql for the migration -- run
it once against app_hosting before using these endpoints):

    salary_history_id  INT UNSIGNED AUTO_INCREMENT PK
    employee_id         INT UNSIGNED                     -- FK -> employees
    basic_salary         DECIMAL(12,2)
    effective_date       DATE
    note                 VARCHAR(255)
    created_at            TIMESTAMP

Business rules:
  - Only one row per (employee_id, effective_date) -- checked on
    create/update, 409 if taken.
"""
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

class SalaryHistoryIn(BaseModel):
    employee_id: int
    basic_salary: float
    effective_date: date
    note: Optional[str] = None


class SalaryHistoryUpdate(BaseModel):
    """All fields optional -- only columns actually sent get updated."""
    employee_id: Optional[int] = None
    basic_salary: Optional[float] = None
    effective_date: Optional[date] = None
    note: Optional[str] = None


# --- Helpers -------------------------------------------------------------

def _row_to_dict(row) -> dict:
    return dict(row._mapping)


def _fetch_history(db: Session, salary_history_id: int) -> dict:
    row = db.execute(
        text("SELECT * FROM employee_salary_history WHERE salary_history_id = :salary_history_id"),
        {"salary_history_id": salary_history_id},
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Salary history row {salary_history_id} not found")
    return _row_to_dict(row)


def _duplicate_exists(
    db: Session, employee_id: int, effective_date_, exclude_id: Optional[int] = None
) -> bool:
    params: dict = {"employee_id": employee_id, "effective_date": effective_date_}
    exclude_clause = ""
    if exclude_id is not None:
        exclude_clause = "AND salary_history_id != :exclude_id"
        params["exclude_id"] = exclude_id
    row = db.execute(
        text(
            f"""
            SELECT 1 FROM employee_salary_history
            WHERE employee_id = :employee_id AND effective_date = :effective_date
            {exclude_clause}
            LIMIT 1
            """
        ),
        params,
    ).first()
    return row is not None


# --- Routes --------------------------------------------------------------

@router.get("/salary-history")
def list_salary_history(
    employee_id: Optional[int] = Query(None, description="Filter by employee"),
    db: Session = Depends(get_db),
):
    """List salary history rows, optionally filtered by employee, most
    recent effective_date first."""
    clauses, params = [], {}
    if employee_id is not None:
        clauses.append("employee_id = :employee_id")
        params["employee_id"] = employee_id
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    try:
        rows = db.execute(
            text(f"SELECT * FROM employee_salary_history {where} ORDER BY effective_date DESC"),
            params,
        )
        return {"status": "success", "data": [_row_to_dict(r) for r in rows]}
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read employee_salary_history -- has employee_salary_history.sql been run yet? ({e})",
        )


@router.get("/salary-history/{salary_history_id}")
def get_salary_history(salary_history_id: int, db: Session = Depends(get_db)):
    return {"status": "success", "data": _fetch_history(db, salary_history_id)}


@router.post("/salary-history", status_code=201)
def create_salary_history(payload: SalaryHistoryIn, db: Session = Depends(get_db)):
    if _duplicate_exists(db, payload.employee_id, payload.effective_date):
        raise HTTPException(
            status_code=409,
            detail="This employee already has a salary history row effective on that date.",
        )
    try:
        result = db.execute(
            text(
                """
                INSERT INTO employee_salary_history
                    (employee_id, basic_salary, effective_date, note)
                VALUES
                    (:employee_id, :basic_salary, :effective_date, :note)
                """
            ),
            payload.model_dump(),
        )
        db.commit()
        return {"status": "success", "data": _fetch_history(db, result.lastrowid)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create salary history row: {e}")


@router.put("/salary-history/{salary_history_id}")
def update_salary_history(
    salary_history_id: int, payload: SalaryHistoryUpdate, db: Session = Depends(get_db)
):
    current = _fetch_history(db, salary_history_id)  # 404 early if it doesn't exist

    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "employee_id" in updates or "effective_date" in updates:
        effective_employee_id = updates.get("employee_id", current["employee_id"])
        effective_date_ = updates.get("effective_date", current["effective_date"])
        if _duplicate_exists(db, effective_employee_id, effective_date_, exclude_id=salary_history_id):
            raise HTTPException(
                status_code=409,
                detail="This employee already has a salary history row effective on that date.",
            )

    set_clause = ", ".join(f"{col} = :{col}" for col in updates)
    updates["salary_history_id"] = salary_history_id

    try:
        db.execute(
            text(f"UPDATE employee_salary_history SET {set_clause} WHERE salary_history_id = :salary_history_id"),
            updates,
        )
        db.commit()
        return {"status": "success", "data": _fetch_history(db, salary_history_id)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update salary history row {salary_history_id}: {e}")


@router.delete("/salary-history/{salary_history_id}")
def delete_salary_history(salary_history_id: int, db: Session = Depends(get_db)):
    """Hard delete -- this table is itself an audit log, so removing a
    mistaken entry outright (rather than soft-deleting) is fine."""
    _fetch_history(db, salary_history_id)  # 404 early if it doesn't exist
    try:
        db.execute(
            text("DELETE FROM employee_salary_history WHERE salary_history_id = :salary_history_id"),
            {"salary_history_id": salary_history_id},
        )
        db.commit()
        return {"status": "success", "message": f"Salary history row {salary_history_id} deleted"}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not delete salary history row {salary_history_id}: {e}")
