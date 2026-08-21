"""
Dashboard summary API -- one aggregation endpoint that feeds the
Dashboard page. It deliberately does not reimplement math that already
exists elsewhere: fleet revenue/expense/profit/KPI figures reuse the exact
per-vehicle helpers from vehicle_financial_report_route.py, so dashboard
numbers always agree with the Vehicle Financial & KPI Performance Report.
Everything else (headcount, attendance, today's log coverage, live rental
status) is a handful of aggregate queries against tables that already
exist.

See DASHBOARD_RECOMMENDATION.md at the repo root for the design this
implements.

GET /api/dashboard/summary
    company_id             -- which Wialon credentials to use (defaults to
                               DEFAULT_COMPANY_ID, same convention as every
                               other Wialon-backed route)
    start_date / end_date  -- the "monthly" section's date range (defaults
                               to the 1st of the current month through
                               today). Revenue, expenses, payroll cost,
                               staff salary, and rental expense are all
                               fundamentally monthly figures (payroll runs
                               one payroll_periods row per calendar month,
                               rental expense is prorated per month), so a
                               range is resolved to the set of calendar
                               months it overlaps and each of those months
                               is summed in full -- see _months_in_range().
                               The trend charts plot exactly those months,
                               so they update with whatever range is
                               selected instead of a fixed lookback window.
                               The "daily" section always reflects today
                               regardless of this filter -- see
                               DASHBOARD_RECOMMENDATION.md section 4 for why.
    department_id          -- optional, narrows the workforce section to
                               one department

The Wialon vehicle roster and each month's financials are fetched once per
request and reused across the monthly totals and the trend charts, instead
of being recomputed for each -- Wialon calls and the per-vehicle SQL are
the slow part of this endpoint.
"""
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config.database import get_db
from app.config.settings import DEFAULT_COMPANY_ID
from app.routes.payroll_report_route import MONTH_NAMES
from app.routes.vehicle_financial_report_route import (
    DIESEL_CATEGORY,
    ENGINE_OIL_CATEGORY,
    REPAIR_CATEGORY,
    _clamp_kpi_achieved,
    _expenses_by_vehicle,
    _get_all_vehicles_enriched,
    _rental_expense_and_status_by_vehicle,
    _revenue_by_vehicle,
    _row_to_dict,
    _staff_salary_by_vehicle,
)

router = APIRouter()

MAX_RANGE_MONTHS = 24


# --- Helpers -----------------------------------------------------------

def _months_in_range(start_date: date, end_date: date) -> list:
    """Every (year, month) calendar month touched by [start_date, end_date],
    inclusive, in chronological order."""
    months = []
    y, m = start_date.year, start_date.month
    while (y, m) <= (end_date.year, end_date.month):
        months.append((y, m))
        m += 1
        if m == 13:
            m, y = 1, y + 1
    return months


# --- Section builders ------------------------------------------------------

def _month_financials(db: Session, year: int, month: int, vehicles: list) -> dict:
    """Fleet-wide revenue/expenses/profit/KPI for one calendar month,
    computed with the same per-vehicle helpers
    vehicle_financial_report_route.py uses -- just summed instead of
    returned as one row per vehicle. `vehicles` is the Wialon roster,
    fetched once by the caller and passed in so this never triggers its
    own Wialon call."""
    revenue_by_vehicle = _revenue_by_vehicle(db, year, month)
    expenses_by_vehicle = _expenses_by_vehicle(db, year, month)
    salary_by_vehicle = _staff_salary_by_vehicle(db, year, month)
    rental_by_vehicle = _rental_expense_and_status_by_vehicle(db, year, month)

    extras_by_vehicle = {}
    for r in db.execute(
        text("SELECT * FROM vehicle_monthly_kpi WHERE report_year = :year AND report_month = :month"),
        {"year": year, "month": month},
    ):
        extras_by_vehicle[r.vehicles_id] = _row_to_dict(r)

    total_revenue = total_repair = total_oil = total_diesel = 0.0
    total_salary = total_rental = 0.0
    kpi_achieved_values = []

    for v in vehicles:
        vid = v["vehicles_id"]
        revenue = revenue_by_vehicle.get(vid, 0)
        cats = expenses_by_vehicle.get(vid, {})
        repair = cats.get(REPAIR_CATEGORY, 0)
        oil = cats.get(ENGINE_OIL_CATEGORY, 0)
        diesel = cats.get(DIESEL_CATEGORY, 0)
        salary = salary_by_vehicle.get(vid, 0)
        rental = rental_by_vehicle.get(vid, {"expense": 0.0, "working": 0, "standby": 0, "broken": 0})
        rental_expense = rental["expense"]

        total_expenses = repair + oil + diesel + salary + rental_expense
        profit = revenue - total_expenses

        extras = extras_by_vehicle.get(vid, {})
        bonus = float(extras.get("bonus") or 0)
        kpi_achieved_values.append(_clamp_kpi_achieved(profit + bonus))

        total_revenue += revenue
        total_repair += repair
        total_oil += oil
        total_diesel += diesel
        total_salary += salary
        total_rental += rental_expense

    total_expenses = round(total_repair + total_oil + total_diesel + total_salary + total_rental, 2)
    total_profit = round(total_revenue - total_expenses, 2)
    avg_kpi_pct = (
        round(sum(kpi_achieved_values) / len(kpi_achieved_values) / 200 * 100, 1) if kpi_achieved_values else 0.0
    )

    return {
        "total_revenue": round(total_revenue, 2),
        "total_expenses": total_expenses,
        "total_profit": total_profit,
        "expense_breakdown": {
            "repair": round(total_repair, 2),
            "engine_oil": round(total_oil, 2),
            "diesel": round(total_diesel, 2),
        },
        "payroll_cost": round(total_salary, 2),
        "rental_expense": round(total_rental, 2),
        "avg_kpi_achievement_pct": avg_kpi_pct,
    }


def _aggregate_month_financials(monthly_breakdown: list, vehicle_count: int) -> dict:
    """Sums the already-computed per-month figures across the selected
    date range. Takes the list of _month_financials() results (one per
    month) so the per-month numbers only ever get computed once, shared
    between this and the trend charts."""
    totals = {
        "total_revenue": 0.0,
        "total_expenses": 0.0,
        "total_profit": 0.0,
        "expense_breakdown": {"repair": 0.0, "engine_oil": 0.0, "diesel": 0.0},
        "payroll_cost": 0.0,
        "rental_expense": 0.0,
    }
    kpi_pct_values = []
    for mf in monthly_breakdown:
        totals["total_revenue"] += mf["total_revenue"]
        totals["total_expenses"] += mf["total_expenses"]
        totals["total_profit"] += mf["total_profit"]
        for k in totals["expense_breakdown"]:
            totals["expense_breakdown"][k] += mf["expense_breakdown"][k]
        totals["payroll_cost"] += mf["payroll_cost"]
        totals["rental_expense"] += mf["rental_expense"]
        kpi_pct_values.append(mf["avg_kpi_achievement_pct"])

    avg_kpi_pct = round(sum(kpi_pct_values) / len(kpi_pct_values), 1) if kpi_pct_values else 0.0

    return {
        "vehicle_count": vehicle_count,
        "total_revenue": round(totals["total_revenue"], 2),
        "total_expenses": round(totals["total_expenses"], 2),
        "total_profit": round(totals["total_profit"], 2),
        "expense_breakdown": {k: round(v, 2) for k, v in totals["expense_breakdown"].items()},
        "payroll_cost": round(totals["payroll_cost"], 2),
        "rental_expense": round(totals["rental_expense"], 2),
        "avg_kpi_achievement_pct": avg_kpi_pct,
    }


def _build_trends(months: list, monthly_breakdown: list) -> dict:
    """One point per calendar month in the selected date range, reusing
    the per-month figures already computed for the totals above -- so the
    chart updates dynamically with whatever range is selected instead of
    a fixed lookback window disconnected from the filter."""
    return {
        "labels": [f"{MONTH_NAMES[m - 1][:3]} {y}" for y, m in months],
        # Raw (year, month) per point, so the frontend can build precise
        # drill-down links (e.g. to the Financial Report for that exact
        # month) without having to parse the formatted label back apart.
        "months": [[y, m] for y, m in months],
        "revenue": [mf["total_revenue"] for mf in monthly_breakdown],
        "expenses": [mf["total_expenses"] for mf in monthly_breakdown],
        "profit": [mf["total_profit"] for mf in monthly_breakdown],
        "payroll_cost": [mf["payroll_cost"] for mf in monthly_breakdown],
    }


def _current_rental_status(db: Session) -> dict:
    """A live snapshot -- total rental vehicles currently active, and each
    one's most recent Working/On Standby/Broken attendance entry -- rather
    than a tally of status-days across a date range, which answers a
    different question ("how many days were vehicles broken") than what
    the Rental Fleet Status card is for ("what's the fleet doing right
    now")."""
    total_row = db.execute(text("SELECT COUNT(*) AS cnt FROM vehicle_rentals WHERE status = 'Active'")).first()
    total_active_rentals = int(total_row.cnt or 0)

    rows = db.execute(
        text(
            """
            SELECT r.rental_id, a.status
            FROM vehicle_rentals r
            LEFT JOIN vehicle_rental_attendance a
                ON a.rental_id = r.rental_id
               AND a.work_date = (
                    SELECT MAX(a2.work_date) FROM vehicle_rental_attendance a2 WHERE a2.rental_id = r.rental_id
                )
            WHERE r.status = 'Active'
            """
        )
    )
    counts = {"working": 0, "standby": 0, "broken": 0, "unmarked": 0}
    status_key = {"Working": "working", "On Standby": "standby", "Broken": "broken"}
    for r in rows:
        counts[status_key.get(r.status, "unmarked")] += 1

    return {"total_active_rentals": total_active_rentals, "current_status_counts": counts}


def _workforce_summary(db: Session, months: list, department_id: Optional[int]) -> dict:
    dept_clause = "AND e.department_id = :department_id" if department_id else ""
    params: dict = {}
    if department_id:
        params["department_id"] = department_id

    active_row = db.execute(
        text(f"SELECT COUNT(*) AS cnt FROM employees e WHERE e.employment_status = 'Active' {dept_clause}"),
        params,
    ).first()
    active_headcount = int(active_row.cnt or 0)

    by_dept = db.execute(
        text(
            """
            SELECT d.name AS department, COUNT(*) AS headcount
            FROM employees e
            JOIN departments d ON d.department_id = e.department_id
            WHERE e.employment_status = 'Active'
            GROUP BY d.name
            ORDER BY headcount DESC
            """
        )
    )
    headcount_by_department = [{"department": r.department, "headcount": int(r.headcount)} for r in by_dept]

    total_attended = 0
    total_possible = 0
    period_statuses = []
    for year, month in months:
        period_row = db.execute(
            text("SELECT * FROM payroll_periods WHERE period_year = :year AND period_month = :month LIMIT 1"),
            {"year": year, "month": month},
        ).first()
        if not period_row:
            continue
        period = _row_to_dict(period_row)
        period_statuses.append({"label": f"{MONTH_NAMES[month - 1][:3]} {year}", "status": period["status"]})
        working_days = period["total_working_days"] or 1
        # Denominator is the current active headcount (respecting the
        # department filter), not COUNT(DISTINCT employee_id) of whoever
        # happens to have an attendance row for the period -- an employee
        # with zero attendance rows marked is absent-by-omission, not
        # excluded from the rate entirely.
        att_row = db.execute(
            text(
                f"""
                SELECT SUM(a.is_attended) AS attended
                FROM attendance a
                JOIN employees e ON e.employee_id = a.employee_id
                WHERE a.payroll_period_id = :pid AND e.employment_status = 'Active' {dept_clause}
                """
            ),
            {"pid": period["payroll_period_id"], **params},
        ).first()
        total_attended += int(att_row.attended or 0)
        total_possible += working_days * active_headcount

    attendance_rate_pct = round(total_attended / total_possible * 100, 1) if total_possible else None

    return {
        "active_headcount": active_headcount,
        "headcount_by_department": headcount_by_department,
        "attendance_rate_pct": attendance_rate_pct,
        "period_statuses": period_statuses,
    }


def _daily_summary(db: Session, today: date) -> dict:
    logged_row = db.execute(
        text(
            "SELECT COUNT(DISTINCT vehicle_id) AS cnt FROM vehicle_operation_logs "
            "WHERE operation_date = :today AND status = 'Active'"
        ),
        {"today": today},
    ).first()

    # Attendance Rate = Present Employees / Active Headcount * 100 -- the
    # denominator must be everyone currently Active, not just however many
    # attendance rows happen to be entered for today.
    headcount_row = db.execute(
        text("SELECT COUNT(*) AS cnt FROM employees WHERE employment_status = 'Active'")
    ).first()
    active_headcount = int(headcount_row.cnt or 0)

    att_row = db.execute(
        text(
            """
            SELECT SUM(a.is_attended) AS attended
            FROM attendance a
            JOIN employees e ON e.employee_id = a.employee_id
            WHERE a.work_date = :today AND e.employment_status = 'Active'
            """
        ),
        {"today": today},
    ).first()
    attended = int(att_row.attended or 0)

    return {
        "date": today.isoformat(),
        "vehicles_logged_today": int(logged_row.cnt or 0),
        "today_attendance_rate_pct": round(attended / active_headcount * 100, 1) if active_headcount else None,
    }


# --- Route -----------------------------------------------------------------

@router.get("/dashboard/summary")
def get_dashboard_summary(
    company_id: int = Query(DEFAULT_COMPANY_ID, description="Company whose Wialon credentials to use"),
    start_date: Optional[date] = Query(None, description="Range start (defaults to the 1st of the current month)"),
    end_date: Optional[date] = Query(None, description="Range end (defaults to today)"),
    department_id: Optional[int] = Query(None, description="Narrow the workforce section to one department"),
    db: Session = Depends(get_db),
):
    today = date.today()
    end_date = end_date or today
    start_date = start_date or end_date.replace(day=1)
    if start_date > end_date:
        raise HTTPException(status_code=400, detail="start_date must be on or before end_date")

    months = _months_in_range(start_date, end_date)
    if len(months) > MAX_RANGE_MONTHS:
        raise HTTPException(
            status_code=400,
            detail=f"Date range too wide -- please select {MAX_RANGE_MONTHS} months or fewer.",
        )

    try:
        vehicles = _get_all_vehicles_enriched(db, company_id)
    except Exception:
        vehicles = []

    try:
        monthly_breakdown = [_month_financials(db, y, m, vehicles) for y, m in months]
        monthly = _aggregate_month_financials(monthly_breakdown, len(vehicles))
        trends = _build_trends(months, monthly_breakdown)
        workforce = _workforce_summary(db, months, department_id)
        daily = _daily_summary(db, today)
        rental_fleet = _current_rental_status(db)
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Could not compute the dashboard summary: {e}")

    range_label = f"{start_date.strftime('%b %d, %Y')} - {end_date.strftime('%b %d, %Y')}"

    return {
        "status": "success",
        "generated_at": datetime.utcnow().isoformat(),
        "period": {"start_date": start_date.isoformat(), "end_date": end_date.isoformat(), "label": range_label},
        "daily": daily,
        "monthly": monthly,
        "workforce": workforce,
        "trends": trends,
        "rental_fleet": rental_fleet,
    }
