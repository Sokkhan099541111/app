"""
CRUD API for `users` -- the User Management page. Every endpoint requires
the caller to hold the 'view'/'create'/'edit'/'delete' permission (as
appropriate) on the 'settings-users' menu (see app/services/auth_service.py
require_permission and app/auth_rbac.sql's role_menu_permissions seed).

Role assignment is many-to-many via `user_roles` -- create/update accept a
`role_ids` list and fully replace that user's role assignments (simplest
correct semantics: the request body is always the complete desired set).

Delete is a soft delete (is_active = 0), consistent with the rest of this
codebase (e.g. vehicle_operation_logs) -- keeps audit history (created_by
references elsewhere, last_login_at, etc.) rather than losing it, and a
deactivated user is rejected at login/get_current_user regardless of
whether their row still physically exists.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, EmailStr
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config.database import get_db
from app.services.auth_service import (
    get_user_by_id,
    get_user_by_username_or_email,
    hash_password,
    require_permission,
    serialize_user,
)

router = APIRouter()

MENU_KEY = "settings-users"


class UserCreate(BaseModel):
    username: str
    email: EmailStr
    password: str
    full_name: Optional[str] = None
    company_id: int  # required -- must exist in company_wialon_credentials
    role_ids: list[int] = []
    is_active: bool = True


class UserUpdate(BaseModel):
    email: Optional[EmailStr] = None
    password: Optional[str] = None  # only set if changing it
    full_name: Optional[str] = None
    company_id: Optional[int] = None
    role_ids: Optional[list[int]] = None
    is_active: Optional[bool] = None


def _validate_company_id(db: Session, company_id: int) -> None:
    """A user's company must be one that actually exists in
    company_wialon_credentials. Enforced here (not only in the UI dropdown)
    so a hand-crafted API request can't attach a user to a company that was
    never configured -- 400 rather than a silent bad reference."""
    row = db.execute(
        text("SELECT 1 FROM company_wialon_credentials WHERE company_id = :cid LIMIT 1"),
        {"cid": company_id},
    ).first()
    if not row:
        raise HTTPException(
            status_code=400,
            detail=f"Company {company_id} does not exist in Company Wialon Credentials",
        )


def _set_user_roles(db: Session, user_id: int, role_ids: list[int]) -> None:
    db.execute(text("DELETE FROM user_roles WHERE user_id = :user_id"), {"user_id": user_id})
    for role_id in set(role_ids):
        db.execute(
            text("INSERT INTO user_roles (user_id, role_id) VALUES (:user_id, :role_id)"),
            {"user_id": user_id, "role_id": role_id},
        )


@router.get("/users")
def list_users(
    search: Optional[str] = Query(None, description="Filter by username, email, or full name"),
    is_active: Optional[bool] = Query(None),
    db: Session = Depends(get_db),
    _: dict = Depends(require_permission(MENU_KEY, "view")),
):
    clauses, params = [], {}
    if search:
        clauses.append("(username LIKE :search OR email LIKE :search OR full_name LIKE :search)")
        params["search"] = f"%{search}%"
    if is_active is not None:
        clauses.append("is_active = :is_active")
        params["is_active"] = 1 if is_active else 0
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    try:
        rows = db.execute(
            text(f"SELECT user_id FROM users {where} ORDER BY username"), params
        )
        user_ids = [r.user_id for r in rows]
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read users -- has app/auth_rbac.sql been run yet? ({e})",
        )
    data = []
    for uid in user_ids:
        user = get_user_by_id(db, uid)
        if user:
            data.append(serialize_user(db, user))
    return {"status": "success", "data": data}


@router.get("/users/{user_id}")
def get_user(
    user_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(require_permission(MENU_KEY, "view")),
):
    user = get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail=f"User {user_id} not found")
    return {"status": "success", "data": serialize_user(db, user)}


@router.post("/users", status_code=201)
def create_user(
    payload: UserCreate,
    db: Session = Depends(get_db),
    _: dict = Depends(require_permission(MENU_KEY, "create")),
):
    if get_user_by_username_or_email(db, payload.username):
        raise HTTPException(status_code=409, detail=f"Username '{payload.username}' is already taken")
    if get_user_by_username_or_email(db, payload.email):
        raise HTTPException(status_code=409, detail=f"Email '{payload.email}' is already in use")
    if len(payload.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    _validate_company_id(db, payload.company_id)

    try:
        result = db.execute(
            text(
                """
                INSERT INTO users (username, email, password_hash, full_name, company_id, is_active)
                VALUES (:username, :email, :password_hash, :full_name, :company_id, :is_active)
                """
            ),
            {
                "username": payload.username,
                "email": payload.email,
                "password_hash": hash_password(payload.password),
                "full_name": payload.full_name,
                "company_id": payload.company_id,
                "is_active": 1 if payload.is_active else 0,
            },
        )
        user_id = result.lastrowid
        _set_user_roles(db, user_id, payload.role_ids)
        db.commit()
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create user: {e}")

    return {"status": "success", "data": serialize_user(db, get_user_by_id(db, user_id))}


@router.put("/users/{user_id}")
def update_user(
    user_id: int,
    payload: UserUpdate,
    db: Session = Depends(get_db),
    _: dict = Depends(require_permission(MENU_KEY, "edit")),
):
    existing = get_user_by_id(db, user_id)
    if not existing:
        raise HTTPException(status_code=404, detail=f"User {user_id} not found")

    updates: dict = {}
    if payload.email is not None and payload.email != existing["email"]:
        dup = get_user_by_username_or_email(db, payload.email)
        if dup and dup["user_id"] != user_id:
            raise HTTPException(status_code=409, detail=f"Email '{payload.email}' is already in use")
        updates["email"] = payload.email
    if payload.password is not None:
        if len(payload.password) < 8:
            raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
        updates["password_hash"] = hash_password(payload.password)
    if payload.full_name is not None:
        updates["full_name"] = payload.full_name
    if payload.company_id is not None:
        _validate_company_id(db, payload.company_id)
        updates["company_id"] = payload.company_id
    if payload.is_active is not None:
        updates["is_active"] = 1 if payload.is_active else 0

    try:
        if updates:
            set_clause = ", ".join(f"{col} = :{col}" for col in updates)
            updates["user_id"] = user_id
            db.execute(text(f"UPDATE users SET {set_clause} WHERE user_id = :user_id"), updates)
        if payload.role_ids is not None:
            _set_user_roles(db, user_id, payload.role_ids)
        db.commit()
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update user {user_id}: {e}")

    return {"status": "success", "data": serialize_user(db, get_user_by_id(db, user_id))}


@router.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(MENU_KEY, "delete")),
):
    if not get_user_by_id(db, user_id):
        raise HTTPException(status_code=404, detail=f"User {user_id} not found")
    if user_id == current_user["user_id"]:
        raise HTTPException(status_code=400, detail="You cannot deactivate your own account")
    try:
        db.execute(text("UPDATE users SET is_active = 0 WHERE user_id = :id"), {"id": user_id})
        db.commit()
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not deactivate user {user_id}: {e}")
    return {"status": "success", "message": f"User {user_id} deactivated"}
