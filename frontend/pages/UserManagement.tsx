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
  Switch,
  Tag,
  Tooltip,
} from "antd";
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  UserOutlined,
  SaveOutlined,
  CloseOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { useAuth } from "../src/context/AuthContext";

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
    duration: 4.5,
    style: { borderRadius: 10 },
  });

interface RoleOption {
  role_id: number;
  role_name: string;
}

interface CompanyOption {
  company_id: number;
  company_name: string | null;
}

export default function UserManagement() {
  const { can, user: currentUser } = useAuth();
  const canCreate = can("settings-users", "create");
  const canEdit = can("settings-users", "edit");
  const canDelete = can("settings-users", "delete");

  const [rows, setRows] = useState<any[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingRow, setEditingRow] = useState<any>(null);
  const [search, setSearch] = useState("");
  const [form] = Form.useForm();

  useEffect(() => {
    loadRows();
    loadRoles();
    loadCompanies();
  }, []);

  const loadRows = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/users");
      if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
      const result = await response.json();
      setRows(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading users:", error);
      notifyError("Couldn't load users", error.message);
    } finally {
      setLoading(false);
    }
  };

  const loadRoles = async () => {
    try {
      const response = await fetch("/api/roles?is_active=true");
      if (!response.ok) return;
      const result = await response.json();
      setRoles(Array.isArray(result.data) ? result.data : []);
    } catch (error) {
      console.error("Error loading roles:", error);
    }
  };

  // Company options come straight from Company Wialon Credentials -- that
  // table is the single source of truth for which companies exist, so a
  // user can only ever be attached to one that's actually configured.
  const loadCompanies = async () => {
    try {
      const response = await fetch("/api/company-wialon-credentials");
      if (!response.ok) return;
      const result = await response.json();
      setCompanies(Array.isArray(result.data) ? result.data : []);
    } catch (error) {
      console.error("Error loading companies:", error);
    }
  };

  const companyOptions = companies.map((c) => ({
    value: c.company_id,
    label: c.company_name || `Company ${c.company_id}`,
  }));

  const openCreate = () => {
    setEditingRow(null);
    form.resetFields();
    form.setFieldsValue({ is_active: true, role_ids: [] });
    setIsModalVisible(true);
  };

  const openEdit = (record: any) => {
    setEditingRow(record);
    form.setFieldsValue({
      username: record.username,
      email: record.email,
      full_name: record.full_name,
      company_id: record.company_id ?? undefined,
      password: undefined,
      role_ids: (record.roles || []).map((r: any) => r.role_id),
      is_active: Boolean(record.is_active),
    });
    setIsModalVisible(true);
  };

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const isEditing = Boolean(editingRow);
      const url = isEditing ? `/api/users/${editingRow.user_id}` : "/api/users";
      const payload: any = isEditing
        ? {
            email: values.email,
            full_name: values.full_name,
            company_id: values.company_id,
            role_ids: values.role_ids,
            is_active: values.is_active,
            ...(values.password ? { password: values.password } : {}),
          }
        : {
            username: values.username,
            email: values.email,
            password: values.password,
            full_name: values.full_name,
            company_id: values.company_id,
            role_ids: values.role_ids,
            is_active: values.is_active,
          };
      const response = await fetch(url, {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const detail = errBody.detail || response.statusText;
        if (response.status === 409) {
          notifyError("Could not save user", detail);
          return;
        }
        throw new Error(detail);
      }
      notifySuccess(isEditing ? "User updated" : "User created");
      setIsModalVisible(false);
      setEditingRow(null);
      loadRows();
    } catch (error: any) {
      console.error("Error saving user:", error);
      notifyError("Save failed", error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const response = await fetch(`/api/users/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess("User deactivated");
      loadRows();
    } catch (error: any) {
      console.error("Error deactivating user:", error);
      notifyError("Deactivate failed", error.message);
    }
  };

  const filteredRows = rows.filter((r) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      String(r.username || "").toLowerCase().includes(s) ||
      String(r.email || "").toLowerCase().includes(s) ||
      String(r.full_name || "").toLowerCase().includes(s) ||
      String(r.company_name || "").toLowerCase().includes(s)
    );
  });

  const columns = [
    {
      title: "No",
      key: "no",
      width: 50,
      fixed: "left" as const,
      render: (_: any, __: any, index: number) => index + 1,
    },
    {
      title: "Username",
      dataIndex: "username",
      key: "username",
      sorter: (a: any, b: any) => String(a.username ?? "").localeCompare(String(b.username ?? "")),
    },
    { title: "Email", dataIndex: "email", key: "email" },
    { title: "Full Name", dataIndex: "full_name", key: "full_name", render: (v: string) => v || "-" },
    {
      title: "Company",
      dataIndex: "company_name",
      key: "company_name",
      render: (v: string, record: any) => v || (record.company_id ? `Company ${record.company_id}` : "-"),
      sorter: (a: any, b: any) => String(a.company_name ?? "").localeCompare(String(b.company_name ?? "")),
    },
    {
      title: "Roles",
      key: "roles",
      render: (_: any, record: any) => (
        <Space size={4} wrap>
          {(record.roles || []).length === 0
            ? <Tag>No role</Tag>
            : record.roles.map((r: any) => <Tag key={r.role_id} color="blue">{r.role_name}</Tag>)}
        </Space>
      ),
    },
    {
      title: "Status",
      dataIndex: "is_active",
      key: "is_active",
      width: 100,
      render: (v: boolean) => (v ? <Tag color="green">Active</Tag> : <Tag color="red">Inactive</Tag>),
    },
    {
      title: "Action",
      key: "action",
      width: 100,
      fixed: "right" as const,
      render: (_: any, record: any) => (
        <Space>
          {canEdit && <Button icon={<EditOutlined />} onClick={() => openEdit(record)} />}
          {canDelete && (
            <Popconfirm
              title="Deactivate this user?"
              disabled={record.user_id === currentUser?.user_id}
              onConfirm={() => handleDelete(record.user_id)}
            >
              <Button icon={<DeleteOutlined />} danger disabled={record.user_id === currentUser?.user_id} />
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
          <UserOutlined style={{ marginRight: 8 }} />
          User Management
        </span>
      }
      extra={
        <Space>
          <Input
            placeholder="Search username, email, name"
            prefix={<SearchOutlined />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
            style={{ width: 240 }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => loadRows()} />
          {canCreate && (
            <Tooltip title="Add User">
              <Button
                aria-label="Add User"
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
      <style>{`
        .compact-vehicle-table .ant-table { font-size: 12px; }
        .compact-vehicle-table .ant-table-thead > tr > th { font-size: 12px; padding: 6px 8px; }
        .compact-vehicle-table .ant-table-tbody > tr > td { font-size: 12px; padding: 6px 8px; }
      `}</style>

      <Table
        className="compact-vehicle-table"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={filteredRows}
        rowKey="user_id"
        bordered
        scroll={{ x: "max-content" }}
        pagination={{ pageSize: 20, showSizeChanger: true }}
      />

      <Modal
        title={editingRow ? "Edit User" : "Add User"}
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
            name="username"
            label="Username"
            rules={[{ required: true, message: "Please enter a username" }]}
          >
            <Input placeholder="e.g. jsmith" disabled={Boolean(editingRow)} />
          </Form.Item>
          <Form.Item
            name="email"
            label="Email"
            rules={[
              { required: true, message: "Please enter an email" },
              { type: "email", message: "Please enter a valid email" },
            ]}
          >
            <Input placeholder="e.g. jsmith@example.com" />
          </Form.Item>
          <Form.Item name="full_name" label="Full Name">
            <Input placeholder="Optional" />
          </Form.Item>
          <Form.Item
            name="company_id"
            label="Company Name"
            rules={[{ required: true, message: "Please select a company" }]}
            extra={
              companyOptions.length === 0
                ? "No companies configured yet -- add one under Settings > Wialon Credentials first."
                : undefined
            }
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="Select a company"
              options={companyOptions}
              notFoundContent="No companies configured"
            />
          </Form.Item>
          <Form.Item
            name="password"
            label={editingRow ? "Password" : "Password"}
            rules={
              editingRow
                ? [{ min: 8, message: "Password must be at least 8 characters" }]
                : [
                    { required: true, message: "Please enter a password" },
                    { min: 8, message: "Password must be at least 8 characters" },
                  ]
            }
            extra={editingRow ? "Leave blank to keep the current password" : undefined}
          >
            <Input.Password placeholder={editingRow ? "Leave blank to keep unchanged" : "At least 8 characters"} />
          </Form.Item>
          <Form.Item name="role_ids" label="Roles">
            <Select
              mode="multiple"
              placeholder="Assign one or more roles"
              options={roles.map((r) => ({ value: r.role_id, label: r.role_name }))}
              allowClear
            />
          </Form.Item>
          <Form.Item name="is_active" label="Active" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Space style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button icon={<CloseOutlined />} onClick={() => setIsModalVisible(false)}>
              Cancel
            </Button>
            <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving} style={{ backgroundColor: "#051650" }}>
              Save
            </Button>
          </Space>
        </Form>
      </Modal>
    </Card>
  );
}
