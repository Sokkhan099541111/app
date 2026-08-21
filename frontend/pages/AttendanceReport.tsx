import { useEffect, useMemo, useState } from "react";
import { Card, Table, Button, Space, Select, notification, Tooltip, message } from "antd";
import { CloseCircleFilled, FileTextOutlined, FileExcelOutlined } from "@ant-design/icons";
import { useAuth } from "../src/context/AuthContext";
import dayjs from "dayjs";
import ExcelJS from "exceljs";
import { useSearchParams } from "react-router-dom";
import { getLogoBuffer } from "../src/utils/companyLogo";

const notifyError = (title: string, description?: string) =>
  notification.error({
    message: title,
    description,
    icon: <CloseCircleFilled style={{ color: "#ff4d4f" }} />,
    placement: "topRight",
    duration: 4.5,
    style: { borderRadius: 10 },
  });

const STATUS_LABEL: Record<string, string> = { "1": "Present", "0": "Absent", L: "Leave", H: "Holiday" };
const STATUS_COLOR: Record<string, string> = { "1": "#22c55e", "0": "#ff4d4f", L: "#f59e0b", H: "#3b82f6" };
// Single-letter codes shown in the calendar grid: P=Present, A=Absent,
// L=Leave, H=Holiday (matches AttendanceManagement.tsx's entry grid).
const CALENDAR_STATUS_CODE: Record<string, string> = { "1": "P", "0": "A", L: "L", H: "H" };

// "Ms. Chem Pisey" -- salutation (gender) first, with a trailing period,
// followed by the employee's name.
const staffName = (gender: string | null | undefined, name: string | null | undefined) => {
  const fullName = name ?? "";
  if (!gender) return fullName || "-";
  const salutation = gender.endsWith(".") ? gender : `${gender}.`;
  return `${salutation} ${fullName}`.trim() || "-";
};

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const periodLabel = (period: { period_year: number; period_month: number }) =>
  `${MONTH_NAMES[period.period_month - 1] ?? period.period_month} ${period.period_year}`;

type ViewMode = "summary" | "calendar" | "list";

export default function AttendanceReport() {
  const { can } = useAuth();
  const canExport = can("payroll-attendance-report", "export");
  const [searchParams] = useSearchParams();
  const [employees, setEmployees] = useState<any[]>([]);
  const [periods, setPeriods] = useState<any[]>([]);
  const [attendanceRows, setAttendanceRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const [filterEmployee, setFilterEmployee] = useState<number | "all">("all");
  const [filterPeriod, setFilterPeriod] = useState<number | "all">("all");
  const [view, setView] = useState<ViewMode>("summary");
  const [exportLoading, setExportLoading] = useState(false);

  useEffect(() => {
    loadEmployees();
    loadPeriods();
  }, []);

  useEffect(() => {
    loadAttendance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterEmployee, filterPeriod]);

  const loadEmployees = async () => {
    try {
      const response = await fetch("/api/employees?status=All");
      if (!response.ok) throw new Error(`Failed to fetch employees: ${response.statusText}`);
      const result = await response.json();
      setEmployees(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading employees:", error);
      notifyError("Couldn't load employees", error.message);
    }
  };

  const loadPeriods = async () => {
    try {
      const response = await fetch("/api/payroll-periods");
      if (!response.ok) throw new Error(`Failed to fetch periods: ${response.statusText}`);
      const result = await response.json();
      const loadedPeriods = Array.isArray(result.data) ? result.data : [];
      setPeriods(loadedPeriods);

      // Default to the current month's period, unless a specific
      // year/month was requested via URL (dashboard drill-down).
      const yearParam = searchParams.get("year");
      const monthParam = searchParams.get("month");
      const targetYear = yearParam ? Number(yearParam) : dayjs().year();
      const targetMonth = monthParam ? Number(monthParam) : dayjs().month() + 1;
      const currentPeriod = loadedPeriods.find(
        (p: any) => p.period_year === targetYear && p.period_month === targetMonth
      );
      if (currentPeriod) {
        setFilterPeriod(currentPeriod.payroll_period_id);
      }
    } catch (error: any) {
      console.error("Error loading payroll periods:", error);
      notifyError("Couldn't load payroll periods", error.message);
    }
  };

  const loadAttendance = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterEmployee !== "all") params.append("employee_id", String(filterEmployee));
      if (filterPeriod !== "all") params.append("payroll_period_id", String(filterPeriod));
      const response = await fetch(`/api/attendance?${params}`);
      if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
      const result = await response.json();
      setAttendanceRows(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading attendance:", error);
      notifyError("Couldn't load attendance", error.message);
    } finally {
      setLoading(false);
    }
  };

  const filteredEmployees = useMemo(
    () => (filterEmployee === "all" ? employees : employees.filter((e) => e.employee_id === filterEmployee)),
    [employees, filterEmployee]
  );
  const filteredPeriods = useMemo(
    () => (filterPeriod === "all" ? periods : periods.filter((p) => p.payroll_period_id === filterPeriod)),
    [periods, filterPeriod]
  );

  const attendanceByKey = useMemo(() => {
    const map = new Map<string, any>();
    for (const r of attendanceRows) {
      map.set(`${r.employee_id}-${dayjs(r.work_date).format("YYYY-MM-DD")}`, r);
    }
    return map;
  }, [attendanceRows]);

  const periodDays = (period: any): string[] => {
    const start = dayjs(period.start_date);
    const end = dayjs(period.end_date);
    const list: string[] = [];
    let cur = start;
    while (cur.isBefore(end) || cur.isSame(end, "day")) {
      list.push(cur.format("YYYY-MM-DD"));
      cur = cur.add(1, "day");
    }
    return list;
  };

  // --- Summary rows: one per employee x period combo -----------------
  const summaryRows = useMemo(() => {
    const out: any[] = [];
    filteredEmployees.forEach((emp) => {
      filteredPeriods.forEach((period) => {
        const days = periodDays(period);
        let present = 0, absent = 0, leave = 0, holiday = 0, unmarked = 0;
        days.forEach((d) => {
          const row = attendanceByKey.get(`${emp.employee_id}-${d}`);
          if (!row) unmarked++;
          else if (row.status === "1") present++;
          else if (row.status === "0") absent++;
          else if (row.status === "L") leave++;
          else if (row.status === "H") holiday++;
        });
        out.push({
          key: `${emp.employee_id}-${period.payroll_period_id}`,
          employee_id: emp.employee_id,
          employee_code: emp.employee_code,
          gender: emp.gender,
          employee_name: emp.full_name,
          period_id: period.payroll_period_id,
          period_label: periodLabel(period),
          working_days: days.length,
          present,
          absent,
          leave,
          holiday,
          unmarked,
          total_attended: present + holiday,
        });
      });
    });
    return out;
  }, [filteredEmployees, filteredPeriods, attendanceByKey]);

  // --- List rows: one per employee x period x day that has a record --
  const listRows = useMemo(() => {
    const out: any[] = [];
    filteredEmployees.forEach((emp) => {
      filteredPeriods.forEach((period) => {
        periodDays(period).forEach((d) => {
          const row = attendanceByKey.get(`${emp.employee_id}-${d}`);
          out.push({
            key: `${emp.employee_id}-${period.payroll_period_id}-${d}`,
            employee_code: emp.employee_code,
            gender: emp.gender,
            employee_name: emp.full_name,
            period_label: periodLabel(period),
            work_date: d,
            status: row ? row.status : null,
          });
        });
      });
    });
    return out;
  }, [filteredEmployees, filteredPeriods, attendanceByKey]);

  const maxDays = Math.max(1, ...filteredPeriods.map((p) => periodDays(p).length));

  const summaryColumns = [
    {
      title: "No",
      key: "no",
      width: 60,
      render: (_: any, __: any, index: number) => index + 1,
    },
    {
      title: "Code",
      dataIndex: "employee_code",
      key: "employee_code",
      sorter: (a: any, b: any) => String(a.employee_code ?? "").localeCompare(String(b.employee_code ?? "")),
    },
    {
      title: "Staff Name",
      key: "staff_name",
      render: (_: any, record: any) => staffName(record.gender, record.employee_name),
      sorter: (a: any, b: any) => String(a.employee_name ?? "").localeCompare(String(b.employee_name ?? "")),
    },
    {
      title: "Period",
      dataIndex: "period_label",
      key: "period_label",
      sorter: (a: any, b: any) => String(a.period_label ?? "").localeCompare(String(b.period_label ?? "")),
    },
    {
      title: "Working Days",
      dataIndex: "working_days",
      key: "working_days",
      sorter: (a: any, b: any) => Number(a.working_days ?? 0) - Number(b.working_days ?? 0),
    },
    {
      title: "Present",
      dataIndex: "present",
      key: "present",
      sorter: (a: any, b: any) => Number(a.present ?? 0) - Number(b.present ?? 0),
    },
    {
      title: "Absent",
      dataIndex: "absent",
      key: "absent",
      sorter: (a: any, b: any) => Number(a.absent ?? 0) - Number(b.absent ?? 0),
    },
    {
      title: "Leave",
      dataIndex: "leave",
      key: "leave",
      sorter: (a: any, b: any) => Number(a.leave ?? 0) - Number(b.leave ?? 0),
    },
    {
      title: "Holiday",
      dataIndex: "holiday",
      key: "holiday",
      sorter: (a: any, b: any) => Number(a.holiday ?? 0) - Number(b.holiday ?? 0),
    },
    {
      title: "Unmarked",
      dataIndex: "unmarked",
      key: "unmarked",
      sorter: (a: any, b: any) => Number(a.unmarked ?? 0) - Number(b.unmarked ?? 0),
    },
    {
      title: "Total Attended",
      dataIndex: "total_attended",
      key: "total_attended",
      sorter: (a: any, b: any) => Number(a.total_attended ?? 0) - Number(b.total_attended ?? 0),
      render: (v: number) => <strong>{v}</strong>,
    },
  ];

  const calendarColumns = [
    {
      title: "No",
      key: "no",
      width: 60,
      fixed: "left" as const,
      render: (_: any, __: any, index: number) => index + 1,
    },
    {
      title: "Code",
      dataIndex: "employee_code",
      key: "employee_code",
      fixed: "left" as const,
      sorter: (a: any, b: any) => String(a.employee_code ?? "").localeCompare(String(b.employee_code ?? "")),
    },
    {
      title: "Staff Name",
      key: "staff_name",
      fixed: "left" as const,
      render: (_: any, record: any) => staffName(record.gender, record.employee_name),
      sorter: (a: any, b: any) => String(a.employee_name ?? "").localeCompare(String(b.employee_name ?? "")),
    },
    {
      title: "Period",
      dataIndex: "period_label",
      key: "period_label",
      fixed: "left" as const,
      sorter: (a: any, b: any) => String(a.period_label ?? "").localeCompare(String(b.period_label ?? "")),
    },
    ...Array.from({ length: maxDays }, (_, i) => ({
      title: String(i + 1),
      key: `d${i + 1}`,
      width: 40,
      render: (_: any, record: any) => {
        const status = record.days[i];
        if (status === undefined) return "-";
        if (status === null) return <span style={{ color: "#ccc", fontWeight: 700 }}>-</span>;
        return (
          <span style={{ color: STATUS_COLOR[status], fontWeight: 700 }}>
            {CALENDAR_STATUS_CODE[status] ?? status}
          </span>
        );
      },
    })),
  ];

  const calendarRows = useMemo(() => {
    const out: any[] = [];
    filteredEmployees.forEach((emp) => {
      filteredPeriods.forEach((period) => {
        const days = periodDays(period).map((d) => {
          const row = attendanceByKey.get(`${emp.employee_id}-${d}`);
          return row ? row.status : null;
        });
        out.push({
          key: `${emp.employee_id}-${period.payroll_period_id}`,
          employee_code: emp.employee_code,
          gender: emp.gender,
          employee_name: emp.full_name,
          period_label: periodLabel(period),
          days,
        });
      });
    });
    return out;
  }, [filteredEmployees, filteredPeriods, attendanceByKey]);

  const listColumns = [
    {
      title: "No",
      key: "no",
      width: 60,
      render: (_: any, __: any, index: number) => index + 1,
    },
    {
      title: "Code",
      dataIndex: "employee_code",
      key: "employee_code",
      sorter: (a: any, b: any) => String(a.employee_code ?? "").localeCompare(String(b.employee_code ?? "")),
    },
    {
      title: "Staff Name",
      key: "staff_name",
      render: (_: any, record: any) => staffName(record.gender, record.employee_name),
      sorter: (a: any, b: any) => String(a.employee_name ?? "").localeCompare(String(b.employee_name ?? "")),
    },
    {
      title: "Period",
      dataIndex: "period_label",
      key: "period_label",
      sorter: (a: any, b: any) => String(a.period_label ?? "").localeCompare(String(b.period_label ?? "")),
    },
    {
      title: "Date",
      dataIndex: "work_date",
      key: "work_date",
      sorter: (a: any, b: any) => String(a.work_date ?? "").localeCompare(String(b.work_date ?? "")),
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      sorter: (a: any, b: any) => String(a.status ?? "").localeCompare(String(b.status ?? "")),
      render: (v: string | null) =>
        v ? <span style={{ color: STATUS_COLOR[v], fontWeight: 600 }}>{STATUS_LABEL[v]}</span> : <span style={{ color: "#999" }}>Unmarked</span>,
    },
  ];

  const handleExportExcel = async () => {
    let header: string[] = [];
    let rows: (string | number)[][] = [];
    let title = "Attendance Report";

    if (view === "summary") {
      title = "Attendance Report - Summary";
      header = ["Code", "Staff Name", "Period", "Working Days", "Present", "Absent", "Leave", "Holiday", "Unmarked", "Total Attended"];
      rows = summaryRows.map((r) => [
        r.employee_code, staffName(r.gender, r.employee_name), r.period_label, r.working_days, r.present, r.absent, r.leave, r.holiday, r.unmarked, r.total_attended,
      ]);
    } else if (view === "calendar") {
      title = "Attendance Report - Calendar Grid";
      header = ["Code", "Staff Name", "Period", ...Array.from({ length: maxDays }, (_, i) => String(i + 1))];
      rows = calendarRows.map((r) => [
        r.employee_code,
        staffName(r.gender, r.employee_name),
        r.period_label,
        ...r.days.map((d: string | null) => (d ? CALENDAR_STATUS_CODE[d] ?? d : "")),
      ]);
    } else {
      title = "Attendance Report - Daily List";
      header = ["Code", "Staff Name", "Period", "Date", "Status"];
      rows = listRows.map((r) => [r.employee_code, staffName(r.gender, r.employee_name), r.period_label, r.work_date, r.status ? STATUS_LABEL[r.status] : "Unmarked"]);
    }

    if (rows.length === 0) {
      message.warning("There is no data to export.");
      return;
    }

    setExportLoading(true);
    try {
      const totalColumns = Math.max(header.length, 4);

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Attendance");

      const thinBorder = {
        top: { style: "thin" as const },
        left: { style: "thin" as const },
        bottom: { style: "thin" as const },
        right: { style: "thin" as const },
      };
      const headerFill = {
        type: "pattern" as const,
        pattern: "solid" as const,
        fgColor: { argb: "FFE6E6E6" },
      };

      const logoBuffer = await getLogoBuffer();
      const logoImageId = workbook.addImage({
        buffer: logoBuffer as any,
        extension: "png",
      });
      sheet.addImage(logoImageId, {
        tl: { col: 0, row: 0 },
        ext: { width: 90, height: 55 },
      });
      sheet.getRow(1).height = 42;

      sheet.mergeCells(1, 2, 1, totalColumns);
      const titleCell = sheet.getCell(1, 2);
      titleCell.value = title;
      titleCell.font = { size: 16, bold: true };
      titleCell.alignment = { vertical: "middle", horizontal: "center" };

      sheet.getRow(2).height = 8;

      let currentRow = 3;
      const headerRow = sheet.getRow(currentRow);
      header.forEach((label, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = label;
        cell.font = { bold: true };
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.fill = headerFill;
        cell.border = thinBorder;
      });
      currentRow += 1;

      rows.forEach((line) => {
        const row = sheet.getRow(currentRow);
        line.forEach((value, colIdx) => {
          const cell = row.getCell(colIdx + 1);
          cell.value = value;
          cell.alignment = { vertical: "middle" };
          cell.border = thinBorder;
        });
        currentRow += 1;
      });

      header.forEach((label, i) => {
        sheet.getColumn(i + 1).width = Math.max(String(label).length + 4, 12);
      });

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `attendance-report-${view}-${dayjs().format("YYYY-MM-DD")}.xlsx`;
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
    <Card
      title={
        <span>
          <FileTextOutlined style={{ marginRight: 8 }} />
          Attendance Report
        </span>
      }
      extra={
        <Space>
          <Select
            value={filterEmployee}
            onChange={setFilterEmployee}
            style={{ width: 200 }}
            showSearch
            optionFilterProp="label"
            options={[
              { label: "All employees", value: "all" },
              ...employees.map((e) => ({ label: e.full_name, value: e.employee_id })),
            ]}
          />
          <Select
            value={filterPeriod}
            onChange={setFilterPeriod}
            showSearch
            optionFilterProp="label"
            style={{ width: 180 }}
            options={[
              { label: "All periods", value: "all" },
              ...periods.map((p) => ({
                label: periodLabel(p),
                value: p.payroll_period_id,
              })),
            ]}
          />
          <Select
            value={view}
            onChange={setView}
            style={{ width: 160 }}
            options={[
              { label: "Summary view", value: "summary" },
              { label: "Calendar grid", value: "calendar" },
              { label: "Daily list", value: "list" },
            ]}
          />
          {canExport && (
            <Tooltip title="Export Excel">
              <Button
                aria-label="Export Excel"
                icon={<FileExcelOutlined />}
                onClick={handleExportExcel}
                loading={exportLoading}
                style={{ background: "#217346", borderColor: "#217346", color: "#fff" }}
              />
            </Tooltip>
          )}
        </Space>
      }
    >
      <p style={{ color: "#666", marginTop: -8 }}>
        Read-only reporting view -- filter by employee and period, switch between summary, calendar, and daily-list layouts.
      </p>
      <style>{`
        .compact-vehicle-table .ant-table {
          font-size: 12px;
        }
        .compact-vehicle-table .ant-table-thead > tr > th {
          font-size: 12px;
          padding: 6px 8px;
        }
        .compact-vehicle-table .ant-table-tbody > tr > td {
          font-size: 12px;
          padding: 6px 8px;
        }
      `}</style>
      {view === "summary" && (
        <Table
          className="compact-vehicle-table"
          size="small"
          loading={loading}
          columns={summaryColumns}
          dataSource={summaryRows}
          rowKey="key"
          bordered
          pagination={{ pageSize: 20, showSizeChanger: true }}
        />
      )}
      {view === "calendar" && (
        <Table
          className="compact-vehicle-table"
          size="small"
          loading={loading}
          columns={calendarColumns}
          dataSource={calendarRows}
          rowKey="key"
          bordered
          scroll={{ x: "max-content" }}
          pagination={{ pageSize: 20, showSizeChanger: true }}
        />
      )}
      {view === "list" && (
        <Table
          className="compact-vehicle-table"
          size="small"
          loading={loading}
          columns={listColumns}
          dataSource={listRows}
          rowKey="key"
          bordered
          pagination={{ pageSize: 31, showSizeChanger: true }}
        />
      )}
    </Card>
  );
}
