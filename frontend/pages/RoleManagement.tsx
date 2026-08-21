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
  Switch,
  Tag,
  Tooltip,
  Checkbox,
  Spin,
} from "antd";
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  SafetyCertificateOutlined,
  SaveOutlined,
  CloseOutlined,
  KeyOutlined,
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

interface PermissionOption {
  permission_id: number;
  permission_key: string;
  description: string | null;
}

interface MenuRow {
  menu_id: number;
  parent_menu_id: number | null;
  label: string;
}

export default function RoleManagement() {
  const { can } = useAuth();
  const canCreate = can("settings-roles", "create");
  const canEdit = can("settings-roles", "edit");
  const canDelete = can("settings-roles", "delete");

  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingRow, setEditingRow] = useState<any>(null);
  const [form] = Form.useForm();

  // Permission-matrix modal state
  const [permModalVisible, setPermModalVisible] = useState(false);
  const [permRole, setPermRole] = useState<any>(null);
  const [permLoading, setPermLoading] = useState(false);
  const [permSaving, setPermSaving] = useState(false);
  const [allMenus, setAllMenus] = useState<MenuRow[]>([]);
  const [permissionCatalog, setPermissionCatalog] = useState<PermissionOption[]>([]);
  const [grants, setGrants] = useState<Record<number, Set<string>>>({});

  useEffect(() => {
    loadRows();
  }, []);

  const loadRows = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/roles");
      if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
      const result = await response.json();
      setRows(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading roles:", error);
      notifyError("Couldn't load roles", error.message);
    } finally {
      setLoading(false);
    }
  };

  const openCreate = () => {
    setEditingRow(null);
    form.resetFields();
    form.setFieldsValue({ is_active: true });
    setIsModalVisible(true);
  };

  const openEdit = (record: any) => {
    setEditingRow(record);
    form.setFieldsValue({
      role_name: record.role_name,
      description: record.description,
      is_active: Boolean(record.is_active),
    });
    setIsModalVisible(true);
  };

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const isEditing = Boolean(editingRow);
      const url = isEditing ? `/api/roles/${editingRow.role_id}` : "/api/roles";
      const response = await fetch(url, {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const detail = errBody.detail || response.statusText;
        if (response.status === 409) {
          notifyError("Role already exists", detail);
          return;
        }
        throw new Error(detail);
      }
      notifySuccess(isEditing ? "Role updated" : "Role created");
      setIsModalVisible(false);
      setEditingRow(null);
      loadRows();
    } catch (error: any) {
      console.error("Error saving role:", error);
      notifyError("Save failed", error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const response = await fetch(`/api/roles/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess("Role deactivated");
      loadRows();
    } catch (error: any) {
      console.error("Error deactivating role:", error);
      notifyError("Deactivate failed", error.message);
    }
  };

  const openPermissions = async (record: any) => {
    setPermRole(record);
    setPermModalVisible(true);
    setPermLoading(true);
    try {
      const [menusRes, catalogRes, grantsRes] = await Promise.all([
        fetch("/api/menus"),
        fetch("/api/permissions"),
        fetch(`/api/roles/${record.role_id}/permissions`),
      ]);
      if (!menusRes.ok || !catalogRes.ok || !grantsRes.ok) {
        throw new Error("Could not load the permission matrix");
      }
      const menusResult = await menusRes.json();
      const catalogResult = await catalogRes.json();
      const grantsResult = await grantsRes.json();

      setAllMenus(Array.isArray(menusResult.data) ? menusResult.data : []);
      setPermissionCatalog(Array.isArray(catalogResult.data) ? catalogResult.data : []);

      const grantMap: Record<number, Set<string>> = {};
      for (const entry of grantsResult.data || []) {
        grantMap[entry.menu_id] = new Set(entry.permission_keys || []);
      }
      setGrants(grantMap);
    } catch (error: any) {
      console.error("Error loading permission matrix:", error);
      notifyError("Couldn't load permissions", error.message);
      setPermModalVisible(false);
    } finally {
      setPermLoading(false);
    }
  };

  const toggleGrant = (menuId: number, permissionKey: string, checked: boolean) => {
    setGrants((prev) => {
      const next = { ...prev };
      const set = new Set(next[menuId] || []);
      if (checked) set.add(permissionKey);
      else set.delete(permissionKey);
      next[menuId] = set;
      return next;
    });
  };

  const savePermissions = async () => {
    if (!permRole) return;
    setPermSaving(true);
    try {
      const body = {
        menus: allMenus.map((m) => ({
          menu_id: m.menu_id,
          permission_keys: Array.from(grants[m.menu_id] || []),
        })),
      };
      const response = await fetch(`/api/roles/${permRole.role_id}/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess("Permissions saved");
      setPermModalVisible(false);
    } catch (error: any) {
      console.error("Error saving permissions:", error);
      notifyError("Save failed", error.message);
    } finally {
      setPermSaving(false);
    }
  };

  // Order: each top-level menu immediately followed by its children
  // (indented), regardless of the order the API happened to return.
  const orderedMenuRows = useMemo(() => {
    const byParent: Record<number, MenuRow[]> = {};
    const topLevel: MenuRow[] = [];
    for (const m of allMenus) {
      if (m.parent_menu_id) {
        byParent[m.parent_menu_id] = byParent[m.parent_menu_id] || [];
        byParent[m.parent_menu_id].push(m);
      } else {
        topLevel.push(m);
      }
    }
    const out: { menu: MenuRow; indent: boolean }[] = [];
    for (const parent of topLevel) {
      out.push({ menu: parent, indent: false });
      for (const child of byParent[parent.menu_id] || []) {
        out.push({ menu: child, indent: true });
      }
    }
    return out;
  }, [allMenus]);

  const columns = [
    {
      title: "No",
      key: "no",
      width: 50,
      render: (_: any, __: any, index: number) => index + 1,
    },
    {
      title: "Role Name",
      dataIndex: "role_name",
      key: "role_name",
      sorter: (a: any, b: any) => String(a.role_name ?? "").localeCompare(String(b.role_name ?? "")),
    },
    { title: "Description", dataIndex: "description", key: "description", render: (v: string) => v || "-" },
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
      width: 160,
      render: (_: any, record: any) => (
        <Space>
          <Tooltip title="Assign Menus & Permissions">
            <Button icon={<KeyOutlined />} onClick={() => openPermissions(record)} />
          </Tooltip>
          {canEdit && <Button icon={<EditOutlined />} onClick={() => openEdit(record)} />}
          {canDelete && (
            <Popconfirm title="Deactivate this role?" onConfirm={() => handleDelete(record.role_id)}>
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
          <SafetyCertificateOutlined style={{ marginRight: 8 }} />
          Role Management
        </span>
      }
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => loadRows()} />
          {canCreate && (
            <Tooltip title="Add Role">
              <Button
                aria-label="Add Role"
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
        dataSource={rows}
        rowKey="role_id"
        bordered
        scroll={{ x: "max-content" }}
        pagination={{ pageSize: 20, showSizeChanger: true }}
      />

      <Modal
        title={editingRow ? "Edit Role" : "Add Role"}
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
            name="role_name"
            label="Role Name"
            rules={[{ required: true, message: "Please enter the role name" }]}
          >
            <Input placeholder="e.g. Manager" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} placeholder="Optional" />
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

      <Modal
        title={`Menus & Permissions -- ${permRole?.role_name || ""}`}
        open={permModalVisible}
        onCancel={() => setPermModalVisible(false)}
        footer={null}
        width={720}
        destroyOnClose
      >
        {permLoading ? (
          <div style={{ textAlign: "center", padding: 40 }}>
            <Spin />
          </div>
        ) : (
          <>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "2px solid #f0f0f0" }}>Menu</th>
                  {permissionCatalog.map((p) => (
                    <th key={p.permission_id} style={{ textAlign: "center", padding: "6px 8px", borderBottom: "2px solid #f0f0f0", width: 70 }}>
                      {p.permission_key.charAt(0).toUpperCase() + p.permission_key.slice(1)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orderedMenuRows.map(({ menu, indent }) => (
                  <tr key={menu.menu_id}>
                    <td style={{ padding: "6px 8px", paddingLeft: indent ? 28 : 8, borderBottom: "1px solid #f5f5f5", fontWeight: indent ? 400 : 600 }}>
                      {menu.label}
                    </td>
                    {permissionCatalog.map((p) => (
                      <td key={p.permission_id} style={{ textAlign: "center", padding: "6px 8px", borderBottom: "1px solid #f5f5f5" }}>
                        <Checkbox
                          checked={grants[menu.menu_id]?.has(p.permission_key) || false}
                          onChange={(e) => toggleGrant(menu.menu_id, p.permission_key, e.target.checked)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <Space style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
              <Button icon={<CloseOutlined />} onClick={() => setPermModalVisible(false)}>
                Cancel
              </Button>
              <Button type="primary" icon={<SaveOutlined />} loading={permSaving} onClick={savePermissions} style={{ backgroundColor: "#051650" }}>
                Save Permissions
              </Button>
            </Space>
          </>
        )}
      </Modal>
    </Card>
  );
}
