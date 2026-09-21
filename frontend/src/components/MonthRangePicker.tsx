import { DatePicker } from "antd";
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";

const { RangePicker } = DatePicker;

/**
 * The shared period filter used by the report screens, so every module
 * looks and behaves the same way.
 *
 * WHY A CONSTRAINED RANGE:
 * The Financial & KPI Report, Rental Expense Report and Payroll Worksheet
 * are monthly by construction -- vehicle_monthly_kpi is stored per
 * year+month, rental cost is (monthly rent / days in month) x days on
 * site, and payroll salary and working-days come from one payroll period.
 * Letting a range span several months, or start mid-month, would silently
 * produce figures that look plausible but are wrong.
 *
 * So this shows a start-end range (matching the other filters visually,
 * and making the covered period explicit as requested) while snapping the
 * selection to whole months. Picking any day in a month selects that
 * entire month.
 *
 * Daily KPI Entry uses a plain RangePicker instead -- its rows are
 * individual dated entries, so an arbitrary range is meaningful there.
 */
export default function MonthRangePicker({
  month,
  onChange,
  allowClear = false,
  style,
}: {
  /** Any day inside the selected month. */
  month: Dayjs;
  /** Receives the first day of the newly selected month. */
  onChange: (firstOfMonth: Dayjs) => void;
  allowClear?: boolean;
  style?: React.CSSProperties;
}) {
  const start = month.startOf("month");
  const end = month.endOf("month");

  return (
    <RangePicker
      value={[start, end]}
      format="DD-MMM-YYYY"
      allowClear={allowClear}
      style={{ width: 260, ...style }}
      // Snap to whole months: whichever end the user picks, take its month.
      onChange={(values) => {
        const picked = values?.[0] ?? values?.[1];
        if (picked) onChange(picked.startOf("month"));
      }}
      // Both ends move together, so editing either one selects that month.
      onCalendarChange={(values) => {
        const picked = values?.[0] ?? values?.[1];
        if (picked) onChange(picked.startOf("month"));
      }}
    />
  );
}

/** Today, for the modules that default to the current day. */
export const todayRange = (): [Dayjs, Dayjs] => [dayjs().startOf("day"), dayjs().startOf("day")];
