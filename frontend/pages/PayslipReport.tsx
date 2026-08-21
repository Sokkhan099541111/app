import { useEffect, useState } from "react";
import { Card, Table, Button, Space, Select, DatePicker, Tooltip, notification, message } from "antd";
import {
  ReloadOutlined,
  FileExcelOutlined,
  FilePdfOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  DollarCircleOutlined,
} from "@ant-design/icons";
import { useAuth } from "../src/context/AuthContext";
import dayjs from "dayjs";
import ExcelJS from "exceljs";
import { useSearchParams } from "react-router-dom";
import { getLogoBuffer } from "../src/utils/companyLogo";

const DATE_FORMAT = "YYYY-MM-DD";
const { RangePicker } = DatePicker;

const notifyError = (title: string, description?: string) =>
  notification.error({
    message: title,
    description,
    icon: <CloseCircleFilled style={{ color: "#ff4d4f" }} />,
    placement: "topRight",
    duration: 4.5,
    style: { borderRadius: 10 },
  });

const notifySuccess = (title: string, description?: string) =>
  notification.success({
    message: title,
    description,
    icon: <CheckCircleFilled style={{ color: "#22c55e" }} />,
    placement: "topRight",
    duration: 3,
    style: { borderRadius: 10 },
  });

const money = (v: number) => `$${Number(v ?? 0).toFixed(2)}`;

// "Ms. Chem Pisey" -- salutation (gender) first, with a trailing period,
// followed by the employee's name.
const staffName = (gender: string | null | undefined, name: string | null | undefined) => {
  const fullName = name ?? "";
  if (!gender) return fullName || "-";
  const salutation = gender.endsWith(".") ? gender : `${gender}.`;
  return `${salutation} ${fullName}`.trim() || "-";
};

// Currency-related columns summed in the Total row (on-screen + export).
const CURRENCY_KEYS = [
  "total_basic_salary",
  "salary_per_day",
  "total_amount",
  "ot_amount",
  "basic_of_food",
  "food_daily",
  "other_allowance",
  "total_salary_daily",
] as const;

const COLUMNS = [
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
    render: (_: any, record: any) => staffName(record.gender, record.full_name),
    sorter: (a: any, b: any) => String(a.full_name ?? "").localeCompare(String(b.full_name ?? "")),
  },
  {
    title: "Period",
    key: "period",
    render: (_: any, r: any) => `${r.period_year}-${String(r.period_month).padStart(2, "0")}`,
    sorter: (a: any, b: any) =>
      Number(a.period_year) * 100 + Number(a.period_month) - (Number(b.period_year) * 100 + Number(b.period_month)),
  },
  {
    title: "Working Days",
    dataIndex: "total_working_days",
    key: "total_working_days",
    sorter: (a: any, b: any) => Number(a.total_working_days ?? 0) - Number(b.total_working_days ?? 0),
  },
  {
    title: "Basic Salary",
    dataIndex: "total_basic_salary",
    key: "total_basic_salary",
    render: money,
    sorter: (a: any, b: any) => Number(a.total_basic_salary ?? 0) - Number(b.total_basic_salary ?? 0),
  },
  {
    title: "Salary / Day",
    dataIndex: "salary_per_day",
    key: "salary_per_day",
    render: money,
    sorter: (a: any, b: any) => Number(a.salary_per_day ?? 0) - Number(b.salary_per_day ?? 0),
  },
  {
    title: "Attended",
    dataIndex: "total_attended",
    key: "total_attended",
    sorter: (a: any, b: any) => Number(a.total_attended ?? 0) - Number(b.total_attended ?? 0),
  },
  {
    title: "Total Amount",
    dataIndex: "total_amount",
    key: "total_amount",
    render: money,
    sorter: (a: any, b: any) => Number(a.total_amount ?? 0) - Number(b.total_amount ?? 0),
  },
  {
    title: "OT Hours",
    dataIndex: "ot_hours",
    key: "ot_hours",
    sorter: (a: any, b: any) => Number(a.ot_hours ?? 0) - Number(b.ot_hours ?? 0),
  },
  {
    title: "OT Amount",
    dataIndex: "ot_amount",
    key: "ot_amount",
    render: money,
    sorter: (a: any, b: any) => Number(a.ot_amount ?? 0) - Number(b.ot_amount ?? 0),
  },
  {
    title: "Basic of Food",
    dataIndex: "basic_of_food",
    key: "basic_of_food",
    render: money,
    sorter: (a: any, b: any) => Number(a.basic_of_food ?? 0) - Number(b.basic_of_food ?? 0),
  },
  {
    title: "Food Daily",
    dataIndex: "food_daily",
    key: "food_daily",
    render: money,
    sorter: (a: any, b: any) => Number(a.food_daily ?? 0) - Number(b.food_daily ?? 0),
  },
  {
    title: "Other Allowance",
    dataIndex: "other_allowance",
    key: "other_allowance",
    render: money,
    sorter: (a: any, b: any) => Number(a.other_allowance ?? 0) - Number(b.other_allowance ?? 0),
  },
  {
    title: "Total Salary Daily",
    dataIndex: "total_salary_daily",
    key: "total_salary_daily",
    sorter: (a: any, b: any) => Number(a.total_salary_daily ?? 0) - Number(b.total_salary_daily ?? 0),
    render: (v: number) => <strong>{money(v)}</strong>,
  },
];

export default function PayslipReport() {
  const { can } = useAuth();
  const canExport = can("payroll-report", "export");
  const [searchParams] = useSearchParams();
  const [rows, setRows] = useState<any[]>([]);
  const [employees, setEmployees] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  // Date-range filter (From Date / To Date) -- defaults to the current
  // month so the report shows the current payroll data on first load,
  // unless start_date/end_date are supplied via URL (dashboard drill-down).
  const [filterDateRange, setFilterDateRange] = useState<[string, string]>(() => {
    const start = searchParams.get("start_date");
    const end = searchParams.get("end_date");
    if (start && end) return [start, end];
    return [dayjs().startOf("month").format(DATE_FORMAT), dayjs().endOf("month").format(DATE_FORMAT)];
  });
  const [filterEmployee, setFilterEmployee] = useState<number | "all" | undefined>(undefined);

  useEffect(() => {
    loadEmployees();
    loadReport(filterDateRange, undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const loadReport = async (
    dateRange: [string, string] = filterDateRange,
    employeeId: number | "all" | undefined = filterEmployee
  ) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (dateRange) {
        params.append("start_date", dateRange[0]);
        params.append("end_date", dateRange[1]);
      }
      if (employeeId != null && employeeId !== "all") params.append("employee_id", String(employeeId));
      const response = await fetch(`/api/payroll-report?${params}`);
      if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
      const result = await response.json();
      setRows(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading payroll report:", error);
      notifyError("Couldn't load payroll report", error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleExportExcel = async () => {
    if (rows.length === 0) {
      message.warning("There is no data to export.");
      return;
    }
    setExportLoading(true);
    try {
      const totalColumns = Math.max(COLUMNS.length, 4);

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Payslip Report");

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
      titleCell.value = "Payslip Report";
      titleCell.font = { size: 16, bold: true };
      titleCell.alignment = { vertical: "middle", horizontal: "center" };

      sheet.getRow(2).height = 8;

      let currentRow = 3;
      const headerRow = sheet.getRow(currentRow);
      COLUMNS.forEach((col, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = col.title;
        cell.font = { bold: true };
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.fill = headerFill;
        cell.border = thinBorder;
      });
      currentRow += 1;

      rows.forEach((record, index) => {
        const row = sheet.getRow(currentRow);
        COLUMNS.forEach((col, colIdx) => {
          const cell = row.getCell(colIdx + 1);
          if (col.key === "no") {
            cell.value = index + 1;
          } else if (col.key === "period") {
            cell.value = `${record.period_year}-${String(record.period_month).padStart(2, "0")}`;
          } else if (col.key === "staff_name") {
            cell.value = staffName(record.gender, record.full_name);
          } else {
            const raw = record[col.dataIndex as string];
            cell.value = typeof raw === "number" || typeof raw === "string" ? raw : String(raw ?? "");
          }
          cell.alignment = { vertical: "middle" };
          cell.border = thinBorder;
        });
        currentRow += 1;
      });

      const staffNameIdx = COLUMNS.findIndex((col) => col.key === "staff_name");
      const totalRow = sheet.getRow(currentRow);
      if (staffNameIdx !== -1) {
        const cell = totalRow.getCell(staffNameIdx + 1);
        cell.value = "TOTAL";
        cell.font = { bold: true };
      }
      COLUMNS.forEach((col, i) => {
        if ((CURRENCY_KEYS as readonly string[]).includes(col.key)) {
          const cell = totalRow.getCell(i + 1);
          const sum = rows.reduce((acc, r) => acc + Number(r[col.key] ?? 0), 0);
          cell.value = sum;
          cell.font = { bold: true };
        }
      });
      for (let c = 1; c <= COLUMNS.length; c++) {
        const cell = totalRow.getCell(c);
        cell.border = thinBorder;
        cell.alignment = { vertical: "middle" };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F5F5" } };
      }
      currentRow += 1;

      COLUMNS.forEach((col, i) => {
        sheet.getColumn(i + 1).width = Math.max(String(col.title).length + 4, 14);
      });

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Payslip_Report_${dayjs().format(DATE_FORMAT)}.xlsx`;
      link.click();
      window.URL.revokeObjectURL(url);
      notifySuccess("Exported to Excel");
    } catch (error: any) {
      console.error("Error exporting to Excel:", error);
      message.error("Failed to export Excel file.");
    } finally {
      setExportLoading(false);
    }
  };

  const handleExportPdf = async () => {
    if (rows.length === 0) {
      message.warning("There is no data to export.");
      return;
    }
    setPdfLoading(true);
    try {
      const params = new URLSearchParams();
      params.append("start_date", filterDateRange[0]);
      params.append("end_date", filterDateRange[1]);
      if (filterEmployee != null && filterEmployee !== "all") params.append("employee_id", String(filterEmployee));
      const response = await fetch(`/api/payroll-report/payslip-pdf?${params}`);
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Payslip_Report_${dayjs().format(DATE_FORMAT)}.pdf`;
      link.click();
      window.URL.revokeObjectURL(url);
      notifySuccess("Exported to PDF");
    } catch (error: any) {
      console.error("Error exporting to PDF:", error);
      notifyError("Couldn't export PDF", error.message);
    } finally {
      setPdfLoading(false);
    }
  };

  return (
    <Card
      title={
        <span>
          <DollarCircleOutlined style={{ marginRight: 8 }} />
          Payslip Report
        </span>
      }
      extra={
        <Space>
          <RangePicker
            allowClear={false}
            format="DD MMM YYYY"
            value={[dayjs(filterDateRange[0]), dayjs(filterDateRange[1])]}
            onChange={(dates) => {
              if (dates && dates[0] && dates[1]) {
                const range: [string, string] = [dates[0].format(DATE_FORMAT), dates[1].format(DATE_FORMAT)];
                setFilterDateRange(range);
                loadReport(range, filterEmployee);
              }
            }}
          />
          <Select
            allowClear
            showSearch
            placeholder="Employee"
            optionFilterProp="label"
            style={{ width: 200 }}
            value={filterEmployee}
            onChange={(v) => {
              setFilterEmployee(v);
              loadReport(filterDateRange, v);
            }}
            options={[
              { label: "All Employees", value: "all" },
              ...employees.map((e) => ({ label: e.full_name, value: e.employee_id })),
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={() => loadReport()} />
          {canExport && (
            <Tooltip title="Export Excel">
              <Button
                aria-label="Export Excel"
                icon={<FileExcelOutlined />}
                onClick={handleExportExcel}
                loading={exportLoading}
                style={{ backgroundColor: "#22c55e", color: "#fff", borderColor: "#22c55e" }}
              />
            </Tooltip>
          )}
          {canExport && (
            <Tooltip title="Export PDF">
              <Button
                aria-label="Export PDF"
                icon={<FilePdfOutlined />}
                onClick={handleExportPdf}
                loading={pdfLoading}
                style={{ backgroundColor: "#f5222d", color: "#fff", borderColor: "#f5222d" }}
              />
            </Tooltip>
          )}
        </Space>
      }
    >
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

      <Table
        className="compact-vehicle-table"
        size="small"
        loading={loading}
        columns={COLUMNS}
        dataSource={rows}
        rowKey={(r: any) => r.payroll_entry_id ?? `${r.employee_id}-${r.payroll_period_id}`}
        bordered
        scroll={{ x: "max-content" }}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        summary={() => (
          <Table.Summary fixed>
            <Table.Summary.Row>
              {COLUMNS.map((col, idx) => {
                const key = col.key;
                let content: React.ReactNode = null;
                if (key === "staff_name") {
                  content = <strong>TOTAL</strong>;
                } else if ((CURRENCY_KEYS as readonly string[]).includes(key)) {
                  const sum = rows.reduce((acc, r) => acc + Number(r[key] ?? 0), 0);
                  content = <strong>{money(sum)}</strong>;
                }
                return (
                  <Table.Summary.Cell key={key} index={idx} align={key === "staff_name" ? "left" : "center"}>
                    {content}
                  </Table.Summary.Cell>
                );
              })}
            </Table.Summary.Row>
          </Table.Summary>
        )}
      />
    </Card>
  );
}
