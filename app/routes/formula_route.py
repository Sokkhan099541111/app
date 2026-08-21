"""
CRUD API for `formulas` -- a master reference list of cost-estimate line
items (see app/formulas.sql), matching the uploaded Bill of Quantities
template: No, Description, Unit, Distance, Unit Price, Quantity.

Table schema:

    formula_id      INT UNSIGNED AUTO_INCREMENT PK
    description     VARCHAR(500)
    unit            VARCHAR(50)
    distance        VARCHAR(100)            -- optional, free text
    unit_price      DECIMAL(12,2)
    quantity        DECIMAL(12,2)
    created_at      TIMESTAMP
    updated_at      TIMESTAMP

Business rules:
  - Amount (Unit Price x Quantity) is computed on every response, not
    stored -- so it's always correct after an edit.
  - No dependents/foreign keys elsewhere in the schema reference this table
    yet, so DELETE is a straightforward hard delete.
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

class FormulaIn(BaseModel):
    description: str
    unit: str
    distance: Optional[str] = None
    unit_price: float = 0
    quantity: float = 0


class FormulaUpdate(BaseModel):
    """All fields optional -- only columns actually sent get updated."""
    description: Optional[str] = None
    unit: Optional[str] = None
    distance: Optional[str] = None
    unit_price: Optional[float] = None
    quantity: Optional[float] = None


# --- Helpers -------------------------------------------------------------

def _row_to_dict(row) -> dict:
    d = dict(row._mapping)
    d["amount"] = float(d.get("unit_price") or 0) * float(d.get("quantity") or 0)
    return d


def _fetch_formula(db: Session, formula_id: int) -> dict:
    row = db.execute(
        text("SELECT * FROM formulas WHERE formula_id = :formula_id"),
        {"formula_id": formula_id},
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Formula {formula_id} not found")
    return _row_to_dict(row)


# --- Routes --------------------------------------------------------------

@router.get("/formulas")
def list_formulas(
    search: Optional[str] = Query(None, description="Filter by description (partial match)"),
    sort_by: str = Query("formula_id", description="Column to sort by"),
    sort_dir: str = Query("asc", description="asc or desc"),
    db: Session = Depends(get_db),
):
    allowed_sort = {"formula_id", "description", "unit", "unit_price", "quantity", "created_at"}
    if sort_by not in allowed_sort:
        sort_by = "formula_id"
    sort_dir = "DESC" if str(sort_dir).lower() == "desc" else "ASC"

    clauses, params = [], {}
    if search:
        clauses.append("description LIKE :search")
        params["search"] = f"%{search}%"
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    try:
        rows = db.execute(
            text(f"SELECT * FROM formulas {where} ORDER BY {sort_by} {sort_dir}"),
            params,
        )
        return {"status": "success", "data": [_row_to_dict(r) for r in rows]}
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read formulas -- has formulas.sql been run yet? ({e})",
        )


@router.get("/formulas/{formula_id}")
def get_formula(formula_id: int, db: Session = Depends(get_db)):
    return {"status": "success", "data": _fetch_formula(db, formula_id)}


@router.post("/formulas", status_code=201)
def create_formula(payload: FormulaIn, db: Session = Depends(get_db)):
    try:
        result = db.execute(
            text(
                """
                INSERT INTO formulas (description, unit, distance, unit_price, quantity)
                VALUES (:description, :unit, :distance, :unit_price, :quantity)
                """
            ),
            payload.model_dump(),
        )
        db.commit()
        return {"status": "success", "data": _fetch_formula(db, result.lastrowid)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create formula: {e}")


@router.put("/formulas/{formula_id}")
def update_formula(formula_id: int, payload: FormulaUpdate, db: Session = Depends(get_db)):
    _fetch_formula(db, formula_id)  # 404 early if it doesn't exist

    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    set_clause = ", ".join(f"{col} = :{col}" for col in updates)
    updates["formula_id"] = formula_id

    try:
        db.execute(
            text(f"UPDATE formulas SET {set_clause} WHERE formula_id = :formula_id"),
            updates,
        )
        db.commit()
        return {"status": "success", "data": _fetch_formula(db, formula_id)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update formula {formula_id}: {e}")


@router.delete("/formulas/{formula_id}")
def delete_formula(formula_id: int, db: Session = Depends(get_db)):
    _fetch_formula(db, formula_id)  # 404 early if it doesn't exist
    try:
        db.execute(
            text("DELETE FROM formulas WHERE formula_id = :formula_id"),
            {"formula_id": formula_id},
        )
        db.commit()
        return {"status": "success", "message": f"Formula {formula_id} deleted"}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not delete formula {formula_id}: {e}")
