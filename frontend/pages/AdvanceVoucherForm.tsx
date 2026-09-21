import { useEffect, useMemo, useState } from "react";
import {
  Form,
  Input,
  InputNumber,
  Select,
  DatePicker,
  Button,
  Row,
  Col,
  Table,
  Space,
  Divider,
  Tag,
  Typography,
  Tooltip,
  Alert,
  Modal,
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  SaveOutlined,
  CloseOutlined,
} from "@ant-design/icons";
import dayjs, { Dayjs } from "dayjs";

const { Text } = Typography;
const DATE_FORMAT = "YYYY-MM-DD";

/**
 * Advance Clearance voucher -- header, dynamic expense rows, live totals.
 *
 * The totals shown here are a PREVIEW. The backend recomputes every row's
 * USD value and the balance on save, so the stored figures never depend
 * on what the browser calculated. They use the same arithmetic, so the
 * preview matches -- but if they ever diverge, the server wins.
 */

export interface MasterOption {
  id: number;
  name: string;
}

export interface AdvanceVoucherLine {
  key: string;
  expense_date?: string | null;
  bill_no?: string | null;
  category_id?: number | null;
  description?: string | null;
  expense_by_id?: number | null;
  amount: number;
  currency: "USD" | "KHR";
  exchange_rate?: number | null;
  remarks?: string | null;
}

interface Props {
  initialValues?: any;
  departments: MasterOption[];
  persons: (MasterOption & { department_id?: number | null })[];
  categories: MasterOption[];
  expenseByOptions: MasterOption[];
  defaultExchangeRate: number;
  onSave: (payload: any) => void;
  onCancel?: () => void;
  saving?: boolean;
}

const money = (v: number) =>
  `$ ${Number(v ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/**
 * USD value of one row. Mirrors _line_amount_usd on the backend.
 *
 * A USD row passes through untouched rather than being divided by a rate
 * of 1 -- same number, but dividing would imply a conversion happened.
 * A KHR row with no usable rate returns null, meaning "cannot be
 * converted yet", which the caller shows as a dash instead of as $0.00.
 */
export function lineAmountUsd(
  amount: number | null | undefined,
  currency: "USD" | "KHR",
  rate: number | null | undefined
): number | null {
  const value = Number(amount ?? 0);
  if (!Number.isFinite(value)) return null;
  if (currency === "USD") return Math.round(value * 100) / 100;
  const r = Number(rate ?? 0);
  if (!Number.isFinite(r) || r <= 0) return null;
  return Math.round((value / r) * 100) / 100;
}

/**
 * Sort key for an expense row: Expense Category, then Bill/Invoice Date
 * oldest first. Mirrors _sort_key on the backend, so what is displayed
 * while editing is the order that gets stored.
 *
 * Uncategorised rows sort LAST -- an uncategorised row is usually
 * unfinished, and putting it first would push the real groups down. A row
 * with no date goes to the end of its own category rather than leading it.
 */
export function sortLines(
  lines: AdvanceVoucherLine[],
  categoryName: (id?: number | null) => string
): AdvanceVoucherLine[] {
  return [...lines].sort((a, b) => {
    const ca = categoryName(a.category_id);
    const cb = categoryName(b.category_id);
    if (!ca !== !cb) return ca ? -1 : 1;          // blank category last
    const byCategory = ca.toLowerCase().localeCompare(cb.toLowerCase());
    if (byCategory !== 0) return byCategory;
    const da = a.expense_date ?? "9999-12-31";    // undated last in group
    const db_ = b.expense_date ?? "9999-12-31";
    return da.localeCompare(db_);
  });
}

/**
 * Is a Bill/Invoice Date inside the selected Expense Period?
 *
 * An undated row counts as IN: it has not been excluded by a date it does
 * not have, and hiding a row the user is midway through typing would look
 * like the row was lost.
 */
export function withinPeriod(
  value: string | null | undefined,
  from: Dayjs | null,
  to: Dayjs | null
): boolean {
  if (!value) return true;
  if (!from || !to) return true;
  const d = dayjs(value);
  return !d.isBefore(from, "day") && !d.isAfter(to, "day");
}

let rowSeq = 0;
const newRow = (defaultRate: number): AdvanceVoucherLine => ({
  key: `row-${Date.now()}-${rowSeq++}`,
  expense_date: null,
  bill_no: "",
  category_id: null,
  description: "",
  expense_by_id: null,
  amount: 0,
  currency: "USD",
  // Prefilled but editable: the row stores the rate it was cleared at, so
  // a later change to the company default never restates this voucher.
  exchange_rate: defaultRate,
  remarks: "",
});

export default function AdvanceVoucherForm({
  initialValues,
  departments,
  persons,
  categories,
  expenseByOptions,
  defaultExchangeRate,
  onSave,
  onCancel,
  saving,
}: Props) {
  const [form] = Form.useForm();
  const [lines, setLines] = useState<AdvanceVoucherLine[]>([]);
  const [cashAdvance, setCashAdvance] = useState<number>(0);
  const [departmentId, setDepartmentId] = useState<number | null>(null);

  useEffect(() => {
    if (initialValues) {
      form.setFieldsValue({
        period: initialValues.period_year
          ? dayjs(`${initialValues.period_year}-${initialValues.period_month}-01`)
          : null,
        department_id: initialValues.department_id ?? null,
        person_id: initialValues.person_id,
        voucher_date: initialValues.voucher_date ? dayjs(initialValues.voucher_date) : null,
        expense_period:
          initialValues.expense_from_date && initialValues.expense_to_date
            ? [dayjs(initialValues.expense_from_date), dayjs(initialValues.expense_to_date)]
            : null,
        cash_advance: Number(initialValues.cash_advance ?? 0),
        status: initialValues.status ?? "Draft",
        remarks: initialValues.remarks ?? "",
      });
      setCashAdvance(Number(initialValues.cash_advance ?? 0));
      setDepartmentId(initialValues.department_id ?? null);
      setLines(
        (initialValues.lines ?? []).map((l: any, i: number) => ({
          key: `existing-${l.line_id ?? i}`,
          expense_date: l.expense_date ?? null,
          bill_no: l.bill_no ?? "",
          category_id: l.category_id ?? null,
          description: l.description ?? "",
          expense_by_id: l.expense_by_id ?? null,
          amount: Number(l.amount ?? 0),
          currency: (l.currency ?? "USD") as "USD" | "KHR",
          // The SAVED rate, not today's default -- see newRow above.
          exchange_rate: l.exchange_rate != null ? Number(l.exchange_rate) : defaultExchangeRate,
          remarks: l.remarks ?? "",
        }))
      );
    } else {
      form.resetFields();
      const today = dayjs();
      form.setFieldsValue({
        period: today,
        voucher_date: today,
        // Defaults to the whole reporting month -- the common case, and
        // it means a new voucher is never filtering rows out before the
        // user has chosen anything.
        expense_period: [today.startOf("month"), today.endOf("month")],
        status: "Draft",
        cash_advance: 0,
      });
      setCashAdvance(0);
      setDepartmentId(null);
      setLines([newRow(defaultExchangeRate)]);
    }
  }, [initialValues, form, defaultExchangeRate]);

  // The Name list narrows to the chosen Department, but a person with no
  // department stays selectable -- otherwise they would be unreachable
  // until someone assigned them one.
  const personOptions = useMemo(() => {
    const pool =
      departmentId == null
        ? persons
        : persons.filter((p) => p.department_id === departmentId || p.department_id == null);
    return pool.map((p) => ({ value: p.id, label: p.name }));
  }, [persons, departmentId]);

  const updateLine = (key: string, patch: Partial<AdvanceVoucherLine>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const selectedMonth: Dayjs | undefined = Form.useWatch("period", form);
  const expensePeriod: [Dayjs, Dayjs] | undefined = Form.useWatch("expense_period", form);
  const periodFrom = expensePeriod?.[0] ?? null;
  const periodTo = expensePeriod?.[1] ?? null;

  // The Expense Period is the voucher's SCOPE: rows inside it are the
  // voucher, rows outside it are not. Both lists are kept -- the ones
  // outside are not thrown away silently, they are surfaced so the user
  // can widen the period or fix the date before saving.
  const inPeriod = useMemo(
    () => lines.filter((l) => withinPeriod(l.expense_date, periodFrom, periodTo)),
    [lines, periodFrom, periodTo]
  );
  const outOfPeriod = useMemo(
    () => lines.filter((l) => !withinPeriod(l.expense_date, periodFrom, periodTo)),
    [lines, periodFrom, periodTo]
  );

  const categoryName = (id?: number | null) =>
    categories.find((c) => c.id === id)?.name ?? "";

  // Rows are shown in the order they will be STORED (category, then
  // date), so what the user reviews before saving is what comes back
  // afterwards. Sorting only on save would silently reshuffle the table
  // the next time the voucher is opened.
  const sortedLines = useMemo(
    () => sortLines(inPeriod, categoryName),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inPeriod, categories]
  );

  // Totals cover the in-period rows only, matching what the table shows.
  // A total that silently included hidden rows would not reconcile against
  // the list printed underneath it.
  const totalExpense = useMemo(
    () =>
      Math.round(
        sortedLines.reduce(
          (sum, l) => sum + (lineAmountUsd(l.amount, l.currency, l.exchange_rate) ?? 0),
          0
        ) * 100
      ) / 100,
    [sortedLines]
  );

  // Balance = Cash Advance - Actual Expense.
  //   > 0  the person holds money that is not theirs  -> Return
  //   < 0  they spent their own money                 -> Refund
  const balance = Math.round((cashAdvance - totalExpense) * 100) / 100;

  const columns = [
    {
      title: "Date",
      dataIndex: "expense_date",
      width: 140,
      render: (_: any, row: AdvanceVoucherLine) => (
        <DatePicker
          style={{ width: "100%" }}
          format={DATE_FORMAT}
          disabledDate={(d) =>
            !!periodFrom &&
            !!periodTo &&
            (d.isBefore(periodFrom, "day") || d.isAfter(periodTo, "day"))
          }
          value={row.expense_date ? dayjs(row.expense_date) : null}
          onChange={(d: Dayjs | null) =>
            updateLine(row.key, { expense_date: d ? d.format(DATE_FORMAT) : null })
          }
        />
      ),
    },
    {
      title: "Bill / Invoice No.",
      dataIndex: "bill_no",
      width: 150,
      render: (_: any, row: AdvanceVoucherLine) => (
        <Input
          value={row.bill_no ?? ""}
          onChange={(e) => updateLine(row.key, { bill_no: e.target.value })}
        />
      ),
    },
    {
      title: "Category",
      dataIndex: "category_id",
      width: 170,
      render: (_: any, row: AdvanceVoucherLine) => (
        <Select
          showSearch
          allowClear
          optionFilterProp="label"
          style={{ width: "100%" }}
          value={row.category_id ?? undefined}
          onChange={(v) => updateLine(row.key, { category_id: v ?? null })}
          options={categories.map((c) => ({ value: c.id, label: c.name }))}
        />
      ),
    },
    {
      title: "Description",
      dataIndex: "description",
      width: 240,
      render: (_: any, row: AdvanceVoucherLine) => (
        <Input
          value={row.description ?? ""}
          placeholder="Expense, and the principal / customer / project"
          onChange={(e) => updateLine(row.key, { description: e.target.value })}
        />
      ),
    },
    {
      title: "Expense By",
      dataIndex: "expense_by_id",
      width: 140,
      render: (_: any, row: AdvanceVoucherLine) => (
        <Select
          allowClear
          style={{ width: "100%" }}
          value={row.expense_by_id ?? undefined}
          onChange={(v) => updateLine(row.key, { expense_by_id: v ?? null })}
          options={expenseByOptions.map((o) => ({ value: o.id, label: o.name }))}
        />
      ),
    },
    {
      title: "Amount",
      dataIndex: "amount",
      width: 130,
      render: (_: any, row: AdvanceVoucherLine) => (
        <InputNumber
          style={{ width: "100%" }}
          min={0}
          step={0.01}
          value={row.amount}
          onChange={(v) => updateLine(row.key, { amount: Number(v ?? 0) })}
        />
      ),
    },
    {
      title: "Currency",
      dataIndex: "currency",
      width: 100,
      render: (_: any, row: AdvanceVoucherLine) => (
        <Select
          style={{ width: "100%" }}
          value={row.currency}
          onChange={(v: "USD" | "KHR") =>
            updateLine(row.key, {
              currency: v,
              // Switching to KHR with no rate on the row would make the
              // USD value uncomputable, so seed the default.
              exchange_rate: v === "KHR" ? row.exchange_rate || defaultExchangeRate : row.exchange_rate,
            })
          }
          options={[
            { value: "USD", label: "USD" },
            { value: "KHR", label: "KHR" },
          ]}
        />
      ),
    },
    {
      title: "Rate",
      dataIndex: "exchange_rate",
      width: 110,
      render: (_: any, row: AdvanceVoucherLine) =>
        row.currency === "KHR" ? (
          <InputNumber
            style={{ width: "100%" }}
            min={0.0001}
            step={1}
            value={row.exchange_rate ?? undefined}
            onChange={(v) => updateLine(row.key, { exchange_rate: v == null ? null : Number(v) })}
          />
        ) : (
          // Blank, not 1 -- there is no conversion on a USD row.
          <Text type="secondary">-</Text>
        ),
    },
    {
      title: "Amount (USD)",
      dataIndex: "amount_usd",
      width: 120,
      render: (_: any, row: AdvanceVoucherLine) => {
        const usd = lineAmountUsd(row.amount, row.currency, row.exchange_rate);
        return usd == null ? (
          <Tooltip title="Enter an exchange rate to convert this row">
            <Text type="warning">-</Text>
          </Tooltip>
        ) : (
          <Text strong>{money(usd)}</Text>
        );
      },
    },
    {
      title: "Remarks",
      dataIndex: "remarks",
      width: 160,
      render: (_: any, row: AdvanceVoucherLine) => (
        <Input
          value={row.remarks ?? ""}
          onChange={(e) => updateLine(row.key, { remarks: e.target.value })}
        />
      ),
    },
    {
      title: "",
      key: "action",
      width: 50,
      fixed: "right" as const,
      render: (_: any, row: AdvanceVoucherLine) => (
        <Tooltip title="Delete row">
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => setLines((prev) => prev.filter((l) => l.key !== row.key))}
          />
        </Tooltip>
      ),
    },
  ];

  const submit = (values: any) => {
    const period: Dayjs = values.period;
    const range: [Dayjs, Dayjs] = values.expense_period;

    onSave({
      period_year: period.year(),
      period_month: period.month() + 1,
      department_id: values.department_id ?? null,
      person_id: values.person_id,
      voucher_date: values.voucher_date.format(DATE_FORMAT),
      expense_from_date: range[0].format(DATE_FORMAT),
      expense_to_date: range[1].format(DATE_FORMAT),
      cash_advance: Number(values.cash_advance ?? 0),
      status: values.status ?? "Draft",
      remarks: values.remarks || null,
      // amount_usd is deliberately NOT sent -- the backend derives it, so
      // there is exactly one place that decides what a row is worth.
      // Only the in-period rows -- the Expense Period defines what this
      // voucher contains. Rows outside it were shown in the warning above
      // and the user confirmed their removal.
      lines: sortedLines.map((l) => ({
        expense_date: l.expense_date || null,
        bill_no: l.bill_no || null,
        category_id: l.category_id ?? null,
        description: l.description || null,
        expense_by_id: l.expense_by_id ?? null,
        amount: Number(l.amount ?? 0),
        currency: l.currency,
        exchange_rate: l.currency === "KHR" ? Number(l.exchange_rate ?? 0) || null : null,
        remarks: l.remarks || null,
      })),
    });
  };

  /**
   * Dropping rows is the one irreversible thing this form does, so it is
   * never silent. Anything outside the Expense Period is confirmed by
   * name before it goes.
   */
  const handleFinish = (values: any) => {
    if (outOfPeriod.length === 0) {
      submit(values);
      return;
    }
    Modal.confirm({
      title: `Remove ${outOfPeriod.length} row${outOfPeriod.length > 1 ? "s" : ""} from this voucher?`,
      content: (
        <>
          <p>
            These Bill/Invoice Dates fall outside the Expense Period, so they are
            not part of this voucher and will be removed when you save:
          </p>
          <ul style={{ paddingLeft: 18, maxHeight: 180, overflow: "auto" }}>
            {outOfPeriod.map((l) => (
              <li key={l.key}>
                {l.expense_date ?? "-"} - {l.description || "(no description)"}
              </li>
            ))}
          </ul>
          <p>Cancel and widen the Expense Period if you meant to keep them.</p>
        </>
      ),
      okText: "Remove and save",
      okButtonProps: { danger: true },
      cancelText: "Cancel",
      onOk: () => submit(values),
    });
  };

  return (
    <Form form={form} layout="vertical" onFinish={handleFinish}>
      <Row gutter={16}>
        <Col span={6}>
          <Form.Item
            name="period"
            label="Month / Year"
            rules={[{ required: true, message: "Please select the reporting month" }]}
          >
            <DatePicker
              picker="month"
              format="MMMM YYYY"
              style={{ width: "100%" }}
              // Moving the month makes the old period invalid, so reset it
              // to the new month rather than leaving a range that no
              // longer overlaps and silently hides every row.
              onChange={(m) =>
                m && form.setFieldsValue({ expense_period: [m.startOf("month"), m.endOf("month")] })
              }
            />
          </Form.Item>
        </Col>
        <Col span={6}>
          <Form.Item name="department_id" label="Department">
            <Select
              showSearch
              allowClear
              optionFilterProp="label"
              placeholder="Select a department..."
              onChange={(v) => {
                setDepartmentId(v ?? null);
                // The chosen person may not belong to the new department.
                // Clearing is safer than leaving a selection the dropdown
                // no longer offers.
                form.setFieldsValue({ person_id: undefined });
              }}
              options={departments.map((d) => ({ value: d.id, label: d.name }))}
            />
          </Form.Item>
        </Col>
        <Col span={6}>
          <Form.Item
            name="person_id"
            label="Name"
            rules={[{ required: true, message: "Please select a name" }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="Search a name..."
              options={personOptions}
            />
          </Form.Item>
        </Col>
        <Col span={6}>
          <Form.Item label="Voucher No.">
            {/* Generated by the server on save, and never editable
                afterwards -- by the time anyone edits a voucher the number
                has been quoted on paper. */}
            <Input
              disabled
              value={initialValues?.voucher_no ?? "Generated on save"}
              style={{ fontWeight: 600, color: "#051650" }}
            />
          </Form.Item>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={6}>
          <Form.Item
            name="voucher_date"
            label="Voucher Date"
            rules={[{ required: true, message: "Please select the voucher date" }]}
          >
            <DatePicker format={DATE_FORMAT} style={{ width: "100%" }} />
          </Form.Item>
        </Col>
        <Col span={9}>
          {/* The voucher's scope. Only Bill/Invoice Dates inside this
              range belong to the voucher, so changing it re-filters the
              table and the totals immediately. Confined to the reporting
              month: a period spanning two months would make "the August
              voucher" carry September bills. */}
          <Form.Item
            name="expense_period"
            label="Voucher Date / Expense Period"
            rules={[{ required: true, message: "Please select the expense period" }]}
          >
            <DatePicker.RangePicker
              format={DATE_FORMAT}
              style={{ width: "100%" }}
              allowClear={false}
              disabledDate={(d) =>
                !!selectedMonth &&
                (d.isBefore(selectedMonth.startOf("month"), "day") ||
                  d.isAfter(selectedMonth.endOf("month"), "day"))
              }
            />
          </Form.Item>
        </Col>
        <Col span={5}>
          <Form.Item name="cash_advance" label="Total Cash Advance">
            <InputNumber
              style={{ width: "100%" }}
              min={0}
              step={0.01}
              addonBefore="$"
              onChange={(v) => setCashAdvance(Number(v ?? 0))}
            />
          </Form.Item>
        </Col>
        <Col span={4}>
          <Form.Item name="status" label="Status">
            <Select
              options={[
                { value: "Draft", label: "Draft" },
                { value: "Submitted", label: "Submitted" },
              ]}
            />
          </Form.Item>
        </Col>
      </Row>

      <Divider titlePlacement="left" style={{ margin: "4px 0 16px" }}>
        Expense Detail
      </Divider>

      {outOfPeriod.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`${outOfPeriod.length} row${
            outOfPeriod.length > 1 ? "s fall" : " falls"
          } outside the Expense Period and ${
            outOfPeriod.length > 1 ? "are" : "is"
          } not part of this voucher`}
          description={
            <>
              Hidden from the table and excluded from the totals below. They are
              not deleted yet -- widen the Expense Period to bring them back, or
              save to remove them from this voucher.
              <div style={{ marginTop: 6, fontSize: 12 }}>
                {outOfPeriod
                  .slice(0, 5)
                  .map((l) =>
                    `${l.expense_date ?? "-"}  ${l.description || "(no description)"}`
                  )
                  .join("   |   ")}
                {outOfPeriod.length > 5 ? `   ... and ${outOfPeriod.length - 5} more` : ""}
              </div>
            </>
          }
        />
      )}

      <Text type="secondary" style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
        Showing Bill/Invoice Dates from{" "}
        <strong>
          {periodFrom && periodTo
            ? `${periodFrom.format("DD-MMM-YYYY")} to ${periodTo.format("DD-MMM-YYYY")}`
            : "the whole month"}
        </strong>
        . Rows are grouped by Expense Category, then ordered by Bill/Invoice Date
        (oldest first) -- the order they are saved, printed and exported in.
      </Text>

      {/* Inputs inside the expense table inherit the 12px table font, so
          the rows read as data rather than as a stack of form controls.
          Scoped to this table only -- the header fields above it stay at
          the normal size, where they are labels rather than a grid. */}
      <style>{`
        .advance-expense-table .ant-input,
        .advance-expense-table .ant-input-number-input,
        .advance-expense-table .ant-select-selector,
        .advance-expense-table .ant-select-selection-item,
        .advance-expense-table .ant-picker-input > input {
          font-size: 12px;
        }
      `}</style>

      <Table
        className="compact-vehicle-table advance-expense-table"
        size="small"
        bordered
        rowKey="key"
        columns={columns}
        dataSource={sortedLines}
        pagination={false}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: "No expense rows yet -- add one below." }}
      />

      <Button
        type="dashed"
        icon={<PlusOutlined />}
        onClick={() => setLines((prev) => [...prev, newRow(defaultExchangeRate)])}
        style={{ marginTop: 12, width: "100%" }}
      >
        Add Row
      </Button>

      {/* Totals block, mirroring the paper form's footer. */}
      <div
        style={{
          marginTop: 20,
          padding: 16,
          background: "#fafafa",
          borderRadius: 8,
          display: "flex",
          gap: 32,
          flexWrap: "wrap",
          justifyContent: "flex-end",
        }}
      >
        <div>
          <Text type="secondary">Total Actual Expense</Text>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{money(totalExpense)}</div>
        </div>
        <div>
          <Text type="secondary">Total Cash Advance</Text>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{money(cashAdvance)}</div>
        </div>
        <div>
          <Text type="secondary">Balance</Text>
          <div
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: balance > 0 ? "#389e0d" : balance < 0 ? "#cf1322" : undefined,
            }}
          >
            {money(Math.abs(balance))}{" "}
            {balance > 0 ? (
              <Tag color="green">Return by employee</Tag>
            ) : balance < 0 ? (
              <Tag color="red">Refund to employee</Tag>
            ) : (
              <Tag>Cleared</Tag>
            )}
          </div>
        </div>
      </div>

      <Form.Item name="remarks" label="Remarks" style={{ marginTop: 16 }}>
        <Input.TextArea rows={2} placeholder="Optional notes for this voucher..." />
      </Form.Item>

      <Divider style={{ margin: "4px 0 20px" }} />

      <Space style={{ display: "flex", justifyContent: "flex-end" }}>
        {onCancel && (
          <Button icon={<CloseOutlined />} onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          type="primary"
          htmlType="submit"
          icon={<SaveOutlined />}
          loading={saving}
          style={{ backgroundColor: "#051650" }}
        >
          {initialValues ? "Update Voucher" : "Create Voucher"}
        </Button>
      </Space>
    </Form>
  );
}
