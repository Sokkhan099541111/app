"""
Monthly Vehicle Financial & KPI Performance Report -- aggregates data that
already lives in four other modules into one row per vehicle, plus a small
table (vehicle_monthly_kpi, see app/vehicle_monthly_kpi.sql) for the only
three fields nothing else can supply: Bonus, Meter / Month and % KPI (all
manually entered). Everything else, including Monthly KPI, Monthly KPI +
Bonus and Remarks, is computed.

Per-vehicle figures and where each comes from:

  - Code, Plate Number, Vehicle Type -- Vehicle Unit API (Wialon), same
    fleet report (template_id=21) the other vehicle modules already use.
  - Driver Name -- `employees` WHERE employees.vehicles_id = <this vehicle>
    (same convention as Vehicle Rental / Daily KPI / Vehicle Expense).
  - Total Monthly Revenue -- SUM of Daily KPI Entry's computed KPI
    (LEAST(quantity, daily_productivity) * unit_price) for the month.
  - Repair & Maintenance / Engine Oil, Pump & Brake / Diesel Fuel / Other
    Expense -- SUM(vehicle_expenses.amount) per category for the month.
    Other Expense is the catch-all category added in
    app/vehicle_expenses_add_other_category.sql; it is summed and totalled
    exactly like the other three.
  - Total Staff Salary -- SUM of Payroll Worker by Month's "Total Salary
    Daily" for whichever employee(s) have this vehicle assigned
    (employees.vehicles_id), for the payroll_periods row matching the
    selected year/month. Uses the exact same formula as
    GET /payroll-report/worksheet.
  - Vehicle Rental Expense -- Monthly Report Rental Expense's
    Total Rental Expense = (monthly_rental / days_in_month) *
    (Total Working + Total On Standby), summed over that vehicle's
    rental record(s) for the month.
  - Remarks -- the vehicle's Working / On Standby / Broken day counts for
    the month, straight from Monthly Report Rental Expense's day-by-day
    attendance (vehicle_rental_attendance), formatted as text.

Computed (never stored):
    Total Monthly Expenses  = Repair + Engine Oil/Pump/Brake + Diesel
                               + Other Expense + Staff Salary
                               + Vehicle Rental Expense
    Monthly Profit           = Total Monthly Revenue - Total Monthly Expenses
    Monthly KPI               = 0                          if Monthly Profit <= 0
                                 Monthly Profit * (% KPI / 100)  otherwise
                               (% KPI is per vehicle per month, stored in
                                vehicle_monthly_kpi.kpi_percent; unset rows
                                use DEFAULT_KPI_PERCENT)
    Monthly KPI + Bonus       = Monthly KPI + Bonus
                               (Bonus may be negative -- see the Bonus note
                                below -- in which case this REDUCES the
                                total, and the result may go below zero)
    Remaining KPI              = 0                          if (Monthly KPI + Bonus - Meter / Month) <= 0
                                 Monthly KPI + Bonus - Meter / Month  otherwise
"""
import calendar
import time
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Optional

from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config.database import get_db
# Reused rather than re-probed: one definition of "has the mileage
# migration run?" keeps this report and the Daily KPI screen in agreement.
from app.routes.daily_kpi_route import has_mileage_columns
from app.config.settings import DEFAULT_COMPANY_ID
from app.services.wialon_snkrp_reports import WialonReportService, get_wialon_credentials

router = APIRouter()

FLEET_RESOURCE_ID = 601651347
FLEET_TEMPLATE_ID = 21

REPAIR_CATEGORY = "Repair Expenses / Maintenance Cost"
ENGINE_OIL_CATEGORY = "Engine Oil, Pump & Brake"
DIESEL_CATEGORY = "Diesel Fuel"
OTHER_CATEGORY = "Other Expense"


# The % KPI applied when a vehicle/month has no stored value.
#
# Substituted on READ rather than written into every row (see
# app/vehicle_monthly_kpi_add_kpi_percent.sql): rows nobody has touched
# then follow this constant if the company default ever changes, instead
# of being frozen at whatever it was when the row happened to be created.
DEFAULT_KPI_PERCENT = 2.0


def has_kpi_percent_column(db: Session) -> bool:
    """True once app/vehicle_monthly_kpi_add_kpi_percent.sql has been run.

    Probed rather than assumed so the report still renders before the
    migration -- every vehicle simply shows the default.
    """
    try:
        row = db.execute(
            text(
                """
                SELECT COUNT(*) AS n
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = 'vehicle_monthly_kpi'
                  AND COLUMN_NAME = 'kpi_percent'
                """
            )
        ).first()
        return bool(row and row.n)
    except SQLAlchemyError:
        return False


# --- Request body (manual extras) -----------------------------------------

class VehicleMonthlyKpiIn(BaseModel):
    """Bonus and Meter / Month for one vehicle in one month.

    `bonus` is deliberately unbounded: it is a manual adjustment that can
    be POSITIVE (a reward, increasing Monthly KPI + Bonus and therefore
    Remaining KPI) or NEGATIVE (a penalty, reducing them). Do not add a
    ge=0 constraint here -- and note that the database column must be a
    signed DECIMAL for a negative value to survive the round trip; see
    app/vehicle_monthly_kpi_allow_negative_bonus.sql.

    `meter_per_month` is an odometer reading, so it is constrained to zero
    or more.
    """
    vehicles_id: int
    year: int
    month: int = Field(..., ge=1, le=12)
    bonus: float = 0
    meter_per_month: float = Field(0, ge=0)
    # A percentage: numeric, never negative, and capped at 100 so a typo
    # like 200 (meant as 2.00) is rejected rather than stored. None means
    # "clear it" -- the vehicle goes back to the system default.
    kpi_percent: Optional[float] = Field(None, ge=0, le=100)


def _monthly_kpi(monthly_profit: float, kpi_percent: float) -> float:
    """Monthly KPI = IF(Monthly Profit <= 0, 0, Monthly Profit x % KPI).

    The zero floor is the point of the rule: a vehicle that lost money
    earns no KPI, and a NEGATIVE profit must not produce a negative KPI
    that would then net off against another vehicle's in the totals row.
    Zero profit is treated the same way -- nothing earned, nothing to
    take a percentage of.

    kpi_percent arrives as a percentage (2 meaning 2%), so it is divided
    by 100 here. Rounded to cents by the caller.
    """
    if monthly_profit <= 0:
        return 0.0
    return monthly_profit * (kpi_percent / 100.0)


def _monthly_kpi_plus_bonus(monthly_kpi: float, bonus: float) -> float:
    """Monthly KPI + Bonus = Monthly KPI + Bonus.

    Bonus may be NEGATIVE (a penalty), so this result can go below zero
    and is deliberately not floored: the column is an arithmetic total,
    and hiding a penalty that exceeds the KPI earned would misreport it.
    A missing Bonus is 0.

    Replaces the old "Monthly Profit + Bonus". Note it now builds on
    Monthly KPI (already a percentage of profit), not on raw profit, so
    it is a much smaller number than the column it replaced.
    """
    return monthly_kpi + (bonus or 0)


# --- Helpers ---------------------------------------------------------------

def _row_to_dict(row) -> dict:
    return dict(row._mapping)


def _driver_names_by_vehicle(db: Session, vehicle_ids: list) -> dict:
    """{vehicles_id: full_name} for whichever employee currently has each
    vehicle assigned (employees.vehicles_id)."""
    vehicle_ids = [v for v in dict.fromkeys(vehicle_ids) if v is not None]
    if not vehicle_ids:
        return {}
    placeholders = ", ".join(f":id{i}" for i in range(len(vehicle_ids)))
    params = {f"id{i}": vid for i, vid in enumerate(vehicle_ids)}
    rows = db.execute(
        text(
            f"""
            SELECT vehicles_id, CONCAT(first_name, ' ', last_name) AS full_name
            FROM employees
            WHERE vehicles_id IN ({placeholders}) AND employment_status != 'Terminated'
            """
        ),
        params,
    )
    return {row.vehicles_id: row.full_name for row in rows}


def _get_all_vehicles_enriched(db: Session, company_id: int) -> list:
    """Every vehicle in the Wialon account, enriched with Code/Vehicle Type
    (from the fleet report, scoped to the default unit group) and Plate
    Number (the unit's name). Returns [] on any failure so the report never
    hard-fails just because Wialon is down."""
    try:
        creds = get_wialon_credentials(db, company_id)
        service = WialonReportService(base_url=creds["base_url"])
        service.login(creds["wialon_token"])

        all_units = service.get_all_units()

        metrics_by_name = {}
        groups = service.get_objects()
        if groups:
            group_id = groups[0].get("id")
            now = int(time.time())
            report_rows = service.run_report(
                resource_id=FLEET_RESOURCE_ID,
                template_id=FLEET_TEMPLATE_ID,
                object_id=group_id,
                start=now - 86400,
                end=now,
            )
            metrics_by_name = service.parse_report_metrics_by_name(report_rows)

        result = []
        for u in all_units:
            key = service.normalize_name(u.get("name"))
            metrics = metrics_by_name.get(key, {})
            result.append(
                {
                    "vehicles_id": u["id"],
                    "plate_number": u.get("name") or "",
                    "code": metrics.get("code", ""),
                    "vehicle_type": metrics.get("vehicleTypeEng", ""),
                }
            )
        return result
    except Exception as e:
        print(f"DEBUG: vehicle financial report vehicle list fetch failed: {e}")
        return []


def _month_bounds(year: int, month: int) -> tuple:
    """First day of the month, and first day of the NEXT month.

    Used as a half-open range [start, next) instead of
    YEAR(col) = :year AND MONTH(col) = :month. Wrapping the column in a
    function makes the predicate non-sargable, so MySQL cannot use an
    index on work_date and has to evaluate every row in the table. The
    range form compares the bare column and can seek. It is also exactly
    equivalent: every date in the month is >= the 1st and < the 1st of the
    following month, with no gap and no overlap.
    """
    start = date(year, month, 1)
    nxt = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    return start, nxt


def _revenue_by_vehicle(db: Session, year: int, month: int) -> dict:
    """Total Monthly Revenue per vehicle = the sum of that vehicle's Daily
    KPI values for the month.

    Daily KPI per entry is the same figure the Daily KPI Entry screen
    shows (see _with_kpi in daily_kpi_route.py):

        work_type_kpi = LEAST(quantity, daily_productivity) * unit_price
        Daily KPI     = work_type_kpi + total_amount

    total_amount (mileage x amount per km) used to be left out here, so
    the report under-reported revenue for every "Assigned" vehicle
    relative to what the entry screen displayed for the very same rows.
    Both now use the same definition.

    Each row is ROUNDed before summing, matching _with_kpi's per-entry
    rounding -- so the monthly total is the sum of the figures the user
    actually sees, not a separately-rounded quantity that can differ by a
    cent.

    Grouped by vehicles_id, the unique vehicle key, so two vehicles with
    similar codes or plates can never merge. Vehicles with no entries are
    simply absent from the result and the caller reads them as 0.

    LEFT JOIN, not JOIN: an entry whose work type has since been removed
    would otherwise vanish from the total entirely, taking its
    total_amount with it. With the outer join its work-type component
    counts as 0 and the rest of the entry still counts.

    The join is on formulas.formula_id, a primary key, so it matches at
    most one row per entry -- no fan-out, and no entry can be counted
    twice.
    """
    # total_amount arrives with app/daily_kpi_add_mileage_amount.sql. Until
    # that migration is run the column does not exist, so substitute a
    # literal 0 -- which is what it contributes anyway.
    total_amount_term = (
        "COALESCE(e.total_amount, 0)" if has_mileage_columns(db) else "0"
    )
    period_start, next_period_start = _month_bounds(year, month)

    rows = db.execute(
        text(
            f"""
            SELECT e.vehicles_id,
                   SUM(
                       ROUND(
                           COALESCE(LEAST(f.quantity, e.daily_productivity) * f.unit_price, 0)
                           + {total_amount_term},
                           2
                       )
                   ) AS revenue
            FROM daily_kpi_entries e
            LEFT JOIN formulas f ON f.formula_id = e.work_type_id
            WHERE e.work_date >= :period_start
              AND e.work_date < :next_period_start
            GROUP BY e.vehicles_id
            """
        ),
        {"period_start": period_start, "next_period_start": next_period_start},
    )
    return {r.vehicles_id: float(r.revenue or 0) for r in rows}


def _expenses_by_vehicle(db: Session, year: int, month: int) -> dict:
    rows = db.execute(
        text(
            """
            SELECT vehicles_id, category, SUM(amount) AS total
            FROM vehicle_expenses
            WHERE YEAR(expense_date) = :year AND MONTH(expense_date) = :month
            GROUP BY vehicles_id, category
            """
        ),
        {"year": year, "month": month},
    )
    result: dict = {}
    for r in rows:
        result.setdefault(r.vehicles_id, {})[r.category] = float(r.total or 0)
    return result


def _staff_salary_by_vehicle(db: Session, year: int, month: int) -> dict:
    """SUM of Payroll Worker by Month's Total Salary Daily per vehicle
    (employees.vehicles_id), using the payroll_periods row that matches
    this year/month. Returns {} (no salaries) if no such period exists
    yet -- the report still renders, just with $0 staff salary."""
    period_row = db.execute(
        text("SELECT * FROM payroll_periods WHERE period_year = :year AND period_month = :month LIMIT 1"),
        {"year": year, "month": month},
    ).first()
    if not period_row:
        return {}
    period = _row_to_dict(period_row)
    total_working_days = period["total_working_days"] or 1

    emp_rows = db.execute(
        text(
            """
            SELECT
                e.employee_id, e.vehicles_id,
                COALESCE(
                    (SELECT sh.basic_salary FROM employee_salary_history sh
                     WHERE sh.employee_id = e.employee_id AND sh.effective_date <= :start_date
                     ORDER BY sh.effective_date DESC LIMIT 1),
                    e.basic_salary
                ) AS total_basic_salary,
                COALESCE(
                    (SELECT SUM(CASE WHEN a.status IN ('1','H') THEN 1 ELSE 0 END) FROM attendance a
                     WHERE a.employee_id = e.employee_id AND a.payroll_period_id = :payroll_period_id),
                    0
                ) AS total_attended,
                -- Present ONLY ('1'). Basic Food is paid on days actually
                -- worked, so it must not count Holiday ('H') the way
                -- total_attended above does. Kept identical to the payroll
                -- worksheet so Total Staff Salary here matches it exactly.
                COALESCE(
                    (SELECT SUM(CASE WHEN a.status = '1' THEN 1 ELSE 0 END) FROM attendance a
                     WHERE a.employee_id = e.employee_id AND a.payroll_period_id = :payroll_period_id),
                    0
                ) AS total_present,
                COALESCE(pe.ot_amount, 0) AS ot_amount,
                COALESCE(pe.other_allowance, 0) AS other_allowance,
                COALESCE(
                    (SELECT fp.basic_food_amount FROM food_policy_history fp
                     WHERE fp.effective_date <= :start_date
                     ORDER BY fp.effective_date DESC LIMIT 1),
                    0
                ) AS basic_of_food
            FROM employees e
            LEFT JOIN payroll_entries pe
                ON pe.employee_id = e.employee_id AND pe.payroll_period_id = :payroll_period_id
            WHERE e.vehicles_id IS NOT NULL AND e.employment_status != 'Terminated'
            """
        ),
        {"start_date": period["start_date"], "payroll_period_id": period["payroll_period_id"]},
    )

    result: dict = {}
    for r in emp_rows:
        total_basic_salary = float(r.total_basic_salary)
        total_attended = int(r.total_attended)
        total_present = int(r.total_present)
        basic_of_food = float(r.basic_of_food)
        ot_amount = float(r.ot_amount)
        other_allowance = float(r.other_allowance)

        total_amount = round((total_basic_salary / total_working_days) * total_attended, 2)
        food_daily = round((basic_of_food / total_working_days) * total_present, 2)
        total_salary_daily = round(total_amount + ot_amount + food_daily + other_allowance, 2)

        result[r.vehicles_id] = result.get(r.vehicles_id, 0) + total_salary_daily
    return result


def _rental_expense_and_status_by_vehicle(db: Session, year: int, month: int) -> dict:
    """{vehicles_id: {"expense", "working", "standby", "broken"}} -- the
    Vehicle Rental Expense figure plus the day-status counts Remarks is
    built from, summed across all of that vehicle's rental record(s)."""
    days_in_month = calendar.monthrange(year, month)[1]
    rows = db.execute(
        text(
            """
            SELECT r.vehicles_id, r.monthly_rental,
                   SUM(CASE WHEN a.status = 'Working' THEN 1 ELSE 0 END) AS working,
                   SUM(CASE WHEN a.status = 'On Standby' THEN 1 ELSE 0 END) AS standby,
                   SUM(CASE WHEN a.status = 'Broken' THEN 1 ELSE 0 END) AS broken
            FROM vehicle_rentals r
            LEFT JOIN vehicle_rental_attendance a
                ON a.rental_id = r.rental_id
               AND YEAR(a.work_date) = :year AND MONTH(a.work_date) = :month
            GROUP BY r.rental_id
            """
        ),
        {"year": year, "month": month},
    )
    result: dict = {}
    for r in rows:
        monthly_rental = float(r.monthly_rental or 0)
        working = int(r.working or 0)
        standby = int(r.standby or 0)
        broken = int(r.broken or 0)
        expense = round((monthly_rental / days_in_month) * (working + standby), 2)

        acc = result.setdefault(r.vehicles_id, {"expense": 0.0, "working": 0, "standby": 0, "broken": 0})
        acc["expense"] += expense
        acc["working"] += working
        acc["standby"] += standby
        acc["broken"] += broken
    return result


# --- Routes --------------------------------------------------------------

@router.get("/vehicle-financial-report")
def get_vehicle_financial_report(
    year: int = Query(..., description="Report year"),
    month: int = Query(..., ge=1, le=12, description="Report month (1-12)"),
    company_id: int = Query(
        DEFAULT_COMPANY_ID, description="Company whose Wialon credentials to use for Code/Plate/Vehicle Type"
    ),
    db: Session = Depends(get_db),
):
    vehicles = _get_all_vehicles_enriched(db, company_id)
    vehicle_ids = [v["vehicles_id"] for v in vehicles]

    driver_names = _driver_names_by_vehicle(db, vehicle_ids)

    try:
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
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=(
                "Could not compute the vehicle financial report -- have daily_kpi.sql, "
                f"vehicle_expenses.sql, vehicle_rentals.sql, and vehicle_monthly_kpi.sql all been run yet? ({e})"
            ),
        )

    data = []
    for v in vehicles:
        vid = v["vehicles_id"]
        revenue = revenue_by_vehicle.get(vid, 0)
        cats = expenses_by_vehicle.get(vid, {})
        repair = cats.get(REPAIR_CATEGORY, 0)
        engine_oil = cats.get(ENGINE_OIL_CATEGORY, 0)
        diesel = cats.get(DIESEL_CATEGORY, 0)
        other = cats.get(OTHER_CATEGORY, 0)
        staff_salary = salary_by_vehicle.get(vid, 0)
        rental = rental_by_vehicle.get(vid, {"expense": 0.0, "working": 0, "standby": 0, "broken": 0})
        rental_expense = rental["expense"]

        total_monthly_expenses = round(
            repair + engine_oil + diesel + other + staff_salary + rental_expense, 2
        )
        monthly_profit = round(revenue - total_monthly_expenses, 2)

        extras = extras_by_vehicle.get(vid, {})
        bonus = float(extras.get("bonus") or 0)
        meter_per_month = float(extras.get("meter_per_month") or 0)
        # None (or a missing column, before the migration) means nobody has
        # set a percentage for this vehicle/month -- fall back to the
        # system default. A stored 0 is a real choice and is kept.
        stored_percent = extras.get("kpi_percent")
        kpi_percent = (
            float(stored_percent) if stored_percent is not None else DEFAULT_KPI_PERCENT
        )

        monthly_kpi = round(_monthly_kpi(monthly_profit, kpi_percent), 2)
        monthly_kpi_plus_bonus = round(_monthly_kpi_plus_bonus(monthly_kpi, bonus), 2)
        # Remaining KPI used to subtract Meter / Month from KPI Achieved.
        # That column is gone, so it now subtracts from Monthly KPI +
        # Bonus -- the column that took its place as "what this vehicle
        # earned this month". Still floored at 0: a shortfall is reported
        # as nothing remaining, not as a negative amount.
        remaining = monthly_kpi_plus_bonus - meter_per_month
        remaining_kpi = round(remaining, 2) if remaining > 0 else 0.0

        remarks = f"Working: {rental['working']}, On Standby: {rental['standby']}, B: {rental['broken']}"

        data.append(
            {
                "vehicles_id": vid,
                "code": v["code"],
                "plate_number": v["plate_number"],
                "vehicle_type": v["vehicle_type"],
                "driver_name": driver_names.get(vid, ""),
                "total_monthly_revenue": round(revenue, 2),
                "repair_expense": round(repair, 2),
                "engine_oil_expense": round(engine_oil, 2),
                "diesel_expense": round(diesel, 2),
                "other_expense": round(other, 2),
                "staff_salary": round(staff_salary, 2),
                "rental_expense": round(rental_expense, 2),
                "total_monthly_expenses": total_monthly_expenses,
                "monthly_profit": monthly_profit,
                # Sits immediately after Monthly Profit on the report.
                "kpi_percent": round(kpi_percent, 2),
                # True when the value is the system default rather than one
                # somebody chose -- lets the UI show it differently without
                # having to guess from the number.
                "kpi_percent_is_default": stored_percent is None,
                "monthly_kpi": monthly_kpi,
                "bonus": bonus,
                "monthly_kpi_plus_bonus": monthly_kpi_plus_bonus,
                "meter_per_month": meter_per_month,
                "remaining_kpi": remaining_kpi,
                "remarks": remarks,
            }
        )

    return {"status": "success", "year": year, "month": month, "total_vehicles": len(data), "data": data}


@router.put("/vehicle-financial-report/extras")
def upsert_vehicle_monthly_kpi(payload: VehicleMonthlyKpiIn, db: Session = Depends(get_db)):
    """Create or update the manually-entered fields on this report --
    Bonus, Meter / Month and % KPI -- for one vehicle + month. Monthly
    KPI, Monthly KPI + Bonus and Remarks are computed, not stored.

    Sending kpi_percent as null clears it, which returns that vehicle to
    the system default rather than storing a zero."""
    existing = db.execute(
        text(
            "SELECT id FROM vehicle_monthly_kpi "
            "WHERE vehicles_id = :vehicles_id AND report_year = :year AND report_month = :month"
        ),
        {"vehicles_id": payload.vehicles_id, "year": payload.year, "month": payload.month},
    ).first()

    # Written only once the migration has been run; until then the other
    # two fields still save normally rather than the whole request failing.
    with_percent = has_kpi_percent_column(db)

    try:
        if existing:
            percent_set = ", kpi_percent = :kpi_percent" if with_percent else ""
            db.execute(
                text(
                    f"""
                    UPDATE vehicle_monthly_kpi
                    SET bonus = :bonus, meter_per_month = :meter_per_month{percent_set}
                    WHERE id = :id
                    """
                ),
                {**payload.model_dump(), "id": existing.id},
            )
        else:
            percent_col = ", kpi_percent" if with_percent else ""
            percent_val = ", :kpi_percent" if with_percent else ""
            db.execute(
                text(
                    f"""
                    INSERT INTO vehicle_monthly_kpi
                        (vehicles_id, report_year, report_month, bonus, meter_per_month{percent_col})
                    VALUES
                        (:vehicles_id, :year, :month, :bonus, :meter_per_month{percent_val})
                    """
                ),
                payload.model_dump(),
            )
        db.commit()

        row = db.execute(
            text(
                "SELECT * FROM vehicle_monthly_kpi "
                "WHERE vehicles_id = :vehicles_id AND report_year = :year AND report_month = :month"
            ),
            {"vehicles_id": payload.vehicles_id, "year": payload.year, "month": payload.month},
        ).first()
        return {"status": "success", "data": _row_to_dict(row)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not save monthly KPI extras: {e}")
