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
 * Sales Categories & Persons -- the two master lists the Sales
 * Performance module filters and reports by.
 *
 * Both are soft-deleted (status -> Inactive) rather than removed: sales
 * figures already recorded against a category or person must keep
 * resolving their name, and a hard delete would either fail on the
 * foreign key or orphan historical rows.
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

type Kind = "category" | "person";

const ENDPOINT: Record<Kind, string> = {
  category: "/api/sales-categories",
  person: "/api/sales-persons",
};
const PK: Record<Kind, string> = {
  category: "category_id",
  person: "sales_person_id",
};
const LABEL: Record<Kind, string> = {
  category: "Sales Category",
  person: "Sales Person",
};

const STATUS_OPTIONS = [
  { value: "Active", label: "Active" },
  { value: "Inactive", label: "Inactive" },
];

export default function SalesMaster() {
  const { can } = useAuth();
  const canCreate = can("sales-master", "create");
  const canEdit = can("sales-master", "edit");
  const canDelete = can("sales-master", "delete");

  const [kind, setKind] = useState<Kind>("category");
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingRow, setEditingRow] = useState<any>(null);
  const [statusFilter, setStatusFilter] = useState<string>("All");
  const [form] = Form.useForm();

  useEffect(() => {
    loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, statusFilter]);

  const loadRows = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${ENDPOINT[kind]}?status=${statusFilter}`);
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      const result = await response.json();
      setRows(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading sales master data:", error);
      notifyError(`Couldn't load ${LABEL[kind].toLowerCase()}s`, error.message);
      setRows([]);
    } finally {
      setLoading(false);
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
      team: record.team ?? "",
      status: record.status,
    });
    setIsModalVisible(true);
  };

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const isEditing = Boolean(editingRow);
      const url = isEditing
        ? `${ENDPOINT[kind]}/${editingRow[PK[kind]]}`
        : ENDPOINT[kind];

      // The category endpoint has no `team` column -- sending it would be
      // rejected, so the payload is built per kind rather than spread.
      const payload =
        kind === "person"
          ? { name: values.name, team: values.team || null, status: values.status }
          : { name: values.name, status: values.status };

      const response = await fetch(url, {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess(isEditing ? `${LABEL[kind]} updated` : `${LABEL[kind]} added`);
      setIsModalVisible(false);
      setEditingRow(null);
      loadRows();
    } catch (error: any) {
      console.error("Error saving sales master record:", error);
      notifyError("Save failed", error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeactivate = async (record: any) => {
    try {
      const response = await fetch(`${ENDPOINT[kind]}/${record[PK[kind]]}`, { method: "DELETE" });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess(`${LABEL[kind]} deactivated`);
      loadRows();
    } catch (error: any) {
      console.error("Error deactivating sales master record:", error);
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
    ...(kind === "person"
      ? [
          {
            title: "Team",
            dataIndex: "team",
            key: "team",
            render: (v: string) => v || <span style={{ color: "#bfbfbf" }}>-</span>,
            sorter: (a: any, b: any) => String(a.team ?? "").localeCompare(String(b.team ?? "")),
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
              description="It stays on existing sales figures but can no longer be selected."
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
          Sales Categories &amp; Persons
        </span>
      }
      extra={
        <Space wrap>
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
          { key: "category", label: "Sales Categories" },
          { key: "person", label: "Sales Persons" },
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
            label={kind === "category" ? "Category Name" : "Sales Person Name"}
            rules={[
              { required: true, message: "Please enter a name" },
              { max: kind === "category" ? 150 : 200, message: "Name is too long" },
            ]}
          >
            <Input placeholder={kind === "category" ? "e.g. Machinery" : "e.g. Mr. Sok Dara"} />
          </Form.Item>

          {kind === "person" && (
            <Form.Item name="team" label="Team" rules={[{ max: 150, message: "Team is too long" }]}>
              <Input placeholder="Optional — e.g. North Team" />
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
