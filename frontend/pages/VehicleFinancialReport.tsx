import { useEffect, useMemo, useState } from "react";
import { Card, Button, Tooltip, message, Empty, DatePicker, Spin, Modal, Form, InputNumber, Space, Pagination } from "antd";
import {
  FileExcelOutlined,
  ReloadOutlined,
  FundOutlined,
  CaretUpOutlined,
  CaretDownOutlined,
  EditOutlined,
  SaveOutlined,
  CloseOutlined,
} from "@ant-design/icons";
import { useAuth } from "../src/context/AuthContext";
import dayjs, { Dayjs } from "dayjs";
import ExcelJS from "exceljs";
import { useSearchParams } from "react-router-dom";
import { getLogoBuffer } from "../src/utils/companyLogo";

const money = (v: number | null | undefined) =>
  `$ ${Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const HEADER_BG = "#e6e6e6";
const PROFIT_BG = "#e6f4ea";
const LOSS_BG = "#fde9e9";

// Frozen columns: No / Code / Plate Number stay visible while the rest of
// the wide table scrolls horizontally underneath them.
const NO_WIDTH = 46;
const CODE_WIDTH = 70;
const PLATE_WIDTH = 100;
const NO_LEFT = 0;
const CODE_LEFT = NO_WIDTH;
const PLATE_LEFT = NO_WIDTH + CODE_WIDTH;
const FROZEN_EDGE_SHADOW = "2px 0 4px -2px rgba(0,0,0,0.25)";

const CURRENCY_KEYS = [
  "total_monthly_revenue",
  "repair_expense",
  "engine_oil_expense",
  "diesel_expense",
  "staff_salary",
  "rental_expense",
  "total_monthly_expenses",
  "monthly_profit",
  "monthly_kpi",
  "bonus",
  "monthly_profit_plus_bonus",
  "kpi_achieved",
  "meter_per_month",
  "remaining_kpi",
] as const;

type SortKey =
  | "code"
  | "plate_number"
  | "vehicle_type"
  | "driver_name"
  | "total_monthly_revenue"
  | "total_monthly_expenses"
  | "monthly_profit";

const STRING_SORT_KEYS = new Set<SortKey>(["code", "plate_number", "vehicle_type", "driver_name"]);

export default function VehicleFinancialReport() {
  const { can } = useAuth();
  const canEdit = can("vehicle-financial-report", "edit");
  const canExport = can("vehicle-financial-report", "export");
  const [searchParams] = useSearchParams();
  const [month, setMonth] = useState<Dayjs>(() => {
    const y = searchParams.get("year");
    const m = searchParams.get("month");
    if (y && m) return dayjs(`${y}-${String(m).padStart(2, "0")}-01`);
    return dayjs().startOf("month");
  });
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingRow, setEditingRow] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [form] = Form.useForm();

  useEffect(() => {
    loadReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  const loadReport = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        year: String(month.year()),
        month: String(month.month() + 1),
      });
      const response = await fetch(`/api/vehicle-financial-report?${params}`);
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      const result = await response.json();
      setRows(Array.isArray(result.data) ? result.data : []);
      setCurrentPage(1);
    } catch (error: any) {
      console.error("Error loading vehicle financial report:", error);
      message.error(error.message || "Could not load the vehicle financial report.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sortedRows = useMemo(() => {
    if (!sortKey) return rows;
    const list = [...rows];
    list.sort((a, b) => {
      const cmp = STRING_SORT_KEYS.has(sortKey)
        ? String(a[sortKey] ?? "").localeCompare(String(b[sortKey] ?? ""))
        : Number(a[sortKey] ?? 0) - Number(b[sortKey] ?? 0);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [rows, sortKey, sortDir]);

  const pagedRows = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return sortedRows.slice(start, start + pageSize);
  }, [sortedRows, currentPage, pageSize]);

  const sortableTh = (
    key: SortKey,
    label: string,
    width: number,
    sticky?: { left: number; lastFrozen?: boolean }
  ) => (
    <th
      rowSpan={2}
      style={{
        ...thStyle(width),
        cursor: "pointer",
        userSelect: "none",
        ...(sticky
          ? {
              position: "sticky" as const,
              left: sticky.left,
              zIndex: 3,
              background: HEADER_BG,
              boxShadow: sticky.lastFrozen ? FROZEN_EDGE_SHADOW : undefined,
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

  const totals = useMemo(() => {
    const sums: Record<string, number> = {};
    for (const key of CURRENCY_KEYS) sums[key] = 0;
    for (const r of sortedRows) {
      for (const key of CURRENCY_KEYS) sums[key] += Number(r[key] ?? 0);
    }
    return sums;
  }, [sortedRows]);

  const openEdit = (record: any) => {
    setEditingRow(record);
    form.setFieldsValue({
      bonus: record.bonus,
      meter_per_month: record.meter_per_month,
    });
    setIsModalVisible(true);
  };

  const handleSaveExtras = async (values: any) => {
    if (!editingRow) return;
    setSaving(true);
    try {
      const payload = {
        vehicles_id: editingRow.vehicles_id,
        year: month.year(),
        month: month.month() + 1,
        bonus: values.bonus ?? 0,
        meter_per_month: values.meter_per_month ?? 0,
      };
      const response = await fetch("/api/vehicle-financial-report/extras", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      message.success("Saved");
      setIsModalVisible(false);
      setEditingRow(null);
      loadReport();
    } catch (error: any) {
      console.error("Error saving monthly KPI extras:", error);
      message.error(error.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const handleExportExcel = async () => {
    if (rows.length === 0) {
      message.warning("There is no data to export.");
      return;
    }
    setExportLoading(true);
    try {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Financial & KPI Report");

      const thin = { style: "thin" as const };
      const thinBorder = { top: thin, left: thin, bottom: thin, right: thin };
      const headerFill = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFE6E6E6" } };

      const headers = [
        "No.", "Code", "Plate Number", "Vehicle Type", "Driver Name", "Total Monthly Revenue",
        "Repair & Maintenance Expense", "Engine Oil, Pump & Brake Expense", "Total Diesel Fuel Expense",
        "Total Staff Salary", "Vehicle Rental Expense", "Total Monthly Expenses", "Monthly Profit",
        "Monthly KPI", "Bonus", "Monthly Profit + Bonus", "KPI Achieved", "Meter / Month",
        "Remaining KPI", "Remarks",
      ];
      const totalColumns = headers.length;

      const logoBuffer = await getLogoBuffer();
      const logoImageId = workbook.addImage({ buffer: logoBuffer as any, extension: "png" });
      sheet.addImage(logoImageId, { tl: { col: 0, row: 0 }, ext: { width: 90, height: 55 } });
      sheet.getRow(1).height = 42;

      sheet.mergeCells(1, 2, 1, totalColumns);
      const titleCell = sheet.getCell(1, 2);
      titleCell.value = `Monthly Vehicle Financial & KPI Performance Report - ${month.format("MMMM YYYY")}`;
      titleCell.font = { size: 15, bold: true };
      titleCell.alignment = { vertical: "middle", horizontal: "center" };

      sheet.getRow(2).height = 8;

      const headerRow = 3;
      headers.forEach((label, i) => {
        const cell = sheet.getCell(headerRow, i + 1);
        cell.value = label;
        cell.font = { bold: true };
        cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
        cell.fill = headerFill;
        cell.border = thinBorder;
      });

      sortedRows.forEach((r, index) => {
        const row = sheet.getRow(headerRow + 1 + index);
        const values = [
          index + 1, r.code || "", r.plate_number || "", r.vehicle_type || "", r.driver_name || "",
          Number(r.total_monthly_revenue ?? 0), Number(r.repair_expense ?? 0), Number(r.engine_oil_expense ?? 0),
          Number(r.diesel_expense ?? 0), Number(r.staff_salary ?? 0), Number(r.rental_expense ?? 0),
          Number(r.total_monthly_expenses ?? 0), Number(r.monthly_profit ?? 0),
          Number(r.monthly_kpi ?? 0), Number(r.bonus ?? 0),
          Number(r.monthly_profit_plus_bonus ?? 0), Number(r.kpi_achieved ?? 0),
          Number(r.meter_per_month ?? 0), Number(r.remaining_kpi ?? 0), r.remarks || "",
        ];
        values.forEach((v, colIdx) => {
          const cell = row.getCell(colIdx + 1);
          cell.value = v as any;
          cell.alignment = { vertical: "middle" };
          cell.border = thinBorder;
        });
      });

      const totalRowIndex = headerRow + 1 + sortedRows.length;
      const totalRow = sheet.getRow(totalRowIndex);
      sheet.mergeCells(totalRowIndex, 1, totalRowIndex, 5);
      const totalLabelCell = totalRow.getCell(1);
      totalLabelCell.value = "TOTAL";
      totalLabelCell.font = { bold: true };
      totalLabelCell.alignment = { horizontal: "right", vertical: "middle" };
      const totalValues = [
        Number(totals.total_monthly_revenue ?? 0), Number(totals.repair_expense ?? 0),
        Number(totals.engine_oil_expense ?? 0), Number(totals.diesel_expense ?? 0),
        Number(totals.staff_salary ?? 0), Number(totals.rental_expense ?? 0),
        Number(totals.total_monthly_expenses ?? 0), Number(totals.monthly_profit ?? 0),
        Number(totals.monthly_kpi ?? 0), Number(totals.bonus ?? 0),
        Number(totals.monthly_profit_plus_bonus ?? 0), Number(totals.kpi_achieved ?? 0),
        Number(totals.meter_per_month ?? 0), Number(totals.remaining_kpi ?? 0),
      ];
      totalValues.forEach((v, i) => {
        const cell = totalRow.getCell(6 + i);
        cell.value = v;
        cell.font = { bold: true };
        cell.alignment = { vertical: "middle" };
      });
      for (let c = 1; c <= totalColumns; c++) {
        totalRow.getCell(c).border = thinBorder;
        totalRow.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F5F5" } };
      }

      headers.forEach((label, i) => {
        sheet.getColumn(i + 1).width = Math.max(label.length + 2, 12);
      });
      sheet.getColumn(2).width = 10;
      sheet.getColumn(3).width = 14;
      sheet.getColumn(5).width = 18;
      sheet.getColumn(20).width = 24;

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Vehicle_Financial_KPI_Report_${month.format("YYYY-MM")}.xlsx`;
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
    <Card bodyStyle={{ paddingTop: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 16,
          padding: "12px 16px",
          background: "#fafafa",
          border: "1px solid #f0f0f0",
          borderRadius: 8,
        }}
      >
        <span style={{ fontSize: 16, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
          <FundOutlined style={{ marginRight: 8 }} />
          Monthly Vehicle Financial & KPI Performance Report
        </span>
        <Space size={12} wrap align="center" style={{ marginLeft: "auto" }}>
          <DatePicker
            picker="month"
            format="MMMM YYYY"
            allowClear={false}
            value={month}
            onChange={(value) => value && setMonth(value.startOf("month"))}
            style={{ flexShrink: 0 }}
          />
          <Tooltip title="Refresh">
            <Button aria-label="Refresh" icon={<ReloadOutlined />} onClick={loadReport} style={{ flexShrink: 0 }} />
          </Tooltip>
          {canExport && (
            <Tooltip title="Export Excel">
              <Button
                aria-label="Export Excel"
                icon={<FileExcelOutlined />}
                onClick={handleExportExcel}
                loading={exportLoading}
                disabled={rows.length === 0}
                style={{ background: "#217346", borderColor: "#217346", color: "#fff", flexShrink: 0 }}
              />
            </Tooltip>
          )}
        </Space>
      </div>

      <Spin spinning={loading}>
        {rows.length === 0 && !loading ? (
          <Empty description="No vehicles found for this month." />
        ) : (
          <>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", fontSize: 12, width: "max-content", minWidth: "100%" }}>
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
                      No
                    </th>
                    {sortableTh("code", "Code", CODE_WIDTH, { left: CODE_LEFT })}
                    {sortableTh("plate_number", "Plate Number", PLATE_WIDTH, { left: PLATE_LEFT, lastFrozen: true })}
                    {sortableTh("vehicle_type", "Vehicle Type", 110)}
                    {sortableTh("driver_name", "Driver Name", 130)}
                    {sortableTh("total_monthly_revenue", "Total Monthly Revenue", 130)}
                    <th colSpan={5} style={thStyle(0)}>Total Expenses</th>
                    {sortableTh("total_monthly_expenses", "Total Monthly Expenses", 130)}
                    {sortableTh("monthly_profit", "Monthly Profit", 120)}
                    <th rowSpan={2} style={thStyle(100)}>Monthly KPI</th>
                    <th rowSpan={2} style={thStyle(90)}>Bonus</th>
                    <th rowSpan={2} style={thStyle(140)}>Monthly Profit + Bonus</th>
                    <th rowSpan={2} style={thStyle(100)}>KPI Achieved</th>
                    <th rowSpan={2} style={thStyle(100)}>Meter / Month</th>
                    <th rowSpan={2} style={thStyle(100)}>Remaining KPI</th>
                    <th rowSpan={2} style={thStyle(190)}>Remarks</th>
                    <th rowSpan={2} style={thStyle(60)}>Action</th>
                  </tr>
                  <tr>
                    <th style={thStyle(120)}>Repair & Maintenance Expense</th>
                    <th style={thStyle(120)}>Engine Oil, Pump & Brake Expense</th>
                    <th style={thStyle(110)}>Total Diesel Fuel Expense</th>
                    <th style={thStyle(110)}>Total Staff Salary</th>
                    <th style={thStyle(110)}>Vehicle Rental Expense</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((r, index) => (
                    <tr key={r.vehicles_id}>
                      <td style={stickyTdStyle(NO_WIDTH, NO_LEFT)}>{(currentPage - 1) * pageSize + index + 1}</td>
                      <td style={stickyTdStyle(CODE_WIDTH, CODE_LEFT)}>{r.code || "-"}</td>
                      <td style={stickyTdStyle(PLATE_WIDTH, PLATE_LEFT, true)}>{r.plate_number || "-"}</td>
                      <td style={tdStyle()}>{r.vehicle_type || "-"}</td>
                      <td style={{ ...tdStyle(), textAlign: "left", paddingLeft: 6 }}>{r.driver_name || "-"}</td>
                      <td style={tdStyle()}>{money(r.total_monthly_revenue)}</td>
                      <td style={tdStyle()}>{money(r.repair_expense)}</td>
                      <td style={tdStyle()}>{money(r.engine_oil_expense)}</td>
                      <td style={tdStyle()}>{money(r.diesel_expense)}</td>
                      <td style={tdStyle()}>{money(r.staff_salary)}</td>
                      <td style={tdStyle()}>{money(r.rental_expense)}</td>
                      <td style={{ ...tdStyle(), fontWeight: 700 }}>{money(r.total_monthly_expenses)}</td>
                      <td
                        style={{
                          ...tdStyle(),
                          fontWeight: 700,
                          background: Number(r.monthly_profit ?? 0) >= 0 ? PROFIT_BG : LOSS_BG,
                        }}
                      >
                        {money(r.monthly_profit)}
                      </td>
                      <td style={tdStyle()}>{money(r.monthly_kpi)}</td>
                      <td style={tdStyle()}>{money(r.bonus)}</td>
                      <td
                        style={{
                          ...tdStyle(),
                          fontWeight: 700,
                          background: Number(r.monthly_profit_plus_bonus ?? 0) >= 0 ? PROFIT_BG : LOSS_BG,
                        }}
                      >
                        {money(r.monthly_profit_plus_bonus)}
                      </td>
                      <td style={tdStyle()}>{money(r.kpi_achieved)}</td>
                      <td style={tdStyle()}>{money(r.meter_per_month)}</td>
                      <td style={tdStyle()}>{money(r.remaining_kpi)}</td>
                      <td style={{ ...tdStyle(), textAlign: "left", paddingLeft: 6 }}>{r.remarks || "-"}</td>
                      <td style={tdStyle()}>
                        <Tooltip title="Edit Bonus / Meter per Month">
                          {canEdit && <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />}
                        </Tooltip>
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td style={stickyTdStyle(NO_WIDTH, NO_LEFT, false, "#fafafa")} />
                    <td style={stickyTdStyle(CODE_WIDTH, CODE_LEFT, false, "#fafafa")} />
                    <td style={stickyTdStyle(PLATE_WIDTH, PLATE_LEFT, true, "#fafafa")} />
                    <td style={{ ...tdStyle(), background: "#fafafa" }} />
                    <td style={{ ...tdStyle(), background: "#fafafa", textAlign: "left", paddingLeft: 6, fontWeight: 700 }}>
                      TOTAL
                    </td>
                    <td style={{ ...tdStyle(), background: "#fafafa", fontWeight: 700 }}>
                      {money(totals.total_monthly_revenue)}
                    </td>
                    <td style={{ ...tdStyle(), background: "#fafafa", fontWeight: 700 }}>{money(totals.repair_expense)}</td>
                    <td style={{ ...tdStyle(), background: "#fafafa", fontWeight: 700 }}>
                      {money(totals.engine_oil_expense)}
                    </td>
                    <td style={{ ...tdStyle(), background: "#fafafa", fontWeight: 700 }}>{money(totals.diesel_expense)}</td>
                    <td style={{ ...tdStyle(), background: "#fafafa", fontWeight: 700 }}>{money(totals.staff_salary)}</td>
                    <td style={{ ...tdStyle(), background: "#fafafa", fontWeight: 700 }}>{money(totals.rental_expense)}</td>
                    <td style={{ ...tdStyle(), background: "#fafafa", fontWeight: 700 }}>
                      {money(totals.total_monthly_expenses)}
                    </td>
                    <td
                      style={{
                        ...tdStyle(),
                        fontWeight: 700,
                        background: totals.monthly_profit >= 0 ? PROFIT_BG : LOSS_BG,
                      }}
                    >
                      {money(totals.monthly_profit)}
                    </td>
                    <td style={{ ...tdStyle(), background: "#fafafa", fontWeight: 700 }}>{money(totals.monthly_kpi)}</td>
                    <td style={{ ...tdStyle(), background: "#fafafa", fontWeight: 700 }}>{money(totals.bonus)}</td>
                    <td
                      style={{
                        ...tdStyle(),
                        fontWeight: 700,
                        background: totals.monthly_profit_plus_bonus >= 0 ? PROFIT_BG : LOSS_BG,
                      }}
                    >
                      {money(totals.monthly_profit_plus_bonus)}
                    </td>
                    <td style={{ ...tdStyle(), background: "#fafafa", fontWeight: 700 }}>{money(totals.kpi_achieved)}</td>
                    <td style={{ ...tdStyle(), background: "#fafafa", fontWeight: 700 }}>{money(totals.meter_per_month)}</td>
                    <td style={{ ...tdStyle(), background: "#fafafa", fontWeight: 700 }}>{money(totals.remaining_kpi)}</td>
                    <td style={{ ...tdStyle(), background: "#fafafa" }} />
                    <td style={{ ...tdStyle(), background: "#fafafa" }} />
                  </tr>
                </tbody>
              </table>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
              <Pagination
                current={currentPage}
                pageSize={pageSize}
                total={sortedRows.length}
                showSizeChanger
                pageSizeOptions={["10", "20", "50", "100"]}
                showTotal={(total) => `${total} vehicles`}
                onChange={(page, size) => {
                  setCurrentPage(page);
                  setPageSize(size);
                }}
              />
            </div>
          </>
        )}
      </Spin>

      <Modal
        title="Edit Bonus / Meter per Month"
        open={isModalVisible}
        onCancel={() => {
          setIsModalVisible(false);
          setEditingRow(null);
        }}
        footer={null}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleSaveExtras}>
          <Form.Item name="bonus" label="Bonus">
            <InputNumber style={{ width: "100%" }} min={0} step={0.01} prefix="$" />
          </Form.Item>
          <Form.Item name="meter_per_month" label="Meter / Month">
            <InputNumber style={{ width: "100%" }} min={0} step={0.01} prefix="$" />
          </Form.Item>
          <Space style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button icon={<CloseOutlined />} onClick={() => setIsModalVisible(false)}>
              Cancel
            </Button>
            <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving} style={{ backgroundColor: "#051650" }}>
              Save
            </Button>
          </Space>
        </Form>
      </Modal>
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
    width: width || undefined,
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
