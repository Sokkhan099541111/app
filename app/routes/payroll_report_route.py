"""
Read-only payslip report -- joins employees, payroll_periods, payroll_entries,
attendance, employee_salary_history, and food_policy_history and applies the
payroll workbook's formulas:

    Salary of per day  = Total Basic Salary / Total Working Days of the Month
    Total Amount       = Salary of per day x Total Attended
    Food Daily         = (Basic of Food / Total Working Days of the Month) x Total Attended
    Total Salary Daily = Total Amount + Amount of OT + Food Daily + Basic of Other Allowance

Nothing here is stored -- it's computed fresh from payroll_periods x
employees (every active employee gets a row for every period in range,
even before anyone has filled in a payroll_entries row -- OT/Other
Allowance just default to $0 until entered, matching the "Payroll Worker
by Month" worksheet), attendance (summed via is_attended),
employee_salary_history (the rate effective on or before the period's
start_date, falling back to employees.basic_salary), and food_policy_history
(the rate effective on or before the period's start_date). Terminated
employees only appear for periods where they already have a recorded
payroll_entries row, so old payslips stay visible without terminated staff
flooding new/future periods.
"""
import io
import os
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config.database import get_db

router = APIRouter()

MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]

# Fallback logo used on the exported payslip PDF when no company has an
# active, uploaded Wialon-credentials logo -- kept alongside this route so
# the PDF export doesn't depend on the frontend's asset folder.
LOGO_PATH = os.path.join(os.path.dirname(__file__), "..", "assets", "snkrp_logo.png")

# Where company_wialon_credential_route.py's upload-logo endpoint saves
# files, and what company_logo URLs (e.g. "/uploads/logos/xxx.png") are
# relative to.
UPLOADS_DIR = os.path.join(os.path.dirname(__file__), "..", "uploads")


def _row_to_dict(row) -> dict:
    return dict(row._mapping)


def _resolve_company_logo_path(db: Session) -> Optional[str]:
    """Filesystem path to the active company's uploaded logo, or None if no
    company is active / has a logo uploaded / the file is missing on disk."""
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


def _fetch_payslip_rows(
    db: Session,
    period_year: Optional[int],
    period_month: Optional[int],
    employee_id: Optional[int],
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
) -> list[dict]:
    """Shared query behind both GET /payroll-report (JSON) and
    GET /payroll-report/payslip-pdf (PDF) -- same filters, same formulas,
    plus gender/department/position for the PDF's employee-info block.

    start_date/end_date filter by payroll period overlap (pp.start_date /
    pp.end_date) rather than an exact year+month match, so a date range
    spanning parts of two periods pulls in both."""
    # Always exclude Terminated employees UNLESS they already have a
    # payroll_entries row for that period (keeps historical payslips intact
    # without terminated staff showing up in newly-added periods).
    clauses = ["(e.employment_status != 'Terminated' OR pe.payroll_entry_id IS NOT NULL)"]
    params: dict = {}
    if period_year is not None:
        clauses.append("pp.period_year = :period_year")
        params["period_year"] = period_year
    if period_month is not None:
        clauses.append("pp.period_month = :period_month")
        params["period_month"] = period_month
    if employee_id is not None:
        clauses.append("e.employee_id = :employee_id")
        params["employee_id"] = employee_id
    if start_date is not None:
        clauses.append("pp.end_date >= :start_date")
        params["start_date"] = start_date
    if end_date is not None:
        clauses.append("pp.start_date <= :end_date")
        params["end_date"] = end_date
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    sql = f"""
        SELECT
            base.*,
            ROUND(base.total_basic_salary / base.total_working_days, 2) AS salary_per_day,
            ROUND((base.total_basic_salary / base.total_working_days) * base.total_attended, 2) AS total_amount,
            ROUND((base.basic_of_food / base.total_working_days) * base.total_attended, 2) AS food_daily,
            ROUND((base.total_basic_salary / base.total_working_days) * base.total_attended, 2)
                + base.ot_amount
                + ROUND((base.basic_of_food / base.total_working_days) * base.total_attended, 2)
                + base.other_allowance AS total_salary_daily
        FROM (
            SELECT
                pe.payroll_entry_id,
                e.employee_id,
                e.employee_code,
                e.gender,
                CONCAT(e.first_name, ' ', e.last_name) AS full_name,
                d.name AS department_name,
                p.title AS position_title,
                pp.payroll_period_id,
                pp.period_year,
                pp.period_month,
                pp.total_working_days,
                COALESCE(
                    (SELECT sh.basic_salary FROM employee_salary_history sh
                     WHERE sh.employee_id = e.employee_id AND sh.effective_date <= pp.start_date
                     ORDER BY sh.effective_date DESC LIMIT 1),
                    e.basic_salary
                ) AS total_basic_salary,
                COALESCE(
                    (SELECT fp.basic_food_amount FROM food_policy_history fp
                     WHERE fp.effective_date <= pp.start_date
                     ORDER BY fp.effective_date DESC LIMIT 1),
                    0
                ) AS basic_of_food,
                COALESCE(
                    (SELECT SUM(a.is_attended) FROM attendance a
                     WHERE a.employee_id = e.employee_id AND a.payroll_period_id = pp.payroll_period_id),
                    0
                ) AS total_attended,
                COALESCE(pe.ot_hours, 0) AS ot_hours,
                COALESCE(pe.ot_amount, 0) AS ot_amount,
                COALESCE(pe.other_allowance, 0) AS other_allowance
            FROM employees e
            CROSS JOIN payroll_periods pp
            LEFT JOIN payroll_entries pe
                ON pe.employee_id = e.employee_id AND pe.payroll_period_id = pp.payroll_period_id
            LEFT JOIN departments d ON d.department_id = e.department_id
            LEFT JOIN positions p ON p.position_id = e.position_id
            {where}
        ) AS base
        ORDER BY base.full_name
    """
    rows = db.execute(text(sql), params)
    return [_row_to_dict(r) for r in rows]


def _build_payslip_pdf(rows: list[dict], logo_path: Optional[str] = None) -> bytes:
    """Renders one A5 payslip page per row, in the same layout as the
    Payslip Report page's Excel export -- logo, employee info block,
    itemized earnings breakdown, and a Net Pay banner."""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_RIGHT
    from reportlab.lib.pagesizes import A5
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        HRFlowable,
        Image,
        PageBreak,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    NAVY = colors.HexColor("#051650")
    LIGHT_GREY = colors.HexColor("#F2F2F2")
    BORDER_GREY = colors.HexColor("#D9D9D9")

    styles = getSampleStyleSheet()
    company_style = ParagraphStyle("Company", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=11, textColor=NAVY, leading=13)
    address_style = ParagraphStyle("Address", parent=styles["Normal"], fontName="Helvetica", fontSize=6.5, textColor=colors.HexColor("#666666"), leading=8)
    title_style = ParagraphStyle("Title", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=14, textColor=NAVY, alignment=TA_CENTER, spaceAfter=1)
    subtitle_style = ParagraphStyle("Subtitle", parent=styles["Normal"], fontName="Helvetica", fontSize=8.5, textColor=colors.HexColor("#555555"), alignment=TA_CENTER)
    section_style = ParagraphStyle("Section", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=8.5, textColor=colors.white)
    label_style = ParagraphStyle("Label", parent=styles["Normal"], fontName="Helvetica", fontSize=8, textColor=colors.HexColor("#555555"), leading=10)
    value_style = ParagraphStyle("Value", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=8.5, textColor=colors.black, leading=10)
    net_label_style = ParagraphStyle("NetLabel", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=10.5, textColor=colors.white, leading=13)
    net_value_style = ParagraphStyle("NetValue", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=10.5, textColor=colors.white, alignment=TA_RIGHT, leading=13)
    footer_style = ParagraphStyle("Footer", parent=styles["Normal"], fontName="Helvetica-Oblique", fontSize=6.5, textColor=colors.HexColor("#888888"))
    formula_style = ParagraphStyle("Formula", parent=styles["Normal"], fontName="Helvetica-Oblique", fontSize=6.5, textColor=colors.HexColor("#888888"), alignment=TA_CENTER)
    sig_style = ParagraphStyle("Sig", parent=styles["Normal"], fontName="Helvetica", fontSize=7.5, textColor=colors.HexColor("#333333"), alignment=TA_CENTER)

    PAGE_W, _ = A5
    MARGIN = 10 * mm
    CONTENT_W = PAGE_W - 2 * MARGIN

    def money(v) -> str:
        return f"$ {float(v or 0):,.2f}"

    def section_header(text_):
        t = Table([[Paragraph(text_, section_style)]], colWidths=[CONTENT_W])
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), NAVY),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]))
        return t

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A5,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=9 * mm,
        bottomMargin=9 * mm,
        title="Payslip Report",
    )

    story = []
    effective_logo_path = logo_path if logo_path and os.path.isfile(logo_path) else LOGO_PATH
    has_logo = os.path.isfile(effective_logo_path)

    for i, row in enumerate(rows):
        period_label = f"{MONTH_NAMES[int(row['period_month']) - 1]} {row['period_year']}"

        if has_logo:
            logo = Image(effective_logo_path, width=20 * mm, height=20 * mm * (106 / 174))
        else:
            logo = Paragraph("", label_style)
        company_block = [
            Paragraph("SNKRP", company_style),
            Paragraph("Fleet &amp; Workforce Operations", address_style),
        ]
        header_tbl = Table([[logo, company_block]], colWidths=[22 * mm, CONTENT_W - 22 * mm])
        header_tbl.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ]))
        story.append(header_tbl)
        story.append(Spacer(1, 5))
        story.append(HRFlowable(width=CONTENT_W, thickness=1.2, color=NAVY))
        story.append(Spacer(1, 6))

        story.append(Paragraph("PAYSLIP", title_style))
        story.append(Paragraph(f"Pay Period: {period_label}", subtitle_style))
        story.append(Spacer(1, 8))

        story.append(section_header("EMPLOYEE INFORMATION"))
        story.append(Spacer(1, 4))
        info_rows = [
            [Paragraph("Employee Name", label_style), Paragraph(row.get("full_name") or "-", value_style),
             Paragraph("Employee Code", label_style), Paragraph(row.get("employee_code") or "-", value_style)],
            [Paragraph("Department", label_style), Paragraph(row.get("department_name") or "-", value_style),
             Paragraph("Position", label_style), Paragraph(row.get("position_title") or "-", value_style)],
            [Paragraph("Gender", label_style), Paragraph(row.get("gender") or "-", value_style),
             Paragraph("Pay Period", label_style), Paragraph(period_label, value_style)],
            [Paragraph("Working Days", label_style), Paragraph(str(row.get("total_working_days") or 0), value_style),
             Paragraph("Days Attended", label_style), Paragraph(str(row.get("total_attended") or 0), value_style)],
        ]
        col_w = CONTENT_W / 4
        info_tbl = Table(info_rows, colWidths=[col_w * 0.8, col_w * 1.2, col_w * 0.8, col_w * 1.2])
        info_tbl.setStyle(TableStyle([
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 2.5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
            ("BOX", (0, 0), (-1, -1), 0.75, BORDER_GREY),
            ("INNERGRID", (0, 0), (-1, -1), 0.5, BORDER_GREY),
        ]))
        story.append(info_tbl)
        story.append(Spacer(1, 8))

        story.append(section_header("EARNINGS BREAKDOWN"))
        story.append(Spacer(1, 4))
        working_days = row.get("total_working_days") or 0
        attended = row.get("total_attended") or 0
        salary_per_day = row.get("salary_per_day") or 0
        earn_rows = [
            ["Basic Salary (Monthly)", f"{money(row.get('total_basic_salary'))} / {working_days} days", f"{money(salary_per_day)} /day"],
            ["Basic Pay", f"{money(salary_per_day)} x {attended} days attended", money(row.get("total_amount"))],
            ["Overtime", f"{float(row.get('ot_hours') or 0):.1f} hrs", money(row.get("ot_amount"))],
            ["Food Allowance", f"pro-rated x {attended} days", money(row.get("food_daily"))],
            ["Other Allowance", "-", money(row.get("other_allowance"))],
        ]
        table_data = [["Description", "Detail", "Amount"]] + earn_rows
        earn_tbl = Table(table_data, colWidths=[CONTENT_W * 0.34, CONTENT_W * 0.40, CONTENT_W * 0.26])
        earn_tbl.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 8),
            ("BACKGROUND", (0, 0), (-1, 0), LIGHT_GREY),
            ("ALIGN", (2, 0), (2, -1), "RIGHT"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("BOX", (0, 0), (-1, -1), 0.75, BORDER_GREY),
            ("INNERGRID", (0, 0), (-1, -1), 0.5, BORDER_GREY),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 3.5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FAFAFA")]),
        ]))
        story.append(earn_tbl)
        story.append(Spacer(1, 6))

        net_tbl = Table(
            [[Paragraph("NET PAY", net_label_style), Paragraph(money(row.get("total_salary_daily")), net_value_style)]],
            colWidths=[CONTENT_W * 0.6, CONTENT_W * 0.4],
        )
        net_tbl.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), NAVY),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 7),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ]))
        story.append(net_tbl)
        story.append(Spacer(1, 3))
        story.append(Paragraph(
            "Net Pay = Basic Pay + Overtime + Food Allowance + Other Allowance",
            formula_style,
        ))
        story.append(Spacer(1, 14))

        sig_tbl = Table(
            [
                ["_" * 28, "_" * 28],
                [Paragraph("Employee Signature", sig_style), Paragraph("Approved By (HR / Admin)", sig_style)],
            ],
            colWidths=[CONTENT_W / 2, CONTENT_W / 2],
        )
        sig_tbl.setStyle(TableStyle([("ALIGN", (0, 0), (-1, -1), "CENTER")]))
        story.append(sig_tbl)
        story.append(Spacer(1, 10))
        story.append(HRFlowable(width=CONTENT_W, thickness=0.5, color=BORDER_GREY))
        story.append(Spacer(1, 3))
        story.append(Paragraph(
            "This payslip is computer-generated and does not require a signature to be valid.",
            footer_style,
        ))

        if i < len(rows) - 1:
            story.append(PageBreak())

    doc.build(story)
    return buffer.getvalue()


@router.get("/payroll-report")
def get_payroll_report(
    period_year: Optional[int] = Query(None, description="Filter by year"),
    period_month: Optional[int] = Query(None, description="Filter by month (1-12)"),
    employee_id: Optional[int] = Query(None, description="Filter by employee"),
    start_date: Optional[date] = Query(None, description="Payroll period overlap range start (YYYY-MM-DD)"),
    end_date: Optional[date] = Query(None, description="Payroll period overlap range end (YYYY-MM-DD)"),
    db: Session = Depends(get_db),
):
    """One row per employee per payroll period that has a payroll_entries
    row -- add a payroll entry first (even with OT/allowance left at 0) for
    an employee/period to show up here."""
    try:
        rows = _fetch_payslip_rows(db, period_year, period_month, employee_id, start_date, end_date)
        return {"status": "success", "data": rows}
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=(
                "Could not compute the payroll report -- have employee_salary_history.sql, "
                f"food_policy_history.sql, payroll_periods.sql, attendance.sql, and "
                f"payroll_entries.sql all been run yet? ({e})"
            ),
        )


@router.get("/payroll-report/payslip-pdf")
def get_payslip_pdf(
    period_year: Optional[int] = Query(None, description="Filter by year"),
    period_month: Optional[int] = Query(None, description="Filter by month (1-12)"),
    employee_id: Optional[int] = Query(None, description="Filter by employee"),
    start_date: Optional[date] = Query(None, description="Payroll period overlap range start (YYYY-MM-DD)"),
    end_date: Optional[date] = Query(None, description="Payroll period overlap range end (YYYY-MM-DD)"),
    db: Session = Depends(get_db),
):
    """Same filters/rows as GET /payroll-report, rendered as a printable A5
    payslip PDF -- one page per employee/period row, in the same layout as
    the sample payslip design (logo, employee info, earnings breakdown,
    Net Pay banner)."""
    try:
        rows = _fetch_payslip_rows(db, period_year, period_month, employee_id, start_date, end_date)
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=(
                "Could not compute the payroll report -- have employee_salary_history.sql, "
                f"food_policy_history.sql, payroll_periods.sql, attendance.sql, and "
                f"payroll_entries.sql all been run yet? ({e})"
            ),
        )
    if not rows:
        raise HTTPException(status_code=404, detail="No payslip rows found for the given filters.")

    pdf_bytes = _build_payslip_pdf(rows, logo_path=_resolve_company_logo_path(db))
    filename = (
        f"Payslip_{rows[0]['employee_code']}.pdf"
        if len(rows) == 1
        else f"Payslip_Report_{len(rows)}_employees.pdf"
    )
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/payroll-report/worksheet")
def get_payroll_worksheet(
    payroll_period_id: int = Query(..., description="Payroll period to build the worksheet for"),
    include_terminated: bool = Query(False, description="Include Terminated employees"),
    db: Session = Depends(get_db),
):
    """
    The "Payroll Worker by Month" spreadsheet view -- one row per employee
    for a single payroll period, with a day-by-day attendance tick plus the
    same payslip formulas as GET /payroll-report. Unlike /payroll-report
    (which only lists employees that already have a payroll_entries row),
    this lists every employee for the period via a LEFT JOIN, so OT/other
    allowance default to 0 until someone fills in a payroll entry --
    matching the workbook, where every worker has a row every month
    regardless of whether OT was entered yet.

    Returns:
      - period: the payroll_periods row (start_date/end_date/total_working_days)
      - employees: one row per employee with the computed payslip fields
        (salary_per_day, total_attended, total_amount, food_daily,
        total_salary_daily, etc.)
      - attendance: raw {employee_id, work_date, status} rows for the
        period -- the frontend pivots these into day-of-month columns
        (1..total_working_days) itself, since column count varies by month.
    """
    period_row = db.execute(
        text("SELECT * FROM payroll_periods WHERE payroll_period_id = :id"),
        {"id": payroll_period_id},
    ).first()
    if not period_row:
        raise HTTPException(status_code=404, detail=f"Payroll period {payroll_period_id} not found")
    period = _row_to_dict(period_row)

    status_clause = "" if include_terminated else "AND e.employment_status != 'Terminated'"

    try:
        emp_rows = db.execute(
            text(
                f"""
                SELECT
                    e.employee_id,
                    e.employee_code,
                    e.gender,
                    CONCAT(e.first_name, ' ', e.last_name) AS full_name,
                    e.employment_status,
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
                    COALESCE(pe.ot_hours, 0) AS ot_hours,
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
                    ON pe.employee_id = e.employee_id
                   AND pe.payroll_period_id = :payroll_period_id
                WHERE 1 = 1 {status_clause}
                ORDER BY e.first_name ASC, e.last_name ASC
                """
            ),
            {"payroll_period_id": payroll_period_id, "start_date": period["start_date"]},
        )

        total_working_days = period["total_working_days"] or 1
        employees = []
        for r in emp_rows:
            row = _row_to_dict(r)
            total_basic_salary = float(row["total_basic_salary"])
            total_attended = int(row["total_attended"])
            basic_of_food = float(row["basic_of_food"])
            ot_amount = float(row["ot_amount"])
            other_allowance = float(row["other_allowance"])

            salary_per_day = round(total_basic_salary / total_working_days, 2)
            total_amount = round((total_basic_salary / total_working_days) * total_attended, 2)
            food_daily = round((basic_of_food / total_working_days) * total_attended, 2)
            total_salary_daily = round(total_amount + ot_amount + food_daily + other_allowance, 2)

            employees.append(
                {
                    **row,
                    "total_basic_salary": total_basic_salary,
                    "salary_per_day": salary_per_day,
                    "total_working_days": total_working_days,
                    "total_attended": total_attended,
                    "total_amount": total_amount,
                    "ot_hours": float(row["ot_hours"]),
                    "ot_amount": ot_amount,
                    "basic_of_food": basic_of_food,
                    "food_daily": food_daily,
                    "other_allowance": other_allowance,
                    "total_salary_daily": total_salary_daily,
                }
            )

        attendance_rows = db.execute(
            text(
                "SELECT employee_id, work_date, status FROM attendance "
                "WHERE payroll_period_id = :payroll_period_id"
            ),
            {"payroll_period_id": payroll_period_id},
        )
        attendance = [_row_to_dict(r) for r in attendance_rows]

        return {"status": "success", "period": period, "employees": employees, "attendance": attendance}
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=(
                "Could not build the payroll worksheet -- have employees.sql, "
                "employee_salary_history.sql, food_policy_history.sql, payroll_periods.sql, "
                f"attendance.sql, and payroll_entries.sql all been run yet? ({e})"
            ),
        )
