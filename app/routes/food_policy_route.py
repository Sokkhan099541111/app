"""
CRUD API for `food_policy_history` -- the company-wide "Basic of Food"
monthly allowance, kept as a dated history. /api/payroll-report reads the
most recent row on or before a payroll period's start_date, so past periods
keep computing with the rate that was in effect at the time even after the
company changes it.

Table schema (see app/food_policy_history.sql for the migration -- run it
once against app_hosting before using these endpoints):

    food_policy_id     INT UNSIGNED AUTO_INCREMENT PK
    effective_date      DATE
    basic_food_amount    DECIMAL(12,2)
    note                 VARCHAR(255)
    updated_by            VARCHAR(100)
    created_at             TIMESTAMP

Business rules:
  - Only one row per effective_date -- checked on create/update, 409 if
    taken.
"""
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config.database import get_db

router = APIRouter()


# --- Request bodies ----------------------------------------------------

class FoodPolicyIn(BaseModel):
    effective_date: date
    basic_food_amount: float
    note: Optional[str] = None
    updated_by: Optional[str] = None


class FoodPolicyUpdate(BaseModel):
    """All fields optional -- only columns actually sent get updated."""
    effective_date: Optional[date] = None
    basic_food_amount: Optional[float] = None
    note: Optional[str] = None
    updated_by: Optional[str] = None


# --- Helpers -------------------------------------------------------------

def _row_to_dict(row) -> dict:
    return dict(row._mapping)


def _fetch_policy(db: Session, food_policy_id: int) -> dict:
    row = db.execute(
        text("SELECT * FROM food_policy_history WHERE food_policy_id = :food_policy_id"),
        {"food_policy_id": food_policy_id},
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Food policy row {food_policy_id} not found")
    return _row_to_dict(row)


def _duplicate_exists(db: Session, effective_date_, exclude_id: Optional[int] = None) -> bool:
    params: dict = {"effective_date": effective_date_}
    exclude_clause = ""
    if exclude_id is not None:
        exclude_clause = "AND food_policy_id != :exclude_id"
        params["exclude_id"] = exclude_id
    row = db.execute(
        text(
            f"SELECT 1 FROM food_policy_history WHERE effective_date = :effective_date {exclude_clause} LIMIT 1"
        ),
        params,
    ).first()
    return row is not None


# --- Routes --------------------------------------------------------------

@router.get("/food-policy")
def list_food_policy(db: Session = Depends(get_db)):
    """List every food allowance rate change, most recent first."""
    try:
        rows = db.execute(text("SELECT * FROM food_policy_history ORDER BY effective_date DESC"))
        return {"status": "success", "data": [_row_to_dict(r) for r in rows]}
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read food_policy_history -- has food_policy_history.sql been run yet? ({e})",
        )


@router.get("/food-policy/{food_policy_id}")
def get_food_policy(food_policy_id: int, db: Session = Depends(get_db)):
    return {"status": "success", "data": _fetch_policy(db, food_policy_id)}


@router.post("/food-policy", status_code=201)
def create_food_policy(payload: FoodPolicyIn, db: Session = Depends(get_db)):
    if _duplicate_exists(db, payload.effective_date):
        raise HTTPException(
            status_code=409,
            detail=f"A food policy row already exists effective {payload.effective_date.isoformat()}.",
        )
    try:
        result = db.execute(
            text(
                """
                INSERT INTO food_policy_history
                    (effective_date, basic_food_amount, note, updated_by)
                VALUES
                    (:effective_date, :basic_food_amount, :note, :updated_by)
                """
            ),
            payload.model_dump(),
        )
        db.commit()
        return {"status": "success", "data": _fetch_policy(db, result.lastrowid)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create food policy row: {e}")


@router.put("/food-policy/{food_policy_id}")
def update_food_policy(food_policy_id: int, payload: FoodPolicyUpdate, db: Session = Depends(get_db)):
    _fetch_policy(db, food_policy_id)  # 404 early if it doesn't exist

    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "effective_date" in updates and _duplicate_exists(
        db, updates["effective_date"], exclude_id=food_policy_id
    ):
        raise HTTPException(
            status_code=409,
            detail=f"A food policy row already exists effective {updates['effective_date'].isoformat()}.",
        )

    set_clause = ", ".join(f"{col} = :{col}" for col in updates)
    updates["food_policy_id"] = food_policy_id

    try:
        db.execute(
            text(f"UPDATE food_policy_history SET {set_clause} WHERE food_policy_id = :food_policy_id"),
            updates,
        )
        db.commit()
        return {"status": "success", "data": _fetch_policy(db, food_policy_id)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update food policy row {food_policy_id}: {e}")


@router.delete("/food-policy/{food_policy_id}")
def delete_food_policy(food_policy_id: int, db: Session = Depends(get_db)):
    """Hard delete -- this table is itself an audit log, so removing a
    mistaken entry outright (rather than soft-deleting) is fine."""
    _fetch_policy(db, food_policy_id)  # 404 early if it doesn't exist
    try:
        db.execute(
            text("DELETE FROM food_policy_history WHERE food_policy_id = :food_policy_id"),
            {"food_policy_id": food_policy_id},
        )
        db.commit()
        return {"status": "success", "message": f"Food policy row {food_policy_id} deleted"}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not delete food policy row {food_policy_id}: {e}")
