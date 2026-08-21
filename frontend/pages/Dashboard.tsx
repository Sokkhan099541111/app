import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, Select, DatePicker, Button, Tooltip, Spin, notification } from "antd";
import {
  DashboardOutlined,
  ReloadOutlined,
  TruckOutlined,
  FundOutlined,
  TeamOutlined,
  CloseCircleFilled,
  CarOutlined,
  ScheduleOutlined,
  RiseOutlined,
  FallOutlined,
  DollarCircleOutlined,
  WalletOutlined,
  TrophyOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  WarningOutlined,
  ApartmentOutlined,
} from "@ant-design/icons";
import dayjs, { Dayjs } from "dayjs";

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

const money = (v: number | null | undefined) =>
  `$ ${Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

const shortMoney = (v: number) => {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
};

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "-" : `${v}%`);

const EXPENSE_COLORS = { repair: "#1677ff", engine_oil: "#faad14", diesel: "#f5222d" };

// Matches the exact category enum strings used by /vehicles/expenses so
// pie-slice clicks can deep-link straight to a pre-filtered list.
const EXPENSE_CATEGORY = {
  repair: "Repair Expenses / Maintenance Cost",
  engine_oil: "Engine Oil, Pump & Brake",
  diesel: "Diesel Fuel",
};

function darken(hex: string, amount = 0.35) {
  const c = hex.replace("#", "");
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  return `rgb(${Math.round(r * (1 - amount))}, ${Math.round(g * (1 - amount))}, ${Math.round(b * (1 - amount))})`;
}

function polarPoint(cx: number, cy: number, rx: number, ry: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + rx * Math.cos(rad), y: cy + ry * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, rx: number, ry: number, startAngle: number, endAngle: number) {
  const start = polarPoint(cx, cy, rx, ry, endAngle);
  const end = polarPoint(cx, cy, rx, ry, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? 0 : 1;
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${rx} ${ry} 0 ${largeArc} 0 ${end.x} ${end.y} Z`;
}

function MetricCard({
  icon,
  label,
  value,
  sub,
  valueColor,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  valueColor?: string;
  onClick?: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => onClick && setHover(true)}
      onMouseLeave={() => setHover(false)}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) onClick();
      }}
      style={{
        background: hover ? "#f0f5ff" : "#fafafa",
        border: hover ? "1px solid #adc6ff" : "1px solid #f0f0f0",
        borderRadius: 8,
        padding: "12px 16px",
        cursor: onClick ? "pointer" : "default",
        transition: "background 0.15s, border-color 0.15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#888", marginBottom: 4 }}>
        <span style={{ fontSize: 14, color: "#051650" }}>{icon}</span>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, color: valueColor || "#051650" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#aaa", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

/** Pseudo-3D pie chart -- an ellipse "cap" over a darker, vertically
 * offset "body" to fake the classic extruded-cylinder pie look. */
function Pie3DChart({
  data,
  height = 200,
  onSliceClick,
}: {
  data: { label: string; value: number; color: string; key?: string }[];
  height?: number;
  onSliceClick?: (key: string) => void;
}) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  if (total <= 0) {
    return <div style={{ color: "#999", fontSize: 13, textAlign: "center", padding: "40px 0" }}>No expense data for this range.</div>;
  }

  const width = 300;
  const cx = 120;
  const cy = 88;
  const rx = 95;
  const ry = 55;
  const depth = 16;

  let cumulative = 0;
  const slices = data
    .filter((d) => d.value > 0)
    .map((d) => {
      const startAngle = (cumulative / total) * 360;
      cumulative += d.value;
      const endAngle = (cumulative / total) * 360;
      return { ...d, startAngle, endAngle, sharePct: (d.value / total) * 100 };
    });

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {slices.map((s, i) => (
          <path
            key={`side-${i}`}
            d={arcPath(cx, cy + depth, rx, ry, s.startAngle, s.endAngle)}
            fill={darken(s.color)}
            style={{ cursor: onSliceClick ? "pointer" : "default" }}
            onClick={() => onSliceClick && s.key && onSliceClick(s.key)}
          />
        ))}
        {slices.map((s, i) => (
          <path
            key={`top-${i}`}
            d={arcPath(cx, cy, rx, ry, s.startAngle, s.endAngle)}
            fill={s.color}
            stroke="#fff"
            strokeWidth={1.5}
            style={{ cursor: onSliceClick ? "pointer" : "default" }}
            onClick={() => onSliceClick && s.key && onSliceClick(s.key)}
          />
        ))}
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 160 }}>
        {slices.map((s, i) => (
          <div
            key={i}
            onClick={() => onSliceClick && s.key && onSliceClick(s.key)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              cursor: onSliceClick ? "pointer" : "default",
            }}
          >
            <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color, display: "inline-block", flexShrink: 0 }} />
            <span style={{ color: "#666", flex: 1 }}>{s.label}</span>
            <span style={{ fontWeight: 600 }}>{money(s.value)}</span>
            <span style={{ color: "#999", fontSize: 11, minWidth: 40, textAlign: "right" }}>{s.sharePct.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Bar chart (one or more series per month) with gridlines, a zero
 * baseline, and the actual value printed above/below every bar. */
function BarChart({
  labels,
  series,
  height = 240,
  onGroupClick,
}: {
  labels: string[];
  series: { name: string; color: string; values: number[] }[];
  height?: number;
  onGroupClick?: (index: number) => void;
}) {
  const barWidth = 18;
  const barGap = 6;
  const groupGap = 26;
  const leftPad = 54;
  const rightPad = 16;
  const topPad = 22;
  const bottomPad = 30;

  const groupWidth = series.length * barWidth + (series.length - 1) * barGap;
  const width = Math.max(360, leftPad + rightPad + labels.length * (groupWidth + groupGap));

  const allValues = series.flatMap((s) => s.values);
  const maxVal = Math.max(0, ...allValues);
  const minVal = Math.min(0, ...allValues);
  const plotH = height - topPad - bottomPad;
  const span = maxVal - minVal || 1;
  const yFor = (v: number) => topPad + plotH - ((v - minVal) / span) * plotH;
  const zeroY = yFor(0);

  const gridCount = 4;
  const gridValues = Array.from({ length: gridCount + 1 }, (_, i) => minVal + (i * span) / gridCount);

  return (
    <div style={{ overflowX: "auto" }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ minWidth: "100%" }}>
        {gridValues.map((gv, i) => {
          const y = yFor(gv);
          return (
            <g key={i}>
              <line x1={leftPad} y1={y} x2={width - rightPad} y2={y} stroke="#f0f0f0" strokeWidth={1} />
              <text x={leftPad - 8} y={y + 3} fontSize={9} textAnchor="end" fill="#999">
                {shortMoney(gv)}
              </text>
            </g>
          );
        })}
        {labels.map((label, gi) => {
          const groupX = leftPad + gi * (groupWidth + groupGap);
          return (
            <g
              key={label}
              style={{ cursor: onGroupClick ? "pointer" : "default" }}
              onClick={() => onGroupClick && onGroupClick(gi)}
            >
              <rect
                x={groupX - groupGap / 2 + 2}
                y={topPad}
                width={groupWidth + groupGap - 4}
                height={plotH}
                fill="transparent"
              />
              {series.map((s, si) => {
                const v = s.values[gi] ?? 0;
                const x = groupX + si * (barWidth + barGap);
                const y1 = yFor(v);
                const barY = Math.min(zeroY, y1);
                const barH = Math.max(Math.abs(y1 - zeroY), 1);
                const labelY = v >= 0 ? barY - 5 : barY + barH + 11;
                return (
                  <g key={s.name}>
                    <rect x={x} y={barY} width={barWidth} height={barH} fill={s.color} rx={2} />
                    <text x={x + barWidth / 2} y={labelY} fontSize={8.5} textAnchor="middle" fill="#666">
                      {shortMoney(v)}
                    </text>
                  </g>
                );
              })}
              <text x={groupX + groupWidth / 2} y={height - 8} fontSize={10} textAnchor="middle" fill="#888">
                {label}
              </text>
            </g>
          );
        })}
        <line x1={leftPad} y1={zeroY} x2={width - rightPad} y2={zeroY} stroke="#d9d9d9" strokeWidth={1} />
      </svg>
      <div style={{ display: "flex", gap: 16, marginTop: 8, paddingLeft: leftPad, flexWrap: "wrap" }}>
        {series.map((s) => (
          <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#666" }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color, display: "inline-block" }} />
            {s.name}
          </div>
        ))}
      </div>
    </div>
  );
}

const RENTAL_STATUS_ROWS = [
  { key: "working" as const, label: "Working", color: "#389e0d", icon: <CheckCircleOutlined /> },
  { key: "standby" as const, label: "On standby", color: "#d48806", icon: <ClockCircleOutlined /> },
  { key: "broken" as const, label: "Broken", color: "#cf1322", icon: <WarningOutlined /> },
];

export default function Dashboard() {
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [departments, setDepartments] = useState<any[]>([]);
  const [filterRange, setFilterRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf("month"), dayjs()]);
  const [filterDepartment, setFilterDepartment] = useState<number | undefined>(undefined);

  useEffect(() => {
    loadDepartments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterRange, filterDepartment]);

  const loadDepartments = async () => {
    try {
      const response = await fetch("/api/departments");
      if (!response.ok) return;
      const result = await response.json();
      setDepartments(Array.isArray(result.data) ? result.data : []);
    } catch {
      // Non-critical -- the department filter just stays empty.
    }
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.append("start_date", filterRange[0].format("YYYY-MM-DD"));
      params.append("end_date", filterRange[1].format("YYYY-MM-DD"));
      if (filterDepartment !== undefined) params.append("department_id", String(filterDepartment));
      const response = await fetch(`/api/dashboard/summary?${params}`);
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      const result = await response.json();
      setData(result);
    } catch (error: any) {
      console.error("Error loading dashboard:", error);
      notifyError("Couldn't load the dashboard", error.message);
    } finally {
      setLoading(false);
    }
  };

  const expensePieData = useMemo(() => {
    if (!data) return [];
    const b = data.monthly.expense_breakdown;
    return [
      { label: "Repair & maintenance", value: b.repair, color: EXPENSE_COLORS.repair, key: "repair" },
      { label: "Engine oil & brake", value: b.engine_oil, color: EXPENSE_COLORS.engine_oil, key: "engine_oil" },
      { label: "Diesel fuel", value: b.diesel, color: EXPENSE_COLORS.diesel, key: "diesel" },
    ];
  }, [data]);

  // Latest calendar month covered by the selected date range -- used to
  // deep-link period-level cards into single-month report pages.
  const latestMonth = useMemo(() => {
    const months = data?.trends?.months;
    if (!Array.isArray(months) || months.length === 0) return null;
    const [year, month] = months[months.length - 1];
    return { year, month };
  }, [data]);

  const rangeParams = () => ({
    start_date: filterRange[0].format("YYYY-MM-DD"),
    end_date: filterRange[1].format("YYYY-MM-DD"),
  });

  const goToFinancialReport = () => {
    if (!latestMonth) return;
    navigate(`/vehicles/financial-report?year=${latestMonth.year}&month=${latestMonth.month}`);
  };

  const goToExpenses = (category?: string) => {
    const { start_date, end_date } = rangeParams();
    const params = new URLSearchParams({ start_date, end_date });
    if (category) params.append("category", category);
    navigate(`/vehicles/expenses?${params}`);
  };

  const goToPayslipReport = () => {
    const { start_date, end_date } = rangeParams();
    navigate(`/payroll/report?${new URLSearchParams({ start_date, end_date })}`);
  };

  const goToPayslipReportForMonth = (year: number, month: number) => {
    const start = dayjs(`${year}-${String(month).padStart(2, "0")}-01`);
    navigate(
      `/payroll/report?${new URLSearchParams({
        start_date: start.startOf("month").format("YYYY-MM-DD"),
        end_date: start.endOf("month").format("YYYY-MM-DD"),
      })}`
    );
  };

  const goToAttendanceReport = () => {
    if (!latestMonth) return;
    navigate(`/payroll/attendance-report?year=${latestMonth.year}&month=${latestMonth.month}`);
  };

  return (
    <Card>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 16,
          marginBottom: 16,
          padding: 12,
          background: "#fafafa",
          border: "1px solid #f0f0f0",
          borderRadius: 8,
        }}
      >
        <span style={{ fontSize: 16, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
          <DashboardOutlined style={{ marginRight: 8 }} />
          Dashboard
        </span>
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, marginLeft: "auto" }}>
          <Select
            allowClear
            placeholder="All departments"
            style={{ width: 180 }}
            value={filterDepartment}
            onChange={(value) => setFilterDepartment(value)}
            options={departments.map((d) => ({ label: d.name, value: d.department_id }))}
          />
          <RangePicker
            allowClear={false}
            value={filterRange}
            onChange={(values) => {
              if (values && values[0] && values[1]) setFilterRange([values[0], values[1]]);
            }}
          />
          <Tooltip title="Refresh">
            <Button aria-label="Refresh" icon={<ReloadOutlined />} onClick={loadData} />
          </Tooltip>
        </div>
      </div>

      {loading && !data ? (
        <div style={{ textAlign: "center", padding: 60 }}>
          <Spin size="large" />
        </div>
      ) : !data ? null : (
        <Spin spinning={loading}>
          {/* Top KPI strip */}
          <div style={{ marginBottom: 8, fontSize: 12, color: "#999", fontWeight: 600 }}>TODAY</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 20 }}>
            <MetricCard
              icon={<CarOutlined />}
              label="Vehicles logged today"
              value={`${data.daily.vehicles_logged_today} / ${data.monthly.vehicle_count}`}
              sub={data.daily.date}
              onClick={() => navigate("/daily-activities")}
            />
            <MetricCard
              icon={<ScheduleOutlined />}
              label="Today's attendance rate"
              value={pct(data.daily.today_attendance_rate_pct)}
              onClick={() => navigate("/payroll/attendance")}
            />
          </div>

          <div style={{ marginBottom: 8, fontSize: 12, color: "#999", fontWeight: 600 }}>
            {data.period.label.toUpperCase()}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 24 }}>
            <MetricCard icon={<RiseOutlined />} label="Revenue" value={money(data.monthly.total_revenue)} onClick={goToFinancialReport} />
            <MetricCard icon={<FallOutlined />} label="Expenses" value={money(data.monthly.total_expenses)} onClick={() => goToExpenses()} />
            <MetricCard
              icon={<DollarCircleOutlined />}
              label="Profit"
              value={money(data.monthly.total_profit)}
              valueColor={data.monthly.total_profit >= 0 ? "#389e0d" : "#cf1322"}
              onClick={goToFinancialReport}
            />
            <MetricCard icon={<WalletOutlined />} label="Payroll cost" value={money(data.monthly.payroll_cost)} onClick={goToPayslipReport} />
            <MetricCard
              icon={<TrophyOutlined />}
              label="Avg KPI achievement"
              value={pct(data.monthly.avg_kpi_achievement_pct)}
              onClick={goToFinancialReport}
            />
            <MetricCard
              icon={<TeamOutlined />}
              label="Active headcount"
              value={String(data.workforce.active_headcount)}
              onClick={() => navigate("/employees")}
            />
            <MetricCard
              icon={<CalendarOutlined />}
              label="Attendance rate"
              value={pct(data.workforce.attendance_rate_pct)}
              onClick={goToAttendanceReport}
            />
          </div>

          {/* Fleet Operations + Financial Performance */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
            <Card
              size="small"
              title={
                <span>
                  <TruckOutlined style={{ marginRight: 8 }} />
                  Fleet operations
                </span>
              }
            >
              <div style={{ fontSize: 12, color: "#888", marginBottom: 10 }}>Expense mix</div>
              <Pie3DChart
                data={expensePieData}
                onSliceClick={(key) => {
                  const category = (EXPENSE_CATEGORY as Record<string, string>)[key];
                  goToExpenses(category);
                }}
              />

              <div style={{ fontSize: 12, color: "#888", margin: "20px 0 10px" }}>Rental fleet status (current)</div>
              <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
                <div
                  style={{ textAlign: "center", flexShrink: 0, cursor: "pointer" }}
                  onClick={() => navigate("/vehicles/rentals")}
                >
                  <div style={{ fontSize: 30, fontWeight: 700, color: "#051650" }}>{data.rental_fleet.total_active_rentals}</div>
                  <div style={{ fontSize: 11, color: "#999", whiteSpace: "nowrap" }}>Total rental vehicles</div>
                </div>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
                  {RENTAL_STATUS_ROWS.map((row) => {
                    const count = data.rental_fleet.current_status_counts[row.key];
                    const widthPct =
                      data.rental_fleet.total_active_rentals > 0 ? (count / data.rental_fleet.total_active_rentals) * 100 : 0;
                    return (
                      <div key={row.key}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
                          <span style={{ display: "flex", alignItems: "center", gap: 5, color: row.color }}>
                            {row.icon}
                            {row.label}
                          </span>
                          <span style={{ fontWeight: 600 }}>{count}</span>
                        </div>
                        <div style={{ background: "#f0f0f0", borderRadius: 4, height: 7 }}>
                          <div style={{ width: `${widthPct}%`, background: row.color, height: 7, borderRadius: 4 }} />
                        </div>
                      </div>
                    );
                  })}
                  {data.rental_fleet.current_status_counts.unmarked > 0 && (
                    <div style={{ fontSize: 11, color: "#999" }}>
                      {data.rental_fleet.current_status_counts.unmarked} not marked yet
                    </div>
                  )}
                </div>
              </div>
            </Card>

            <Card
              size="small"
              title={
                <span>
                  <FundOutlined style={{ marginRight: 8 }} />
                  Revenue vs expenses vs profit
                </span>
              }
            >
              <BarChart
                labels={data.trends.labels}
                series={[
                  { name: "Revenue", color: "#1677ff", values: data.trends.revenue },
                  { name: "Expenses", color: "#fa8c16", values: data.trends.expenses },
                  { name: "Profit", color: "#52c41a", values: data.trends.profit },
                ]}
                onGroupClick={(i) => {
                  const point = data.trends.months?.[i];
                  if (point) navigate(`/vehicles/financial-report?year=${point[0]}&month=${point[1]}`);
                }}
              />
            </Card>
          </div>

          {/* Workforce & Payroll */}
          <Card
            size="small"
            title={
              <span>
                <TeamOutlined style={{ marginRight: 8 }} />
                Workforce & payroll
              </span>
            }
          >
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 24 }}>
              <div>
                <div style={{ fontSize: 12, color: "#888", marginBottom: 10 }}>Headcount by department</div>
                {data.workforce.headcount_by_department.map((d: any) => {
                  const max = Math.max(1, ...data.workforce.headcount_by_department.map((x: any) => x.headcount));
                  return (
                    <div key={d.department} style={{ marginBottom: 8 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
                        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <ApartmentOutlined style={{ color: "#051650" }} />
                          {d.department}
                        </span>
                        <span style={{ fontWeight: 600 }}>{d.headcount}</span>
                      </div>
                      <div style={{ background: "#f0f0f0", borderRadius: 4, height: 8 }}>
                        <div style={{ width: `${(d.headcount / max) * 100}%`, background: "#051650", height: 8, borderRadius: 4 }} />
                      </div>
                    </div>
                  );
                })}

                {data.workforce.period_statuses.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <div style={{ fontSize: 12, color: "#888", marginBottom: 6 }}>Payroll period status</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {data.workforce.period_statuses.map((p: any) => (
                        <span
                          key={p.label}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            fontSize: 11,
                            padding: "2px 8px",
                            borderRadius: 10,
                            background: p.status === "Open" ? "#fff7e6" : "#f6ffed",
                            color: p.status === "Open" ? "#d48806" : "#389e0d",
                          }}
                        >
                          <CalendarOutlined />
                          {p.label}: {p.status}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div>
                <div style={{ fontSize: 12, color: "#888", marginBottom: 6 }}>Payroll cost trend</div>
                <BarChart
                  height={220}
                  labels={data.trends.labels}
                  series={[{ name: "Payroll cost", color: "#722ed1", values: data.trends.payroll_cost }]}
                  onGroupClick={(i) => {
                    const point = data.trends.months?.[i];
                    if (point) goToPayslipReportForMonth(point[0], point[1]);
                  }}
                />
              </div>
            </div>
          </Card>
        </Spin>
      )}
    </Card>
  );
}
