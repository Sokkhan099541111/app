"""
Sales Performance module -- Actual Sales vs Budget Plan by month and year.

Run app/sales_performance.sql once against app_hosting before using these
endpoints. The module is self-contained: it owns sales_categories,
sales_persons, sales_actuals and sales_budgets, and reads nothing from the
vehicle or payroll modules.

Actual and Budget share one grain -- (period_year, period_month,
category_id, sales_person_id) -- so both can be summed under the same
filters and compared like for like.

Everything on the report is COMPUTED from those two figures, never stored:

    Variance      = Actual - Budget          (negative = short of budget)
    Variance %    = Variance / Budget * 100
    Achievement % = Actual / Budget * 100

    Status        = "Above"     if Achievement >= ABOVE_THRESHOLD_PCT
                    "On Target" if Achievement >= ON_TARGET_THRESHOLD_PCT
                    "Below"     otherwise

A zero budget is the awkward case: dividing by it is undefined, so the
percentages come back as None rather than 0 or infinity, and the frontend
renders "--". Reporting 0% achievement against a 0 budget would claim a
failure that did not happen.
"""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config.database import get_db

router = APIRouter()

MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]

# A month is "On Target" from 95% of budget, and "Above" from 100%.
# Without a band, 99.9% would read as a failure identical to 40%.
ABOVE_THRESHOLD_PCT = 100.0
ON_TARGET_THRESHOLD_PCT = 95.0


# --- Request bodies ------------------------------------------------------

class SalesCategoryIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=150)
    status: str = Field("Active", pattern="^(Active|Inactive)$")


class SalesPersonIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    team: Optional[str] = Field(None, max_length=150)
    status: str = Field("Active", pattern="^(Active|Inactive)$")


class SalesFigureIn(BaseModel):
    """One Actual or Budget figure for a month.

    category_id / sales_person_id may be omitted for a company-wide
    figure. amount is constrained to zero or more -- a negative month's
    sales would silently offset other months in every total on the report.
    """
    period_year: int = Field(..., ge=2000, le=2100)
    period_month: int = Field(..., ge=1, le=12)
    category_id: Optional[int] = None
    sales_person_id: Optional[int] = None
    amount: float = Field(0, ge=0)
    remarks: Optional[str] = Field(None, max_length=500)


class SalesFigureUpdate(BaseModel):
    """All fields optional -- only what is sent gets updated."""
    period_year: Optional[int] = Field(None, ge=2000, le=2100)
    period_month: Optional[int] = Field(None, ge=1, le=12)
    category_id: Optional[int] = None
    sales_person_id: Optional[int] = None
    amount: Optional[float] = Field(None, ge=0)
    remarks: Optional[str] = Field(None, max_length=500)


# --- Helpers ---------------------------------------------------------------

def _row_to_dict(row) -> dict:
    return dict(row._mapping)


def _pct(numerator: float, denominator: float) -> Optional[float]:
    """Percentage, or None when the denominator is zero.

    None (rendered "--") is the honest answer for "actual vs a budget of
    nothing"; 0 would read as total failure and infinity is not a number
    anyone can act on.
    """
    if not denominator:
        return None
    return round(numerator / denominator * 100, 2)


def _status(achievement_pct: Optional[float], actual: float, budget: float) -> str:
    """Above / On Target / Below, from Achievement %.

    With no budget set, any sales at all count as Above and nothing counts
    as On Target -- there is no target to be on.
    """
    if achievement_pct is None:
        return "Above" if actual > 0 else "On Target" if budget == 0 and actual == 0 else "Below"
    if achievement_pct >= ABOVE_THRESHOLD_PCT:
        return "Above"
    if achievement_pct >= ON_TARGET_THRESHOLD_PCT:
        return "On Target"
    return "Below"


def _compare(actual: float, budget: float) -> dict:
    """The whole comparison for one bucket of Actual and Budget.

    The percentages are derived from the RAW figures and rounded only at
    the end. Rounding the variance to 2dp first and then dividing lets the
    rounding error compound into the percentage -- on a large budget that
    is visible in the second decimal place, which is exactly where someone
    reconciling against a spreadsheet will notice it.
    """
    raw_actual = float(actual or 0)
    raw_budget = float(budget or 0)
    raw_variance = raw_actual - raw_budget

    achievement_pct = _pct(raw_actual, raw_budget)
    return {
        "actual": round(raw_actual, 2),
        "budget": round(raw_budget, 2),
        "variance": round(raw_variance, 2),
        "variance_pct": _pct(raw_variance, raw_budget),
        "achievement_pct": achievement_pct,
        "status": _status(achievement_pct, raw_actual, raw_budget),
    }


def _assert_master_exists(db: Session, table: str, pk: str, value: Optional[int], label: str) -> None:
    if value is None:
        return
    row = db.execute(text(f"SELECT 1 FROM {table} WHERE {pk} = :v LIMIT 1"), {"v": value}).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"{label} {value} not found")


def _assert_consistent_grain(
    db: Session,
    table: str,
    period_year: int,
    period_month: int,
    category_id: Optional[int],
    sales_person_id: Optional[int],
    exclude_id: Optional[int] = None,
    pk: str = "",
) -> None:
    """Refuse to mix a company-wide figure with broken-down ones.

    A month holding BOTH a company-wide row (category and person NULL) and
    category/person rows would double-count: the report sums whatever
    matches the filter, so the same sales would appear twice in the total.

    MySQL cannot express this as a constraint -- NULLs do not compare in a
    UNIQUE index -- so it is enforced here, on write, where the user can be
    told exactly what is wrong.
    """
    is_company_wide = category_id is None and sales_person_id is None

    clauses = ["period_year = :y", "period_month = :m"]
    params: dict = {"y": period_year, "m": period_month}
    if exclude_id is not None and pk:
        clauses.append(f"{pk} != :exclude_id")
        params["exclude_id"] = exclude_id

    if is_company_wide:
        clauses.append("(category_id IS NOT NULL OR sales_person_id IS NOT NULL)")
        conflict = "a breakdown by category/sales person already exists"
    else:
        clauses.append("category_id IS NULL AND sales_person_id IS NULL")
        conflict = "a company-wide figure already exists"

    row = db.execute(
        text(f"SELECT 1 FROM {table} WHERE {' AND '.join(clauses)} LIMIT 1"), params
    ).first()
    if row:
        raise HTTPException(
            status_code=409,
            detail=(
                f"{MONTH_NAMES[period_month - 1]} {period_year}: {conflict}. "
                "Use one level consistently for a month -- either a single "
                "company-wide figure or a breakdown, not both, or the totals "
                "would count the same sales twice."
            ),
        )


FIGURE_SELECT = """
    SELECT f.{pk} AS record_id, f.period_year, f.period_month,
           f.category_id, f.sales_person_id, f.amount, f.remarks,
           f.created_at, f.updated_at,
           c.name AS category_name,
           p.name AS sales_person_name,
           p.team AS sales_team
    FROM {table} f
    LEFT JOIN sales_categories c ON c.category_id = f.category_id
    LEFT JOIN sales_persons   p ON p.sales_person_id = f.sales_person_id
"""


def _figure_table(kind: str) -> tuple:
    """('sales_actuals', 'actual_id') or ('sales_budgets', 'budget_id')."""
    if kind == "actual":
        return "sales_actuals", "actual_id"
    if kind == "budget":
        return "sales_budgets", "budget_id"
    raise HTTPException(status_code=400, detail="kind must be 'actual' or 'budget'")


# --- Master data: categories ---------------------------------------------

@router.get("/sales-categories")
def list_sales_categories(
    status: str = Query("Active", description="'Active' (default), 'Inactive' or 'All'"),
    db: Session = Depends(get_db),
):
    clauses, params = [], {}
    normalized = (status or "Active").strip().capitalize()
    if normalized != "All":
        clauses.append("status = :status")
        params["status"] = normalized
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    try:
        rows = db.execute(text(f"SELECT * FROM sales_categories {where} ORDER BY name"), params)
        return {"status": "success", "data": [_row_to_dict(r) for r in rows]}
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read sales_categories -- has sales_performance.sql been run? ({e})",
        )


@router.post("/sales-categories", status_code=201)
def create_sales_category(payload: SalesCategoryIn, db: Session = Depends(get_db)):
    try:
        result = db.execute(
            text("INSERT INTO sales_categories (name, status) VALUES (:name, :status)"),
            payload.model_dump(),
        )
        db.commit()
        row = db.execute(
            text("SELECT * FROM sales_categories WHERE category_id = :id"), {"id": result.lastrowid}
        ).first()
        return {"status": "success", "data": _row_to_dict(row)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create sales category: {e}")


@router.put("/sales-categories/{category_id}")
def update_sales_category(category_id: int, payload: SalesCategoryIn, db: Session = Depends(get_db)):
    _assert_master_exists(db, "sales_categories", "category_id", category_id, "Sales category")
    try:
        db.execute(
            text("UPDATE sales_categories SET name = :name, status = :status WHERE category_id = :id"),
            {**payload.model_dump(), "id": category_id},
        )
        db.commit()
        row = db.execute(
            text("SELECT * FROM sales_categories WHERE category_id = :id"), {"id": category_id}
        ).first()
        return {"status": "success", "data": _row_to_dict(row)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update sales category: {e}")


@router.delete("/sales-categories/{category_id}")
def delete_sales_category(category_id: int, db: Session = Depends(get_db)):
    """Soft delete -- figures already recorded against this category must
    keep resolving, so the row is deactivated rather than removed."""
    _assert_master_exists(db, "sales_categories", "category_id", category_id, "Sales category")
    try:
        db.execute(
            text("UPDATE sales_categories SET status = 'Inactive' WHERE category_id = :id"),
            {"id": category_id},
        )
        db.commit()
        return {"status": "success", "message": f"Sales category {category_id} deactivated"}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not deactivate sales category: {e}")


# --- Master data: sales persons ------------------------------------------

@router.get("/sales-persons")
def list_sales_persons(
    status: str = Query("Active", description="'Active' (default), 'Inactive' or 'All'"),
    db: Session = Depends(get_db),
):
    clauses, params = [], {}
    normalized = (status or "Active").strip().capitalize()
    if normalized != "All":
        clauses.append("status = :status")
        params["status"] = normalized
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    try:
        rows = db.execute(text(f"SELECT * FROM sales_persons {where} ORDER BY name"), params)
        return {"status": "success", "data": [_row_to_dict(r) for r in rows]}
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read sales_persons -- has sales_performance.sql been run? ({e})",
        )


@router.post("/sales-persons", status_code=201)
def create_sales_person(payload: SalesPersonIn, db: Session = Depends(get_db)):
    try:
        result = db.execute(
            text("INSERT INTO sales_persons (name, team, status) VALUES (:name, :team, :status)"),
            payload.model_dump(),
        )
        db.commit()
        row = db.execute(
            text("SELECT * FROM sales_persons WHERE sales_person_id = :id"), {"id": result.lastrowid}
        ).first()
        return {"status": "success", "data": _row_to_dict(row)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create sales person: {e}")


@router.put("/sales-persons/{sales_person_id}")
def update_sales_person(sales_person_id: int, payload: SalesPersonIn, db: Session = Depends(get_db)):
    _assert_master_exists(db, "sales_persons", "sales_person_id", sales_person_id, "Sales person")
    try:
        db.execute(
            text(
                "UPDATE sales_persons SET name = :name, team = :team, status = :status "
                "WHERE sales_person_id = :id"
            ),
            {**payload.model_dump(), "id": sales_person_id},
        )
        db.commit()
        row = db.execute(
            text("SELECT * FROM sales_persons WHERE sales_person_id = :id"), {"id": sales_person_id}
        ).first()
        return {"status": "success", "data": _row_to_dict(row)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update sales person: {e}")


@router.delete("/sales-persons/{sales_person_id}")
def delete_sales_person(sales_person_id: int, db: Session = Depends(get_db)):
    _assert_master_exists(db, "sales_persons", "sales_person_id", sales_person_id, "Sales person")
    try:
        db.execute(
            text("UPDATE sales_persons SET status = 'Inactive' WHERE sales_person_id = :id"),
            {"id": sales_person_id},
        )
        db.commit()
        return {"status": "success", "message": f"Sales person {sales_person_id} deactivated"}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not deactivate sales person: {e}")


# --- Figures: actuals and budgets ----------------------------------------
#
# One set of endpoints serves both, switched by ?kind=. The two tables are
# structurally identical, and keeping them on one code path is what
# guarantees Actual and Budget stay comparable -- a rule added to one
# cannot drift away from the other.

@router.get("/sales-figures")
def list_sales_figures(
    kind: str = Query(..., description="'actual' or 'budget'"),
    period_year: Optional[int] = Query(None, ge=2000, le=2100),
    period_month: Optional[int] = Query(None, ge=1, le=12),
    category_id: Optional[int] = Query(None),
    sales_person_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
):
    table, pk = _figure_table(kind)
    clauses, params = [], {}
    if period_year is not None:
        clauses.append("f.period_year = :y")
        params["y"] = period_year
    if period_month is not None:
        clauses.append("f.period_month = :m")
        params["m"] = period_month
    if category_id is not None:
        clauses.append("f.category_id = :c")
        params["c"] = category_id
    if sales_person_id is not None:
        clauses.append("f.sales_person_id = :p")
        params["p"] = sales_person_id
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    try:
        rows = db.execute(
            text(
                FIGURE_SELECT.format(table=table, pk=pk)
                + f" {where} ORDER BY f.period_year DESC, f.period_month DESC, f.{pk} DESC"
            ),
            params,
        )
        return {"status": "success", "kind": kind, "data": [_row_to_dict(r) for r in rows]}
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read {table} -- has sales_performance.sql been run? ({e})",
        )


@router.post("/sales-figures", status_code=201)
def create_sales_figure(
    payload: SalesFigureIn,
    kind: str = Query(..., description="'actual' or 'budget'"),
    db: Session = Depends(get_db),
):
    table, pk = _figure_table(kind)
    _assert_master_exists(db, "sales_categories", "category_id", payload.category_id, "Sales category")
    _assert_master_exists(db, "sales_persons", "sales_person_id", payload.sales_person_id, "Sales person")
    _assert_consistent_grain(
        db, table, payload.period_year, payload.period_month,
        payload.category_id, payload.sales_person_id,
    )

    try:
        result = db.execute(
            text(
                f"""
                INSERT INTO {table}
                    (period_year, period_month, category_id, sales_person_id, amount, remarks)
                VALUES
                    (:period_year, :period_month, :category_id, :sales_person_id, :amount, :remarks)
                """
            ),
            payload.model_dump(),
        )
        db.commit()
        row = db.execute(
            text(FIGURE_SELECT.format(table=table, pk=pk) + f" WHERE f.{pk} = :id"),
            {"id": result.lastrowid},
        ).first()
        return {"status": "success", "data": _row_to_dict(row)}
    except SQLAlchemyError as e:
        db.rollback()
        # The UNIQUE key on the grain is the likely cause -- say so plainly
        # instead of surfacing a raw driver error.
        raise HTTPException(
            status_code=409,
            detail=(
                f"Could not save this {kind} -- a figure for that month and "
                f"category/sales person may already exist. ({e})"
            ),
        )


@router.put("/sales-figures/{record_id}")
def update_sales_figure(
    record_id: int,
    payload: SalesFigureUpdate,
    kind: str = Query(..., description="'actual' or 'budget'"),
    db: Session = Depends(get_db),
):
    table, pk = _figure_table(kind)
    current = db.execute(
        text(f"SELECT * FROM {table} WHERE {pk} = :id"), {"id": record_id}
    ).first()
    if not current:
        raise HTTPException(status_code=404, detail=f"{kind.capitalize()} {record_id} not found")
    current = _row_to_dict(current)

    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    _assert_master_exists(db, "sales_categories", "category_id", updates.get("category_id"), "Sales category")
    _assert_master_exists(db, "sales_persons", "sales_person_id", updates.get("sales_person_id"), "Sales person")

    # Re-check the grain against the values this row will END UP with.
    _assert_consistent_grain(
        db, table,
        updates.get("period_year", current["period_year"]),
        updates.get("period_month", current["period_month"]),
        updates.get("category_id", current["category_id"]),
        updates.get("sales_person_id", current["sales_person_id"]),
        exclude_id=record_id,
        pk=pk,
    )

    set_clause = ", ".join(f"{col} = :{col}" for col in updates)
    updates["id"] = record_id
    try:
        db.execute(text(f"UPDATE {table} SET {set_clause} WHERE {pk} = :id"), updates)
        db.commit()
        row = db.execute(
            text(FIGURE_SELECT.format(table=table, pk=pk) + f" WHERE f.{pk} = :id"),
            {"id": record_id},
        ).first()
        return {"status": "success", "data": _row_to_dict(row)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update {kind} {record_id}: {e}")


@router.delete("/sales-figures/{record_id}")
def delete_sales_figure(
    record_id: int,
    kind: str = Query(..., description="'actual' or 'budget'"),
    db: Session = Depends(get_db),
):
    table, pk = _figure_table(kind)
    try:
        result = db.execute(text(f"DELETE FROM {table} WHERE {pk} = :id"), {"id": record_id})
        db.commit()
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail=f"{kind.capitalize()} {record_id} not found")
        return {"status": "success", "message": f"{kind.capitalize()} {record_id} deleted"}
    except HTTPException:
        raise
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not delete {kind} {record_id}: {e}")


# --- The report ----------------------------------------------------------

def _monthly_sums(db: Session, table: str, year: int, filters: dict) -> dict:
    """{month: amount} for one year, honouring the category/person filter."""
    clauses = ["period_year = :year"]
    params: dict = {"year": year}
    if filters.get("category_id") is not None:
        clauses.append("category_id = :category_id")
        params["category_id"] = filters["category_id"]
    if filters.get("sales_person_id") is not None:
        clauses.append("sales_person_id = :sales_person_id")
        params["sales_person_id"] = filters["sales_person_id"]

    rows = db.execute(
        text(
            f"""
            SELECT period_month, COALESCE(SUM(amount), 0) AS total
            FROM {table}
            WHERE {' AND '.join(clauses)}
            GROUP BY period_month
            """
        ),
        params,
    )
    return {int(r.period_month): float(r.total or 0) for r in rows}


@router.get("/sales-performance")
def get_sales_performance(
    year: int = Query(..., ge=2000, le=2100, description="Report year"),
    start_month: int = Query(1, ge=1, le=12, description="First month to include"),
    end_month: int = Query(12, ge=1, le=12, description="Last month to include"),
    category_id: Optional[int] = Query(None, description="Filter by sales category"),
    sales_person_id: Optional[int] = Query(None, description="Filter by sales person"),
    db: Session = Depends(get_db),
):
    """Actual vs Budget for each month of a year, plus period and annual totals.

    `months` covers the selected range and drives the chart and table.
    `period` totals that range -- the "YTD" figures when the range starts
    at January. `annual` always covers all 12 months regardless of the
    range, so the yearly picture does not silently change when someone
    narrows the months.
    """
    if end_month < start_month:
        raise HTTPException(status_code=400, detail="end_month cannot be before start_month")

    filters = {"category_id": category_id, "sales_person_id": sales_person_id}
    try:
        actual_by_month = _monthly_sums(db, "sales_actuals", year, filters)
        budget_by_month = _monthly_sums(db, "sales_budgets", year, filters)
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not compute sales performance -- has sales_performance.sql been run? ({e})",
        )

    months = []
    for m in range(start_month, end_month + 1):
        entry = _compare(actual_by_month.get(m, 0.0), budget_by_month.get(m, 0.0))
        entry.update({"month": m, "month_name": MONTH_NAMES[m - 1], "month_short": MONTH_NAMES[m - 1][:3]})
        months.append(entry)

    period = _compare(
        sum(actual_by_month.get(m, 0.0) for m in range(start_month, end_month + 1)),
        sum(budget_by_month.get(m, 0.0) for m in range(start_month, end_month + 1)),
    )
    annual = _compare(sum(actual_by_month.values()), sum(budget_by_month.values()))

    # Best / lowest by ACHIEVEMENT, not raw amount -- a big month against a
    # bigger budget is not a good month. Months with no budget are excluded
    # because they have no achievement figure to rank by.
    ranked = [m for m in months if m["achievement_pct"] is not None]
    best = max(ranked, key=lambda m: m["achievement_pct"]) if ranked else None
    lowest = min(ranked, key=lambda m: m["achievement_pct"]) if ranked else None

    return {
        "status": "success",
        "year": year,
        "start_month": start_month,
        "end_month": end_month,
        "filters": {"category_id": category_id, "sales_person_id": sales_person_id},
        "months": months,
        "period": period,
        "annual": annual,
        "highlights": {
            "best_month": best and {"month_name": best["month_name"], "achievement_pct": best["achievement_pct"]},
            "lowest_month": lowest and {"month_name": lowest["month_name"], "achievement_pct": lowest["achievement_pct"]},
        },
        "thresholds": {"above_pct": ABOVE_THRESHOLD_PCT, "on_target_pct": ON_TARGET_THRESHOLD_PCT},
    }


@router.get("/sales-performance/years")
def get_sales_years(db: Session = Depends(get_db)):
    """Years that have any Actual or Budget data, for the year picker.
    Always includes the current year so a fresh install can be started."""
    try:
        rows = db.execute(
            text(
                """
                SELECT period_year FROM sales_actuals
                UNION
                SELECT period_year FROM sales_budgets
                """
            )
        )
        years = {int(r.period_year) for r in rows}
    except SQLAlchemyError as e:
        print(f"DEBUG: could not read sales years: {e}")
        years = set()

    years.add(datetime.now().year)
    return {"status": "success", "years": sorted(years, reverse=True)}
