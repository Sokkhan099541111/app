"""
CRUD API for `attendance` -- one row per employee per calendar day, the
"tick" system from the payroll workbook. This is what the frontend's
attendance calendar reads and writes one day at a time, and what
/api/payroll-report sums (via is_attended) to get Total Attended.

Table schema (see app/attendance.sql for the migration -- run it once
against app_hosting before using these endpoints; requires employees.sql and
payroll_periods.sql to have been run first):

    attendance_id       BIGINT UNSIGNED AUTO_INCREMENT PK
    employee_id           INT UNSIGNED             -- FK -> employees
    payroll_period_id     INT UNSIGNED             -- FK -> payroll_periods
    work_date               DATE
    status                   ENUM('1','0','H','L')  -- 1=Present 0=Absent H=Holiday L=Leave
    is_attended              TINYINT(1)   GENERATED (1 if status in ('1','H') else 0)
    created_at                TIMESTAMP

is_attended is a MySQL GENERATED column -- never set it directly in
INSERT/UPDATE.

Business rules:
  - Only one row per (employee_id, work_date) -- checked on create, 409 if
    taken (the frontend should PUT to that existing row's attendance_id
    instead of POSTing a second one for the same day).
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

class AttendanceIn(BaseModel):
    employee_id: int
    payroll_period_id: int
    work_date: date
    status: str = "1"  # '1' | '0' | 'H' | 'L'


class AttendanceUpdate(BaseModel):
    """All fields optional -- only columns actually sent get updated."""
    employee_id: Optional[int] = None
    payroll_period_id: Optional[int] = None
    work_date: Optional[date] = None
    status: Optional[str] = None


# --- Helpers -------------------------------------------------------------

def _row_to_dict(row) -> dict:
    return dict(row._mapping)


def _fetch_attendance(db: Session, attendance_id: int) -> dict:
    row = db.execute(
        text("SELECT * FROM attendance WHERE attendance_id = :attendance_id"),
        {"attendance_id": attendance_id},
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Attendance row {attendance_id} not found")
    return _row_to_dict(row)


def _duplicate_exists(db: Session, employee_id: int, work_date_, exclude_id: Optional[int] = None) -> bool:
    params: dict = {"employee_id": employee_id, "work_date": work_date_}
    exclude_clause = ""
    if exclude_id is not None:
        exclude_clause = "AND attendance_id != :exclude_id"
        params["exclude_id"] = exclude_id
    row = db.execute(
        text(
            f"""
            SELECT 1 FROM attendance
            WHERE employee_id = :employee_id AND work_date = :work_date
            {exclude_clause}
            LIMIT 1
            """
        ),
        params,
    ).first()
    return row is not None


# --- Routes --------------------------------------------------------------

@router.get("/attendance")
def list_attendance(
    employee_id: Optional[int] = Query(None, description="Filter by employee"),
    payroll_period_id: Optional[int] = Query(None, description="Filter by payroll period"),
    start: Optional[date] = Query(None, description="work_date range start (YYYY-MM-DD)"),
    end: Optional[date] = Query(None, description="work_date range end (YYYY-MM-DD)"),
    db: Session = Depends(get_db),
):
    """List attendance rows, optionally filtered by employee, payroll
    period, and/or a work_date range (all combine with AND)."""
    clauses, params = [], {}
    if employee_id is not None:
        clauses.append("employee_id = :employee_id")
        params["employee_id"] = employee_id
    if payroll_period_id is not None:
        clauses.append("payroll_period_id = :payroll_period_id")
        params["payroll_period_id"] = payroll_period_id
    if start is not None:
        clauses.append("work_date >= :start")
        params["start"] = start
    if end is not None:
        clauses.append("work_date <= :end")
        params["end"] = end

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    try:
        rows = db.execute(
            text(f"SELECT * FROM attendance {where} ORDER BY work_date ASC"),
            params,
        )
        return {"status": "success", "data": [_row_to_dict(r) for r in rows]}
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read attendance -- has attendance.sql been run yet? ({e})",
        )


@router.get("/attendance/{attendance_id}")
def get_attendance(attendance_id: int, db: Session = Depends(get_db)):
    return {"status": "success", "data": _fetch_attendance(db, attendance_id)}


@router.post("/attendance", status_code=201)
def create_attendance(payload: AttendanceIn, db: Session = Depends(get_db)):
    if payload.status == "1" and payload.work_date > date.today():
        raise HTTPException(
            status_code=400,
            detail="Can't mark a future date as Present before it arrives.",
        )
    if _duplicate_exists(db, payload.employee_id, payload.work_date):
        raise HTTPException(
            status_code=409,
            detail=(
                f"Attendance for this employee on {payload.work_date.isoformat()} already "
                "exists -- update that row instead of creating a new one."
            ),
        )
    try:
        result = db.execute(
            text(
                """
                INSERT INTO attendance
                    (employee_id, payroll_period_id, work_date, status)
                VALUES
                    (:employee_id, :payroll_period_id, :work_date, :status)
                """
            ),
            payload.model_dump(),
        )
        db.commit()
        return {"status": "success", "data": _fetch_attendance(db, result.lastrowid)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create attendance row: {e}")


@router.put("/attendance/{attendance_id}")
def update_attendance(attendance_id: int, payload: AttendanceUpdate, db: Session = Depends(get_db)):
    current = _fetch_attendance(db, attendance_id)  # 404 early if it doesn't exist

    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    effective_status = updates.get("status", current["status"])
    effective_work_date_for_check = updates.get("work_date", current["work_date"])
    if effective_status == "1" and effective_work_date_for_check > date.today():
        raise HTTPException(
            status_code=400,
            detail="Can't mark a future date as Present before it arrives.",
        )

    if "employee_id" in updates or "work_date" in updates:
        effective_employee_id = updates.get("employee_id", current["employee_id"])
        effective_work_date = updates.get("work_date", current["work_date"])
        if _duplicate_exists(db, effective_employee_id, effective_work_date, exclude_id=attendance_id):
            raise HTTPException(
                status_code=409,
                detail="Another attendance row already exists for this employee on that date.",
            )

    set_clause = ", ".join(f"{col} = :{col}" for col in updates)
    updates["attendance_id"] = attendance_id

    try:
        db.execute(
            text(f"UPDATE attendance SET {set_clause} WHERE attendance_id = :attendance_id"),
            updates,
        )
        db.commit()
        return {"status": "success", "data": _fetch_attendance(db, attendance_id)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update attendance row {attendance_id}: {e}")


@router.delete("/attendance/{attendance_id}")
def delete_attendance(attendance_id: int, db: Session = Depends(get_db)):
    """Hard delete -- removes the tick entirely (the frontend calendar
    treats a missing day as unmarked, not as any particular status)."""
    _fetch_attendance(db, attendance_id)  # 404 early if it doesn't exist
    try:
        db.execute(
            text("DELETE FROM attendance WHERE attendance_id = :attendance_id"),
            {"attendance_id": attendance_id},
        )
        db.commit()
        return {"status": "success", "message": f"Attendance row {attendance_id} deleted"}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not delete attendance row {attendance_id}: {e}")
