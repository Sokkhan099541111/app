"""
CRUD API for `vendors` -- the master reference list used by the Vehicle
Expense module (see app/vehicle_expenses.sql). Vendor Name and Phone Number
are entered or selected here when logging an expense.

Table schema:

    vendor_id       INT UNSIGNED AUTO_INCREMENT PK
    name            VARCHAR(200)
    phone_number    VARCHAR(50)
    created_at      TIMESTAMP
    updated_at      TIMESTAMP

Business rules:
  - `name` must be unique (checked on create/update, 409 if taken).
  - DELETE is blocked (409) if any vehicle_expenses rows still reference
    this vendor.
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

class VendorIn(BaseModel):
    name: str
    phone_number: Optional[str] = None


class VendorUpdate(BaseModel):
    """All fields optional -- only columns actually sent get updated."""
    name: Optional[str] = None
    phone_number: Optional[str] = None


# --- Helpers -------------------------------------------------------------

def _row_to_dict(row) -> dict:
    return dict(row._mapping)


def _fetch_vendor(db: Session, vendor_id: int) -> dict:
    row = db.execute(
        text("SELECT * FROM vendors WHERE vendor_id = :vendor_id"),
        {"vendor_id": vendor_id},
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Vendor {vendor_id} not found")
    return _row_to_dict(row)


def _duplicate_exists(db: Session, name: str, exclude_id: Optional[int] = None) -> bool:
    params: dict = {"name": name}
    exclude_clause = ""
    if exclude_id is not None:
        exclude_clause = "AND vendor_id != :exclude_id"
        params["exclude_id"] = exclude_id
    row = db.execute(
        text(f"SELECT 1 FROM vendors WHERE name = :name {exclude_clause} LIMIT 1"),
        params,
    ).first()
    return row is not None


def _has_dependents(db: Session, vendor_id: int) -> bool:
    row = db.execute(
        text("SELECT 1 FROM vehicle_expenses WHERE vendor_id = :id LIMIT 1"),
        {"id": vendor_id},
    ).first()
    return row is not None


# --- Routes --------------------------------------------------------------

@router.get("/vendors")
def list_vendors(
    search: Optional[str] = Query(None, description="Filter by name (partial match)"),
    sort_by: str = Query("name", description="Column to sort by"),
    sort_dir: str = Query("asc", description="asc or desc"),
    db: Session = Depends(get_db),
):
    allowed_sort = {"vendor_id", "name", "phone_number", "created_at"}
    if sort_by not in allowed_sort:
        sort_by = "name"
    sort_dir = "DESC" if str(sort_dir).lower() == "desc" else "ASC"

    clauses, params = [], {}
    if search:
        clauses.append("name LIKE :search")
        params["search"] = f"%{search}%"
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    try:
        rows = db.execute(
            text(f"SELECT * FROM vendors {where} ORDER BY {sort_by} {sort_dir}"),
            params,
        )
        return {"status": "success", "data": [_row_to_dict(r) for r in rows]}
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read vendors -- has vehicle_expenses.sql been run yet? ({e})",
        )


@router.get("/vendors/{vendor_id}")
def get_vendor(vendor_id: int, db: Session = Depends(get_db)):
    return {"status": "success", "data": _fetch_vendor(db, vendor_id)}


@router.post("/vendors", status_code=201)
def create_vendor(payload: VendorIn, db: Session = Depends(get_db)):
    if _duplicate_exists(db, payload.name):
        raise HTTPException(status_code=409, detail=f"Vendor '{payload.name}' already exists.")
    try:
        result = db.execute(
            text("INSERT INTO vendors (name, phone_number) VALUES (:name, :phone_number)"),
            payload.model_dump(),
        )
        db.commit()
        return {"status": "success", "data": _fetch_vendor(db, result.lastrowid)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create vendor: {e}")


@router.put("/vendors/{vendor_id}")
def update_vendor(vendor_id: int, payload: VendorUpdate, db: Session = Depends(get_db)):
    _fetch_vendor(db, vendor_id)  # 404 early if it doesn't exist

    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "name" in updates and _duplicate_exists(db, updates["name"], exclude_id=vendor_id):
        raise HTTPException(status_code=409, detail=f"Vendor '{updates['name']}' already exists.")

    set_clause = ", ".join(f"{col} = :{col}" for col in updates)
    updates["vendor_id"] = vendor_id

    try:
        db.execute(
            text(f"UPDATE vendors SET {set_clause} WHERE vendor_id = :vendor_id"),
            updates,
        )
        db.commit()
        return {"status": "success", "data": _fetch_vendor(db, vendor_id)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update vendor {vendor_id}: {e}")


@router.delete("/vendors/{vendor_id}")
def delete_vendor(vendor_id: int, db: Session = Depends(get_db)):
    """Hard delete -- blocked with 409 if any vehicle_expenses rows still
    reference this vendor."""
    _fetch_vendor(db, vendor_id)  # 404 early if it doesn't exist
    if _has_dependents(db, vendor_id):
        raise HTTPException(
            status_code=409,
            detail="This vendor still has expense entries recorded against it. Delete those first.",
        )
    try:
        db.execute(
            text("DELETE FROM vendors WHERE vendor_id = :vendor_id"),
            {"vendor_id": vendor_id},
        )
        db.commit()
        return {"status": "success", "message": f"Vendor {vendor_id} deleted"}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not delete vendor {vendor_id}: {e}")
