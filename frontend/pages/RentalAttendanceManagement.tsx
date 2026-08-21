import { useEffect, useMemo, useState } from "react";
import { Card, Space, Select, Spin, Tag, Tooltip, notification, DatePicker } from "antd";
import { CheckCircleFilled, CloseCircleFilled, CarOutlined } from "@ant-design/icons";
import { useAuth } from "../src/context/AuthContext";
import dayjs, { Dayjs } from "dayjs";

const notifyError = (title: string, description?: string) =>
  notification.error({
    message: title,
    description,
    icon: <CloseCircleFilled style={{ color: "#ff4d4f" }} />,
    placement: "topRight",
    duration: 4.5,
    style: { borderRadius: 10 },
  });

// Click cycle: unmarked -> Working -> On Standby -> Broken -> unmarked
const CYCLE = ["Working", "On Standby", "Broken"] as const;
type StatusCode = (typeof CYCLE)[number];

const STATUS_META: Record<StatusCode, { label: string; color: string; bg: string }> = {
  Working: { label: "W", color: "#ffffff", bg: "#22c55e" },
  "On Standby": { label: "S", color: "#ffffff", bg: "#3b82f6" },
  Broken: { label: "B", color: "#ffffff", bg: "#ff4d4f" },
};

export default function RentalAttendanceManagement() {
  const { can } = useAuth();
  const canEdit = can("rental-attendance", "edit");
  const [rentals, setRentals] = useState<any[]>([]);
  const [rentalId, setRentalId] = useState<number | undefined>(undefined);
  const [month, setMonth] = useState<Dayjs>(dayjs().startOf("month"));
  const [attendanceRows, setAttendanceRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [rentalsLoading, setRentalsLoading] = useState(false);
  const [busyDate, setBusyDate] = useState<string | null>(null);

  useEffect(() => {
    loadRentals();
  }, []);

  useEffect(() => {
    if (rentalId != null) {
      loadAttendance();
    } else {
      setAttendanceRows([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rentalId, month]);

  const loadRentals = async () => {
    setRentalsLoading(true);
    try {
      const response = await fetch("/api/vehicle-rentals?status=Active");
      if (!response.ok) throw new Error(`Failed to fetch rental vehicles: ${response.statusText}`);
      const result = await response.json();
      setRentals(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading rental vehicles:", error);
      notifyError("Couldn't load rental vehicles", error.message);
    } finally {
      setRentalsLoading(false);
    }
  };

  const loadAttendance = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        rental_id: String(rentalId),
        year: String(month.year()),
        month: String(month.month() + 1),
      });
      const response = await fetch(`/api/vehicle-rental-attendance?${params}`);
      if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
      const result = await response.json();
      setAttendanceRows(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading rental attendance:", error);
      notifyError("Couldn't load rental attendance", error.message);
    } finally {
      setLoading(false);
    }
  };

  const selectedRental = useMemo(
    () => rentals.find((r) => r.rental_id === rentalId),
    [rentals, rentalId]
  );

  const arrivalDate = selectedRental?.arrival_date ? dayjs(selectedRental.arrival_date) : null;

  const rentalOptions = useMemo(
    () =>
      rentals.map((r) => ({
        value: r.rental_id,
        label: r.plate_number || r.code || `#${r.vehicles_id}`,
      })),
    [rentals]
  );

  const days = useMemo(() => {
    const daysInMonth = month.daysInMonth();
    return Array.from({ length: daysInMonth }, (_, i) => month.date(i + 1).format("YYYY-MM-DD"));
  }, [month]);

  const rowByDate = useMemo(() => {
    const map = new Map<string, any>();
    for (const r of attendanceRows) {
      map.set(dayjs(r.work_date).format("YYYY-MM-DD"), r);
    }
    return map;
  }, [attendanceRows]);

  const totals = useMemo(() => {
    const working = attendanceRows.filter((r) => r.status === "Working").length;
    const standby = attendanceRows.filter((r) => r.status === "On Standby").length;
    const broken = attendanceRows.filter((r) => r.status === "Broken").length;
    return { working, standby, broken };
  }, [attendanceRows]);

  const handleDayClick = async (workDate: string) => {
    if (!canEdit) return;  // view-only: grid is read-only
    if (rentalId == null || busyDate) return;
    if (arrivalDate && dayjs(workDate).isBefore(arrivalDate, "day")) return;
    const existing = rowByDate.get(workDate);
    setBusyDate(workDate);
    try {
      if (!existing) {
        const response = await fetch("/api/vehicle-rental-attendance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rental_id: rentalId, work_date: workDate, status: "Working" }),
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
        const response = await fetch(`/api/vehicle-rental-attendance/${existing.attendance_id}`, {
          method: "DELETE",
        });
        if (!response.ok) {
          const errBody = await response.json().catch(() => ({}));
          throw new Error(errBody.detail || response.statusText);
        }
        setAttendanceRows((prev) => prev.filter((r) => r.attendance_id !== existing.attendance_id));
        return;
      }

      const nextStatus = CYCLE[currentIndex + 1];
      const response = await fetch(`/api/vehicle-rental-attendance/${existing.attendance_id}`, {
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
      console.error("Error updating rental attendance:", error);
      notifyError("Couldn't update attendance", error.message);
    } finally {
      setBusyDate(null);
    }
  };

  return (
    <Card
      title={
        <span>
          <CarOutlined style={{ marginRight: 8 }} />
          Rental Attendance Entry
        </span>
      }
      extra={
        <Space>
          <Select
            showSearch
            allowClear
            placeholder={rentalsLoading ? "Loading vehicles..." : "Select a rental vehicle..."}
            optionFilterProp="label"
            style={{ width: 260 }}
            value={rentalId}
            onChange={setRentalId}
            options={rentalOptions}
            loading={rentalsLoading}
            disabled={rentalsLoading}
          />
          <DatePicker
            picker="month"
            format="MMMM YYYY"
            allowClear={false}
            value={month}
            onChange={(value) => value && setMonth(value.startOf("month"))}
          />
        </Space>
      }
    >
      {rentalId == null ? (
        <div style={{ padding: 40, textAlign: "center", color: "#999" }}>
          Select a rental vehicle and a month to mark daily status.
        </div>
      ) : (
        <Spin spinning={loading}>
          <div style={{ marginBottom: 16 }}>
            <Space size="middle">
              <Tag color="green">W Working</Tag>
              <Tag color="blue">S On Standby</Tag>
              <Tag color="red">B Broken</Tag>
              <span style={{ color: "#666" }}>Click a day to cycle Working → On Standby → Broken → unmarked</span>
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
              const isBeforeArrival = arrivalDate ? dayjs(d).isBefore(arrivalDate, "day") : false;
              return (
                <Tooltip
                  key={d}
                  title={isBeforeArrival ? `Before arrival date (${arrivalDate!.format("DD MMM YYYY")})` : d}
                >
                  <div
                    onClick={() => canEdit && !isBeforeArrival && handleDayClick(d)}
                    style={{
                      height: 56,
                      borderRadius: 8,
                      border: "1px solid #e5e7eb",
                      background: isBeforeArrival ? "#f0f0f0" : meta ? meta.bg : "#fafafa",
                      color: isBeforeArrival ? "#bbb" : meta ? meta.color : "#999",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: !canEdit || isBeforeArrival ? "not-allowed" : isBusy ? "wait" : "pointer",
                      opacity: isBusy ? 0.6 : isBeforeArrival ? 0.7 : 1,
                      userSelect: "none",
                      fontWeight: 600,
                    }}
                  >
                    <div style={{ fontSize: 11, opacity: 0.85 }}>{dayjs(d).format("DD")}</div>
                    <div style={{ fontSize: 14 }}>{meta ? meta.label : "-"}</div>
                  </div>
                </Tooltip>
              );
            })}
          </div>
          <div style={{ marginTop: 16, color: "#666" }}>
            <CheckCircleFilled style={{ color: "#22c55e", marginRight: 6 }} />
            Working: <strong>{totals.working}</strong> &nbsp;|&nbsp; On Standby: <strong>{totals.standby}</strong> &nbsp;|&nbsp;
            Broken: <strong>{totals.broken}</strong> &nbsp;/ {days.length} days
          </div>
        </Spin>
      )}
    </Card>
  );
}
