import { useEffect, useMemo, useState } from "react";
import { Card, Select, Button, Tooltip, message, Empty } from "antd";
import { FileExcelOutlined, ReloadOutlined, TableOutlined, CaretUpOutlined, CaretDownOutlined } from "@ant-design/icons";
import { useAuth } from "../src/context/AuthContext";
import { Link } from "react-router-dom";
import dayjs from "dayjs";
import ExcelJS from "exceljs";
import { getLogoBuffer } from "../src/utils/companyLogo";

interface PeriodOption {
  id: number;
  label: string;
  raw: any;
}

const money = (v: number) =>
  `$ ${Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Light grey header, matching the other report tables.
const HEADER_BG = "#e6e6e6";
// Matches the "Monthly Profit" column's background in the Monthly Vehicle
// Financial & KPI Performance Report (VehicleFinancialReport.tsx's
// PROFIT_BG) for visual consistency across reports.
const PROFIT_BG = "#e6f4ea";
const BASIC_SALARY_BG = PROFIT_BG; // Total Basic Salary / Salary per day
const ATTENDED_BG = PROFIT_BG; // Total Attended / Total Amount
const TOTAL_DAILY_BG = PROFIT_BG; // Total Salary Daily

// Frozen columns: No / Code / Staff Name stay visible while the wide
// day-by-day table scrolls horizontally underneath them.
const NO_WIDTH = 60;
const CODE_WIDTH = 70;
const STAFF_NAME_WIDTH = 200;
const NO_LEFT = 0;
const CODE_LEFT = NO_WIDTH;
const STAFF_NAME_LEFT = NO_WIDTH + CODE_WIDTH;
const FROZEN_EDGE_SHADOW = "2px 0 4px -2px rgba(0,0,0,0.25)";

// Single-letter attendance codes shown in the Attend row: P=Present,
// A=Absent, L=Leave, H=Holiday (matches AttendanceManagement.tsx's entry
// grid and the Attendance Report's calendar view).
const ATTEND_CODE: Record<string, string> = { "1": "P", "0": "A", L: "L", H: "H" };

// "Ms. Chem Pisey" -- salutation (gender) first, with a trailing period,
// followed by the employee's name.
const staffName = (gender: string | null | undefined, name: string | null | undefined) => {
  const fullName = name ?? "";
  if (!gender) return fullName || "-";
  const salutation = gender.endsWith(".") ? gender : `${gender}.`;
  return `${salutation} ${fullName}`.trim() || "-";
};

type SortKey =
  | "employee_code"
  | "gender"
  | "full_name"
  | "total_basic_salary"
  | "salary_per_day"
  | "total_attended"
  | "total_amount"
  | "ot_hours"
  | "ot_amount"
  | "basic_of_food"
  | "food_daily"
  | "other_allowance"
  | "total_salary_daily";

const STRING_SORT_KEYS = new Set<SortKey>(["employee_code", "gender", "full_name"]);

export default function PayrollWorksheet() {
  const { can } = useAuth();
  const canExport = can("payroll-worksheet", "export");
  const [periods, setPeriods] = useState<PeriodOption[]>([]);
  const [periodId, setPeriodId] = useState<number | undefined>(undefined);
  const [period, setPeriod] = useState<any>(null);
  const [employees, setEmployees] = useState<any[]>([]);
  const [attendance, setAttendance] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  useEffect(() => {
    loadPeriods();
  }, []);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sortableTh = (
    key: SortKey,
    label: string,
    width: number,
    opts: { rowSpan?: number; background?: string; sticky?: { left: number; lastFrozen?: boolean } } = {}
  ) => (
    <th
      rowSpan={opts.rowSpan}
      style={{
        ...thStyle(width),
        ...(opts.background ? { background: opts.background } : {}),
        cursor: "pointer",
        userSelect: "none",
        ...(opts.sticky
          ? {
              position: "sticky" as const,
              left: opts.sticky.left,
              zIndex: 3,
              background: opts.background ?? HEADER_BG,
              boxShadow: opts.sticky.lastFrozen ? FROZEN_EDGE_SHADOW : undefined,
            }
          : {}),
      }}
      onClick={() => handleSort(key)}
    >
      {label}
      <span style={{ display: "inline-flex", flexDirection: "column", verticalAlign: "middle", marginLeft: 4 }}>
        <CaretUpOutlined style={{ fontSize: 8, color: sortKey === key && sortDir === "asc" ? "#1677ff" : "#bfbfbf" }} />
        <CaretDownOutlined
          style={{ fontSize: 8, marginTop: -3, color: sortKey === key && sortDir === "desc" ? "#1677ff" : "#bfbfbf" }}
        />
      </span>
    </th>
  );

  const loadPeriods = async () => {
    try {
      const response = await fetch("/api/payroll-periods");
      if (!response.ok) throw new Error(`Failed to fetch payroll periods: ${response.statusText}`);
      const result = await response.json();
      const data = Array.isArray(result.data) ? result.data : [];
      const options = data.map((p: any) => ({
        id: p.payroll_period_id,
        label: dayjs(`${p.period_year}-${String(p.period_month).padStart(2, "0")}-01`).format(
          "MMMM YYYY"
        ),
        raw: p,
      }));
      setPeriods(options);
      if (options.length > 0 && periodId == null) {
        const now = dayjs();
        const currentOption = options.find(
          (p: PeriodOption) => p.raw.period_year === now.year() && p.raw.period_month === now.month() + 1
        );
        const defaultOption = currentOption ?? options[0];
        setPeriodId(defaultOption.id);
        loadWorksheet(defaultOption.id);
      }
    } catch (error: any) {
      console.error("Error loading payroll periods:", error);
      message.error("Could not load payroll periods.");
    }
  };

  const loadWorksheet = async (id: number | undefined = periodId) => {
    if (id == null) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/payroll-report/worksheet?payroll_period_id=${id}`);
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      const result = await response.json();
      setPeriod(result.period ?? null);
      setEmployees(Array.isArray(result.employees) ? result.employees : []);
      setAttendance(Array.isArray(result.attendance) ? result.attendance : []);
    } catch (error: any) {
      console.error("Error loading payroll worksheet:", error);
      message.error(error.message || "Could not load the payroll worksheet.");
      setPeriod(null);
      setEmployees([]);
      setAttendance([]);
    } finally {
      setLoading(false);
    }
  };

  const dayCount = period?.total_working_days ?? 0;
  const days = useMemo(() => Array.from({ length: dayCount }, (_, i) => i + 1), [dayCount]);

  // employee_id -> { dayOfMonth -> status }
  const attendanceByEmployee = useMemo(() => {
    const map = new Map<number, Map<number, string>>();
    for (const a of attendance) {
      const dayOfMonth = dayjs(a.work_date).date();
      if (!map.has(a.employee_id)) map.set(a.employee_id, new Map());
      map.get(a.employee_id)!.set(dayOfMonth, a.status);
    }
    return map;
  }, [attendance]);

  const sortedEmployees = useMemo(() => {
    if (!sortKey) return employees;
    const list = [...employees];
    list.sort((a, b) => {
      const cmp = STRING_SORT_KEYS.has(sortKey)
        ? String(a[sortKey] ?? "").localeCompare(String(b[sortKey] ?? ""))
        : Number(a[sortKey] ?? 0) - Number(b[sortKey] ?? 0);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [employees, sortKey, sortDir]);

  const totals = useMemo(() => {
    return employees.reduce(
      (acc, e) => ({
        total_basic_salary: acc.total_basic_salary + Number(e.total_basic_salary ?? 0),
        salary_per_day: acc.salary_per_day + Number(e.salary_per_day ?? 0),
        total_amount: acc.total_amount + Number(e.total_amount ?? 0),
        ot_amount: acc.ot_amount + Number(e.ot_amount ?? 0),
        basic_of_food: acc.basic_of_food + Number(e.basic_of_food ?? 0),
        food_daily: acc.food_daily + Number(e.food_daily ?? 0),
        other_allowance: acc.other_allowance + Number(e.other_allowance ?? 0),
        total_salary_daily: acc.total_salary_daily + Number(e.total_salary_daily ?? 0),
      }),
      {
        total_basic_salary: 0,
        salary_per_day: 0,
        total_amount: 0,
        ot_amount: 0,
        basic_of_food: 0,
        food_daily: 0,
        other_allowance: 0,
        total_salary_daily: 0,
      }
    );
  }, [employees]);

  const handleExportExcel = async () => {
    if (employees.length === 0) {
      message.warning("There is no data to export.");
      return;
    }
    setExportLoading(true);
    try {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Payroll Worker");

      const thin = { style: "thin" as const };
      const thinBorder = { top: thin, left: thin, bottom: thin, right: thin };
      const headerFill = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFE6E6E6" } };
      // Matches the "Monthly Profit" column's fill in the Vehicle Financial
      // & KPI Performance Report's Excel export for visual consistency.
      const profitFill = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFE6F4EA" } };
      const orangeFill = profitFill;
      const greenFill = profitFill;

      // Fixed columns: No, Code, Staff Name, Total Basic Salary, Salary/day
      // then `dayCount` day columns, then the 9 summary columns.
      const fixedCols = 5;
      const summaryCols = 9;
      const totalColumns = fixedCols + dayCount + summaryCols;

      // --- Title row ---------------------------------------------------
      const logoBuffer = await getLogoBuffer();
      const logoImageId = workbook.addImage({ buffer: logoBuffer as any, extension: "png" });
      sheet.addImage(logoImageId, { tl: { col: 0, row: 0 }, ext: { width: 90, height: 55 } });
      sheet.getRow(1).height = 30;
      sheet.mergeCells(1, 2, 1, totalColumns);
      const titleCell = sheet.getCell(1, 2);
      titleCell.value = `Payroll Worker  by Month ( ${
        period ? dayjs(`${period.period_year}-${String(period.period_month).padStart(2, "0")}-01`).format("MMMM YYYY") : ""
      } )`;
      titleCell.font = { size: 14, bold: true };
      titleCell.alignment = { horizontal: "center", vertical: "middle" };

      // --- Date-range row ------------------------------------------------
      const rangeRow = 2;
      sheet.getCell(rangeRow, fixedCols + 1).value = period?.start_date ?? "";
      sheet.getCell(rangeRow, fixedCols + 1).font = { bold: true };
      sheet.getCell(rangeRow, fixedCols + dayCount).value = period?.end_date ?? "";
      sheet.getCell(rangeRow, fixedCols + dayCount).font = { bold: true };

      // --- Group header row (row 3): day numbers + group titles --------
      const groupRow = 3;
      sheet.mergeCells(groupRow, 1, groupRow + 1, 1);
      sheet.getCell(groupRow, 1).value = "No.";
      sheet.mergeCells(groupRow, 2, groupRow + 1, 2);
      sheet.getCell(groupRow, 2).value = "Code";
      sheet.mergeCells(groupRow, 3, groupRow + 1, 3);
      sheet.getCell(groupRow, 3).value = "Staff Name";
      sheet.mergeCells(groupRow, 4, groupRow + 1, 4);
      sheet.getCell(groupRow, 4).value = "Total Basic Salary";
      sheet.mergeCells(groupRow, 5, groupRow + 1, 5);
      sheet.getCell(groupRow, 5).value = "Salary of per day";

      for (let d = 1; d <= dayCount; d++) {
        sheet.getCell(groupRow, fixedCols + d).value = d;
        sheet.getCell(groupRow + 1, fixedCols + d).value = "Attend";
      }

      let col = fixedCols + dayCount + 1;
      sheet.mergeCells(groupRow, col, groupRow, col + 1);
      sheet.getCell(groupRow, col).value = "Total Salary of working day";
      sheet.getCell(groupRow + 1, col).value = "Total Attended";
      sheet.getCell(groupRow + 1, col + 1).value = "Total Amount";
      col += 2;
      sheet.mergeCells(groupRow, col, groupRow, col + 1);
      sheet.getCell(groupRow, col).value = "Total Amount OT";
      sheet.getCell(groupRow + 1, col).value = "Number of Hours";
      sheet.getCell(groupRow + 1, col + 1).value = "Amount of OT";
      col += 2;
      sheet.mergeCells(groupRow, col, groupRow, col + 1);
      sheet.getCell(groupRow, col).value = "Food Allowance";
      sheet.getCell(groupRow + 1, col).value = "Basic of Food";
      sheet.getCell(groupRow + 1, col + 1).value = "Food Daily";
      col += 2;
      sheet.mergeCells(groupRow, col, groupRow + 1, col);
      sheet.getCell(groupRow, col).value = "Other Allowance";
      col += 1;
      sheet.mergeCells(groupRow, col, groupRow + 1, col);
      sheet.getCell(groupRow, col).value = "Total Salary Daily";

      for (let r = groupRow; r <= groupRow + 1; r++) {
        for (let c = 1; c <= totalColumns; c++) {
          const cell = sheet.getCell(r, c);
          cell.font = { bold: true, size: 10 };
          cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
          cell.fill = headerFill;
          cell.border = thinBorder;
        }
      }

      // --- Data rows -----------------------------------------------------
      let rowNum = groupRow + 2;
      sortedEmployees.forEach((emp, index) => {
        const row = sheet.getRow(rowNum);
        const dayMap = attendanceByEmployee.get(emp.employee_id) ?? new Map();

        row.getCell(1).value = index + 1;
        row.getCell(2).value = emp.employee_code ?? "";
        row.getCell(3).value = staffName(emp.gender, emp.full_name);
        row.getCell(4).value = Number(emp.total_basic_salary);
        row.getCell(4).fill = orangeFill;
        row.getCell(5).value = Number(emp.salary_per_day);
        row.getCell(5).fill = orangeFill;

        for (let d = 1; d <= dayCount; d++) {
          const status = dayMap.get(d);
          row.getCell(fixedCols + d).value = status ? ATTEND_CODE[status] ?? status : "";
          row.getCell(fixedCols + d).alignment = { horizontal: "center" };
        }

        let c = fixedCols + dayCount + 1;
        row.getCell(c).value = emp.total_attended;
        row.getCell(c).fill = greenFill;
        row.getCell(c + 1).value = Number(emp.total_amount);
        row.getCell(c + 1).fill = greenFill;
        c += 2;
        row.getCell(c).value = Number(emp.ot_hours ?? 0);
        row.getCell(c + 1).value = Number(emp.ot_amount) || "";
        c += 2;
        row.getCell(c).value = Number(emp.basic_of_food);
        row.getCell(c + 1).value = Number(emp.food_daily);
        c += 2;
        row.getCell(c).value = Number(emp.other_allowance);
        c += 1;
        row.getCell(c).value = Number(emp.total_salary_daily);
        row.getCell(c).fill = orangeFill;
        row.getCell(c).font = { bold: true };

        for (let cc = 1; cc <= totalColumns; cc++) {
          row.getCell(cc).border = thinBorder;
        }
        rowNum += 1;
      });

      // --- Total row -------------------------------------------------
      // Sums every currency-related column, mirroring the on-screen Total
      // row -- Total Attended (a day count) and Number of Hours are left
      // blank since they aren't currency.
      const lightGreyFill = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFF5F5F5" } };
      const totalRow = sheet.getRow(rowNum);
      const profitCols = new Set<number>();

      totalRow.getCell(3).value = "TOTAL";
      totalRow.getCell(4).value = totals.total_basic_salary;
      profitCols.add(4);
      totalRow.getCell(5).value = totals.salary_per_day;
      profitCols.add(5);

      let tCol = fixedCols + dayCount + 1;
      totalRow.getCell(tCol + 1).value = totals.total_amount;
      profitCols.add(tCol + 1);
      tCol += 2;
      totalRow.getCell(tCol + 1).value = totals.ot_amount;
      tCol += 2;
      totalRow.getCell(tCol).value = totals.basic_of_food;
      totalRow.getCell(tCol + 1).value = totals.food_daily;
      tCol += 2;
      totalRow.getCell(tCol).value = totals.other_allowance;
      tCol += 1;
      totalRow.getCell(tCol).value = totals.total_salary_daily;
      profitCols.add(tCol);

      for (let cc = 1; cc <= totalColumns; cc++) {
        const cell = totalRow.getCell(cc);
        cell.font = { bold: true };
        cell.border = thinBorder;
        cell.fill = profitCols.has(cc) ? profitFill : lightGreyFill;
        cell.alignment = { vertical: "middle", horizontal: cc === 3 ? "left" : "center" };
      }
      rowNum += 1;

      // Column widths
      sheet.getColumn(1).width = 5;
      sheet.getColumn(2).width = 8;
      sheet.getColumn(3).width = 22;
      sheet.getColumn(4).width = 14;
      sheet.getColumn(5).width = 12;
      for (let d = 1; d <= dayCount; d++) sheet.getColumn(fixedCols + d).width = 5;
      for (let i = 0; i < summaryCols; i++) sheet.getColumn(fixedCols + dayCount + 1 + i).width = 14;

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Payroll_Worker_${period?.period_year ?? ""}_${period?.period_month ?? ""}.xlsx`;
      link.click();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Error exporting to Excel:", error);
      message.error("Failed to export Excel file.");
    } finally {
      setExportLoading(false);
    }
  };

  return (
    <Card>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 16,
          marginBottom: 16,
          padding: "12px 16px",
          background: "#fafafa",
          border: "1px solid #f0f0f0",
          borderRadius: 8,
        }}
      >
        <span style={{ fontSize: 16, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
          <TableOutlined style={{ marginRight: 8 }} />
          Payroll Worker by Month
        </span>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 10,
            marginLeft: "auto",
          }}
        >
        <Select
          showSearch
          placeholder="Select month..."
          optionFilterProp="label"
          value={periodId}
          onChange={(value) => {
            setPeriodId(value);
            loadWorksheet(value);
          }}
          style={{ width: 220, flexShrink: 0 }}
          options={periods.map((p) => ({ label: p.label, value: p.id }))}
        />
        <Tooltip title="Refresh">
          <Button
            aria-label="Refresh"
            icon={<ReloadOutlined />}
            onClick={() => loadWorksheet()}
            style={{ flexShrink: 0 }}
          />
        </Tooltip>
        {canExport && (
          <Tooltip title="Export Excel">
            <Button
              aria-label="Export Excel"
              icon={<FileExcelOutlined />}
              onClick={handleExportExcel}
              loading={exportLoading}
              disabled={employees.length === 0}
              style={{ background: "#217346", borderColor: "#217346", color: "#fff", flexShrink: 0 }}
            />
          </Tooltip>
        )}
        </div>
      </div>

      {employees.length === 0 && !loading ? (
        <Empty description="No employees to show for this period." />
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              borderCollapse: "collapse",
              fontSize: 12,
              width: "max-content",
              minWidth: "100%",
            }}
          >
            <thead>
              <tr>
                <th
                  rowSpan={2}
                  style={{
                    ...thStyle(NO_WIDTH),
                    position: "sticky",
                    left: NO_LEFT,
                    zIndex: 3,
                    background: HEADER_BG,
                  }}
                >
                  No.
                </th>
                {sortableTh("employee_code", "Code", CODE_WIDTH, { rowSpan: 2, sticky: { left: CODE_LEFT } })}
                {sortableTh("full_name", "Staff Name", STAFF_NAME_WIDTH, {
                  rowSpan: 2,
                  sticky: { left: STAFF_NAME_LEFT, lastFrozen: true },
                })}
                {sortableTh("total_basic_salary", "Total Basic Salary", 110, { rowSpan: 2, background: BASIC_SALARY_BG })}
                {sortableTh("salary_per_day", "Salary of per day", 100, { rowSpan: 2, background: BASIC_SALARY_BG })}
                {days.map((d) => (
                  <th key={d} style={thStyle(32)}>
                    {d}
                  </th>
                ))}
                <th colSpan={2} style={thStyle(160)}>
                  Total Salary of working day
                </th>
                <th colSpan={2} style={thStyle(140)}>
                  Total Amount OT
                </th>
                <th colSpan={2} style={thStyle(160)}>
                  Food Allowance
                </th>
                {sortableTh("other_allowance", "Other Allowance", 120, { rowSpan: 2 })}
                {sortableTh("total_salary_daily", "Total Salary Daily", 120, { rowSpan: 2, background: TOTAL_DAILY_BG })}
              </tr>
              <tr>
                {days.map((d) => (
                  <th key={`sub-${d}`} style={thStyle(32)}>
                    Attend
                  </th>
                ))}
                {sortableTh("total_attended", "Total Attended", 80, { background: ATTENDED_BG })}
                {sortableTh("total_amount", "Total Amount", 90, { background: ATTENDED_BG })}
                {sortableTh("ot_hours", "Number of Hours", 75)}
                {sortableTh("ot_amount", "Amount of OT", 75)}
                {sortableTh("basic_of_food", "Basic of Food", 80)}
                {sortableTh("food_daily", "Food Daily", 80)}
              </tr>
            </thead>
            <tbody>
              {sortedEmployees.map((emp, index) => {
                const dayMap = attendanceByEmployee.get(emp.employee_id) ?? new Map<number, string>();
                return (
                  <tr key={emp.employee_id}>
                    <td style={stickyTdStyle(NO_WIDTH, NO_LEFT)}>{index + 1}</td>
                    <td style={stickyTdStyle(CODE_WIDTH, CODE_LEFT)}>{emp.employee_code ?? "-"}</td>
                    <td style={{ ...stickyTdStyle(STAFF_NAME_WIDTH, STAFF_NAME_LEFT, true), textAlign: "left", paddingLeft: 6 }}>
                      <Link
                        to={`/payroll/attendance?employee_id=${emp.employee_id}${periodId != null ? `&period_id=${periodId}` : ""}`}
                        style={{ color: "#1677ff" }}
                      >
                        {staffName(emp.gender, emp.full_name)}
                      </Link>
                    </td>
                    <td style={{ ...tdStyle(), background: BASIC_SALARY_BG }}>
                      {money(emp.total_basic_salary)}
                    </td>
                    <td style={{ ...tdStyle(), background: BASIC_SALARY_BG }}>
                      {money(emp.salary_per_day)}
                    </td>
                    {days.map((d) => {
                      const status = dayMap.get(d);
                      return (
                        <td key={d} style={tdStyle()}>
                          {status ? ATTEND_CODE[status] ?? status : ""}
                        </td>
                      );
                    })}
                    <td style={{ ...tdStyle(), background: ATTENDED_BG }}>{emp.total_attended}</td>
                    <td style={{ ...tdStyle(), background: ATTENDED_BG }}>{money(emp.total_amount)}</td>
                    <td style={tdStyle()}>{Number(emp.ot_hours ?? 0)}</td>
                    <td style={tdStyle()}>{emp.ot_amount ? money(emp.ot_amount) : "$ -"}</td>
                    <td style={tdStyle()}>{money(emp.basic_of_food)}</td>
                    <td style={tdStyle()}>{money(emp.food_daily)}</td>
                    <td style={tdStyle()}>{money(emp.other_allowance)}</td>
                    <td style={{ ...tdStyle(), background: TOTAL_DAILY_BG, fontWeight: 700 }}>
                      {money(emp.total_salary_daily)}
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td style={stickyTdStyle(NO_WIDTH, NO_LEFT, false, "#fafafa")} />
                <td style={stickyTdStyle(CODE_WIDTH, CODE_LEFT, false, "#fafafa")} />
                <td
                  style={{
                    ...stickyTdStyle(STAFF_NAME_WIDTH, STAFF_NAME_LEFT, true, "#fafafa"),
                    textAlign: "left",
                    paddingLeft: 6,
                    fontWeight: 700,
                  }}
                >
                  TOTAL
                </td>
                <td style={{ ...tdStyle(), background: BASIC_SALARY_BG, fontWeight: 700 }}>
                  {money(totals.total_basic_salary)}
                </td>
                <td style={{ ...tdStyle(), background: BASIC_SALARY_BG, fontWeight: 700 }}>
                  {money(totals.salary_per_day)}
                </td>
                <td colSpan={dayCount} style={{ ...tdStyle(), background: "#fafafa" }} />
                <td style={{ ...tdStyle(), background: ATTENDED_BG }} />
                <td style={{ ...tdStyle(), background: ATTENDED_BG, fontWeight: 700 }}>
                  {money(totals.total_amount)}
                </td>
                <td style={tdStyle()} />
                <td style={{ ...tdStyle(), fontWeight: 700 }}>{money(totals.ot_amount)}</td>
                <td style={{ ...tdStyle(), fontWeight: 700 }}>{money(totals.basic_of_food)}</td>
                <td style={{ ...tdStyle(), fontWeight: 700 }}>{money(totals.food_daily)}</td>
                <td style={{ ...tdStyle(), fontWeight: 700 }}>{money(totals.other_allowance)}</td>
                <td style={{ ...tdStyle(), background: TOTAL_DAILY_BG, fontWeight: 700 }}>
                  {money(totals.total_salary_daily)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function thStyle(width: number): React.CSSProperties {
  return {
    background: HEADER_BG,
    border: "1px solid #d9d9d9",
    padding: "4px 6px",
    fontWeight: 700,
    textAlign: "center",
    width,
    whiteSpace: "nowrap",
  };
}

function tdStyle(): React.CSSProperties {
  return {
    border: "1px solid #e8e8e8",
    padding: "3px 6px",
    textAlign: "center",
    whiteSpace: "nowrap",
  };
}

function stickyTdStyle(width: number, left: number, lastFrozen?: boolean, background = "#fff"): React.CSSProperties {
  return {
    ...tdStyle(),
    width,
    position: "sticky",
    left,
    zIndex: 1,
    background,
    boxShadow: lastFrozen ? FROZEN_EDGE_SHADOW : undefined,
  };
}
