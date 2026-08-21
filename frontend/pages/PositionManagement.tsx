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
  Select,
  Tooltip,
} from "antd";
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  IdcardOutlined,
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

export default function PositionManagement() {
  const { can } = useAuth();
  const canCreate = can("positions", "create");
  const canEdit = can("positions", "edit");
  const canDelete = can("positions", "delete");

  const [rows, setRows] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingRow, setEditingRow] = useState<any>(null);
  const [searchText, setSearchText] = useState("");
  const [filterDepartment, setFilterDepartment] = useState<number | undefined>(undefined);
  const [form] = Form.useForm();

  useEffect(() => {
    loadDepartments();
    loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDepartments = async () => {
    try {
      const response = await fetch("/api/departments");
      if (!response.ok) throw new Error(`Failed to fetch departments: ${response.statusText}`);
      const result = await response.json();
      setDepartments(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading departments:", error);
      notifyError("Couldn't load departments", error.message);
    }
  };

  const loadRows = async (departmentId: number | undefined = filterDepartment) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (departmentId != null) params.append("department_id", String(departmentId));
      const response = await fetch(`/api/positions?${params}`);
      if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
      const result = await response.json();
      setRows(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading positions:", error);
      notifyError("Couldn't load positions", error.message);
    } finally {
      setLoading(false);
    }
  };

  const departmentName = (id: number | null) => {
    if (id == null) return "-";
    const d = departments.find((x) => x.department_id === id);
    return d ? d.name : `#${id}`;
  };

  const filteredRows = useMemo(() => {
    if (!searchText.trim()) return rows;
    const q = searchText.trim().toLowerCase();
    return rows.filter((r) => String(r.title ?? "").toLowerCase().includes(q));
  }, [rows, searchText]);

  const openCreate = () => {
    setEditingRow(null);
    form.resetFields();
    setIsModalVisible(true);
  };

  const openEdit = (record: any) => {
    setEditingRow(record);
    form.setFieldsValue({ title: record.title, department_id: record.department_id });
    setIsModalVisible(true);
  };

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const isEditing = Boolean(editingRow);
      const url = isEditing ? `/api/positions/${editingRow.position_id}` : "/api/positions";
      const response = await fetch(url, {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const detail = errBody.detail || response.statusText;
        if (response.status === 409) {
          notifyError("Duplicate position", detail);
          return;
        }
        throw new Error(detail);
      }
      notifySuccess(isEditing ? "Position updated" : "Position added");
      setIsModalVisible(false);
      setEditingRow(null);
      loadRows();
    } catch (error: any) {
      console.error("Error saving position:", error);
      notifyError("Save failed", error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const response = await fetch(`/api/positions/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess("Position deleted");
      loadRows();
    } catch (error: any) {
      console.error("Error deleting position:", error);
      notifyError("Delete failed", error.message);
    }
  };

  const columns = [
    {
      title: "No",
      key: "no",
      width: 60,
      fixed: "left" as const,
      render: (_: any, __: any, index: number) => index + 1,
    },
    {
      title: "Position Title",
      dataIndex: "title",
      key: "title",
      sorter: (a: any, b: any) => String(a.title).localeCompare(String(b.title)),
    },
    {
      title: "Department",
      dataIndex: "department_id",
      key: "department_id",
      render: (v: number | null) => departmentName(v),
      sorter: (a: any, b: any) => departmentName(a.department_id).localeCompare(departmentName(b.department_id)),
    },
    {
      title: "Action",
      key: "action",
      width: 100,
      render: (_: any, record: any) => (
        <Space>
          {canEdit && <Button icon={<EditOutlined />} onClick={() => openEdit(record)} />}
          {canDelete && (
            <Popconfirm
              title="Delete this position?"
              description="Blocked if any employees are assigned to it."
              onConfirm={() => handleDelete(record.position_id)}
            >
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
          <IdcardOutlined style={{ marginRight: 8 }} />
          Positions
        </span>
      }
      extra={
        <Space>
          <Input
            allowClear
            placeholder="Search positions..."
            prefix={<SearchOutlined />}
            style={{ width: 200 }}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
          <Select
            allowClear
            placeholder="Filter by department..."
            style={{ width: 200 }}
            value={filterDepartment}
            onChange={(value) => {
              setFilterDepartment(value);
              loadRows(value);
            }}
            options={departments.map((d) => ({ label: d.name, value: d.department_id }))}
          />
          <Button icon={<ReloadOutlined />} onClick={() => loadRows()} />
          {canCreate && (
            <Tooltip title="Add Position">
              <Button
                aria-label="Add Position"
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
        .compact-vehicle-table .ant-table {
          font-size: 12px;
        }
        .compact-vehicle-table .ant-table-thead > tr > th {
          font-size: 12px;
          padding: 6px 8px;
        }
        .compact-vehicle-table .ant-table-tbody > tr > td {
          font-size: 12px;
          padding: 6px 8px;
        }
      `}</style>

      <Table
        className="compact-vehicle-table"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={filteredRows}
        rowKey="position_id"
        bordered
        pagination={{ pageSize: 20, showSizeChanger: true }}
      />

      <Modal
        title={editingRow ? "Edit Position" : "Add Position"}
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
            name="title"
            label="Position Title"
            rules={[{ required: true, message: "Please enter a position title" }]}
          >
            <Input placeholder="e.g. Team Leader" />
          </Form.Item>
          <Form.Item name="department_id" label="Department">
            <Select
              allowClear
              placeholder="Select a department..."
              options={departments.map((d) => ({ label: d.name, value: d.department_id }))}
            />
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
