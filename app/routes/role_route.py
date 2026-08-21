"""
CRUD API for `roles`, plus the per-role menu/permission matrix that powers
the Role Management page's "assign menus & permissions" screen.

Deactivating a role (DELETE, which is a soft delete via is_active=0) does
NOT strip the role from users who already hold it -- get_user_roles()
filters to active roles only, so a deactivated role simply stops granting
access without silently mutating user_roles history. Hard-deleting a role
is not exposed here on purpose: role_menu_permissions/user_roles both
CASCADE on role_id, so a hard delete would be destructive and hard to
reverse; soft delete is safer for something this structural.

The permission matrix (GET/PUT .../permissions) is where "assign one or
more permissions to each role" (Section 2) and "assign menus/submenus to
specific roles" (Section 3) meet: a role_menu_permissions row for
(role, menu, 'view') both makes that menu visible to the role AND is itself
a granted permission -- see app/services/auth_service.py's module docstring
for the full reasoning.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config.database import get_db
from app.services.auth_service import require_permission

router = APIRouter()

MENU_KEY = "settings-roles"


def _row_to_dict(row) -> dict:
    return dict(row._mapping)


class RoleCreate(BaseModel):
    role_name: str
    description: Optional[str] = None
    is_active: bool = True


class RoleUpdate(BaseModel):
    role_name: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None


class MenuPermissionSet(BaseModel):
    menu_id: int
    permission_keys: list[str]  # subset of 'view'/'create'/'edit'/'delete'/'export'


class SetRolePermissions(BaseModel):
    menus: list[MenuPermissionSet]


def _fetch_role(db: Session, role_id: int) -> dict:
    row = db.execute(text("SELECT * FROM roles WHERE role_id = :id"), {"id": role_id}).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Role {role_id} not found")
    return _row_to_dict(row)


@router.get("/permissions")
def list_permissions(db: Session = Depends(get_db), _: dict = Depends(require_permission(MENU_KEY, "view"))):
    """The fixed permission catalog (view/create/edit/delete/export) -- used
    to render the checkbox columns in the Role Management permission matrix."""
    rows = db.execute(text("SELECT * FROM permissions ORDER BY permission_id"))
    return {"status": "success", "data": [_row_to_dict(r) for r in rows]}


@router.get("/roles")
def list_roles(
    search: Optional[str] = Query(None),
    is_active: Optional[bool] = Query(None),
    db: Session = Depends(get_db),
    _: dict = Depends(require_permission(MENU_KEY, "view")),
):
    clauses, params = [], {}
    if search:
        clauses.append("(role_name LIKE :search OR description LIKE :search)")
        params["search"] = f"%{search}%"
    if is_active is not None:
        clauses.append("is_active = :is_active")
        params["is_active"] = 1 if is_active else 0
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    try:
        rows = db.execute(text(f"SELECT * FROM roles {where} ORDER BY role_name"), params)
        return {"status": "success", "data": [_row_to_dict(r) for r in rows]}
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read roles -- has app/auth_rbac.sql been run yet? ({e})",
        )


@router.get("/roles/{role_id}")
def get_role(role_id: int, db: Session = Depends(get_db), _: dict = Depends(require_permission(MENU_KEY, "view"))):
    return {"status": "success", "data": _fetch_role(db, role_id)}


@router.post("/roles", status_code=201)
def create_role(
    payload: RoleCreate,
    db: Session = Depends(get_db),
    _: dict = Depends(require_permission(MENU_KEY, "create")),
):
    dup = db.execute(text("SELECT 1 FROM roles WHERE role_name = :name"), {"name": payload.role_name}).first()
    if dup:
        raise HTTPException(status_code=409, detail=f"Role '{payload.role_name}' already exists")
    try:
        result = db.execute(
            text(
                "INSERT INTO roles (role_name, description, is_active) VALUES (:role_name, :description, :is_active)"
            ),
            {
                "role_name": payload.role_name,
                "description": payload.description,
                "is_active": 1 if payload.is_active else 0,
            },
        )
        db.commit()
        return {"status": "success", "data": _fetch_role(db, result.lastrowid)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create role: {e}")


@router.put("/roles/{role_id}")
def update_role(
    role_id: int,
    payload: RoleUpdate,
    db: Session = Depends(get_db),
    _: dict = Depends(require_permission(MENU_KEY, "edit")),
):
    _fetch_role(db, role_id)
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    if "role_name" in updates:
        dup = db.execute(
            text("SELECT 1 FROM roles WHERE role_name = :name AND role_id != :id"),
            {"name": updates["role_name"], "id": role_id},
        ).first()
        if dup:
            raise HTTPException(status_code=409, detail=f"Role '{updates['role_name']}' already exists")
    if "is_active" in updates:
        updates["is_active"] = 1 if updates["is_active"] else 0

    set_clause = ", ".join(f"{col} = :{col}" for col in updates)
    updates["id"] = role_id
    try:
        db.execute(text(f"UPDATE roles SET {set_clause} WHERE role_id = :id"), updates)
        db.commit()
        return {"status": "success", "data": _fetch_role(db, role_id)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update role {role_id}: {e}")


@router.delete("/roles/{role_id}")
def deactivate_role(
    role_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(require_permission(MENU_KEY, "delete")),
):
    _fetch_role(db, role_id)
    try:
        db.execute(text("UPDATE roles SET is_active = 0 WHERE role_id = :id"), {"id": role_id})
        db.commit()
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not deactivate role {role_id}: {e}")
    return {"status": "success", "message": f"Role {role_id} deactivated"}


def _get_role_permissions_data(db: Session, role_id: int) -> list[dict]:
    """Every menu, with which permission_keys this role currently holds on
    it (empty list if none) -- the shape the permission-matrix UI renders."""
    menu_rows = db.execute(text("SELECT menu_id FROM menus ORDER BY menu_id"))
    granted_rows = db.execute(
        text(
            """
            SELECT rmp.menu_id, p.permission_key
            FROM role_menu_permissions rmp
            JOIN permissions p ON p.permission_id = rmp.permission_id
            WHERE rmp.role_id = :role_id
            """
        ),
        {"role_id": role_id},
    )
    granted: dict[int, list[str]] = {}
    for row in granted_rows:
        granted.setdefault(row.menu_id, []).append(row.permission_key)

    return [{"menu_id": r.menu_id, "permission_keys": granted.get(r.menu_id, [])} for r in menu_rows]


@router.get("/roles/{role_id}/permissions")
def get_role_permissions(
    role_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(require_permission(MENU_KEY, "view")),
):
    _fetch_role(db, role_id)
    return {"status": "success", "data": _get_role_permissions_data(db, role_id)}


@router.put("/roles/{role_id}/permissions")
def set_role_permissions(
    role_id: int,
    payload: SetRolePermissions,
    db: Session = Depends(get_db),
    _: dict = Depends(require_permission(MENU_KEY, "edit")),
):
    """Full replace: the request body is the complete desired permission
    set for this role. Menus/permission_keys not present get cleared."""
    _fetch_role(db, role_id)
    permission_rows = db.execute(text("SELECT permission_id, permission_key FROM permissions"))
    key_to_id = {r.permission_key: r.permission_id for r in permission_rows}

    try:
        db.execute(text("DELETE FROM role_menu_permissions WHERE role_id = :role_id"), {"role_id": role_id})
        for menu_entry in payload.menus:
            for key in menu_entry.permission_keys:
                permission_id = key_to_id.get(key)
                if permission_id is None:
                    continue  # ignore unknown keys rather than fail the whole save
                db.execute(
                    text(
                        """
                        INSERT INTO role_menu_permissions (role_id, menu_id, permission_id)
                        VALUES (:role_id, :menu_id, :permission_id)
                        """
                    ),
                    {"role_id": role_id, "menu_id": menu_entry.menu_id, "permission_id": permission_id},
                )
        db.commit()
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not save permissions for role {role_id}: {e}")

    return {"status": "success", "data": _get_role_permissions_data(db, role_id)}
