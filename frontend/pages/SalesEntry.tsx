import { useEffect, useState } from "react";
import {
  Card,
  Table,
  Button,
  Space,
  Modal,
  Popconfirm,
  notification,
  Form,
  Input,
  InputNumber,
  Select,
  Segmented,
  Tooltip,
  Alert,
} from "antd";
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  SaveOutlined,
  CloseOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  EditOutlined as EntryIcon,
} from "@ant-design/icons";
import dayjs from "dayjs";
import { useAuth } from "../src/context/AuthContext";

/**
 * Sales Entry -- records the monthly Actual and Budget figures the Sales
 * Performance report compares.
 *
 * One screen serves both, switched by the Actual/Budget toggle, because
 * they have the same shape. Keeping them together makes it obvious when a
 * month has an actual but no budget (or the reverse), which is the usual
 * cause of a report row reading "--".
 */

const notifySuccess = (title: string, description?: string) =>
  notification.success({
    message: title,
    description,
    icon: <CheckCircleFilled style={{ color: "#22c55e" }} />,
    placement: "topRight",
    duration: 3,
    style: { borderRadius: 10 },
  });

const notifyError = (title: string, description?: string) =>
  notification.error({
    message: title,
    description,
    icon: <CloseCircleFilled style={{ color: "#ff4d4f" }} />,
    placement: "topRight",
    duration: 6,
    style: { borderRadius: 10 },
  });

const money = (v: number) =>
  `$ ${Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Kind = "actual" | "budget";

const MONTHS = Array.from({ length: 12 }, (_, i) => ({
  value: i + 1,
  label: dayjs().month(i).format("MMMM"),
}));

export default function SalesEntry() {
  const { can } = useAuth();
  const canCreate = can("sales-entry", "create");
  const canEdit = can("sales-entry", "edit");
  const canDelete = can("sales-entry", "delete");

  const [kind, setKind] = useState<Kind>("actual");
  const [rows, setRows] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [persons, setPersons] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingRow, setEditingRow] = useState<any>(null);
  const [form] = Form.useForm();

  const [filterYear, setFilterYear] = useState<number>(dayjs().year());

  useEffect(() => {
    loadMasters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, filterYear]);

  const loadMasters = async () => {
    try {
      const [cRes, pRes] = await Promise.all([
        fetch("/api/sales-categories"),
        fetch("/api/sales-persons"),
      ]);
      if (cRes.ok) setCategories((await cRes.json()).data ?? []);
      if (pRes.ok) setPersons((await pRes.json()).data ?? []);
    } catch {
      // Optional dimensions -- a company-wide figure needs neither.
    }
  };

  const loadRows = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ kind, period_year: String(filterYear) });
      const response = await fetch(`/api/sales-figures?${params}`);
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      const result = await response.json();
      setRows(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading sales figures:", error);
      notifyError(`Couldn't load ${kind} figures`, error.message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  const openCreate = () => {
    setEditingRow(null);
    form.resetFields();
    form.setFieldsValue({ period_year: filterYear, period_month: dayjs().month() + 1, amount: 0 });
    setIsModalVisible(true);
  };

  const openEdit = (record: any) => {
    setEditingRow(record);
    form.setFieldsValue({
      period_year: record.period_year,
      period_month: record.period_month,
      category_id: record.category_id ?? undefined,
      sales_person_id: record.sales_person_id ?? undefined,
      amount: Number(record.amount ?? 0),
      remarks: record.remarks ?? "",
    });
    setIsModalVisible(true);
  };

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const isEditing = Boolean(editingRow);
      const url = isEditing
        ? `/api/sales-figures/${editingRow.record_id}?kind=${kind}`
        : `/api/sales-figures?kind=${kind}`;
      const response = await fetch(url, {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...values,
          // undefined -> null so clearing a dimension actually clears it.
          category_id: values.category_id ?? null,
          sales_person_id: values.sales_person_id ?? null,
        }),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess(isEditing ? "Figure updated" : "Figure added");
      setIsModalVisible(false);
      setEditingRow(null);
      loadRows();
    } catch (error: any) {
      console.error("Error saving sales figure:", error);
      // The grain conflict message from the API is long but actionable, so
      // it is shown in full rather than truncated.
      notifyError("Save failed", error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (record: any) => {
    try {
      const response = await fetch(`/api/sales-figures/${record.record_id}?kind=${kind}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess("Figure deleted");
      loadRows();
    } catch (error: any) {
      console.error("Error deleting sales figure:", error);
      notifyError("Delete failed", error.message);
    }
  };

  const columns = [
    { title: "No", key: "no", width: 60, render: (_: any, __: any, i: number) => i + 1 },
    {
      title: "Month",
      key: "month",
      width: 130,
      render: (_: any, r: any) => `${dayjs().month(r.period_month - 1).format("MMMM")} ${r.period_year}`,
      sorter: (a: any, b: any) =>
        a.period_year - b.period_year || a.period_month - b.period_month,
    },
    {
      title: "Category",
      dataIndex: "category_name",
      key: "category_name",
      render: (v: string) => v || <span style={{ color: "#bfbfbf" }}>All categories</span>,
    },
    {
      title: "Sales Person",
      key: "sales_person_name",
      render: (_: any, r: any) =>
        r.sales_person_name ? (
          r.sales_team ? `${r.sales_person_name} (${r.sales_team})` : r.sales_person_name
        ) : (
          <span style={{ color: "#bfbfbf" }}>All sales persons</span>
        ),
    },
    {
      title: kind === "actual" ? "Actual Amount" : "Budget Amount",
      dataIndex: "amount",
      key: "amount",
      width: 150,
      render: (v: number) => money(Number(v)),
      sorter: (a: any, b: any) => Number(a.amount ?? 0) - Number(b.amount ?? 0),
    },
    { title: "Remarks", dataIndex: "remarks", key: "remarks", render: (v: string) => v || "-" },
    {
      title: "Action",
      key: "action",
      width: 110,
      render: (_: any, record: any) => (
        <Space>
          {canEdit && <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />}
          {canDelete && (
            <Popconfirm
              title="Delete this figure?"
              description="This permanently removes the row."
              onConfirm={() => handleDelete(record)}
            >
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const yearOptions = Array.from({ length: 7 }, (_, i) => {
    const y = dayjs().year() - 3 + i;
    return { value: y, label: String(y) };
  });

  return (
    <Card
      title={
        <span>
          <EntryIcon style={{ marginRight: 8 }} />
          Sales Entry
        </span>
      }
      extra={
        <Space wrap>
          <Segmented
            value={kind}
            onChange={(v) => setKind(v as Kind)}
            options={[
              { label: "Actual", value: "actual" },
              { label: "Budget", value: "budget" },
            ]}
          />
          <Select value={filterYear} onChange={setFilterYear} style={{ width: 100 }} options={yearOptions} />
          <Tooltip title="Refresh">
            <Button aria-label="Refresh" icon={<ReloadOutlined />} onClick={loadRows} />
          </Tooltip>
          {canCreate && (
            <Tooltip title={`Add ${kind === "actual" ? "Actual" : "Budget"}`}>
              <Button
                aria-label="Add figure"
                type="primary"
                icon={<PlusOutlined />}
                onClick={openCreate}
                style={{ backgroundColor: "#051650" }}
              />
            </Tooltip>
          )}
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        message="Use one level per month"
        description={
          "For any month, record EITHER a single company-wide figure (leave Category and Sales Person empty) " +
          "OR a breakdown by category/sales person -- not both. Mixing them would count the same sales twice " +
          "in the report totals, so the system rejects the second one."
        }
      />

      <Table
        className="compact-vehicle-table"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        rowKey="record_id"
        pagination={{ pageSize: 20, showSizeChanger: true }}
        summary={() => {
          // Totals cover EVERY row for the selected year, not just the
          // current page -- a page-only total would change as you paged
          // through and would not reconcile with the report.
          //
          // Summing is safe because the API refuses to let a month hold
          // both a company-wide figure and a breakdown, so no row here can
          // be counted twice (see _assert_consistent_grain).
          const total = rows.reduce((sum, r) => sum + Number(r.amount ?? 0), 0);
          const monthsCovered = new Set(rows.map((r) => `${r.period_year}-${r.period_month}`)).size;

          return (
            <Table.Summary fixed>
              <Table.Summary.Row style={{ background: "#fafafa", fontWeight: 700 }}>
                <Table.Summary.Cell index={0} colSpan={2}>
                  Total — {filterYear}
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2} colSpan={2}>
                  <span style={{ fontWeight: 400, color: "#8c8c8c" }}>
                    {rows.length} {rows.length === 1 ? "entry" : "entries"} across {monthsCovered}{" "}
                    {monthsCovered === 1 ? "month" : "months"}
                  </span>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={4}>
                  <span style={{ color: "#051650" }}>{money(total)}</span>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={5} colSpan={2} />
              </Table.Summary.Row>
            </Table.Summary>
          );
        }}
      />

      <Modal
        title={`${editingRow ? "Edit" : "Add"} ${kind === "actual" ? "Actual" : "Budget"} Sales`}
        open={isModalVisible}
        onCancel={() => {
          setIsModalVisible(false);
          setEditingRow(null);
        }}
        footer={null}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Space style={{ display: "flex" }} size={12}>
            <Form.Item
              name="period_year"
              label="Year"
              rules={[{ required: true, message: "Please select the year" }]}
              style={{ flex: 1 }}
            >
              <Select options={yearOptions} />
            </Form.Item>
            <Form.Item
              name="period_month"
              label="Month"
              rules={[{ required: true, message: "Please select the month" }]}
              style={{ flex: 1 }}
            >
              <Select options={MONTHS} />
            </Form.Item>
          </Space>

          <Form.Item
            name="category_id"
            label="Sales Category"
            extra="Leave empty for a company-wide figure."
          >
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="All categories"
              options={categories.map((c) => ({ value: c.category_id, label: c.name }))}
            />
          </Form.Item>

          <Form.Item
            name="sales_person_id"
            label="Sales Person"
            extra="Leave empty for a company-wide figure."
          >
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="All sales persons"
              options={persons.map((p) => ({
                value: p.sales_person_id,
                label: p.team ? `${p.name} (${p.team})` : p.name,
              }))}
            />
          </Form.Item>

          <Form.Item
            name="amount"
            label={kind === "actual" ? "Actual Amount" : "Budget Amount"}
            rules={[
              { required: true, message: "Please enter the amount" },
              { type: "number", min: 0, message: "Amount cannot be negative" },
            ]}
          >
            <InputNumber style={{ width: "100%" }} min={0} step={0.01} prefix="$" />
          </Form.Item>

          <Form.Item name="remarks" label="Remarks">
            <Input.TextArea rows={2} placeholder="Optional" />
          </Form.Item>

          <Space style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button icon={<CloseOutlined />} onClick={() => setIsModalVisible(false)}>
              Cancel
            </Button>
            <Button
              type="primary"
              htmlType="submit"
              icon={<SaveOutlined />}
              loading={saving}
              style={{ backgroundColor: "#051650" }}
            >
              Save
            </Button>
          </Space>
        </Form>
      </Modal>
    </Card>
  );
}
