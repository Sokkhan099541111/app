import { useEffect, useMemo, useState } from "react";
import { Card, Button, Tooltip, message, Empty, DatePicker, Spin } from "antd";
import { FileExcelOutlined, ReloadOutlined, FileTextOutlined, CaretUpOutlined, CaretDownOutlined } from "@ant-design/icons";
import { useAuth } from "../src/context/AuthContext";
import dayjs, { Dayjs } from "dayjs";
import ExcelJS from "exceljs";
import { getLogoBuffer } from "../src/utils/companyLogo";

const money = (v: number) =>
  `$ ${Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Light grey header, matching the other report tables.
const HEADER_BG = "#e6e6e6";
const EXPENSE_BG = "#fde9d9"; // pale orange -- Total Rental Expense

// Frozen (sticky) columns: No, Code, Plate Number stay visible while
// scrolling horizontally -- widths must match the <th> widths below so the
// sticky "left" offsets line up.
const NO_WIDTH = 50;
const CODE_WIDTH = 70;
const PLATE_WIDTH = 100;
const NO_LEFT = 0;
const CODE_LEFT = NO_WIDTH;
const PLATE_LEFT = NO_WIDTH + CODE_WIDTH;
const FROZEN_EDGE_SHADOW = "2px 0 4px -2px rgba(0,0,0,0.25)";

const STATUS_META: Record<string, { label: string; color: string }> = {
  Working: { label: "W", color: "#22c55e" },
  "On Standby": { label: "S", color: "#3b82f6" },
  Broken: { label: "B", color: "#ff4d4f" },
};

type SortKey =
  | "code"
  | "plate_number"
  | "vehicle_type"
  | "driver_name"
  | "monthly_rental"
  | "total_working"
  | "total_on_standby"
  | "total_broken"
  | "total_rental_expense";

const STRING_SORT_KEYS = new Set<SortKey>(["code", "plate_number", "vehicle_type", "driver_name"]);

export default function RentalExpenseReport() {
  const { can } = useAuth();
  const canExport = can("rental-report", "export");
  const [month, setMonth] = useState<Dayjs>(dayjs().startOf("month"));
  const [daysInMonth, setDaysInMonth] = useState<number>(dayjs().daysInMonth());
  const [rentals, setRentals] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

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
      const response = await fetch(`/api/vehicle-rentals/report?${params}`);
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      const result = await response.json();
      setRentals(Array.isArray(result.data) ? result.data : []);
      setDaysInMonth(result.days_in_month || month.daysInMonth());
    } catch (error: any) {
      console.error("Error loading rental report:", error);
      message.error(error.message || "Could not load the rental expense report.");
      setRentals([]);
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

  const sortedRentals = useMemo(() => {
    if (!sortKey) return rentals;
    const list = [...rentals];
    list.sort((a, b) => {
      const cmp = STRING_SORT_KEYS.has(sortKey)
        ? String(a[sortKey] ?? "").localeCompare(String(b[sortKey] ?? ""))
        : Number(a[sortKey] ?? 0) - Number(b[sortKey] ?? 0);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [rentals, sortKey, sortDir]);

  const totals = useMemo(() => {
    return rentals.reduce(
      (acc, r) => ({
        total_working: acc.total_working + Number(r.total_working ?? 0),
        total_on_standby: acc.total_on_standby + Number(r.total_on_standby ?? 0),
        total_broken: acc.total_broken + Number(r.total_broken ?? 0),
        total_rental_expense: acc.total_rental_expense + Number(r.total_rental_expense ?? 0),
      }),
      { total_working: 0, total_on_standby: 0, total_broken: 0, total_rental_expense: 0 }
    );
  }, [rentals]);

  const days = useMemo(() => Array.from({ length: daysInMonth }, (_, i) => i + 1), [daysInMonth]);

  const sortableTh = (key: SortKey, label: string, width: number, sticky?: { left: number; lastFrozen?: boolean }) => (
    <th
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

  const stickyTdStyle = (width: number, left: number, lastFrozen?: boolean): React.CSSProperties => ({
    ...tdStyle(),
    width,
    position: "sticky",
    left,
    zIndex: 1,
    background: "#fff",
    boxShadow: lastFrozen ? FROZEN_EDGE_SHADOW : undefined,
  });

  const handleExportExcel = async () => {
    if (rentals.length === 0) {
      message.warning("There is no data to export.");
      return;
    }
    setExportLoading(true);
    try {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Rental Expense");

      const thin = { style: "thin" as const };
      const thinBorder = { top: thin, left: thin, bottom: thin, right: thin };
      const headerFill = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFE6E6E6" } };
      const expenseFill = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFDE9D9" } };

      const fixedCols = 6; // No, Code, Plate Number, Vehicle Type, Driver Name, Monthly Rental
      const summaryCols = 4; // Total Working, Total On Standby, Total Broken, Total Rental Expense
      const totalColumns = fixedCols + daysInMonth + summaryCols;

      const logoBuffer = await getLogoBuffer();
      const logoImageId = workbook.addImage({ buffer: logoBuffer as any, extension: "png" });
      sheet.addImage(logoImageId, { tl: { col: 0, row: 0 }, ext: { width: 90, height: 55 } });
      sheet.getRow(1).height = 42;

      sheet.mergeCells(1, 2, 1, totalColumns);
      const titleCell = sheet.getCell(1, 2);
      titleCell.value = `Monthly Report Rental Expense - ${month.format("MMMM YYYY")}`;
      titleCell.font = { size: 16, bold: true };
      titleCell.alignment = { vertical: "middle", horizontal: "center" };

      sheet.getRow(2).height = 8;

      const headerRow = 3;
      const headers = ["No", "Code", "Plate Number", "Vehicle Type", "Driver Name", "Monthly Rental"]
        .concat(days.map((d) => String(d)))
        .concat(["Total Working", "Total On Standby", "Total Broken", "Total Rental Expense"]);
      headers.forEach((label, i) => {
        const cell = sheet.getCell(headerRow, i + 1);
        cell.value = label;
        cell.font = { bold: true };
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.fill = headerFill;
        cell.border = thinBorder;
      });

      sortedRentals.forEach((r, index) => {
        const row = sheet.getRow(headerRow + 1 + index);
        row.getCell(1).value = index + 1;
        row.getCell(2).value = r.code || "";
        row.getCell(3).value = r.plate_number || "";
        row.getCell(4).value = r.vehicle_type || "";
        row.getCell(5).value = r.driver_name || "";
        row.getCell(6).value = Number(r.monthly_rental ?? 0);

        days.forEach((_d, i) => {
          row.getCell(fixedCols + i + 1).value = r.days[i] ? STATUS_META[r.days[i]]?.label ?? r.days[i] : "";
          row.getCell(fixedCols + i + 1).alignment = { horizontal: "center" };
        });

        let c = fixedCols + daysInMonth + 1;
        row.getCell(c).value = r.total_working;
        row.getCell(c + 1).value = r.total_on_standby;
        row.getCell(c + 2).value = r.total_broken;
        row.getCell(c + 3).value = Number(r.total_rental_expense ?? 0);
        row.getCell(c + 3).fill = expenseFill;
        row.getCell(c + 3).font = { bold: true };

        for (let cc = 1; cc <= totalColumns; cc++) {
          row.getCell(cc).border = thinBorder;
        }
      });

      sheet.getColumn(1).width = 6;
      sheet.getColumn(2).width = 10;
      sheet.getColumn(3).width = 14;
      sheet.getColumn(4).width = 16;
      sheet.getColumn(5).width = 18;
      sheet.getColumn(6).width = 14;
      for (let d = 0; d < daysInMonth; d++) sheet.getColumn(fixedCols + d + 1).width = 5;
      for (let i = 0; i < summaryCols; i++) sheet.getColumn(fixedCols + daysInMonth + 1 + i).width = 15;

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Rental_Expense_${month.format("YYYY-MM")}.xlsx`;
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
          gap: 10,
          marginBottom: 16,
          padding: "12px 16px",
          background: "#fafafa",
          border: "1px solid #f0f0f0",
          borderRadius: 8,
        }}
      >
        <span style={{ fontSize: 16, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
          <FileTextOutlined style={{ marginRight: 8 }} />
          Monthly Report Rental Expense
        </span>
        <DatePicker
          picker="month"
          format="MMMM YYYY"
          allowClear={false}
          value={month}
          onChange={(value) => value && setMonth(value.startOf("month"))}
          style={{ flexShrink: 0, marginLeft: "auto" }}
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
              disabled={rentals.length === 0}
              style={{ background: "#217346", borderColor: "#217346", color: "#fff", flexShrink: 0 }}
            />
          </Tooltip>
        )}
      </div>

      <Spin spinning={loading}>
      {rentals.length === 0 && !loading ? (
        <Empty description="No active rental vehicles for this month." />
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, width: "max-content", minWidth: "100%" }}>
            <thead>
              <tr>
                <th style={{ ...thStyle(NO_WIDTH), position: "sticky", left: NO_LEFT, zIndex: 3, background: HEADER_BG }}>
                  No
                </th>
                {sortableTh("code", "Code", CODE_WIDTH, { left: CODE_LEFT })}
                {sortableTh("plate_number", "Plate Number", PLATE_WIDTH, { left: PLATE_LEFT, lastFrozen: true })}
                {sortableTh("vehicle_type", "Vehicle Type", 110)}
                {sortableTh("driver_name", "Driver Name", 140)}
                {sortableTh("monthly_rental", "Monthly Rental", 100)}
                {days.map((d) => (
                  <th key={d} style={thStyle(32)}>
                    {d}
                  </th>
                ))}
                {sortableTh("total_working", "Total Working", 100)}
                {sortableTh("total_on_standby", "Total On Standby", 110)}
                {sortableTh("total_broken", "Total Broken", 100)}
                {sortableTh("total_rental_expense", "Total Rental Expense", 130)}
              </tr>
            </thead>
            <tbody>
              {sortedRentals.map((r, index) => (
                <tr key={r.rental_id}>
                  <td style={stickyTdStyle(NO_WIDTH, NO_LEFT)}>{index + 1}</td>
                  <td style={stickyTdStyle(CODE_WIDTH, CODE_LEFT)}>{r.code || "-"}</td>
                  <td style={stickyTdStyle(PLATE_WIDTH, PLATE_LEFT, true)}>{r.plate_number || "-"}</td>
                  <td style={tdStyle()}>{r.vehicle_type || "-"}</td>
                  <td style={{ ...tdStyle(), textAlign: "left", paddingLeft: 6 }}>{r.driver_name || "-"}</td>
                  <td style={tdStyle()}>{money(r.monthly_rental)}</td>
                  {days.map((_, i) => {
                    const status = r.days[i];
                    const meta = status ? STATUS_META[status] : undefined;
                    return (
                      <td key={i} style={tdStyle()}>
                        <span style={{ color: meta ? meta.color : "#ccc", fontWeight: 700 }}>
                          {meta ? meta.label : "-"}
                        </span>
                      </td>
                    );
                  })}
                  <td style={tdStyle()}>{r.total_working}</td>
                  <td style={tdStyle()}>{r.total_on_standby}</td>
                  <td style={tdStyle()}>{r.total_broken}</td>
                  <td style={{ ...tdStyle(), background: EXPENSE_BG, fontWeight: 700 }}>
                    {money(r.total_rental_expense)}
                  </td>
                </tr>
              ))}
              <tr>
                <td style={stickyTdStyle(NO_WIDTH, NO_LEFT)} />
                <td style={stickyTdStyle(CODE_WIDTH, CODE_LEFT)} />
                <td style={stickyTdStyle(PLATE_WIDTH, PLATE_LEFT, true)} />
                <td colSpan={3 + daysInMonth} style={{ ...tdStyle(), textAlign: "right", fontWeight: 700 }}>
                  TOTAL
                </td>
                <td style={{ ...tdStyle(), fontWeight: 700 }}>{totals.total_working}</td>
                <td style={{ ...tdStyle(), fontWeight: 700 }}>{totals.total_on_standby}</td>
                <td style={{ ...tdStyle(), fontWeight: 700 }}>{totals.total_broken}</td>
                <td style={{ ...tdStyle(), background: EXPENSE_BG, fontWeight: 700 }}>
                  {money(totals.total_rental_expense)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      </Spin>
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
