import { useEffect, useMemo, useState } from "react";
import { Card, Select, Button, Tooltip, message, Empty, Spin, Tag } from "antd";
import {
  FileExcelOutlined,
  ReloadOutlined,
  LineChartOutlined,
  DollarOutlined,
  AimOutlined,
  FallOutlined,
  RiseOutlined,
  BarChartOutlined,
  TrophyOutlined,
} from "@ant-design/icons";
import { useAuth } from "../src/context/AuthContext";
import dayjs from "dayjs";
import { loadExcelJS } from "../src/utils/loadExcelJS";
import { getLogoBuffer } from "../src/utils/companyLogo";

/**
 * Sales Performance -- Actual vs Budget by month and year.
 *
 * Every figure here is computed by GET /api/sales-performance; nothing is
 * recalculated in the browser. That matters because the same numbers go
 * into the Excel export: one source means the sheet cannot disagree with
 * the screen.
 */

const MONEY_UNIT = 1000; // figures are shown in thousands, as "Sales (K)"

const money = (v: number | null | undefined) =>
  `${Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Percentages are null when there is no budget to measure against. */
const pct = (v: number | null | undefined) => (v == null ? "--" : `${Number(v).toFixed(2)}%`);

const STATUS_COLOR: Record<string, string> = {
  Above: "#22c55e",
  "On Target": "#faad14",
  Below: "#ff4d4f",
};

const CARD_TINT: Record<string, { bg: string; border: string; fg: string }> = {
  actual: { bg: "#eff6ff", border: "#bfdbfe", fg: "#1d4ed8" },
  budget: { bg: "#ecfdf5", border: "#a7f3d0", fg: "#047857" },
  variance: { bg: "#fef2f2", border: "#fecaca", fg: "#dc2626" },
  achievement: { bg: "#f5f3ff", border: "#ddd6fe", fg: "#6d28d9" },
};

interface MonthRow {
  month: number;
  month_name: string;
  month_short: string;
  actual: number;
  budget: number;
  variance: number;
  variance_pct: number | null;
  achievement_pct: number | null;
  status: string;
}

/** Metric card: one headline figure with its label and unit. */
function MetricCard({
  tint,
  icon,
  label,
  value,
  unit,
}: {
  tint: keyof typeof CARD_TINT;
  icon: React.ReactNode;
  label: string;
  value: string;
  unit: string;
}) {
  const t = CARD_TINT[tint];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "14px 18px",
        background: t.bg,
        border: `1px solid ${t.border}`,
        borderRadius: 12,
        flex: 1,
        minWidth: 210,
      }}
    >
      <div
        style={{
          width: 46,
          height: 46,
          borderRadius: "50%",
          background: t.fg,
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 20,
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: t.fg, letterSpacing: 0.4 }}>{label}</div>
        <div style={{ fontSize: 26, fontWeight: 700, color: t.fg, lineHeight: 1.15 }}>{value}</div>
        <div style={{ fontSize: 11, color: "#8c8c8c" }}>— {unit}</div>
      </div>
    </div>
  );
}

/**
 * Budget as grey bars with the Actual line drawn over them, so a month
 * that misses target is visible as the line dipping below its bar.
 * Hand-drawn SVG rather than a chart library -- the same approach as the
 * Dashboard's charts, and it keeps the bundle unchanged.
 */
function BudgetVsActualChart({ rows }: { rows: MonthRow[] }) {
  if (rows.length === 0) return null;

  const width = Math.max(560, rows.length * 92);
  const height = 320;
  const padLeft = 46;
  const padRight = 16;
  const padTop = 24;
  const padBottom = 58;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const maxValue = Math.max(...rows.map((r) => Math.max(r.actual, r.budget)), 1);
  // Round the axis up to a clean number so gridlines read sensibly.
  const step = Math.pow(10, Math.floor(Math.log10(maxValue))) / 2 || 1;
  const axisMax = Math.ceil(maxValue / step) * step;

  const bandW = plotW / rows.length;
  const barW = Math.min(46, bandW * 0.5);
  const y = (v: number) => padTop + plotH - (v / axisMax) * plotH;
  const cx = (i: number) => padLeft + bandW * i + bandW / 2;

  const ticks = 6;
  const gridValues = Array.from({ length: ticks + 1 }, (_, i) => (axisMax / ticks) * i);

  return (
    <div style={{ overflowX: "auto" }}>
      <svg width={width} height={height} role="img" aria-label="Actual sales versus budget by month">
        {gridValues.map((v, i) => (
          <g key={i}>
            <line x1={padLeft} x2={width - padRight} y1={y(v)} y2={y(v)} stroke="#f0f0f0" />
            <text x={padLeft - 8} y={y(v) + 4} textAnchor="end" fontSize={10} fill="#8c8c8c">
              {Math.round(v)}
            </text>
          </g>
        ))}

        {rows.map((r, i) => (
          <rect
            key={`bar-${r.month}`}
            x={cx(i) - barW / 2}
            y={y(r.budget)}
            width={barW}
            height={Math.max(plotH - (y(r.budget) - padTop), 0)}
            fill="#d9d9d9"
          />
        ))}

        {/* One segment per gap, coloured by the month it arrives at, so a
            recovery month is green even if it follows a poor one. */}
        {rows.slice(1).map((r, i) => (
          <line
            key={`seg-${r.month}`}
            x1={cx(i)}
            y1={y(rows[i].actual)}
            x2={cx(i + 1)}
            y2={y(r.actual)}
            stroke={STATUS_COLOR[r.status] ?? "#1677ff"}
            strokeWidth={2.5}
          />
        ))}

        {rows.map((r, i) => (
          <g key={`pt-${r.month}`}>
            <circle cx={cx(i)} cy={y(r.actual)} r={5} fill="#fff" stroke={STATUS_COLOR[r.status] ?? "#1677ff"} strokeWidth={2.5} />
            <text x={cx(i)} y={y(r.actual) - 12} textAnchor="middle" fontSize={11} fontWeight={700} fill="#262626">
              {r.actual.toFixed(1)}
            </text>
            <text x={cx(i)} y={height - 34} textAnchor="middle" fontSize={11} fill="#595959">
              {r.month_short}
            </text>
            <text
              x={cx(i)}
              y={height - 16}
              textAnchor="middle"
              fontSize={10}
              fontWeight={700}
              fill={STATUS_COLOR[r.status] ?? "#8c8c8c"}
            >
              {r.achievement_pct == null ? "--" : `${Math.round(r.achievement_pct)}%`}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export default function SalesPerformance() {
  const { can } = useAuth();
  const canExport = can("sales-performance", "export");

  const [data, setData] = useState<any>(null);
  const [years, setYears] = useState<number[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [persons, setPersons] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);

  const [year, setYear] = useState<number>(dayjs().year());
  const [monthRange, setMonthRange] = useState<[number, number]>([1, 12]);
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined);
  const [salesPersonId, setSalesPersonId] = useState<number | undefined>(undefined);

  useEffect(() => {
    loadYears();
    loadMasters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, monthRange, categoryId, salesPersonId]);

  const loadYears = async () => {
    try {
      const response = await fetch("/api/sales-performance/years");
      if (!response.ok) return;
      const result = await response.json();
      if (Array.isArray(result.years) && result.years.length) setYears(result.years);
    } catch {
      // The year picker falls back to the current year on its own.
    }
  };

  const loadMasters = async () => {
    try {
      const [cRes, pRes] = await Promise.all([
        fetch("/api/sales-categories"),
        fetch("/api/sales-persons"),
      ]);
      if (cRes.ok) setCategories((await cRes.json()).data ?? []);
      if (pRes.ok) setPersons((await pRes.json()).data ?? []);
    } catch {
      // Filters simply stay empty; the report still loads unfiltered.
    }
  };

  const loadReport = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        year: String(year),
        start_month: String(monthRange[0]),
        end_month: String(monthRange[1]),
      });
      if (categoryId != null) params.append("category_id", String(categoryId));
      if (salesPersonId != null) params.append("sales_person_id", String(salesPersonId));

      const response = await fetch(`/api/sales-performance?${params}`);
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      setData(await response.json());
    } catch (error: any) {
      console.error("Error loading sales performance:", error);
      message.error(error.message || "Could not load sales performance.");
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  const months: MonthRow[] = data?.months ?? [];
  const period = data?.period;
  const annual = data?.annual;
  const highlights = data?.highlights;

  const rangeLabel = useMemo(() => {
    if (!months.length) return "";
    return `${months[0].month_short} ${year} – ${months[months.length - 1].month_short} ${year}`;
  }, [months, year]);

  const statusTag = (status: string) => (
    <span style={{ color: STATUS_COLOR[status] ?? "#8c8c8c", fontWeight: 600 }}>{status}</span>
  );

  const handleExportExcel = async () => {
    if (!months.length) {
      message.warning("There is no data to export.");
      return;
    }
    setExportLoading(true);
    try {
      const ExcelJS = await loadExcelJS();
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Sales Performance");

      const thin = { style: "thin" as const };
      const thinBorder = { top: thin, left: thin, bottom: thin, right: thin };
      const headerFill = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFE6E6E6" } };

      const headers = [
        "Month", "Budget (K)", "Actual (K)", "Variance (K)",
        "Variance (%)", "Achievement (%)", "vs Target",
      ];
      const totalColumns = headers.length;

      const logoBuffer = await getLogoBuffer();
      const logoImageId = workbook.addImage({ buffer: logoBuffer as any, extension: "png" });
      sheet.addImage(logoImageId, { tl: { col: 0, row: 0 }, ext: { width: 90, height: 55 } });
      sheet.getRow(1).height = 42;

      sheet.mergeCells(1, 2, 1, totalColumns);
      const titleCell = sheet.getCell(1, 2);
      // Name the filters in the title -- a filtered export that does not say
      // so is indistinguishable from the whole company's numbers.
      const catName = categories.find((c) => c.category_id === categoryId)?.name;
      const personName = persons.find((p) => p.sales_person_id === salesPersonId)?.name;
      titleCell.value =
        `Sales Performance - Actual vs Budget - ${rangeLabel}` +
        (catName ? ` - Category: ${catName}` : "") +
        (personName ? ` - Sales Person: ${personName}` : "");
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

      months.forEach((r, index) => {
        const row = sheet.getRow(headerRow + 1 + index);
        const values = [
          r.month_short,
          r.budget,
          r.actual,
          r.variance,
          r.variance_pct == null ? "--" : r.variance_pct / 100,
          r.achievement_pct == null ? "--" : r.achievement_pct / 100,
          r.status,
        ];
        values.forEach((v, colIdx) => {
          const cell = row.getCell(colIdx + 1);
          cell.value = v as any;
          cell.border = thinBorder;
          cell.alignment = { vertical: "middle" };
          // Real percentages, not strings -- so the sheet can be charted.
          if ((colIdx === 4 || colIdx === 5) && typeof v === "number") cell.numFmt = "0.00%";
          if (colIdx >= 1 && colIdx <= 3) cell.numFmt = "#,##0.00;[Red]-#,##0.00";
        });
      });

      const totalRowIndex = headerRow + 1 + months.length;
      const totalRow = sheet.getRow(totalRowIndex);
      const totals = [
        "Total",
        period?.budget ?? 0,
        period?.actual ?? 0,
        period?.variance ?? 0,
        period?.variance_pct == null ? "--" : period.variance_pct / 100,
        period?.achievement_pct == null ? "--" : period.achievement_pct / 100,
        period?.status ?? "",
      ];
      totals.forEach((v, i) => {
        const cell = totalRow.getCell(i + 1);
        cell.value = v as any;
        cell.font = { bold: true };
        cell.border = thinBorder;
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F5F5" } };
        if ((i === 4 || i === 5) && typeof v === "number") cell.numFmt = "0.00%";
        if (i >= 1 && i <= 3) cell.numFmt = "#,##0.00;[Red]-#,##0.00";
      });

      headers.forEach((label, i) => {
        sheet.getColumn(i + 1).width = Math.max(label.length + 4, 13);
      });

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Sales_Performance_${year}_${monthRange[0]}-${monthRange[1]}.xlsx`;
      link.click();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Error exporting to Excel:", error);
      message.error("Failed to export Excel file.");
    } finally {
      setExportLoading(false);
    }
  };

  const monthOptions = Array.from({ length: 12 }, (_, i) => ({
    value: i + 1,
    label: dayjs().month(i).format("MMM"),
  }));

  return (
    <Card
      title={
        <span>
          <LineChartOutlined style={{ marginRight: 8 }} />
          Sales Performance — Actual vs Budget
        </span>
      }
      extra={
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Select
            value={year}
            onChange={setYear}
            style={{ width: 100 }}
            options={(years.length ? years : [dayjs().year()]).map((y) => ({ value: y, label: String(y) }))}
          />
          <Select
            value={monthRange[0]}
            onChange={(v) => setMonthRange([v, Math.max(v, monthRange[1])])}
            style={{ width: 90 }}
            options={monthOptions}
          />
          <span style={{ color: "#8c8c8c" }}>→</span>
          <Select
            value={monthRange[1]}
            onChange={(v) => setMonthRange([Math.min(monthRange[0], v), v])}
            style={{ width: 90 }}
            options={monthOptions}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="All categories"
            value={categoryId}
            onChange={setCategoryId}
            style={{ width: 170 }}
            options={categories.map((c) => ({ value: c.category_id, label: c.name }))}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="All sales persons"
            value={salesPersonId}
            onChange={setSalesPersonId}
            style={{ width: 190 }}
            options={persons.map((p) => ({
              value: p.sales_person_id,
              label: p.team ? `${p.name} (${p.team})` : p.name,
            }))}
          />
          <Tooltip title="Refresh">
            <Button aria-label="Refresh" icon={<ReloadOutlined />} onClick={loadReport} />
          </Tooltip>
          {canExport && (
            <Tooltip title="Export Excel">
              <Button
                aria-label="Export Excel"
                icon={<FileExcelOutlined />}
                onClick={handleExportExcel}
                loading={exportLoading}
                disabled={months.length === 0}
                style={{ background: "#217346", borderColor: "#217346", color: "#fff" }}
              />
            </Tooltip>
          )}
        </div>
      }
    >
      <Spin spinning={loading}>
        {!data ? (
          <Empty description="No sales data for this selection." />
        ) : (
          <>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
              <MetricCard
                tint="actual"
                icon={<DollarOutlined />}
                label="TOTAL ACTUAL"
                value={money(period.actual / MONEY_UNIT)}
                unit="Sales (K)"
              />
              <MetricCard
                tint="budget"
                icon={<AimOutlined />}
                label="TOTAL BUDGET"
                value={money(period.budget / MONEY_UNIT)}
                unit="Sales (K)"
              />
              <MetricCard
                tint="variance"
                icon={period.variance >= 0 ? <RiseOutlined /> : <FallOutlined />}
                label="VARIANCE"
                value={money(period.variance / MONEY_UNIT)}
                unit="Sales (K)"
              />
              <MetricCard
                tint="achievement"
                icon={<BarChartOutlined />}
                label="ACHIEVEMENT"
                value={pct(period.achievement_pct)}
                unit="vs Budget"
              />
            </div>

            <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 380 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#051650", marginBottom: 6 }}>
                  ACTUAL SALES vs BUDGET SALES
                </div>
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, marginBottom: 4 }}>
                  <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#d9d9d9", marginRight: 5 }} />Budget Sales</span>
                  <span><span style={{ display: "inline-block", width: 10, height: 10, background: STATUS_COLOR.Above, marginRight: 5 }} />Above Budget</span>
                  <span><span style={{ display: "inline-block", width: 10, height: 10, background: STATUS_COLOR["On Target"], marginRight: 5 }} />On Target</span>
                  <span><span style={{ display: "inline-block", width: 10, height: 10, background: STATUS_COLOR.Below, marginRight: 5 }} />Below Budget</span>
                </div>
                <BudgetVsActualChart rows={months.map((m) => ({ ...m, actual: m.actual / MONEY_UNIT, budget: m.budget / MONEY_UNIT }))} />
              </div>

              <div
                style={{
                  width: 220,
                  border: "1px solid #f0f0f0",
                  borderRadius: 10,
                  padding: 14,
                  flexShrink: 0,
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 700, color: "#8c8c8c", marginBottom: 12 }}>
                  HIGHLIGHTS
                </div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ color: STATUS_COLOR.Above, fontWeight: 700, fontSize: 12 }}>
                    <RiseOutlined /> BEST MONTH
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{highlights?.best_month?.month_name ?? "--"}</div>
                  <div style={{ fontSize: 11, color: "#8c8c8c" }}>
                    {pct(highlights?.best_month?.achievement_pct)} of budget
                  </div>
                </div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ color: STATUS_COLOR.Below, fontWeight: 700, fontSize: 12 }}>
                    <FallOutlined /> LOWEST MONTH
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{highlights?.lowest_month?.month_name ?? "--"}</div>
                  <div style={{ fontSize: 11, color: "#8c8c8c" }}>
                    {pct(highlights?.lowest_month?.achievement_pct)} of budget
                  </div>
                </div>
                <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}>
                  <div style={{ color: "#1677ff", fontWeight: 700, fontSize: 12 }}>
                    <TrophyOutlined /> PERIOD ACHIEVEMENT
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "#051650" }}>
                    {pct(period.achievement_pct)}
                  </div>
                  <div style={{ fontSize: 11, color: "#8c8c8c" }}>{rangeLabel}</div>
                </div>
                <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12, marginTop: 12 }}>
                  {/* Annual always covers all 12 months, so narrowing the
                      month range does not quietly change the yearly view. */}
                  <div style={{ fontWeight: 700, fontSize: 12, color: "#8c8c8c" }}>FULL YEAR {year}</div>
                  <div style={{ fontSize: 12 }}>
                    Actual <strong>{money(annual.actual / MONEY_UNIT)}</strong> /
                    Budget <strong>{money(annual.budget / MONEY_UNIT)}</strong>
                  </div>
                  <div style={{ fontSize: 12 }}>
                    Achievement <strong>{pct(annual.achievement_pct)}</strong>{" "}
                    <Tag color={annual.status === "Above" ? "green" : annual.status === "On Target" ? "gold" : "red"}>
                      {annual.status}
                    </Tag>
                  </div>
                </div>
              </div>
            </div>

            <div style={{ overflowX: "auto", marginTop: 18 }}>
              <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
                <thead>
                  <tr>
                    {["Month", "Budget (K)", "Actual (K)", "Variance (K)", "Variance (%)", "Achievement (%)", "vs Target"].map(
                      (h) => (
                        <th
                          key={h}
                          style={{
                            border: "1px solid #d9d9d9",
                            padding: "8px 10px",
                            background: "#051650",
                            color: "#fff",
                            fontWeight: 600,
                            textAlign: "center",
                          }}
                        >
                          {h}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  {months.map((r) => (
                    <tr key={r.month}>
                      <td style={tdStyle()}>{r.month_short}</td>
                      <td style={tdStyle()}>{money(r.budget / MONEY_UNIT)}</td>
                      <td style={tdStyle()}>{money(r.actual / MONEY_UNIT)}</td>
                      <td style={{ ...tdStyle(), color: r.variance >= 0 ? STATUS_COLOR.Above : STATUS_COLOR.Below, fontWeight: 600 }}>
                        {money(r.variance / MONEY_UNIT)}
                      </td>
                      <td style={{ ...tdStyle(), color: (r.variance_pct ?? 0) >= 0 ? STATUS_COLOR.Above : STATUS_COLOR.Below }}>
                        {pct(r.variance_pct)}
                      </td>
                      <td style={{ ...tdStyle(), fontWeight: 600 }}>{pct(r.achievement_pct)}</td>
                      <td style={tdStyle()}>{statusTag(r.status)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td style={{ ...tdStyle(), background: "#051650", color: "#fff", fontWeight: 700 }}>Total</td>
                    <td style={{ ...tdStyle(), background: "#fafafa", fontWeight: 700 }}>{money(period.budget / MONEY_UNIT)}</td>
                    <td style={{ ...tdStyle(), background: "#fafafa", fontWeight: 700 }}>{money(period.actual / MONEY_UNIT)}</td>
                    <td
                      style={{
                        ...tdStyle(),
                        background: "#fafafa",
                        fontWeight: 700,
                        color: period.variance >= 0 ? STATUS_COLOR.Above : STATUS_COLOR.Below,
                      }}
                    >
                      {money(period.variance / MONEY_UNIT)}
                    </td>
                    <td style={{ ...tdStyle(), background: "#fafafa", fontWeight: 700 }}>{pct(period.variance_pct)}</td>
                    <td style={{ ...tdStyle(), background: "#fafafa", fontWeight: 700 }}>{pct(period.achievement_pct)}</td>
                    <td style={{ ...tdStyle(), background: "#fafafa", fontWeight: 700 }}>{statusTag(period.status)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}
      </Spin>
    </Card>
  );
}

const tdStyle = (): React.CSSProperties => ({
  border: "1px solid #d9d9d9",
  padding: "6px 10px",
  textAlign: "center",
  whiteSpace: "nowrap",
});
