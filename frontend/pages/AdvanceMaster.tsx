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
  Tabs,
  Tag,
  Tooltip,
} from "antd";
import {
  PlusOutlined,
  EditOutlined,
  StopOutlined,
  ReloadOutlined,
  SaveOutlined,
  CloseOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  AppstoreOutlined,
} from "@ant-design/icons";
import { useAuth } from "../src/context/AuthContext";

/**
 * Advance Clearance settings -- the four configurable lists the voucher
 * form's dropdowns come from, plus the default exchange rate.
 *
 * Everything here is soft-deleted (status -> Inactive) rather than
 * removed: a category or person named on a historical voucher must keep
 * resolving, and a hard delete would either fail on the foreign key or
 * orphan the voucher.
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
    duration: 5,
    style: { borderRadius: 10 },
  });

type Kind = "departments" | "persons" | "categories" | "expense-by";

const PK: Record<Kind, string> = {
  departments: "department_id",
  persons: "person_id",
  categories: "category_id",
  "expense-by": "expense_by_id",
};

const LABEL: Record<Kind, string> = {
  departments: "Department",
  persons: "Name",
  categories: "Expense Category",
  "expense-by": "Expense By",
};

const STATUS_OPTIONS = [
  { value: "Active", label: "Active" },
  { value: "Inactive", label: "Inactive" },
];

export default function AdvanceMaster() {
  const { can } = useAuth();
  const canCreate = can("advance-master", "create");
  const canEdit = can("advance-master", "edit");
  const canDelete = can("advance-master", "delete");

  const [kind, setKind] = useState<Kind>("departments");
  const [rows, setRows] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingRow, setEditingRow] = useState<any>(null);
  const [statusFilter, setStatusFilter] = useState("All");
  const [defaultRate, setDefaultRate] = useState<number>(4100);
  const [rateSaving, setRateSaving] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, statusFilter]);

  useEffect(() => {
    loadDepartments();
    loadRate();
  }, []);

  const loadRows = async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/advance/master/${kind}?status=${statusFilter}`);
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      const result = await response.json();
      setRows(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      notifyError(`Couldn't load ${LABEL[kind].toLowerCase()} list`, error.message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  const loadDepartments = async () => {
    try {
      const response = await fetch("/api/advance/master/departments?status=Active");
      if (!response.ok) return;
      const result = await response.json();
      setDepartments(Array.isArray(result.data) ? result.data : []);
    } catch {
      // Non-fatal: the Department field on a person simply shows no options.
    }
  };

  const loadRate = async () => {
    try {
      const response = await fetch("/api/advance/settings");
      if (!response.ok) return;
      const result = await response.json();
      if (result.default_exchange_rate) setDefaultRate(Number(result.default_exchange_rate));
    } catch {
      // Non-fatal -- the form falls back to its own default.
    }
  };

  const saveRate = async () => {
    setRateSaving(true);
    try {
      const response = await fetch("/api/advance/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default_exchange_rate: defaultRate }),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess(
        "Default exchange rate saved",
        "Existing vouchers keep the rate stored on each row, so their totals do not change."
      );
    } catch (error: any) {
      notifyError("Couldn't save the rate", error.message);
    } finally {
      setRateSaving(false);
    }
  };

  const openCreate = () => {
    setEditingRow(null);
    form.resetFields();
    form.setFieldsValue({ status: "Active" });
    setIsModalVisible(true);
  };

  const openEdit = (record: any) => {
    setEditingRow(record);
    form.setFieldsValue({
      name: record.name,
      status: record.status,
      department_id: record.department_id ?? null,
    });
    setIsModalVisible(true);
  };

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const isEditing = Boolean(editingRow);
      const url = isEditing
        ? `/api/advance/master/${kind}/${editingRow[PK[kind]]}`
        : `/api/advance/master/${kind}`;
      const response = await fetch(url, {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: values.name,
          status: values.status,
          // Only persons carry a department; the API ignores it elsewhere.
          department_id: kind === "persons" ? values.department_id ?? null : null,
        }),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(
          typeof errBody.detail === "string" ? errBody.detail : response.statusText
        );
      }
      notifySuccess(isEditing ? `${LABEL[kind]} updated` : `${LABEL[kind]} added`);
      setIsModalVisible(false);
      setEditingRow(null);
      loadRows();
      if (kind === "departments") loadDepartments();
    } catch (error: any) {
      notifyError("Save failed", error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeactivate = async (record: any) => {
    try {
      const response = await fetch(`/api/advance/master/${kind}/${record[PK[kind]]}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess(`${LABEL[kind]} deactivated`);
      loadRows();
    } catch (error: any) {
      notifyError("Deactivate failed", error.message);
    }
  };

  const columns = [
    { title: "No", key: "no", width: 60, render: (_: any, __: any, i: number) => i + 1 },
    {
      title: "Name",
      dataIndex: "name",
      key: "name",
      sorter: (a: any, b: any) => String(a.name ?? "").localeCompare(String(b.name ?? "")),
    },
    ...(kind === "persons"
      ? [
          {
            title: "Department",
            dataIndex: "department_id",
            key: "department_id",
            render: (v: number) =>
              departments.find((d) => d.department_id === v)?.name ?? (
                <span style={{ color: "#bfbfbf" }}>-</span>
              ),
          },
        ]
      : []),
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (v: string) => <Tag color={v === "Active" ? "green" : "default"}>{v?.toUpperCase()}</Tag>,
    },
    {
      title: "Action",
      key: "action",
      width: 110,
      render: (_: any, record: any) => (
        <Space>
          {canEdit && <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />}
          {canDelete && record.status === "Active" && (
            <Popconfirm
              title={`Deactivate this ${LABEL[kind].toLowerCase()}?`}
              description="It stays on existing vouchers but can no longer be selected."
              onConfirm={() => handleDeactivate(record)}
            >
              <Tooltip title="Deactivate">
                <Button size="small" danger icon={<StopOutlined />} />
              </Tooltip>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={
        <span>
          <AppstoreOutlined style={{ marginRight: 8 }} />
          Advance Clearance Settings
        </span>
      }
      extra={
        <Space wrap>
          <Space size={4}>
            <span style={{ fontSize: 12, color: "#888" }}>Default KHR rate</span>
            <InputNumber
              min={0.0001}
              step={1}
              value={defaultRate}
              onChange={(v) => setDefaultRate(Number(v ?? 0))}
              style={{ width: 110 }}
            />
            <Button size="small" loading={rateSaving} onClick={saveRate}>
              Save
            </Button>
          </Space>
          <Select
            value={statusFilter}
            onChange={setStatusFilter}
            style={{ width: 130 }}
            options={[{ value: "All", label: "All statuses" }, ...STATUS_OPTIONS]}
          />
          <Tooltip title="Refresh">
            <Button aria-label="Refresh" icon={<ReloadOutlined />} onClick={loadRows} />
          </Tooltip>
          {canCreate && (
            <Tooltip title={`Add ${LABEL[kind]}`}>
              <Button
                aria-label={`Add ${LABEL[kind]}`}
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
      <Tabs
        activeKey={kind}
        onChange={(k) => setKind(k as Kind)}
        items={[
          { key: "departments", label: "Departments" },
          { key: "persons", label: "Names" },
          { key: "categories", label: "Expense Categories" },
          { key: "expense-by", label: "Expense By" },
        ]}
      />

      <Table
        className="compact-vehicle-table"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        rowKey={PK[kind]}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        locale={{ emptyText: "No records found." }}
      />

      <Modal
        title={`${editingRow ? "Edit" : "Add"} ${LABEL[kind]}`}
        open={isModalVisible}
        onCancel={() => {
          setIsModalVisible(false);
          setEditingRow(null);
        }}
        footer={null}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Form.Item
            name="name"
            label={LABEL[kind]}
            rules={[
              { required: true, message: "Please enter a name" },
              {
                validator: (_, value) =>
                  value == null || String(value).trim().length > 0
                    ? Promise.resolve()
                    : Promise.reject(new Error("Name cannot be only spaces")),
              },
              { max: 200, message: "Name is too long" },
            ]}
          >
            <Input placeholder={kind === "persons" ? "e.g. Mr. Sok Dara" : "e.g. Fuel"} />
          </Form.Item>

          {kind === "persons" && (
            <Form.Item name="department_id" label="Department">
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="Optional"
                options={departments.map((d) => ({ value: d.department_id, label: d.name }))}
              />
            </Form.Item>
          )}

          <Form.Item
            name="status"
            label="Status"
            rules={[{ required: true, message: "Please select a status" }]}
          >
            <Select options={STATUS_OPTIONS} />
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
