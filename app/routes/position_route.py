"""
CRUD API for `positions` -- job titles within a department, referenced by
`employees.position_id` (see app/positions.sql, app/employees_add_hr_fields.sql).

Table schema:

    position_id      INT UNSIGNED AUTO_INCREMENT PK
    title              VARCHAR(100)
    department_id        INT UNSIGNED            -- FK -> departments, nullable
    created_at              TIMESTAMP
    updated_at                TIMESTAMP

Business rules:
  - (title, department_id) must be unique (checked on create/update, 409 if
    taken) -- the same title can exist in two different departments.
  - DELETE is blocked with 409 if any employees rows still reference this
    position -- reassign or delete those first.
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

class PositionIn(BaseModel):
    title: str
    department_id: Optional[int] = None


class PositionUpdate(BaseModel):
    """All fields optional -- only columns actually sent get updated."""
    title: Optional[str] = None
    department_id: Optional[int] = None


# --- Helpers -------------------------------------------------------------

def _row_to_dict(row) -> dict:
    return dict(row._mapping)


def _fetch_position(db: Session, position_id: int) -> dict:
    row = db.execute(
        text("SELECT * FROM positions WHERE position_id = :position_id"),
        {"position_id": position_id},
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Position {position_id} not found")
    return _row_to_dict(row)


def _duplicate_exists(
    db: Session, title: str, department_id: Optional[int], exclude_id: Optional[int] = None
) -> bool:
    params: dict = {"title": title, "department_id": department_id}
    dept_clause = "department_id <=> :department_id"  # NULL-safe equality
    exclude_clause = ""
    if exclude_id is not None:
        exclude_clause = "AND position_id != :exclude_id"
        params["exclude_id"] = exclude_id
    row = db.execute(
        text(
            f"SELECT 1 FROM positions WHERE title = :title AND {dept_clause} {exclude_clause} LIMIT 1"
        ),
        params,
    ).first()
    return row is not None


def _has_dependents(db: Session, position_id: int) -> bool:
    row = db.execute(
        text("SELECT 1 FROM employees WHERE position_id = :id LIMIT 1"),
        {"id": position_id},
    ).first()
    return row is not None


# --- Routes --------------------------------------------------------------

@router.get("/positions")
def list_positions(
    search: Optional[str] = Query(None, description="Filter by title (partial match)"),
    department_id: Optional[int] = Query(None, description="Filter by department"),
    sort_by: str = Query("title", description="Column to sort by: title, position_id, created_at"),
    sort_dir: str = Query("asc", description="asc or desc"),
    db: Session = Depends(get_db),
):
    allowed_sort = {"title", "position_id", "created_at"}
    if sort_by not in allowed_sort:
        sort_by = "title"
    sort_dir = "DESC" if str(sort_dir).lower() == "desc" else "ASC"

    clauses, params = [], {}
    if search:
        clauses.append("title LIKE :search")
        params["search"] = f"%{search}%"
    if department_id is not None:
        clauses.append("department_id = :department_id")
        params["department_id"] = department_id
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    try:
        rows = db.execute(
            text(f"SELECT * FROM positions {where} ORDER BY {sort_by} {sort_dir}"),
            params,
        )
        return {"status": "success", "data": [_row_to_dict(r) for r in rows]}
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read positions -- has positions.sql been run yet? ({e})",
        )


@router.get("/positions/{position_id}")
def get_position(position_id: int, db: Session = Depends(get_db)):
    return {"status": "success", "data": _fetch_position(db, position_id)}


@router.post("/positions", status_code=201)
def create_position(payload: PositionIn, db: Session = Depends(get_db)):
    if _duplicate_exists(db, payload.title, payload.department_id):
        raise HTTPException(
            status_code=409,
            detail=f"Position '{payload.title}' already exists in that department.",
        )
    try:
        result = db.execute(
            text(
                "INSERT INTO positions (title, department_id) VALUES (:title, :department_id)"
            ),
            payload.model_dump(),
        )
        db.commit()
        return {"status": "success", "data": _fetch_position(db, result.lastrowid)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create position: {e}")


@router.put("/positions/{position_id}")
def update_position(position_id: int, payload: PositionUpdate, db: Session = Depends(get_db)):
    current = _fetch_position(db, position_id)  # 404 early if it doesn't exist

    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "title" in updates or "department_id" in updates:
        effective_title = updates.get("title", current["title"])
        effective_department_id = updates.get("department_id", current["department_id"])
        if _duplicate_exists(db, effective_title, effective_department_id, exclude_id=position_id):
            raise HTTPException(
                status_code=409,
                detail=f"Position '{effective_title}' already exists in that department.",
            )

    set_clause = ", ".join(f"{col} = :{col}" for col in updates)
    updates["position_id"] = position_id

    try:
        db.execute(
            text(f"UPDATE positions SET {set_clause} WHERE position_id = :position_id"),
            updates,
        )
        db.commit()
        return {"status": "success", "data": _fetch_position(db, position_id)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update position {position_id}: {e}")


@router.delete("/positions/{position_id}")
def delete_position(position_id: int, db: Session = Depends(get_db)):
    """Hard delete -- blocked with 409 if any employees rows still reference
    this position."""
    _fetch_position(db, position_id)  # 404 early if it doesn't exist
    if _has_dependents(db, position_id):
        raise HTTPException(
            status_code=409,
            detail="This position still has employees assigned to it. Reassign or delete those first.",
        )
    try:
        db.execute(
            text("DELETE FROM positions WHERE position_id = :position_id"),
            {"position_id": position_id},
        )
        db.commit()
        return {"status": "success", "message": f"Position {position_id} deleted"}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not delete position {position_id}: {e}")
