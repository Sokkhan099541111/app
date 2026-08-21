"""
CRUD API for `departments` -- the organizational grouping used by
`positions.department_id` and `employees.department_id` (see
app/departments.sql, app/positions.sql, app/employees_add_hr_fields.sql).

Table schema:

    department_id    INT UNSIGNED AUTO_INCREMENT PK
    name               VARCHAR(100)     (unique)
    created_at            TIMESTAMP
    updated_at              TIMESTAMP

Business rules:
  - name must be unique (checked on create/update, 409 if taken).
  - DELETE is blocked with 409 if any positions or employees rows still
    reference this department -- reassign or delete those first.
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

class DepartmentIn(BaseModel):
    name: str


class DepartmentUpdate(BaseModel):
    """All fields optional -- only columns actually sent get updated."""
    name: Optional[str] = None


# --- Helpers -------------------------------------------------------------

def _row_to_dict(row) -> dict:
    return dict(row._mapping)


def _fetch_department(db: Session, department_id: int) -> dict:
    row = db.execute(
        text("SELECT * FROM departments WHERE department_id = :department_id"),
        {"department_id": department_id},
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Department {department_id} not found")
    return _row_to_dict(row)


def _name_taken(db: Session, name: str, exclude_id: Optional[int] = None) -> bool:
    params: dict = {"name": name}
    exclude_clause = ""
    if exclude_id is not None:
        exclude_clause = "AND department_id != :exclude_id"
        params["exclude_id"] = exclude_id
    row = db.execute(
        text(f"SELECT 1 FROM departments WHERE name = :name {exclude_clause} LIMIT 1"),
        params,
    ).first()
    return row is not None


def _has_dependents(db: Session, department_id: int) -> bool:
    row = db.execute(
        text(
            """
            SELECT 1 FROM positions WHERE department_id = :id
            UNION ALL
            SELECT 1 FROM employees WHERE department_id = :id
            LIMIT 1
            """
        ),
        {"id": department_id},
    ).first()
    return row is not None


# --- Routes --------------------------------------------------------------

@router.get("/departments")
def list_departments(
    search: Optional[str] = Query(None, description="Filter by name (partial match)"),
    sort_by: str = Query("name", description="Column to sort by: name, department_id, created_at"),
    sort_dir: str = Query("asc", description="asc or desc"),
    db: Session = Depends(get_db),
):
    allowed_sort = {"name", "department_id", "created_at"}
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
            text(f"SELECT * FROM departments {where} ORDER BY {sort_by} {sort_dir}"),
            params,
        )
        return {"status": "success", "data": [_row_to_dict(r) for r in rows]}
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read departments -- has departments.sql been run yet? ({e})",
        )


@router.get("/departments/check-name")
def check_department_name(
    name: str = Query(..., description="Department name to check"),
    exclude_id: Optional[int] = Query(None, description="Department id to ignore when editing"),
    db: Session = Depends(get_db),
):
    return {"status": "success", "exists": _name_taken(db, name, exclude_id=exclude_id)}


@router.get("/departments/{department_id}")
def get_department(department_id: int, db: Session = Depends(get_db)):
    return {"status": "success", "data": _fetch_department(db, department_id)}


@router.post("/departments", status_code=201)
def create_department(payload: DepartmentIn, db: Session = Depends(get_db)):
    if _name_taken(db, payload.name):
        raise HTTPException(status_code=409, detail=f"Department '{payload.name}' already exists.")
    try:
        result = db.execute(
            text("INSERT INTO departments (name) VALUES (:name)"),
            payload.model_dump(),
        )
        db.commit()
        return {"status": "success", "data": _fetch_department(db, result.lastrowid)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create department: {e}")


@router.put("/departments/{department_id}")
def update_department(department_id: int, payload: DepartmentUpdate, db: Session = Depends(get_db)):
    _fetch_department(db, department_id)  # 404 early if it doesn't exist

    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "name" in updates and _name_taken(db, updates["name"], exclude_id=department_id):
        raise HTTPException(status_code=409, detail=f"Department '{updates['name']}' already exists.")

    set_clause = ", ".join(f"{col} = :{col}" for col in updates)
    updates["department_id"] = department_id

    try:
        db.execute(
            text(f"UPDATE departments SET {set_clause} WHERE department_id = :department_id"),
            updates,
        )
        db.commit()
        return {"status": "success", "data": _fetch_department(db, department_id)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update department {department_id}: {e}")


@router.delete("/departments/{department_id}")
def delete_department(department_id: int, db: Session = Depends(get_db)):
    """Hard delete -- blocked with 409 if any positions or employees rows
    still reference this department."""
    _fetch_department(db, department_id)  # 404 early if it doesn't exist
    if _has_dependents(db, department_id):
        raise HTTPException(
            status_code=409,
            detail="This department still has positions or employees assigned to it. Reassign or delete those first.",
        )
    try:
        db.execute(
            text("DELETE FROM departments WHERE department_id = :department_id"),
            {"department_id": department_id},
        )
        db.commit()
        return {"status": "success", "message": f"Department {department_id} deleted"}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not delete department {department_id}: {e}")
