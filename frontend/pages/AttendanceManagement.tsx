import { useEffect, useMemo, useState } from "react";
import { Card, Space, Select, Spin, Tag, Tooltip, notification } from "antd";
import { CheckCircleFilled, CloseCircleFilled, CalendarOutlined } from "@ant-design/icons";
import { useAuth } from "../src/context/AuthContext";
import { useSearchParams } from "react-router-dom";
import dayjs from "dayjs";

const notifyError = (title: string, description?: string) =>
  notification.error({
    message: title,
    description,
    icon: <CloseCircleFilled style={{ color: "#ff4d4f" }} />,
    placement: "topRight",
    duration: 4.5,
    style: { borderRadius: 10 },
  });

// Click cycle: unmarked -> Present -> Absent -> Leave -> Holiday -> unmarked
// (matches the Payroll Admin prototype's ATT_CYCLE ordering)
const CYCLE = ["1", "0", "L", "H"] as const;
type StatusCode = (typeof CYCLE)[number];

const STATUS_META: Record<StatusCode, { label: string; color: string; bg: string }> = {
  "1": { label: "P", color: "#ffffff", bg: "#22c55e" },
  "0": { label: "A", color: "#ffffff", bg: "#ff4d4f" },
  H: { label: "H", color: "#ffffff", bg: "#3b82f6" },
  L: { label: "L", color: "#ffffff", bg: "#f59e0b" },
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

export default function AttendanceManagement() {
  const { can } = useAuth();
  const canEdit = can("payroll-attendance", "edit");
  const [searchParams] = useSearchParams();
  const [employees, setEmployees] = useState<any[]>([]);
  const [periods, setPeriods] = useState<any[]>([]);
  const [employeeId, setEmployeeId] = useState<number | undefined>(undefined);
  const [periodId, setPeriodId] = useState<number | undefined>(undefined);
  const [attendanceRows, setAttendanceRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyDate, setBusyDate] = useState<string | null>(null);

  useEffect(() => {
    // Deep-link support: /payroll/attendance?employee_id=..&period_id=..
    // (e.g. clicking an employee's name on the Payroll Worker by Month page).
    const empParam = searchParams.get("employee_id");
    const periodParam = searchParams.get("period_id");
    if (empParam) setEmployeeId(Number(empParam));
    if (periodParam) setPeriodId(Number(periodParam));

    loadEmployees();
    loadPeriods();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (employeeId != null && periodId != null) {
      loadAttendance();
    } else {
      setAttendanceRows([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, periodId]);

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

      // Default to the current month's period, if one exists.
      const now = dayjs();
      const currentPeriod = loadedPeriods.find(
        (p: any) => p.period_year === now.year() && p.period_month === now.month() + 1
      );
      if (currentPeriod) {
        setPeriodId((prev) => prev ?? currentPeriod.payroll_period_id);
      }
    } catch (error: any) {
      console.error("Error loading payroll periods:", error);
      notifyError("Couldn't load payroll periods", error.message);
    }
  };

  const loadAttendance = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        employee_id: String(employeeId),
        payroll_period_id: String(periodId),
      });
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

  const selectedPeriod = useMemo(
    () => periods.find((p) => p.payroll_period_id === periodId),
    [periods, periodId]
  );

  // Current/past periods show every employee (so history for employees who
  // later left stays visible). A period later than the current month only
  // shows Active employees, since inactive/terminated staff shouldn't be
  // marked for months that haven't happened yet.
  const isFuturePeriod = useMemo(() => {
    if (!selectedPeriod) return false;
    const now = dayjs();
    const periodKey = selectedPeriod.period_year * 12 + selectedPeriod.period_month;
    const currentKey = now.year() * 12 + (now.month() + 1);
    return periodKey > currentKey;
  }, [selectedPeriod]);

  const employeeOptions = useMemo(
    () =>
      (isFuturePeriod ? employees.filter((e) => e.employment_status === "Active") : employees).map(
        (e) => ({ label: e.full_name, value: e.employee_id })
      ),
    [employees, isFuturePeriod]
  );

  // If the currently selected employee drops out of the list (e.g. they
  // aren't Active and the period just became a future one), clear the
  // selection instead of silently keeping an option that's no longer shown.
  // Skip this check until employees have actually loaded -- otherwise a
  // deep-linked employee_id (e.g. from the Payroll Worker by Month page)
  // gets wiped out by this effect before the employee list ever arrives.
  useEffect(() => {
    if (employees.length === 0) return;
    if (employeeId != null && !employeeOptions.some((o) => o.value === employeeId)) {
      setEmployeeId(undefined);
    }
  }, [employeeId, employeeOptions, employees.length]);

  const days = useMemo(() => {
    if (!selectedPeriod) return [];
    const start = dayjs(selectedPeriod.start_date);
    const end = dayjs(selectedPeriod.end_date);
    const list: string[] = [];
    let cur = start;
    while (cur.isBefore(end) || cur.isSame(end, "day")) {
      list.push(cur.format("YYYY-MM-DD"));
      cur = cur.add(1, "day");
    }
    return list;
  }, [selectedPeriod]);

  const rowByDate = useMemo(() => {
    const map = new Map<string, any>();
    for (const r of attendanceRows) {
      map.set(dayjs(r.work_date).format("YYYY-MM-DD"), r);
    }
    return map;
  }, [attendanceRows]);

  const presentCount = attendanceRows.filter((r) => r.status === "1" || r.status === "H").length;

  const handleDayClick = async (workDate: string) => {
    if (!canEdit) return;  // view-only: grid is read-only
    if (employeeId == null || periodId == null || busyDate) return;
    if (dayjs(workDate).isAfter(dayjs(), "day")) return; // can't mark attendance for a day that hasn't happened yet
    const existing = rowByDate.get(workDate);
    setBusyDate(workDate);
    try {
      if (!existing) {
        // unmarked -> Present
        const response = await fetch("/api/attendance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            employee_id: employeeId,
            payroll_period_id: periodId,
            work_date: workDate,
            status: "1",
          }),
        });
        if (!response.ok) {
          const errBody = await response.json().catch(() => ({}));
          throw new Error(errBody.detail || response.statusText);
        }
        const result = await response.json();
        setAttendanceRows((prev) => [...prev, result.data]);
        return;
      }

      const currentIndex = CYCLE.indexOf(existing.status as StatusCode);
      const isLastInCycle = currentIndex === CYCLE.length - 1;

      if (isLastInCycle) {
        // Leave -> unmarked: delete the row
        const response = await fetch(`/api/attendance/${existing.attendance_id}`, { method: "DELETE" });
        if (!response.ok) {
          const errBody = await response.json().catch(() => ({}));
          throw new Error(errBody.detail || response.statusText);
        }
        setAttendanceRows((prev) => prev.filter((r) => r.attendance_id !== existing.attendance_id));
        return;
      }

      const nextStatus = CYCLE[currentIndex + 1];
      const response = await fetch(`/api/attendance/${existing.attendance_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      const result = await response.json();
      setAttendanceRows((prev) =>
        prev.map((r) => (r.attendance_id === existing.attendance_id ? result.data : r))
      );
    } catch (error: any) {
      console.error("Error updating attendance:", error);
      notifyError("Couldn't update attendance", error.message);
    } finally {
      setBusyDate(null);
    }
  };

  return (
    <Card
      title={
        <span>
          <CalendarOutlined style={{ marginRight: 8 }} />
          Attendance Entry
        </span>
      }
      extra={
        <Space>
          <Select
            showSearch
            allowClear
            placeholder="Select an employee..."
            optionFilterProp="label"
            style={{ width: 220 }}
            value={employeeId}
            onChange={setEmployeeId}
            options={employeeOptions}
          />
          <Select
            allowClear
            placeholder="Select a period..."
            style={{ width: 180 }}
            value={periodId}
            onChange={setPeriodId}
            options={periods.map((p) => ({
              label: `${MONTH_NAMES[p.period_month - 1] ?? p.period_month} ${p.period_year}`,
              value: p.payroll_period_id,
            }))}
          />
        </Space>
      }
    >
      {employeeId == null || periodId == null ? (
        <div style={{ padding: 40, textAlign: "center", color: "#999" }}>
          Select an employee and a payroll period to mark attendance.
        </div>
      ) : (
        <Spin spinning={loading}>
          <div style={{ marginBottom: 16 }}>
            <Space size="middle">
              <Tag color="green">P Present</Tag>
              <Tag color="red">A Absent</Tag>
              <Tag color="orange">L Leave</Tag>
              <Tag color="blue">H Holiday</Tag>
              <span style={{ color: "#666" }}>Click a day to cycle Present → Absent → Leave → Holiday → unmarked</span>
            </Space>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, 1fr)",
              gap: 8,
              maxWidth: 700,
            }}
          >
            {days.map((d) => {
              const row = rowByDate.get(d);
              const meta = row ? STATUS_META[row.status as StatusCode] : undefined;
              const isBusy = busyDate === d;
              const isFuture = dayjs(d).isAfter(dayjs(), "day");
              return (
                <Tooltip key={d} title={isFuture ? `${d} -- can't mark attendance before the date arrives` : d}>
                  <div
                    onClick={() => canEdit && handleDayClick(d)}
                    style={{
                      height: 56,
                      borderRadius: 8,
                      border: "1px solid #e5e7eb",
                      background: isFuture ? "#f5f5f5" : meta ? meta.bg : "#fafafa",
                      color: isFuture ? "#ccc" : meta ? meta.color : "#999",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: !canEdit || isFuture ? "not-allowed" : isBusy ? "wait" : "pointer",
                      opacity: isFuture ? 0.6 : isBusy ? 0.6 : 1,
                      userSelect: "none",
                      fontWeight: 600,
                    }}
                  >
                    <div style={{ fontSize: 11, opacity: 0.85 }}>{dayjs(d).format("DD")}</div>
                    <div style={{ fontSize: 14 }}>{isFuture ? "" : meta ? meta.label : "-"}</div>
                  </div>
                </Tooltip>
              );
            })}
          </div>
          <div style={{ marginTop: 16, color: "#666" }}>
            <CheckCircleFilled style={{ color: "#22c55e", marginRight: 6 }} />
            Total Attended (Present + Holiday): <strong>{presentCount}</strong> / {days.length} days
          </div>
        </Spin>
      )}
    </Card>
  );
}
