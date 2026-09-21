"""
Advance Clearance module -- PHASE 1.

Covers the master data, voucher CRUD (header + expense lines) and the
monthly listing. The approval workflow, attachments, dashboard and
exports are Phase 2; the schema already carries the columns they need
(app/advance_clearance.sql) so adding them will not require an ALTER on a
table holding live vouchers.

Run app/advance_clearance.sql once before using these endpoints.

Design notes that the rest of this file depends on:

  * Money is summed from the LINES, never stored on the voucher. A stored
    total is a second copy of the same fact and the two drift the moment
    a line is edited by anything that forgets to update it.

  * amount_usd IS stored per line, which is not a contradiction: the rate
    used is a fact about when the expense was cleared. Recomputing it
    later from a changed default rate would restate a voucher that has
    already been approved and paid.

  * voucher_no is generated here and protected by a UNIQUE key in the
    database. The generator races if two people create a voucher in the
    same second; the unique key turns that into a retry rather than a
    duplicate.
"""
import calendar
import hashlib
import io
import os
import uuid
from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.config.database import get_db
from app.services.auth_service import get_current_user

router = APIRouter()

DEFAULT_RATE_KEY = "default_exchange_rate"

# Where the logo upload endpoint saves files; company_logo URLs are
# relative to this.
UPLOADS_DIR = os.path.join(os.path.dirname(__file__), "..", "uploads")

# Used when no company logo has been uploaded in Settings yet. The same
# artwork the frontend bundles, so the PDF and the Excel form carry the
# identical mark rather than one of them printing blank.
DEFAULT_LOGO_PATH = os.path.join(
    os.path.dirname(__file__), "..", "assets", "mango-tracking-logo.png"
)

# A save may only put a voucher into one of these. Every later state is
# reached by a sign-off action (see WORKFLOW), never by editing the
# status field directly -- otherwise a voucher could be "Approved"
# without anyone having approved it.
EDITABLE_STATUSES = ("Draft", "Submitted")


# --- Money helpers -------------------------------------------------------

def _money(value) -> float:
    """Round half-up to 2dp and return a float.

    Python's round() is banker's rounding -- round(2.675, 2) is 2.67 --
    which is not what a finance form is expected to do. Decimal with
    ROUND_HALF_UP matches what the person with the receipts will compute
    by hand, and what MySQL's DECIMAL(14,2) will store.
    """
    return float(Decimal(str(value or 0)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _line_amount_usd(amount: float, currency: str, exchange_rate: Optional[float]) -> float:
    """USD value of one expense row.

    USD rows pass through untouched -- dividing by a rate of 1 would be
    the same number but would imply a conversion happened.

    KHR rows need a positive rate. A missing or zero rate is rejected by
    the caller rather than silently treated as 1, which would turn 40,000
    riels into $40,000.
    """
    if currency == "USD":
        return _money(amount)
    return _money(float(amount or 0) / float(exchange_rate))


# --- Request bodies ------------------------------------------------------

class MasterIn(BaseModel):
    """Shared shape for the four master lists."""
    name: str = Field(..., max_length=200)
    status: str = Field("Active")
    # Only advance_persons uses this; ignored elsewhere.
    department_id: Optional[int] = None

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, v: str) -> str:
        cleaned = (v or "").strip()
        if not cleaned:
            raise ValueError("Name is required")
        return cleaned

    @field_validator("status")
    @classmethod
    def _valid_status(cls, v: str) -> str:
        if v not in ("Active", "Inactive"):
            raise ValueError("status must be Active or Inactive")
        return v


class VoucherLineIn(BaseModel):
    expense_date: Optional[date] = None
    bill_no: Optional[str] = Field(None, max_length=100)
    category_id: Optional[int] = None
    description: Optional[str] = Field(None, max_length=500)
    expense_by_id: Optional[int] = None
    amount: float = Field(0, ge=0)
    currency: str = Field("USD")
    exchange_rate: Optional[float] = Field(None, gt=0)
    remarks: Optional[str] = Field(None, max_length=500)

    @field_validator("currency")
    @classmethod
    def _valid_currency(cls, v: str) -> str:
        if v not in ("USD", "KHR"):
            raise ValueError("currency must be USD or KHR")
        return v


class VoucherIn(BaseModel):
    period_year: int = Field(..., ge=2000, le=2100)
    period_month: int = Field(..., ge=1, le=12)
    department_id: Optional[int] = None
    person_id: int
    voucher_date: date
    # USER-SELECTED, and the voucher's scope: only Bill/Invoice Dates
    # inside this range belong to the voucher. Optional so a draft can be
    # started before the span is known, but once set it is enforced.
    expense_from_date: Optional[date] = None
    expense_to_date: Optional[date] = None
    cash_advance: float = Field(0, ge=0)
    status: str = Field("Draft")
    remarks: Optional[str] = Field(None, max_length=500)
    lines: List[VoucherLineIn] = []

    @model_validator(mode="after")
    def _period_is_sane(self):
        """From <= To, and the whole period inside the reporting month.

        A period that straddles two months would make "the August
        voucher" contain September bills, which is exactly what the
        month-level rule exists to prevent.
        """
        if self.expense_from_date and self.expense_to_date:
            if self.expense_from_date > self.expense_to_date:
                raise ValueError(
                    "Expense Period: the From date cannot be after the To date"
                )
        month_start, month_end = _month_bounds(self.period_year, self.period_month)
        for label, value in (
            ("From", self.expense_from_date),
            ("To", self.expense_to_date),
        ):
            if value and not (month_start <= value <= month_end):
                raise ValueError(
                    f"Expense Period {label} date {value.isoformat()} is outside "
                    f"{month_start.isoformat()} to {month_end.isoformat()}"
                )
        return self

    @field_validator("status")
    @classmethod
    def _phase1_status(cls, v: str) -> str:
        if v not in EDITABLE_STATUSES:
            raise ValueError(
                f"status must be one of {', '.join(EDITABLE_STATUSES)}. "
                "The later states are reached through the approval actions "
                "(Submit / Check / Acknowledge / Approve), so that each one "
                "is recorded against the person who performed it."
            )
        return v


# --- Helpers -------------------------------------------------------------

def _row_to_dict(row) -> dict:
    return dict(row._mapping)


def _default_rate(db: Session) -> float:
    row = db.execute(
        text("SELECT setting_value FROM advance_settings WHERE setting_key = :k"),
        {"k": DEFAULT_RATE_KEY},
    ).first()
    try:
        return float(row[0]) if row else 4100.0
    except (TypeError, ValueError):
        return 4100.0


def _next_voucher_no(db: Session, voucher_date: date) -> str:
    """VN + DDMMYYYY + "-" + a 3-digit sequence within that date.

    The sequence restarts each voucher_date, so the number stays short and
    readable. MAX(...) + 1 rather than COUNT(...) + 1: counting would
    reuse a number after a deletion and collide with the unique key.
    """
    prefix = f"VN{voucher_date.strftime('%d%m%Y')}-"
    row = db.execute(
        text(
            """
            SELECT MAX(CAST(SUBSTRING(voucher_no, :plen + 1) AS UNSIGNED)) AS seq
            FROM advance_vouchers
            WHERE voucher_no LIKE :like
            """
        ),
        {"plen": len(prefix), "like": f"{prefix}%"},
    ).first()
    nxt = int(row.seq or 0) + 1
    return f"{prefix}{nxt:03d}"


def _fetch_voucher(db: Session, voucher_id: int) -> dict:
    row = db.execute(
        text(
            """
            SELECT v.*, p.name AS person_name, d.name AS department_name
            FROM advance_vouchers v
            LEFT JOIN advance_persons p ON p.person_id = v.person_id
            LEFT JOIN advance_departments d ON d.department_id = v.department_id
            WHERE v.voucher_id = :id
            """
        ),
        {"id": voucher_id},
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Voucher {voucher_id} not found")

    voucher = _row_to_dict(row)
    lines = [
        _row_to_dict(r)
        for r in db.execute(
            text(
                """
                SELECT l.*, c.name AS category_name, o.name AS expense_by_name
                FROM advance_voucher_lines l
                LEFT JOIN advance_expense_categories c ON c.category_id = l.category_id
                LEFT JOIN advance_expense_by_options o ON o.expense_by_id = l.expense_by_id
                WHERE l.voucher_id = :id
                ORDER BY l.line_order, l.line_id
                """
            ),
            {"id": voucher_id},
        )
    ]
    voucher["lines"] = lines
    voucher["approvals"] = _fetch_approvals(db, voucher_id)
    voucher["signoffs"] = _signoffs_by_action(voucher["approvals"])
    voucher.update(_totals(float(voucher.get("cash_advance") or 0),
                           sum(float(l["amount_usd"] or 0) for l in lines)))
    return voucher


def _totals(cash_advance: float, total_expense: float) -> dict:
    """Balance, and what it means in the form's own language.

        Balance = Total Cash Advance - Total Actual Expense

    Positive  -> the person is holding money that is not theirs: Return.
    Negative  -> they spent their own money: Refund/Reimbursement.
    Zero      -> Cleared.

    amount_return and amount_refund are both reported as POSITIVE numbers
    because that is how they are written on a form and paid; the sign
    lives in `balance` alone. Reporting a refund as -85.00 in a column
    headed "Amount Refund" invites it being entered as a negative payment.
    """
    balance = _money(cash_advance - total_expense)
    return {
        "total_actual_expense": _money(total_expense),
        "total_cash_advance": _money(cash_advance),
        "balance": balance,
        "amount_return": balance if balance > 0 else 0.0,
        "amount_refund": _money(-balance) if balance < 0 else 0.0,
        "balance_status": (
            "Return" if balance > 0 else "Refund" if balance < 0 else "Cleared"
        ),
    }


def _month_bounds(year: int, month: int) -> tuple:
    """First and last day of a reporting month, inclusive."""
    last_day = calendar.monthrange(year, month)[1]
    return date(year, month, 1), date(year, month, last_day)


def _category_names(db: Session) -> dict:
    """{category_id: name}, for sorting rows by category NAME.

    Sorting by category_id would order rows by whenever the category
    happened to be created, which is arbitrary to anyone reading the
    voucher. Name is what they actually see.
    """
    try:
        rows = db.execute(text("SELECT category_id, name FROM advance_expense_categories"))
        return {r.category_id: r.name for r in rows}
    except SQLAlchemyError:
        return {}


def _sort_key(line: dict, names: dict) -> tuple:
    """Category, then Bill/Invoice Date oldest first.

    Rows with no category sort last rather than first: an uncategorised
    row is usually unfinished, and burying it at the top pushes the real
    groups down. Same for a missing date within a group -- date.max keeps
    it at the end of its own category instead of leading it.
    """
    category = names.get(line.get("category_id"), "")
    return (
        category == "",              # False (0) sorts before True (1)
        category.lower(),
        line.get("expense_date") or date.max,
    )


def _resolve_lines(
    db: Session,
    lines: List[VoucherLineIn],
    period_year: int,
    period_month: int,
    expense_from: Optional[date] = None,
    expense_to: Optional[date] = None,
) -> List[dict]:
    """Validate each row, compute its USD value, and sort the rows.

    Done here rather than trusting the client so the report, the export
    and anything added later all read the same number -- the frontend's
    live total is a preview, not the source of truth. The sort is applied
    here too, so the stored line_order matches what everything downstream
    displays instead of each screen sorting for itself.
    """
    default_rate = _default_rate(db)
    month_start, month_end = _month_bounds(period_year, period_month)
    # The Expense Period narrows the month. When it is not set yet, the
    # month itself is the bound -- so a draft still cannot pick up a bill
    # from another month.
    period_start = expense_from or month_start
    period_end = expense_to or month_end
    resolved = []
    for idx, line in enumerate(lines):
        # Every Bill/Invoice Date must fall inside the Expense Period.
        # The period IS the voucher's scope -- a row outside it is not
        # part of this voucher, and storing one would make the header's
        # stated span disagree with the rows underneath it.
        if line.expense_date and not (period_start <= line.expense_date <= period_end):
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Row {idx + 1}: Bill/Invoice Date "
                    f"{line.expense_date.isoformat()} is outside the Expense Period "
                    f"({period_start.isoformat()} to {period_end.isoformat()}). "
                    "Widen the Expense Period, or move the expense to the "
                    "voucher that covers that date."
                ),
            )
        rate = line.exchange_rate
        if line.currency == "KHR":
            # Fall back to the configured rate when the row does not carry
            # one, so a KHR row can never be stored unconverted.
            rate = rate or default_rate
            if not rate or rate <= 0:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"Row {idx + 1}: a KHR amount needs a positive exchange rate. "
                        "Set one on the row, or configure the default rate in "
                        "Advance Settings."
                    ),
                )
        else:
            rate = None  # not applicable to a USD row

        resolved.append(
            {
                # Placeholder -- rewritten below once the rows are sorted.
                "line_order": idx,
                "expense_date": line.expense_date,
                "bill_no": (line.bill_no or "").strip() or None,
                "category_id": line.category_id,
                "description": (line.description or "").strip() or None,
                "expense_by_id": line.expense_by_id,
                "amount": _money(line.amount),
                "currency": line.currency,
                "exchange_rate": rate,
                "amount_usd": _line_amount_usd(line.amount, line.currency, rate),
                "remarks": (line.remarks or "").strip() or None,
            }
        )

    # Category, then date. Sorted AFTER validation so the row numbers in
    # any error message still refer to the order the user entered.
    names = _category_names(db)
    resolved.sort(key=lambda l: _sort_key(l, names))
    for position, line in enumerate(resolved):
        line["line_order"] = position
    return resolved


def _replace_lines(db: Session, voucher_id: int, lines: List[dict]) -> None:
    """Delete-then-insert, inside the caller's transaction.

    Diffing the rows would need a stable client-side id per row, which a
    freely add/delete/reorder table does not have. Wholesale replacement
    is correct and simple; it is safe because it is never committed
    separately from the insert that follows.
    """
    db.execute(
        text("DELETE FROM advance_voucher_lines WHERE voucher_id = :id"),
        {"id": voucher_id},
    )
    for line in lines:
        db.execute(
            text(
                """
                INSERT INTO advance_voucher_lines
                    (voucher_id, line_order, expense_date, bill_no, category_id,
                     description, expense_by_id, amount, currency, exchange_rate,
                     amount_usd, remarks)
                VALUES
                    (:voucher_id, :line_order, :expense_date, :bill_no, :category_id,
                     :description, :expense_by_id, :amount, :currency, :exchange_rate,
                     :amount_usd, :remarks)
                """
            ),
            {**line, "voucher_id": voucher_id},
        )


MISSING_TABLE_HINT = (
    "The Advance Clearance tables are missing. Run "
    "app/advance_clearance.sql against the database, then try again."
)


def _db_detail(e: Exception, action: str) -> str:
    message = str(e)
    if "doesn't exist" in message or "Unknown column" in message:
        return f"{MISSING_TABLE_HINT} ({message})"
    return f"Could not {action}: {message}"


# --- Master data ---------------------------------------------------------
#
# Four lists, identical apart from their table and key column, so one set
# of handlers serves all four rather than four near-copies that drift.

MASTERS = {
    "departments": ("advance_departments", "department_id", False),
    "persons": ("advance_persons", "person_id", True),   # True == has department_id
    "categories": ("advance_expense_categories", "category_id", False),
    "expense-by": ("advance_expense_by_options", "expense_by_id", False),
}


def _master(kind: str):
    if kind not in MASTERS:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown list '{kind}'. Expected one of: {', '.join(MASTERS)}",
        )
    return MASTERS[kind]


@router.get("/advance/master/{kind}")
def list_master(
    kind: str,
    status: str = Query("Active", description="Active, Inactive, or All"),
    department_id: Optional[int] = Query(
        None, description="Persons only -- filter the list to one department"
    ),
    db: Session = Depends(get_db),
):
    table, pk, has_department = _master(kind)

    clauses, params = [], {}
    if status and status.lower() != "all":
        clauses.append("status = :status")
        params["status"] = status.capitalize()
    if has_department and department_id is not None:
        clauses.append("department_id = :department_id")
        params["department_id"] = department_id
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    try:
        rows = db.execute(text(f"SELECT * FROM {table} {where} ORDER BY name"), params)
        return {"status": "success", "data": [_row_to_dict(r) for r in rows]}
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=_db_detail(e, f"read {kind}"))


@router.post("/advance/master/{kind}", status_code=201)
def create_master(kind: str, payload: MasterIn, db: Session = Depends(get_db)):
    table, pk, has_department = _master(kind)
    cols = ["name", "status"] + (["department_id"] if has_department else [])
    params = {
        "name": payload.name,
        "status": payload.status,
        **({"department_id": payload.department_id} if has_department else {}),
    }
    try:
        result = db.execute(
            text(
                f"INSERT INTO {table} ({', '.join(cols)}) "
                f"VALUES ({', '.join(':' + c for c in cols)})"
            ),
            params,
        )
        db.commit()
        row = db.execute(
            text(f"SELECT * FROM {table} WHERE {pk} = :id"), {"id": result.lastrowid}
        ).first()
        return {"status": "success", "data": _row_to_dict(row)}
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f"'{payload.name}' already exists.")
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=_db_detail(e, f"create {kind}"))


@router.put("/advance/master/{kind}/{record_id}")
def update_master(kind: str, record_id: int, payload: MasterIn, db: Session = Depends(get_db)):
    table, pk, has_department = _master(kind)
    sets = ["name = :name", "status = :status"] + (
        ["department_id = :department_id"] if has_department else []
    )
    params = {
        "id": record_id,
        "name": payload.name,
        "status": payload.status,
        **({"department_id": payload.department_id} if has_department else {}),
    }
    try:
        result = db.execute(
            text(f"UPDATE {table} SET {', '.join(sets)} WHERE {pk} = :id"), params
        )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail=f"{kind} {record_id} not found")
        db.commit()
        row = db.execute(text(f"SELECT * FROM {table} WHERE {pk} = :id"), {"id": record_id}).first()
        return {"status": "success", "data": _row_to_dict(row)}
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f"'{payload.name}' already exists.")
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=_db_detail(e, f"update {kind}"))


@router.delete("/advance/master/{kind}/{record_id}")
def deactivate_master(kind: str, record_id: int, db: Session = Depends(get_db)):
    """Soft delete. A category or person named on a historical voucher must
    keep resolving; a hard delete would fail on the foreign key or orphan
    the voucher."""
    table, pk, _ = _master(kind)
    try:
        result = db.execute(
            text(f"UPDATE {table} SET status = 'Inactive' WHERE {pk} = :id"),
            {"id": record_id},
        )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail=f"{kind} {record_id} not found")
        db.commit()
        return {"status": "success", "message": f"{kind} {record_id} deactivated"}
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=_db_detail(e, f"deactivate {kind}"))


# --- Settings ------------------------------------------------------------

@router.get("/advance/settings")
def get_settings(db: Session = Depends(get_db)):
    try:
        rows = db.execute(text("SELECT setting_key, setting_value FROM advance_settings"))
        settings = {r.setting_key: r.setting_value for r in rows}
        return {
            "status": "success",
            "settings": settings,
            "default_exchange_rate": _default_rate(db),
        }
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=_db_detail(e, "read settings"))


class SettingIn(BaseModel):
    default_exchange_rate: float = Field(..., gt=0)


@router.put("/advance/settings")
def update_settings(payload: SettingIn, db: Session = Depends(get_db)):
    """Changing the default rate affects only vouchers created AFTER the
    change -- existing lines keep the rate stored on them, so an approved
    voucher's totals never move."""
    try:
        db.execute(
            text(
                """
                INSERT INTO advance_settings (setting_key, setting_value)
                VALUES (:k, :v)
                ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)
                """
            ),
            {"k": DEFAULT_RATE_KEY, "v": str(payload.default_exchange_rate)},
        )
        db.commit()
        return {"status": "success", "default_exchange_rate": payload.default_exchange_rate}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=_db_detail(e, "update settings"))


# --- Approval trail ------------------------------------------------------
#
# The workflow, and what each action is allowed to move FROM.
#
# Encoded as a table rather than a chain of ifs so the rules are legible
# in one place and the frontend can be handed the same map -- a button the
# user cannot use should not be offered in the first place.
WORKFLOW = {
    "Submit":      {"from": ("Draft",),          "to": "Submitted",     "label": "Requested by"},
    "Check":       {"from": ("Submitted",),      "to": "Checked",       "label": "Checked by: Acc"},
    "Acknowledge": {"from": ("Checked",),        "to": "Acknowledged",  "label": "Acknowledged by: FM"},
    "Approve":     {"from": ("Acknowledged",),   "to": "Approved",      "label": "Approved by: CFO"},
    "Complete":    {"from": ("Approved",),       "to": "Completed",     "label": "Completed by"},
    # Sends the voucher back to the requester to fix. Allowed from any
    # mid-flight state -- whoever spots the problem should be able to
    # return it without first passing it further along.
    "Reject":      {"from": ("Submitted", "Checked", "Acknowledged"),
                    "to": "Draft",               "label": "Rejected by"},
    # Unlocks an approved voucher for editing. Deliberately narrow: only
    # from Approved/Completed, and it leaves its own trail entry, so a
    # reopened voucher can never look as though it was never approved.
    "Reopen":      {"from": ("Approved", "Completed"),
                    "to": "Draft",               "label": "Reopened by"},
}

class ApprovalIn(BaseModel):
    action: str
    comments: Optional[str] = Field(None, max_length=500)

    @field_validator("action")
    @classmethod
    def _known_action(cls, v: str) -> str:
        if v not in WORKFLOW:
            raise ValueError(f"action must be one of: {', '.join(WORKFLOW)}")
        return v


def _approval_reference(voucher_no: str, action: str, user_id: Optional[int]) -> str:
    """Short, quotable reference printed beside the name on the form.

    Format: <VOUCHER_NO>/<ACT>/<8 hex chars>

    The hex is a digest of the voucher, action, user and the exact moment,
    so two sign-offs never collide and the value cannot be guessed from
    the voucher number alone. It is an INDEX into the audit row, not a
    cryptographic signature -- it proves nothing on its own, and is only
    meaningful when looked up against the record it points at.
    """
    seed = f"{voucher_no}|{action}|{user_id}|{datetime.utcnow().isoformat()}|{uuid.uuid4()}"
    digest = hashlib.sha256(seed.encode()).hexdigest()[:8].upper()
    return f"{voucher_no}/{action[:3].upper()}/{digest}"


def _fetch_approvals(db: Session, voucher_id: int) -> list:
    """Every sign-off on this voucher, oldest first."""
    try:
        rows = db.execute(
            text(
                """
                SELECT * FROM advance_voucher_approvals
                WHERE voucher_id = :id
                ORDER BY signed_at, approval_id
                """
            ),
            {"id": voucher_id},
        )
        return [_row_to_dict(r) for r in rows]
    except SQLAlchemyError as e:
        # The approvals migration is separate from the module's own. If it
        # has not been run, the voucher still opens -- it simply has no
        # trail yet, which is exactly true.
        print(f"DEBUG: approvals table unavailable: {e}")
        return []


def _signoffs_by_action(approvals: list) -> dict:
    """{action: the LATEST sign-off for it}.

    Latest, not first: a voucher that was rejected and re-submitted should
    print the sign-off that actually stands, not the superseded one. The
    full history is still in the trail.
    """
    latest: dict = {}
    for a in approvals:
        latest[a["action"]] = a
    return latest


@router.get("/advance/vouchers/{voucher_id}/approvals")
def list_approvals(voucher_id: int, db: Session = Depends(get_db)):
    _fetch_voucher(db, voucher_id)  # 404 early
    return {"status": "success", "data": _fetch_approvals(db, voucher_id)}


@router.post("/advance/vouchers/{voucher_id}/approvals", status_code=201)
def record_approval(
    voucher_id: int,
    payload: ApprovalIn,
    db: Session = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Record one sign-off and move the voucher to its next status.

    The name stored here is the LOGGED-IN user's, never a name typed into
    a form -- that is the whole point. A typed name proves nothing; a name
    captured from the authenticated session, with the moment it happened,
    is a record someone can stand behind.
    """
    voucher = _fetch_voucher(db, voucher_id)
    rule = WORKFLOW[payload.action]

    # The printed signature must be a person's name, not a login handle.
    # users.full_name is optional (see app/routes/users.py), so an account
    # can reach this point with nothing but a username -- and "admin" on a
    # signed finance document is worse than refusing the click.
    #
    # Stripped before testing: a full_name of "   " satisfies a plain
    # truthiness check while printing as blank space.
    signer_name = (current_user.get("full_name") or "").strip()
    if not signer_name:
        raise HTTPException(
            status_code=422,
            detail=(
                "Your user account has no Full Name set, and the Full Name is "
                "what gets printed on the voucher's signature block. Set it in "
                "Settings > User Management, then sign off again."
            ),
        )

    if voucher["status"] not in rule["from"]:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot {payload.action.lower()} a voucher that is "
                f"{voucher['status']}. This step is only available from: "
                f"{', '.join(rule['from'])}."
            ),
        )

    reference = _approval_reference(voucher["voucher_no"], payload.action, current_user.get("user_id"))
    try:
        db.execute(
            text(
                """
                INSERT INTO advance_voucher_approvals
                    (voucher_id, action, user_id, user_name, username,
                     status_after, comments, reference)
                VALUES
                    (:voucher_id, :action, :user_id, :user_name, :username,
                     :status_after, :comments, :reference)
                """
            ),
            {
                "voucher_id": voucher_id,
                "action": payload.action,
                "user_id": current_user.get("user_id"),
                # The User Management Full Name, verbatim. Copied rather
                # than joined at read time: a sign-off records the name that
                # signed, so a later rename must not rewrite history.
                "user_name": signer_name,
                "username": current_user.get("username"),
                "status_after": rule["to"],
                "comments": (payload.comments or "").strip() or None,
                "reference": reference,
            },
        )
        db.execute(
            text("UPDATE advance_vouchers SET status = :status WHERE voucher_id = :id"),
            {"status": rule["to"], "id": voucher_id},
        )
        # One commit: a status change without its trail entry would be an
        # unexplained state, and a trail entry without the status change
        # would describe something that did not happen.
        db.commit()
        return {"status": "success", "data": _fetch_voucher(db, voucher_id)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail=(
                "Could not record the approval. Has "
                "app/advance_clearance_approvals.sql been run? "
                f"({e})"
            ),
        )


# --- Vouchers ------------------------------------------------------------

def _parse_voucher_ids(raw: Optional[str]) -> Optional[List[int]]:
    """Comma-separated voucher IDs from the query string, or None.

    Returns None when nothing was passed -- "no selection" and "an empty
    selection" have to stay distinguishable: the first means export
    everything the filters match, the second means export nothing, and
    silently turning the second into the first would hand someone a
    hundred vouchers when they asked for none.

    Non-numeric fragments are dropped rather than raising: the IDs come
    from checkboxes the UI rendered, so a bad one is a bug on our side,
    and failing the whole download over it helps nobody.
    """
    if raw is None:
        return None
    ids: List[int] = []
    for part in str(raw).split(","):
        part = part.strip()
        if not part:
            continue
        try:
            ids.append(int(part))
        except ValueError:
            continue
    return ids


def _voucher_filters(
    period_year, period_month, department_id, person_id, status, search, start_date, end_date,
    voucher_ids: Optional[List[int]] = None,
) -> tuple:
    """Build the WHERE clause once, for both the listing and the export.

    Shared deliberately: "the export must match what is on screen" is only
    guaranteed if there is literally one filter implementation. Two copies
    agree right up until someone edits one of them.

    voucher_ids narrows to an explicit set (the ticked checkboxes) ON TOP
    of the other filters rather than replacing them. Keeping both means a
    stale ID from a voucher that has since been deleted, or that no longer
    matches the current month, simply returns nothing for that row instead
    of smuggling an out-of-scope voucher into the file.
    """
    clauses, params = [], {}
    if voucher_ids is not None:
        if not voucher_ids:
            # An empty selection matches nothing. 1 = 0 rather than an
            # empty IN (), which is a syntax error in MySQL.
            clauses.append("1 = 0")
        else:
            names = [f"sel{i}" for i in range(len(voucher_ids))]
            clauses.append(
                "v.voucher_id IN (" + ", ".join(f":{n}" for n in names) + ")"
            )
            params.update(dict(zip(names, voucher_ids)))
    if period_year is not None:
        clauses.append("v.period_year = :period_year")
        params["period_year"] = period_year
    if period_month is not None:
        clauses.append("v.period_month = :period_month")
        params["period_month"] = period_month
    if department_id is not None:
        clauses.append("v.department_id = :department_id")
        params["department_id"] = department_id
    if person_id is not None:
        clauses.append("v.person_id = :person_id")
        params["person_id"] = person_id
    if status and status.lower() != "all":
        clauses.append("v.status = :status")
        params["status"] = status
    if start_date is not None:
        clauses.append("v.voucher_date >= :start_date")
        params["start_date"] = start_date
    if end_date is not None:
        clauses.append("v.voucher_date <= :end_date")
        params["end_date"] = end_date
    if search and search.strip():
        clauses.append("(v.voucher_no LIKE :search OR p.name LIKE :search)")
        params["search"] = f"%{search.strip()}%"

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    return where, params


@router.get("/advance/vouchers/export")
def export_vouchers(
    period_year: Optional[int] = Query(None),
    period_month: Optional[int] = Query(None, ge=1, le=12),
    department_id: Optional[int] = Query(None),
    person_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    start_date: Optional[date] = Query(None),
    end_date: Optional[date] = Query(None),
    voucher_ids: Optional[str] = Query(
        None,
        description=(
            "Comma-separated voucher_id list -- the ticked checkboxes. "
            "Omit to export every voucher the other filters match."
        ),
    ),
    db: Session = Depends(get_db),
):
    """The same vouchers the listing returns, each WITH its expense rows.

    Declared before /advance/vouchers/{voucher_id} on purpose: FastAPI
    matches routes in order, so the other way round "export" would be
    parsed as a voucher_id and rejected as a bad integer.

    Two queries, not one-per-voucher: the vouchers, then every line
    belonging to them in a single IN (...). A month of vouchers would
    otherwise be dozens of round trips.
    """
    where, params = _voucher_filters(
        period_year, period_month, department_id, person_id, status, search,
        start_date, end_date, _parse_voucher_ids(voucher_ids),
    )
    try:
        voucher_rows = db.execute(
            text(
                f"""
                SELECT v.*, p.name AS person_name, d.name AS department_name
                FROM advance_vouchers v
                LEFT JOIN advance_persons p ON p.person_id = v.person_id
                LEFT JOIN advance_departments d ON d.department_id = v.department_id
                {where}
                ORDER BY v.voucher_date, v.voucher_no
                """
            ),
            params,
        )
        vouchers = [_row_to_dict(r) for r in voucher_rows]
        if not vouchers:
            return {"status": "success", "data": []}

        ids = [v["voucher_id"] for v in vouchers]
        id_params = {f"id{i}": vid for i, vid in enumerate(ids)}
        placeholders = ", ".join(f":id{i}" for i in range(len(ids)))
        line_rows = db.execute(
            text(
                f"""
                SELECT l.*, c.name AS category_name, o.name AS expense_by_name
                FROM advance_voucher_lines l
                LEFT JOIN advance_expense_categories c ON c.category_id = l.category_id
                LEFT JOIN advance_expense_by_options o ON o.expense_by_id = l.expense_by_id
                WHERE l.voucher_id IN ({placeholders})
                ORDER BY l.voucher_id, l.line_order, l.line_id
                """
            ),
            id_params,
        )
        lines_by_voucher: dict = {}
        for r in line_rows:
            line = _row_to_dict(r)
            lines_by_voucher.setdefault(line["voucher_id"], []).append(line)

        approvals_by_voucher: dict = {}
        try:
            for r in db.execute(
                text(
                    f"""
                    SELECT * FROM advance_voucher_approvals
                    WHERE voucher_id IN ({placeholders})
                    ORDER BY signed_at, approval_id
                    """
                ),
                id_params,
            ):
                a = _row_to_dict(r)
                approvals_by_voucher.setdefault(a["voucher_id"], []).append(a)
        except SQLAlchemyError as e:
            # Same rule as _fetch_approvals: no trail table yet means no
            # sign-offs to print, not a failed export.
            print(f"DEBUG: approvals unavailable for export: {e}")

        for v in vouchers:
            v["lines"] = lines_by_voucher.get(v["voucher_id"], [])
            v["approvals"] = approvals_by_voucher.get(v["voucher_id"], [])
            v["signoffs"] = _signoffs_by_action(v["approvals"])
            # Totalled from the same lines that are about to be written
            # into the sheet, so the export's footer can never disagree
            # with the rows above it.
            v.update(
                _totals(
                    float(v.get("cash_advance") or 0),
                    sum(float(l["amount_usd"] or 0) for l in v["lines"]),
                )
            )
        return {"status": "success", "data": vouchers}
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=_db_detail(e, "export vouchers"))


def _resolve_company_logo_path(db: Session) -> Optional[str]:
    """Filesystem path to the active company's uploaded logo, or None.

    Same resolution the Payslip PDF uses, so every printed document in the
    system carries the same mark.
    """
    try:
        row = db.execute(
            text(
                """
                SELECT company_logo
                FROM company_wialon_credentials
                WHERE is_active = 1 AND company_logo IS NOT NULL AND company_logo != ''
                ORDER BY updated_at DESC
                LIMIT 1
                """
            )
        ).first()
    except SQLAlchemyError:
        return None
    if not row or not row.company_logo:
        return None
    relative = row.company_logo.lstrip("/")
    if relative.startswith("uploads/"):
        relative = relative[len("uploads/"):]
    path = os.path.join(UPLOADS_DIR, relative)
    return path if os.path.isfile(path) else None


def _build_voucher_pdf(vouchers: list, logo_path: Optional[str] = None) -> bytes:
    """One A4 page per voucher, laid out like the printed Advance
    Clearance Form: logo, title, header pairs, the five-column expense
    table, the three totals, and the four sign-off blocks.

    Deliberately mirrors the Excel export rather than reusing it -- the
    two render from the SAME already-sorted rows the API returns, so they
    agree without one depending on the other.
    """
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        Image,
        PageBreak,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    NAVY = colors.HexColor("#051650")
    BORDER = colors.HexColor("#BFBFBF")

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("T", parent=styles["Normal"], fontName="Helvetica-Bold",
                                 fontSize=15, alignment=TA_CENTER, spaceAfter=2)
    label_style = ParagraphStyle("L", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=8.5)
    value_style = ParagraphStyle("V", parent=styles["Normal"], fontName="Helvetica", fontSize=8.5)
    head_style = ParagraphStyle("H", parent=styles["Normal"], fontName="Helvetica-Bold",
                                fontSize=8, textColor=colors.white, alignment=TA_CENTER)
    cell_style = ParagraphStyle("C", parent=styles["Normal"], fontName="Helvetica", fontSize=8, leading=10)
    money_style = ParagraphStyle("M", parent=styles["Normal"], fontName="Helvetica",
                                 fontSize=8, alignment=TA_RIGHT)
    total_style = ParagraphStyle("TT", parent=styles["Normal"], fontName="Helvetica-Bold",
                                 fontSize=8.5, alignment=TA_RIGHT)
    sig_label_style = ParagraphStyle("SL", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=8)
    sig_style = ParagraphStyle("S", parent=styles["Normal"], fontName="Helvetica", fontSize=7.5, leading=10)
    ref_style = ParagraphStyle("R", parent=styles["Normal"], fontName="Helvetica",
                               fontSize=6, textColor=colors.HexColor("#888888"), leading=8)

    def fmt_date(value, fmt="%d-%b-%Y"):
        if not value:
            return ""
        if isinstance(value, str):
            value = value[:19].replace("T", " ")
            for pattern in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
                try:
                    value = datetime.strptime(value, pattern)
                    break
                except ValueError:
                    continue
            else:
                return str(value)
        return value.strftime(fmt)

    def usd(v):
        return f"$ {float(v or 0):,.2f}"

    story = []
    # An uploaded company logo wins; otherwise fall back to the bundled
    # artwork. Only None if even that is missing from the deployment.
    effective_logo = logo_path if logo_path and os.path.isfile(logo_path) else (
        DEFAULT_LOGO_PATH if os.path.isfile(DEFAULT_LOGO_PATH) else None
    )

    for index, v in enumerate(vouchers):
        if index > 0:
            story.append(PageBreak())

        if effective_logo:
            # 3.15:1, matching the source artwork and the Excel export.
            story.append(Image(effective_logo, width=55 * mm, height=17.5 * mm))
            story.append(Spacer(1, 4))
        story.append(Paragraph("Advance Clearance Form", title_style))
        story.append(Spacer(1, 6))

        period = ""
        if v.get("expense_from_date") and v.get("expense_to_date"):
            period = f"{fmt_date(v['expense_from_date'])} - {fmt_date(v['expense_to_date'])}"
        elif v.get("voucher_date"):
            period = fmt_date(v["voucher_date"])

        header = Table(
            [
                [Paragraph("Department :", label_style), Paragraph(v.get("department_name") or "", value_style),
                 Paragraph("Voucher No:", label_style), Paragraph(v.get("voucher_no") or "", value_style)],
                [Paragraph("Name :", label_style), Paragraph(v.get("person_name") or "", value_style),
                 Paragraph("Voucher Date:", label_style), Paragraph(period, value_style)],
            ],
            colWidths=[28 * mm, 55 * mm, 48 * mm, 50 * mm],
        )
        header.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 2),
        ]))
        story.append(header)
        story.append(Spacer(1, 8))

        data = [[
            Paragraph("Bill/Inv. Date", head_style),
            Paragraph("Bill/Inv. No", head_style),
            Paragraph("Description + Principal name related expense (if applicable)", head_style),
            Paragraph("USD/RIELS", head_style),
            Paragraph("Remarks", head_style),
        ]]

        lines = v.get("lines") or []
        for l in lines:
            khr = ""
            if l.get("currency") == "KHR":
                khr = f"KHR {float(l.get('amount') or 0):,.0f} @ {float(l.get('exchange_rate') or 0):,.0f}"
            remark = " | ".join(x for x in [l.get("remarks") or "", khr] if x)
            data.append([
                Paragraph(fmt_date(l.get("expense_date"), "%d-%b-%y"), cell_style),
                Paragraph(l.get("bill_no") or "", cell_style),
                Paragraph(l.get("description") or "", cell_style),
                Paragraph(usd(l.get("amount_usd")), money_style),
                Paragraph(remark, cell_style),
            ])
        if not lines:
            data.append([Paragraph("(no expense rows recorded)", cell_style), "", "", "", ""])

        totals = [
            ("Total Actual Expense", v.get("total_actual_expense"), ""),
            ("Total Cash Advance", v.get("total_cash_advance"), ""),
            (
                "Amount Return/Amount Refund",
                v.get("amount_refund") if v.get("balance_status") == "Refund" else v.get("amount_return"),
                v.get("balance_status") or "",
            ),
        ]
        for label, value, note in totals:
            data.append([Paragraph(label, total_style), "", "",
                         Paragraph(usd(value), total_style), Paragraph(note, cell_style)])

        table = Table(data, colWidths=[22 * mm, 22 * mm, 74 * mm, 24 * mm, 39 * mm], repeatRows=1)
        first_total = len(data) - 3
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), NAVY),
            ("GRID", (0, 0), (-1, -1), 0.4, BORDER),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            # The three total rows span the first three columns, mirroring
            # the merged cells in the Excel form.
            ("SPAN", (0, first_total), (2, first_total)),
            ("SPAN", (0, first_total + 1), (2, first_total + 1)),
            ("SPAN", (0, first_total + 2), (2, first_total + 2)),
            ("BACKGROUND", (0, first_total), (-1, -1), colors.HexColor("#F5F5F5")),
        ]))
        story.append(table)
        story.append(Spacer(1, 14))

        # Sign-off blocks, filled from the approval trail -- blank where
        # nobody has signed, so the page can be signed by hand.
        signoffs = v.get("signoffs") or {}

        def block(label, action):
            a = signoffs.get(action)
            name = (a or {}).get("user_name") or ""
            when = fmt_date((a or {}).get("signed_at"), "%d-%b-%Y %H:%M") if a else ""
            ref = (a or {}).get("reference") or ""
            return [
                Paragraph(label, sig_label_style),
                Spacer(1, 30),
                Paragraph(f"Name: {name}" if name else "Name:", sig_style),
                Paragraph(f"Date: {when}" if when else "Date:", sig_style),
                Paragraph(f"Ref: {ref}" if ref else "", ref_style),
            ]

        sig = Table(
            [[
                block("Requested by:", "Submit"),
                block("Checked by: Acc", "Check"),
                block("Acknowledged by: FM", "Acknowledge"),
                block("Approved by: CFO", "Approve"),
            ]],
            colWidths=[45 * mm, 45 * mm, 45 * mm, 46 * mm],
        )
        sig.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
        story.append(sig)

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=A4,
        leftMargin=12 * mm, rightMargin=12 * mm,
        topMargin=12 * mm, bottomMargin=12 * mm,
        title="Advance Clearance Form",
    )
    doc.build(story)
    return buffer.getvalue()


@router.get("/advance/vouchers/pdf")
def export_vouchers_pdf(
    period_year: Optional[int] = Query(None),
    period_month: Optional[int] = Query(None, ge=1, le=12),
    department_id: Optional[int] = Query(None),
    person_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    start_date: Optional[date] = Query(None),
    end_date: Optional[date] = Query(None),
    voucher_ids: Optional[str] = Query(
        None,
        description=(
            "Comma-separated voucher_id list -- the ticked checkboxes. "
            "Omit to export every voucher the other filters match."
        ),
    ),
    db: Session = Depends(get_db),
):
    """The same vouchers the Excel export produces, as a print-ready PDF.

    Declared before /advance/vouchers/{voucher_id} for the same reason the
    Excel export is: FastAPI matches in order, and "pdf" is not an int.

    Reuses export_vouchers() outright rather than repeating the queries --
    so the two downloads can never contain different data.
    """
    payload = export_vouchers(
        period_year, period_month, department_id, person_id, status, search,
        start_date, end_date, voucher_ids, db,
    )
    vouchers = payload.get("data") or []
    if not vouchers:
        # Worded differently depending on why it is empty. "No vouchers
        # match the current filters" is confusing when the real answer is
        # that the ticked voucher is no longer in the filtered month.
        raise HTTPException(
            status_code=404,
            detail=(
                "None of the selected vouchers are available to export. They may "
                "have been deleted, or they fall outside the current filters."
                if voucher_ids
                else "No vouchers match the current filters."
            ),
        )

    try:
        pdf_bytes = _build_voucher_pdf(vouchers, logo_path=_resolve_company_logo_path(db))
    except ImportError as e:
        raise HTTPException(
            status_code=500,
            detail=f"PDF support needs reportlab installed on the server ({e}).",
        )

    filename = (
        f"Advance_Clearance_{vouchers[0]['voucher_no']}.pdf"
        if len(vouchers) == 1
        else f"Advance_Clearance_{len(vouchers)}_vouchers.pdf"
    )
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/advance/vouchers")
def list_vouchers(
    period_year: Optional[int] = Query(None),
    period_month: Optional[int] = Query(None, ge=1, le=12),
    department_id: Optional[int] = Query(None),
    person_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None, description="Voucher status, or All"),
    search: Optional[str] = Query(
        None, description="Partial, case-insensitive match on Voucher No. or person name"
    ),
    start_date: Optional[date] = Query(None, description="voucher_date from"),
    end_date: Optional[date] = Query(None, description="voucher_date to"),
    db: Session = Depends(get_db),
):
    """One row per voucher, with its expense total summed from the lines.

    The totals come from a LEFT JOIN + GROUP BY rather than a query per
    voucher: the listing shows a page of vouchers at a time and a
    per-row query would be one round trip each. LEFT JOIN so a voucher
    with no lines yet still appears, with a total of 0.
    """
    where, params = _voucher_filters(
        period_year, period_month, department_id, person_id, status, search,
        start_date, end_date,
    )
    try:
        rows = db.execute(
            text(
                f"""
                SELECT v.*,
                       p.name AS person_name,
                       d.name AS department_name,
                       COALESCE(SUM(l.amount_usd), 0) AS total_actual_expense,
                       COUNT(l.line_id) AS line_count
                FROM advance_vouchers v
                LEFT JOIN advance_persons p ON p.person_id = v.person_id
                LEFT JOIN advance_departments d ON d.department_id = v.department_id
                LEFT JOIN advance_voucher_lines l ON l.voucher_id = v.voucher_id
                {where}
                GROUP BY v.voucher_id
                ORDER BY v.voucher_date DESC, v.voucher_id DESC
                """
            ),
            params,
        )
        data = []
        for r in rows:
            row = _row_to_dict(r)
            row.update(
                _totals(
                    float(row.get("cash_advance") or 0),
                    float(row.get("total_actual_expense") or 0),
                )
            )
            data.append(row)
        return {"status": "success", "data": data}
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=_db_detail(e, "read vouchers"))


@router.get("/advance/vouchers/{voucher_id}")
def get_voucher(voucher_id: int, db: Session = Depends(get_db)):
    return {"status": "success", "data": _fetch_voucher(db, voucher_id)}


@router.post("/advance/vouchers", status_code=201)
def create_voucher(payload: VoucherIn, db: Session = Depends(get_db)):
    # The Expense Period is the user's choice and is stored as given; the
    # rows are validated against it rather than the other way round.
    lines = _resolve_lines(
        db, payload.lines, payload.period_year, payload.period_month,
        payload.expense_from_date, payload.expense_to_date,
    )
    try:
        voucher_no = _next_voucher_no(db, payload.voucher_date)
        result = db.execute(
            text(
                """
                INSERT INTO advance_vouchers
                    (voucher_no, period_year, period_month, department_id, person_id,
                     voucher_date, expense_from_date, expense_to_date, cash_advance,
                     status, remarks)
                VALUES
                    (:voucher_no, :period_year, :period_month, :department_id, :person_id,
                     :voucher_date, :expense_from_date, :expense_to_date, :cash_advance,
                     :status, :remarks)
                """
            ),
            {**payload.model_dump(exclude={"lines"}), "voucher_no": voucher_no},
        )
        voucher_id = result.lastrowid
        _replace_lines(db, voucher_id, lines)
        # One commit for header and lines together: a voucher that saved
        # its header but lost its rows would look like a cleared advance
        # of $0.
        db.commit()
        return {"status": "success", "data": _fetch_voucher(db, voucher_id)}
    except IntegrityError as e:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail=(
                "Could not allocate a voucher number -- another voucher was "
                f"created at the same moment. Please try again. ({e})"
            ),
        )
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=_db_detail(e, "create voucher"))


@router.put("/advance/vouchers/{voucher_id}")
def update_voucher(voucher_id: int, payload: VoucherIn, db: Session = Depends(get_db)):
    """Full replace of the header and the expense rows.

    voucher_no is deliberately NOT updatable: it has been quoted on paper
    and referenced elsewhere by the time anyone edits the voucher.
    """
    current = _fetch_voucher(db, voucher_id)  # 404 early
    if current["status"] not in EDITABLE_STATUSES:
        raise HTTPException(
            status_code=409,
            detail=(
                f"This voucher is {current['status']} and cannot be edited. "
                "Use Reopen to unlock it -- that is recorded in the approval "
                "trail, so an edited voucher never looks unapproved."
            ),
        )

    lines = _resolve_lines(
        db, payload.lines, payload.period_year, payload.period_month,
        payload.expense_from_date, payload.expense_to_date,
    )
    try:
        db.execute(
            text(
                """
                UPDATE advance_vouchers SET
                    period_year = :period_year,
                    period_month = :period_month,
                    department_id = :department_id,
                    person_id = :person_id,
                    voucher_date = :voucher_date,
                    expense_from_date = :expense_from_date,
                    expense_to_date = :expense_to_date,
                    cash_advance = :cash_advance,
                    status = :status,
                    remarks = :remarks
                WHERE voucher_id = :voucher_id
                """
            ),
            {**payload.model_dump(exclude={"lines"}), "voucher_id": voucher_id},
        )
        _replace_lines(db, voucher_id, lines)
        db.commit()
        return {"status": "success", "data": _fetch_voucher(db, voucher_id)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=_db_detail(e, f"update voucher {voucher_id}"))


@router.delete("/advance/vouchers/{voucher_id}")
def delete_voucher(voucher_id: int, db: Session = Depends(get_db)):
    """Only a Draft can be deleted. Anything already submitted is part of
    the finance trail and is cancelled instead, so the voucher number is
    never silently reused for something else."""
    current = _fetch_voucher(db, voucher_id)
    try:
        if current["status"] == "Draft":
            db.execute(
                text("DELETE FROM advance_vouchers WHERE voucher_id = :id"),
                {"id": voucher_id},
            )
            message = f"Draft voucher {current['voucher_no']} deleted"
        else:
            db.execute(
                text("UPDATE advance_vouchers SET status = 'Cancelled' WHERE voucher_id = :id"),
                {"id": voucher_id},
            )
            message = f"Voucher {current['voucher_no']} cancelled"
        db.commit()
        return {"status": "success", "message": message}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=_db_detail(e, f"delete voucher {voucher_id}"))
