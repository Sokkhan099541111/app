"""
Monthly Vehicle Financial & KPI Performance Report -- aggregates data that
already lives in four other modules into one row per vehicle, plus a small
table (vehicle_monthly_kpi, see app/vehicle_monthly_kpi.sql) for the only
two fields nothing else can supply: Bonus and Meter / Month (both manually
entered). Everything else, including Monthly KPI, KPI Achieved, and
Remarks, is computed.

Per-vehicle figures and where each comes from:

  - Code, Plate Number, Vehicle Type -- Vehicle Unit API (Wialon), same
    fleet report (template_id=21) the other vehicle modules already use.
  - Driver Name -- `employees` WHERE employees.vehicles_id = <this vehicle>
    (same convention as Vehicle Rental / Daily KPI / Vehicle Expense).
  - Total Monthly Revenue -- SUM of Daily KPI Entry's computed KPI
    (LEAST(quantity, daily_productivity) * unit_price) for the month.
  - Repair & Maintenance / Engine Oil, Pump & Brake / Diesel Fuel Expenses
    -- SUM(vehicle_expenses.amount) per category for the month.
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
                               + Staff Salary + Vehicle Rental Expense
    Monthly Profit           = Total Monthly Revenue - Total Monthly Expenses
    Monthly Profit + Bonus   = Monthly Profit + Bonus
    Monthly KPI               = 200                       if Monthly Profit > 200
                                 0                          if Monthly Profit < 0
                                 Monthly Profit             otherwise
    KPI Achieved               = 200                       if (Monthly Profit + Bonus) > 200
                                 0                          if (Monthly Profit + Bonus) <= 0
                                 Monthly Profit + Bonus     otherwise
    Remaining KPI              = 0                          if (KPI Achieved - Meter / Month) <= 0
                                 KPI Achieved - Meter / Month  otherwise
"""
import calendar
import time

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config.database import get_db
from app.config.settings import DEFAULT_COMPANY_ID
from app.services.wialon_snkrp_reports import WialonReportService, get_wialon_credentials

router = APIRouter()

FLEET_RESOURCE_ID = 601651347
FLEET_TEMPLATE_ID = 21

REPAIR_CATEGORY = "Repair Expenses / Maintenance Cost"
ENGINE_OIL_CATEGORY = "Engine Oil, Pump & Brake"
DIESEL_CATEGORY = "Diesel Fuel"


# --- Request body (manual extras) -----------------------------------------

class VehicleMonthlyKpiIn(BaseModel):
    vehicles_id: int
    year: int
    month: int
    bonus: float = 0
    meter_per_month: float = 0


def _clamp_monthly_kpi(monthly_profit: float) -> float:
    if monthly_profit > 200:
        return 200.0
    if monthly_profit < 0:
        return 0.0
    return monthly_profit


def _clamp_kpi_achieved(monthly_profit_plus_bonus: float) -> float:
    if monthly_profit_plus_bonus > 200:
        return 200.0
    if monthly_profit_plus_bonus <= 0:
        return 0.0
    return monthly_profit_plus_bonus


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


def _revenue_by_vehicle(db: Session, year: int, month: int) -> dict:
    rows = db.execute(
        text(
            """
            SELECT e.vehicles_id,
                   SUM(LEAST(f.quantity, e.daily_productivity) * f.unit_price) AS revenue
            FROM daily_kpi_entries e
            JOIN formulas f ON f.formula_id = e.work_type_id
            WHERE YEAR(e.work_date) = :year AND MONTH(e.work_date) = :month
            GROUP BY e.vehicles_id
            """
        ),
        {"year": year, "month": month},
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
                    (SELECT SUM(a.is_attended) FROM attendance a
                     WHERE a.employee_id = e.employee_id AND a.payroll_period_id = :payroll_period_id),
                    0
                ) AS total_attended,
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
        basic_of_food = float(r.basic_of_food)
        ot_amount = float(r.ot_amount)
        other_allowance = float(r.other_allowance)

        total_amount = round((total_basic_salary / total_working_days) * total_attended, 2)
        food_daily = round((basic_of_food / total_working_days) * total_attended, 2)
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
        staff_salary = salary_by_vehicle.get(vid, 0)
        rental = rental_by_vehicle.get(vid, {"expense": 0.0, "working": 0, "standby": 0, "broken": 0})
        rental_expense = rental["expense"]

        total_monthly_expenses = round(repair + engine_oil + diesel + staff_salary + rental_expense, 2)
        monthly_profit = round(revenue - total_monthly_expenses, 2)

        extras = extras_by_vehicle.get(vid, {})
        bonus = float(extras.get("bonus") or 0)
        meter_per_month = float(extras.get("meter_per_month") or 0)

        monthly_profit_plus_bonus = round(monthly_profit + bonus, 2)
        monthly_kpi = round(_clamp_monthly_kpi(monthly_profit), 2)
        kpi_achieved = round(_clamp_kpi_achieved(monthly_profit_plus_bonus), 2)
        remaining = kpi_achieved - meter_per_month
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
                "staff_salary": round(staff_salary, 2),
                "rental_expense": round(rental_expense, 2),
                "total_monthly_expenses": total_monthly_expenses,
                "monthly_profit": monthly_profit,
                "monthly_kpi": monthly_kpi,
                "bonus": bonus,
                "monthly_profit_plus_bonus": monthly_profit_plus_bonus,
                "kpi_achieved": kpi_achieved,
                "meter_per_month": meter_per_month,
                "remaining_kpi": remaining_kpi,
                "remarks": remarks,
            }
        )

    return {"status": "success", "year": year, "month": month, "total_vehicles": len(data), "data": data}


@router.put("/vehicle-financial-report/extras")
def upsert_vehicle_monthly_kpi(payload: VehicleMonthlyKpiIn, db: Session = Depends(get_db)):
    """Create or update the only two manually-entered fields on this
    report -- Bonus and Meter / Month -- for one vehicle + month. Monthly
    KPI, KPI Achieved, and Remarks are computed, not stored."""
    existing = db.execute(
        text(
            "SELECT id FROM vehicle_monthly_kpi "
            "WHERE vehicles_id = :vehicles_id AND report_year = :year AND report_month = :month"
        ),
        {"vehicles_id": payload.vehicles_id, "year": payload.year, "month": payload.month},
    ).first()

    try:
        if existing:
            db.execute(
                text(
                    """
                    UPDATE vehicle_monthly_kpi
                    SET bonus = :bonus, meter_per_month = :meter_per_month
                    WHERE id = :id
                    """
                ),
                {**payload.model_dump(), "id": existing.id},
            )
        else:
            db.execute(
                text(
                    """
                    INSERT INTO vehicle_monthly_kpi
                        (vehicles_id, report_year, report_month, bonus, meter_per_month)
                    VALUES
                        (:vehicles_id, :year, :month, :bonus, :meter_per_month)
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
