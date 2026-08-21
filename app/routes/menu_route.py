"""
CRUD API for `menus` (self-referencing: parent_menu_id NULL = a top-level
main menu, non-NULL = a submenu of that parent -- see app/auth_rbac.sql)
plus GET /menus/my-menu, which is what the frontend sidebar actually
renders after login.

Management endpoints (list/create/update/delete) are gated on the
'settings-menus' menu's own permissions, same pattern as users/roles.

GET /menus/my-menu only requires being logged in (every user needs to know
their own menu, regardless of whether they can manage OTHER menus) and
returns the tree filtered to what this user's roles grant 'view' on. A
top-level group (e.g. "Vehicle Operations") is included automatically if
ANY of its children are visible, even if the group row itself wasn't
explicitly granted -- requiring an admin to double-grant both the group and
every child would be needless friction. A top-level item with no children
(e.g. "Dashboard") needs its own explicit 'view' grant.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import bindparam, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config.database import get_db
from app.services.auth_service import get_current_user, require_permission

router = APIRouter()

MENU_KEY = "settings-menus"


def _row_to_dict(row) -> dict:
    return dict(row._mapping)


class MenuCreate(BaseModel):
    parent_menu_id: Optional[int] = None
    menu_key: str
    label: str
    path: Optional[str] = None
    icon: Optional[str] = None
    display_order: int = 0
    is_active: bool = True


class MenuUpdate(BaseModel):
    parent_menu_id: Optional[int] = None
    menu_key: Optional[str] = None
    label: Optional[str] = None
    path: Optional[str] = None
    icon: Optional[str] = None
    display_order: Optional[int] = None
    is_active: Optional[bool] = None


def _fetch_menu(db: Session, menu_id: int) -> dict:
    row = db.execute(text("SELECT * FROM menus WHERE menu_id = :id"), {"id": menu_id}).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Menu {menu_id} not found")
    return _row_to_dict(row)


@router.get("/menus")
def list_menus(
    is_active: Optional[bool] = Query(None),
    db: Session = Depends(get_db),
    _: dict = Depends(require_permission(MENU_KEY, "view")),
):
    """Flat list of every menu row (parents and submenus alike) -- the Menu
    Management page builds its own tree/table display from this."""
    clauses, params = [], {}
    if is_active is not None:
        clauses.append("is_active = :is_active")
        params["is_active"] = 1 if is_active else 0
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    try:
        rows = db.execute(
            text(f"SELECT * FROM menus {where} ORDER BY parent_menu_id IS NOT NULL, parent_menu_id, display_order"),
            params,
        )
        return {"status": "success", "data": [_row_to_dict(r) for r in rows]}
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read menus -- has app/auth_rbac.sql been run yet? ({e})",
        )


@router.get("/menus/my-menu")
def get_my_menu(db: Session = Depends(get_db), current_user: dict = Depends(get_current_user)):
    """Returns the current user's permitted menu tree for the sidebar, AND
    (via `permission_keys` on each node) which of view/create/edit/delete/
    export they hold on that specific menu -- so the frontend can hide
    Add/Edit/Delete/Export buttons on a page without a second round trip,
    the client-side half of the "permissions checked on both frontend and
    backend" requirement (the backend's require_permission is still the
    real enforcement)."""
    role_ids = [r["role_id"] for r in current_user["roles"]]
    if not role_ids:
        return {"status": "success", "data": []}

    all_menus = [_row_to_dict(r) for r in db.execute(
        text("SELECT * FROM menus WHERE is_active = 1 ORDER BY display_order")
    )]

    perm_query = text(
        """
        SELECT DISTINCT rmp.menu_id, p.permission_key
        FROM role_menu_permissions rmp
        JOIN permissions p ON p.permission_id = rmp.permission_id
        WHERE rmp.role_id IN :role_ids
        """
    ).bindparams(bindparam("role_ids", expanding=True))
    permission_keys_by_menu: dict[int, list[str]] = {}
    for row in db.execute(perm_query, {"role_ids": role_ids}):
        permission_keys_by_menu.setdefault(row.menu_id, []).append(row.permission_key)
    viewable_ids = {mid for mid, keys in permission_keys_by_menu.items() if "view" in keys}

    def with_permissions(m: dict) -> dict:
        return {**m, "permission_keys": permission_keys_by_menu.get(m["menu_id"], [])}

    children_by_parent: dict[int, list[dict]] = {}
    top_level: list[dict] = []
    for m in all_menus:
        if m["parent_menu_id"]:
            children_by_parent.setdefault(m["parent_menu_id"], []).append(m)
        else:
            top_level.append(m)

    tree = []
    for m in top_level:
        children = children_by_parent.get(m["menu_id"], [])
        if children:
            visible_children = [with_permissions(c) for c in children if c["menu_id"] in viewable_ids]
            if visible_children:
                tree.append({**with_permissions(m), "children": visible_children})
        elif m["menu_id"] in viewable_ids:
            tree.append({**with_permissions(m), "children": []})

    return {"status": "success", "data": tree}


@router.post("/menus", status_code=201)
def create_menu(
    payload: MenuCreate,
    db: Session = Depends(get_db),
    _: dict = Depends(require_permission(MENU_KEY, "create")),
):
    dup = db.execute(text("SELECT 1 FROM menus WHERE menu_key = :key"), {"key": payload.menu_key}).first()
    if dup:
        raise HTTPException(status_code=409, detail=f"Menu key '{payload.menu_key}' already exists")
    if payload.parent_menu_id is not None:
        _fetch_menu(db, payload.parent_menu_id)  # 404 if the parent doesn't exist

    try:
        result = db.execute(
            text(
                """
                INSERT INTO menus (parent_menu_id, menu_key, label, path, icon, display_order, is_active)
                VALUES (:parent_menu_id, :menu_key, :label, :path, :icon, :display_order, :is_active)
                """
            ),
            {
                "parent_menu_id": payload.parent_menu_id,
                "menu_key": payload.menu_key,
                "label": payload.label,
                "path": payload.path,
                "icon": payload.icon,
                "display_order": payload.display_order,
                "is_active": 1 if payload.is_active else 0,
            },
        )
        db.commit()
        return {"status": "success", "data": _fetch_menu(db, result.lastrowid)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create menu: {e}")


@router.put("/menus/{menu_id}")
def update_menu(
    menu_id: int,
    payload: MenuUpdate,
    db: Session = Depends(get_db),
    _: dict = Depends(require_permission(MENU_KEY, "edit")),
):
    _fetch_menu(db, menu_id)
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    if updates.get("parent_menu_id") == menu_id:
        raise HTTPException(status_code=400, detail="A menu cannot be its own parent")
    if "menu_key" in updates:
        dup = db.execute(
            text("SELECT 1 FROM menus WHERE menu_key = :key AND menu_id != :id"),
            {"key": updates["menu_key"], "id": menu_id},
        ).first()
        if dup:
            raise HTTPException(status_code=409, detail=f"Menu key '{updates['menu_key']}' already exists")
    if "is_active" in updates:
        updates["is_active"] = 1 if updates["is_active"] else 0

    set_clause = ", ".join(f"{col} = :{col}" for col in updates)
    updates["id"] = menu_id
    try:
        db.execute(text(f"UPDATE menus SET {set_clause} WHERE menu_id = :id"), updates)
        db.commit()
        return {"status": "success", "data": _fetch_menu(db, menu_id)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update menu {menu_id}: {e}")


@router.delete("/menus/{menu_id}")
def deactivate_menu(
    menu_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(require_permission(MENU_KEY, "delete")),
):
    _fetch_menu(db, menu_id)
    try:
        db.execute(text("UPDATE menus SET is_active = 0 WHERE menu_id = :id"), {"id": menu_id})
        db.commit()
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not deactivate menu {menu_id}: {e}")
    return {"status": "success", "message": f"Menu {menu_id} deactivated"}
