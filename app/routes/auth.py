"""
Login / logout / current-session endpoints.

POST /api/auth/login  -- public (no Authorization header required). Accepts
    a username or email + password, verifies against the bcrypt hash on
    file, and returns a signed JWT plus the user's profile + roles.

POST /api/auth/logout -- requires a valid token. JWTs are stateless (no
    server-side session store here), so there is nothing to invalidate on
    the server; this endpoint exists for API completeness/audit and simply
    confirms the request was authenticated. The actual "log out" action is
    the frontend discarding its stored token -- see frontend/src/context/
    AuthContext.tsx.

GET /api/auth/me -- requires a valid token. Returns the current user's
    profile + roles, used by the frontend to restore session state on page
    load/refresh (the token survives a refresh in localStorage, but the
    in-memory user object does not).
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config.database import get_db
from app.services.auth_service import (
    create_access_token,
    get_current_user,
    get_user_by_username_or_email,
    serialize_user,
    verify_password,
)

router = APIRouter()


class LoginRequest(BaseModel):
    username: str  # username OR email
    password: str


@router.post("/auth/login")
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    user = get_user_by_username_or_email(db, payload.username)
    # Same error for "no such user" and "wrong password" -- don't leak
    # which one it was.
    if not user or not verify_password(payload.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username/email or password")
    if not user["is_active"]:
        raise HTTPException(status_code=401, detail="This account has been deactivated")

    db.execute(
        text("UPDATE users SET last_login_at = NOW() WHERE user_id = :id"),
        {"id": user["user_id"]},
    )
    db.commit()

    token = create_access_token(user["user_id"], user["username"])
    return {
        "status": "success",
        "access_token": token,
        "token_type": "bearer",
        "user": serialize_user(db, user),
    }


@router.post("/auth/logout")
def logout(current_user: dict = Depends(get_current_user)):
    # Stateless JWT -- see module docstring. Confirms the token was valid;
    # the frontend is responsible for discarding it.
    return {"status": "success", "message": "Logged out"}


@router.get("/auth/me")
def me(current_user: dict = Depends(get_current_user)):
    return {"status": "success", "user": current_user}
