"""
CRUD API for `company_wialon_credentials` -- stores per-company Wialon API
access details (token + base URL) plus company contact/branding info (see
app/company_wialon_credentials.sql).

Table schema:

    id                       INT AUTO_INCREMENT PK
    company_id               INT NOT NULL
    company_name             VARCHAR(500)
    company_email            VARCHAR(255)
    company_phone            VARCHAR(50)
    company_address          VARCHAR(500)
    company_contact_person   VARCHAR(255)
    company_website          VARCHAR(255)
    company_logo             VARCHAR(500)
    wialon_token              VARCHAR(255) NOT NULL
    base_url                  VARCHAR(255) NOT NULL
    is_active                 TINYINT(1) NOT NULL DEFAULT 1
    created_at                TIMESTAMP
    updated_at                TIMESTAMP

Business rules:
  - `company_id` must be unique (checked on create/update, 409 if taken) --
    one Wialon credential record per company. It's not user-entered: the
    frontend hides this field entirely and the API auto-assigns the next
    available value (MAX(company_id) + 1) on create.
  - `base_url` is locked to DEFAULT_WIALON_BASE_URL by the frontend (the
    field is rendered disabled there); the API falls back to the same
    default if a blank value ever comes through.
  - `company_logo` is populated via POST .../upload-logo, which saves the
    file under app/uploads/logos and returns the URL to store here. That
    URL is served by the /uploads StaticFiles mount registered in main.py.
"""
import os
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config.database import get_db

router = APIRouter()

# Standard Wialon hosting API endpoint -- the Base URL field is locked to
# this value in the UI, so every company record points at the same host.
# Must be the full AJAX endpoint (WialonReportService posts directly to
# this URL) -- not just the bare host.
DEFAULT_WIALON_BASE_URL = "https://hst-api.wialon.com/wialon/ajax.html"

# Where uploaded logo files are stored on disk / served from. Matches the
# "/uploads" StaticFiles mount in app/main.py.
UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "..", "uploads", "logos")
os.makedirs(UPLOAD_DIR, exist_ok=True)
ALLOWED_LOGO_CONTENT_TYPES = {"image/png"}


# --- Request bodies ----------------------------------------------------

class CompanyWialonCredentialIn(BaseModel):
    company_id: Optional[int] = None  # auto-assigned server-side if omitted
    company_name: Optional[str] = None
    company_email: Optional[str] = None
    company_phone: Optional[str] = None
    company_address: Optional[str] = None
    company_contact_person: Optional[str] = None
    company_website: Optional[str] = None
    company_logo: Optional[str] = None
    wialon_token: str
    base_url: str
    is_active: bool = True


class CompanyWialonCredentialUpdate(BaseModel):
    """All fields optional -- only columns actually sent get updated."""
    company_id: Optional[int] = None
    company_name: Optional[str] = None
    company_email: Optional[str] = None
    company_phone: Optional[str] = None
    company_address: Optional[str] = None
    company_contact_person: Optional[str] = None
    company_website: Optional[str] = None
    company_logo: Optional[str] = None
    wialon_token: Optional[str] = None
    base_url: Optional[str] = None
    is_active: Optional[bool] = None


# --- Helpers -------------------------------------------------------------

def _row_to_dict(row) -> dict:
    return dict(row._mapping)


def _fetch_credential(db: Session, credential_id: int) -> dict:
    row = db.execute(
        text("SELECT * FROM company_wialon_credentials WHERE id = :id"),
        {"id": credential_id},
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Credential {credential_id} not found")
    return _row_to_dict(row)


def _duplicate_exists(db: Session, company_id: int, exclude_id: Optional[int] = None) -> bool:
    params: dict = {"company_id": company_id}
    exclude_clause = ""
    if exclude_id is not None:
        exclude_clause = "AND id != :exclude_id"
        params["exclude_id"] = exclude_id
    row = db.execute(
        text(f"SELECT 1 FROM company_wialon_credentials WHERE company_id = :company_id {exclude_clause} LIMIT 1"),
        params,
    ).first()
    return row is not None


def _next_company_id(db: Session) -> int:
    row = db.execute(
        text("SELECT COALESCE(MAX(company_id), 0) + 1 AS next_id FROM company_wialon_credentials")
    ).first()
    return int(row.next_id) if row else 1


# --- Routes --------------------------------------------------------------

@router.get("/company-wialon-credentials")
def list_company_wialon_credentials(
    search: Optional[str] = Query(None, description="Filter by company name, contact person, or company_id"),
    is_active: Optional[bool] = Query(None, description="Filter by active status"),
    sort_by: str = Query("company_name", description="Column to sort by"),
    sort_dir: str = Query("asc", description="asc or desc"),
    db: Session = Depends(get_db),
):
    allowed_sort = {
        "id",
        "company_id",
        "company_name",
        "company_contact_person",
        "is_active",
        "created_at",
        "updated_at",
    }
    if sort_by not in allowed_sort:
        sort_by = "company_name"
    sort_dir = "DESC" if str(sort_dir).lower() == "desc" else "ASC"

    clauses, params = [], {}
    if search:
        clauses.append(
            "(company_name LIKE :search OR company_contact_person LIKE :search OR company_id LIKE :search)"
        )
        params["search"] = f"%{search}%"
    if is_active is not None:
        clauses.append("is_active = :is_active")
        params["is_active"] = 1 if is_active else 0
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    try:
        rows = db.execute(
            text(f"SELECT * FROM company_wialon_credentials {where} ORDER BY {sort_by} {sort_dir}"),
            params,
        )
        return {"status": "success", "data": [_row_to_dict(r) for r in rows]}
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read company_wialon_credentials -- has company_wialon_credentials.sql been run yet? ({e})",
        )


@router.post("/company-wialon-credentials/upload-logo")
async def upload_company_logo(file: UploadFile = File(...)):
    """Saves an uploaded logo image to disk and returns the URL to store in
    `company_logo`. PNG only, so every ExcelJS/reportlab export that embeds
    this logo can rely on a single known image format."""
    if file.content_type not in ALLOWED_LOGO_CONTENT_TYPES:
        raise HTTPException(status_code=400, detail="Only PNG images are supported for the company logo.")
    filename = f"{uuid.uuid4().hex}.png"
    dest_path = os.path.join(UPLOAD_DIR, filename)
    try:
        contents = await file.read()
        with open(dest_path, "wb") as f:
            f.write(contents)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Could not save logo: {e}")
    return {"status": "success", "url": f"/uploads/logos/{filename}"}


@router.get("/company-wialon-credentials/active-logo")
def get_active_company_logo(db: Session = Depends(get_db)):
    """Used by the frontend's shared logo-export helper and by the Payslip
    PDF builder -- returns the most recently updated active company's logo
    URL, or nulls if no company has an active record with a logo uploaded."""
    try:
        row = db.execute(
            text(
                """
                SELECT company_name, company_logo
                FROM company_wialon_credentials
                WHERE is_active = 1 AND company_logo IS NOT NULL AND company_logo != ''
                ORDER BY updated_at DESC
                LIMIT 1
                """
            )
        ).first()
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Could not look up active company logo: {e}")
    if not row:
        return {"status": "success", "logo_url": None, "company_name": None}
    data = _row_to_dict(row)
    return {"status": "success", "logo_url": data["company_logo"], "company_name": data["company_name"]}


@router.get("/company-wialon-credentials/{credential_id}")
def get_company_wialon_credential(credential_id: int, db: Session = Depends(get_db)):
    return {"status": "success", "data": _fetch_credential(db, credential_id)}


@router.post("/company-wialon-credentials", status_code=201)
def create_company_wialon_credential(payload: CompanyWialonCredentialIn, db: Session = Depends(get_db)):
    data = payload.model_dump()
    if not data.get("company_id"):
        data["company_id"] = _next_company_id(db)
    if not data.get("base_url"):
        data["base_url"] = DEFAULT_WIALON_BASE_URL

    if _duplicate_exists(db, data["company_id"]):
        raise HTTPException(
            status_code=409,
            detail=f"A Wialon credential record for company_id {data['company_id']} already exists.",
        )
    try:
        data["is_active"] = 1 if data["is_active"] else 0
        result = db.execute(
            text(
                """
                INSERT INTO company_wialon_credentials
                    (company_id, company_name, company_email, company_phone, company_address,
                     company_contact_person, company_website, company_logo, wialon_token, base_url, is_active)
                VALUES
                    (:company_id, :company_name, :company_email, :company_phone, :company_address,
                     :company_contact_person, :company_website, :company_logo, :wialon_token, :base_url, :is_active)
                """
            ),
            data,
        )
        db.commit()
        return {"status": "success", "data": _fetch_credential(db, result.lastrowid)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create credential: {e}")


@router.put("/company-wialon-credentials/{credential_id}")
def update_company_wialon_credential(
    credential_id: int, payload: CompanyWialonCredentialUpdate, db: Session = Depends(get_db)
):
    _fetch_credential(db, credential_id)  # 404 early if it doesn't exist

    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "company_id" in updates and _duplicate_exists(db, updates["company_id"], exclude_id=credential_id):
        raise HTTPException(
            status_code=409,
            detail=f"A Wialon credential record for company_id {updates['company_id']} already exists.",
        )

    if "is_active" in updates:
        updates["is_active"] = 1 if updates["is_active"] else 0

    set_clause = ", ".join(f"{col} = :{col}" for col in updates)
    updates["id"] = credential_id

    try:
        db.execute(
            text(f"UPDATE company_wialon_credentials SET {set_clause} WHERE id = :id"),
            updates,
        )
        db.commit()
        return {"status": "success", "data": _fetch_credential(db, credential_id)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update credential {credential_id}: {e}")


@router.delete("/company-wialon-credentials/{credential_id}")
def delete_company_wialon_credential(credential_id: int, db: Session = Depends(get_db)):
    _fetch_credential(db, credential_id)  # 404 early if it doesn't exist
    try:
        db.execute(
            text("DELETE FROM company_wialon_credentials WHERE id = :id"),
            {"id": credential_id},
        )
        db.commit()
        return {"status": "success", "message": f"Credential {credential_id} deleted"}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not delete credential {credential_id}: {e}")
