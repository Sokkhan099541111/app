"""
Authentication + role-based access control (RBAC) helpers shared by
app/routes/auth.py, app/routes/users.py, app/routes/role_route.py, and
app/routes/menu_route.py -- and importable by any other route that wants to
require login (see main.py, which adds `Depends(get_current_user)` to every
existing router) or a specific permission on a specific menu.

Schema this reads from (see app/auth_rbac.sql):
    users                 -- user_id, username, email, password_hash, ...
    roles                 -- role_id, role_name, ...
    user_roles             -- (user_id, role_id) -- a user may hold >1 role
    permissions            -- permission_id, permission_key ('view'/'create'/'edit'/'delete'/'export')
    menus                  -- menu_id, parent_menu_id, menu_key, path, ...
    role_menu_permissions  -- (role_id, menu_id, permission_id) -- the single
                               source of truth for "which menus can this role
                               see" (a 'view' row) and "what can they do on
                               each one" (any other permission row).

Passwords are bcrypt-hashed (never stored/compared as plain text). Sessions
are stateless JWTs -- login returns a signed token, the frontend sends it
back as `Authorization: Bearer <token>` on every request, and this module
verifies the signature + expiry on each request. There is no server-side
session store, so "logout" is a client-side token discard (see
app/routes/auth.py for the accompanying note on that endpoint).
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
import jwt
from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

from app.config.database import get_db
from app.config.settings import JWT_ALGORITHM, JWT_EXPIRE_MINUTES, JWT_SECRET_KEY


# --- Password hashing ----------------------------------------------------

def hash_password(plain_password: str) -> str:
    return bcrypt.hashpw(plain_password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain_password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(plain_password.encode("utf-8"), password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        # Malformed/legacy hash -- never crash the login endpoint over it.
        return False


# --- JWT ------------------------------------------------------------------

def create_access_token(user_id: int, username: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "username": username,
        "iat": now,
        "exp": now + timedelta(minutes=JWT_EXPIRE_MINUTES),
    }
    return jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict:
    """Raises jwt.PyJWTError (expired, bad signature, malformed, ...) on
    any invalid token -- callers should catch and turn it into a 401."""
    return jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])


# --- Loading a user + their roles ------------------------------------------

def _row_to_dict(row) -> dict:
    return dict(row._mapping)


def get_user_by_id(db: Session, user_id: int) -> Optional[dict]:
    row = db.execute(
        text("SELECT * FROM users WHERE user_id = :user_id"), {"user_id": user_id}
    ).first()
    return _row_to_dict(row) if row else None


def get_user_by_username_or_email(db: Session, identifier: str) -> Optional[dict]:
    row = db.execute(
        text("SELECT * FROM users WHERE username = :identifier OR email = :identifier"),
        {"identifier": identifier},
    ).first()
    return _row_to_dict(row) if row else None


def get_user_roles(db: Session, user_id: int) -> list[dict]:
    rows = db.execute(
        text(
            """
            SELECT r.role_id, r.role_name
            FROM user_roles ur
            JOIN roles r ON r.role_id = ur.role_id
            WHERE ur.user_id = :user_id AND r.is_active = 1
            ORDER BY r.role_name
            """
        ),
        {"user_id": user_id},
    )
    return [_row_to_dict(r) for r in rows]


def get_company_name(db: Session, company_id) -> Optional[str]:
    """Resolves users.company_id -> the display name from
    company_wialon_credentials, so the UI can show "Mango Tracking" rather
    than a bare number. Returns None if unset or the company row is gone."""
    if company_id is None:
        return None
    row = db.execute(
        text("SELECT company_name FROM company_wialon_credentials WHERE company_id = :cid LIMIT 1"),
        {"cid": company_id},
    ).first()
    return row.company_name if row else None


def serialize_user(db: Session, user: dict) -> dict:
    """Public-facing user shape (never includes password_hash)."""
    roles = get_user_roles(db, user["user_id"])
    company_id = user.get("company_id")
    return {
        "user_id": user["user_id"],
        "username": user["username"],
        "email": user["email"],
        "full_name": user["full_name"],
        "company_id": company_id,
        "company_name": get_company_name(db, company_id),
        "is_active": bool(user["is_active"]),
        "roles": roles,
    }


# --- FastAPI dependencies ---------------------------------------------------

def get_current_user(
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> dict:
    """Require a valid `Authorization: Bearer <token>` header. Returns the
    serialized current user (with roles) on success; raises 401 otherwise.

    Import this as a route dependency (`Depends(get_current_user)`) to
    require login on any endpoint, or attach it at the router level via
    `app.include_router(router, dependencies=[Depends(get_current_user)])`
    (see main.py) to protect every route in that file at once."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    token = authorization[len("Bearer "):]
    try:
        payload = decode_access_token(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Session expired -- please log in again")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid authentication token")

    try:
        user_id = int(payload.get("sub"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid authentication token")

    user = get_user_by_id(db, user_id)
    if not user or not user["is_active"]:
        raise HTTPException(status_code=401, detail="Account not found or deactivated")

    return serialize_user(db, user)


def require_permission(menu_key: str, permission_key: str):
    """Dependency factory: `Depends(require_permission("settings-users", "create"))`.
    403s unless the current user holds a role that's been granted this
    exact permission on this exact menu (see role_menu_permissions) --
    checked across ALL of the user's roles, so having the permission via
    any one role is enough."""

    def _check(
        current_user: dict = Depends(get_current_user),
        db: Session = Depends(get_db),
    ) -> dict:
        role_ids = [r["role_id"] for r in current_user["roles"]]
        if not role_ids:
            raise HTTPException(status_code=403, detail="Your account has no assigned role")

        query = text(
            """
            SELECT 1
            FROM role_menu_permissions rmp
            JOIN menus m ON m.menu_id = rmp.menu_id
            JOIN permissions p ON p.permission_id = rmp.permission_id
            WHERE rmp.role_id IN :role_ids
              AND m.menu_key = :menu_key
              AND p.permission_key = :permission_key
            LIMIT 1
            """
        ).bindparams(bindparam("role_ids", expanding=True))
        row = db.execute(
            query,
            {"role_ids": role_ids, "menu_key": menu_key, "permission_key": permission_key},
        ).first()
        if not row:
            raise HTTPException(
                status_code=403,
                detail=f"You do not have '{permission_key}' permission on '{menu_key}'",
            )
        return current_user

    return _check


# Which permission each mutating HTTP method requires. GET (and HEAD/OPTIONS)
# deliberately stays at login-only in require_action_permission below: many
# pages read OTHER modules' lists to populate dropdowns (e.g. the Vehicle
# Expense form loads /api/vendors, payroll pages load /api/employees), so
# gating reads per-menu would break pages the user IS allowed to use. What a
# user can SEE in the UI is governed by /menus/my-menu + the frontend route
# guard; what they can CHANGE is enforced here.
_METHOD_TO_PERMISSION = {
    "POST": "create",
    "PUT": "edit",
    "PATCH": "edit",
    "DELETE": "delete",
}


def require_action_permission(*menu_keys: str):
    """Router-level dependency factory for the pre-existing (non-RBAC-aware)
    routers, attached in main.py via
    `app.include_router(r, dependencies=[Depends(require_action_permission("employees"))])`.

    Unlike require_permission (one fixed menu + one fixed permission per
    endpoint), this derives the required permission from the HTTP method of
    the incoming request -- POST needs 'create', PUT/PATCH need 'edit',
    DELETE needs 'delete' -- so every endpoint in an existing route file
    gets correct View-vs-Create/Edit/Delete enforcement without modifying
    the file itself.

    Accepts several menu_keys for route files that serve more than one menu
    (e.g. vehicle_rental_route serves Rental Vehicles, Rental Attendance,
    and Rental Expense Report): holding the permission on ANY of them
    passes. GET requests only require login (see _METHOD_TO_PERMISSION)."""

    def _check(
        request: Request,
        current_user: dict = Depends(get_current_user),
        db: Session = Depends(get_db),
    ) -> dict:
        permission_key = _METHOD_TO_PERMISSION.get(request.method)
        if permission_key is None:
            return current_user  # read-only request: login is enough

        role_ids = [r["role_id"] for r in current_user["roles"]]
        if not role_ids:
            raise HTTPException(status_code=403, detail="Your account has no assigned role")

        query = text(
            """
            SELECT 1
            FROM role_menu_permissions rmp
            JOIN menus m ON m.menu_id = rmp.menu_id
            JOIN permissions p ON p.permission_id = rmp.permission_id
            WHERE rmp.role_id IN :role_ids
              AND m.menu_key IN :menu_keys
              AND p.permission_key = :permission_key
            LIMIT 1
            """
        ).bindparams(
            bindparam("role_ids", expanding=True),
            bindparam("menu_keys", expanding=True),
        )
        row = db.execute(
            query,
            {
                "role_ids": role_ids,
                "menu_keys": list(menu_keys),
                "permission_key": permission_key,
            },
        ).first()
        if not row:
            raise HTTPException(
                status_code=403,
                detail=f"You do not have '{permission_key}' permission for this action",
            )
        return current_user

    return _check
