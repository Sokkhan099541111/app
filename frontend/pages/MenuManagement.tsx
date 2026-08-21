import { useEffect, useMemo, useState } from "react";
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
  MenuOutlined,
  SaveOutlined,
  CloseOutlined,
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

// Matches the icon names AdminLayout.tsx knows how to render (see its
// ICON_MAP) -- kept as a plain string Select so a typo here just falls back
// to a generic icon in the sidebar rather than breaking anything.
const ICON_OPTIONS = [
  "DashboardOutlined", "CarOutlined", "UserOutlined", "FileTextOutlined", "SettingOutlined",
  "DollarOutlined", "TeamOutlined", "ApartmentOutlined", "IdcardOutlined", "ToolOutlined",
  "CalendarOutlined", "ShopOutlined", "DollarCircleOutlined", "TableOutlined", "TagOutlined",
  "CalculatorOutlined", "ContactsOutlined", "WalletOutlined", "FundOutlined", "KeyOutlined",
  "SafetyCertificateOutlined", "MenuOutlined",
];

export default function MenuManagement() {
  const { can } = useAuth();
  const canCreate = can("settings-menus", "create");
  const canEdit = can("settings-menus", "edit");
  const canDelete = can("settings-menus", "delete");

  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingRow, setEditingRow] = useState<any>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    loadRows();
  }, []);

  const loadRows = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/menus");
      if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
      const result = await response.json();
      setRows(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading menus:", error);
      notifyError("Couldn't load menus", error.message);
    } finally {
      setLoading(false);
    }
  };

  const openCreate = () => {
    setEditingRow(null);
    form.resetFields();
    form.setFieldsValue({ is_active: true, display_order: 0 });
    setIsModalVisible(true);
  };

  const openEdit = (record: any) => {
    setEditingRow(record);
    form.setFieldsValue({
      parent_menu_id: record.parent_menu_id || undefined,
      menu_key: record.menu_key,
      label: record.label,
      path: record.path,
      icon: record.icon,
      display_order: record.display_order,
      is_active: Boolean(record.is_active),
    });
    setIsModalVisible(true);
  };

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const isEditing = Boolean(editingRow);
      const url = isEditing ? `/api/menus/${editingRow.menu_id}` : "/api/menus";
      const payload = { ...values, parent_menu_id: values.parent_menu_id ?? null, path: values.path || null, icon: values.icon || null };
      const response = await fetch(url, {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const detail = errBody.detail || response.statusText;
        if (response.status === 409) {
          notifyError("Menu key already exists", detail);
          return;
        }
        throw new Error(detail);
      }
      notifySuccess(isEditing ? "Menu updated" : "Menu created");
      setIsModalVisible(false);
      setEditingRow(null);
      loadRows();
    } catch (error: any) {
      console.error("Error saving menu:", error);
      notifyError("Save failed", error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const response = await fetch(`/api/menus/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess("Menu deactivated");
      loadRows();
    } catch (error: any) {
      console.error("Error deactivating menu:", error);
      notifyError("Deactivate failed", error.message);
    }
  };

  // Ordered so every top-level menu is immediately followed by its own
  // children (indented) -- same convention as RoleManagement's matrix.
  const orderedRows = useMemo(() => {
    const byParent: Record<number, any[]> = {};
    const topLevel: any[] = [];
    for (const m of rows) {
      if (m.parent_menu_id) {
        byParent[m.parent_menu_id] = byParent[m.parent_menu_id] || [];
        byParent[m.parent_menu_id].push(m);
      } else {
        topLevel.push(m);
      }
    }
    Object.values(byParent).forEach((list) => list.sort((a, b) => a.display_order - b.display_order));
    topLevel.sort((a, b) => a.display_order - b.display_order);
    const out: any[] = [];
    for (const parent of topLevel) {
      out.push({ ...parent, __indent: false });
      for (const child of byParent[parent.menu_id] || []) {
        out.push({ ...child, __indent: true });
      }
    }
    return out;
  }, [rows]);

  const parentOptions = rows
    .filter((m) => !m.parent_menu_id)
    .map((m) => ({ value: m.menu_id, label: m.label }));

  const columns = [
    {
      title: "Label",
      dataIndex: "label",
      key: "label",
      render: (v: string, record: any) => (
        <span style={{ paddingLeft: record.__indent ? 24 : 0, fontWeight: record.__indent ? 400 : 600 }}>{v}</span>
      ),
    },
    { title: "Menu Key", dataIndex: "menu_key", key: "menu_key" },
    { title: "Path", dataIndex: "path", key: "path", render: (v: string) => v || "-" },
    { title: "Icon", dataIndex: "icon", key: "icon", render: (v: string) => v || "-" },
    { title: "Order", dataIndex: "display_order", key: "display_order", width: 70 },
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
      render: (_: any, record: any) => (
        <Space>
          {canEdit && <Button icon={<EditOutlined />} onClick={() => openEdit(record)} />}
          {canDelete && (
            <Popconfirm title="Deactivate this menu?" description="Its submenus (if any) are not automatically deactivated." onConfirm={() => handleDelete(record.menu_id)}>
              <Button icon={<DeleteOutlined />} danger />
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
          <MenuOutlined style={{ marginRight: 8 }} />
          Menu Management
        </span>
      }
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => loadRows()} />
          {canCreate && (
            <Tooltip title="Add Menu">
              <Button
                aria-label="Add Menu"
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
        dataSource={orderedRows}
        rowKey="menu_id"
        bordered
        scroll={{ x: "max-content" }}
        pagination={{ pageSize: 30, showSizeChanger: true }}
      />

      <Modal
        title={editingRow ? "Edit Menu" : "Add Menu"}
        open={isModalVisible}
        onCancel={() => {
          setIsModalVisible(false);
          setEditingRow(null);
        }}
        footer={null}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Form.Item name="parent_menu_id" label="Parent Menu">
            <Select placeholder="None -- this is a top-level menu" options={parentOptions} allowClear />
          </Form.Item>
          <Form.Item
            name="menu_key"
            label="Menu Key"
            rules={[{ required: true, message: "Please enter a unique menu key" }]}
          >
            <Input placeholder="e.g. settings-vendors" disabled={Boolean(editingRow)} />
          </Form.Item>
          <Form.Item name="label" label="Label" rules={[{ required: true, message: "Please enter the display label" }]}>
            <Input placeholder="e.g. Vendors" />
          </Form.Item>
          <Form.Item name="path" label="Route Path">
            <Input placeholder="e.g. /vendors -- leave blank for a group with no page of its own" />
          </Form.Item>
          <Form.Item name="icon" label="Icon">
            <Select placeholder="Optional" options={ICON_OPTIONS.map((i) => ({ value: i, label: i }))} allowClear showSearch />
          </Form.Item>
          <Form.Item name="display_order" label="Display Order">
            <InputNumber style={{ width: "100%" }} />
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
