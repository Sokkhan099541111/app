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
  InputNumber,
  Select,
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
  CalendarOutlined,
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

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export default function PayrollPeriodManagement() {
  const { can } = useAuth();
  const canCreate = can("payroll-periods", "create");
  const canEdit = can("payroll-periods", "edit");
  const canDelete = can("payroll-periods", "delete");
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingRow, setEditingRow] = useState<any>(null);
  const [filterStatus, setFilterStatus] = useState<string | undefined>(undefined);
  const [form] = Form.useForm();

  useEffect(() => {
    loadRows();
  }, []);

  const loadRows = async (status: string | undefined = filterStatus) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status) params.append("status", status);
      const response = await fetch(`/api/payroll-periods?${params}`);
      if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
      const result = await response.json();
      setRows(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading payroll periods:", error);
      notifyError("Couldn't load payroll periods", error.message);
    } finally {
      setLoading(false);
    }
  };

  const openCreate = () => {
    setEditingRow(null);
    form.resetFields();
    form.setFieldsValue({ status: "Open", period_year: new Date().getFullYear() });
    setIsModalVisible(true);
  };

  const openEdit = (record: any) => {
    setEditingRow(record);
    form.setFieldsValue({
      period_year: record.period_year,
      period_month: record.period_month,
      status: record.status,
    });
    setIsModalVisible(true);
  };

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const isEditing = Boolean(editingRow);
      const url = isEditing
        ? `/api/payroll-periods/${editingRow.payroll_period_id}`
        : "/api/payroll-periods";
      const response = await fetch(url, {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const detail = errBody.detail || response.statusText;
        if (response.status === 409) {
          notifyError("Duplicate period", detail);
          return;
        }
        throw new Error(detail);
      }
      notifySuccess(isEditing ? "Payroll period updated" : "Payroll period created");
      setIsModalVisible(false);
      setEditingRow(null);
      loadRows();
    } catch (error: any) {
      console.error("Error saving payroll period:", error);
      notifyError("Save failed", error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const response = await fetch(`/api/payroll-periods/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess("Payroll period deleted");
      loadRows();
    } catch (error: any) {
      console.error("Error deleting payroll period:", error);
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
      title: "Period",
      key: "period",
      render: (_: any, r: any) => `${MONTH_NAMES[r.period_month - 1] ?? r.period_month} ${r.period_year}`,
      sorter: (a: any, b: any) => a.period_year * 100 + a.period_month - (b.period_year * 100 + b.period_month),
    },
    {
      title: "Start Date",
      dataIndex: "start_date",
      key: "start_date",
      sorter: (a: any, b: any) => String(a.start_date).localeCompare(String(b.start_date)),
    },
    { title: "End Date", dataIndex: "end_date", key: "end_date" },
    {
      title: "Total Working Days",
      dataIndex: "total_working_days",
      key: "total_working_days",
      sorter: (a: any, b: any) => Number(a.total_working_days ?? 0) - Number(b.total_working_days ?? 0),
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      sorter: (a: any, b: any) => String(a.status).localeCompare(String(b.status)),
      render: (v: string) => <Tag color={v === "Open" ? "green" : "default"}>{v}</Tag>,
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
              title="Delete this payroll period?"
              description="Blocked if attendance or payroll entries already reference it."
              onConfirm={() => handleDelete(record.payroll_period_id)}
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
          <CalendarOutlined style={{ marginRight: 8 }} />
          Payroll Periods
        </span>
      }
      extra={
        <Space>
          <Select
            allowClear
            placeholder="Filter by status..."
            style={{ width: 150 }}
            value={filterStatus}
            onChange={(value) => {
              setFilterStatus(value);
              loadRows(value);
            }}
            options={[
              { label: "Open", value: "Open" },
              { label: "Closed", value: "Closed" },
            ]}
          />
          <Tooltip title="Refresh">
            <Button aria-label="Refresh" icon={<ReloadOutlined />} onClick={() => loadRows()} />
          </Tooltip>
          {canCreate && (
            <Tooltip title="Add Period">
              <Button
                aria-label="Add Period"
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
        dataSource={rows}
        rowKey="payroll_period_id"
        bordered
        pagination={{ pageSize: 20, showSizeChanger: true }}
      />

      <Modal
        title={editingRow ? "Edit Payroll Period" : "Add Payroll Period"}
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
            name="period_year"
            label="Year"
            rules={[{ required: true, message: "Please enter the year" }]}
          >
            <InputNumber style={{ width: "100%" }} disabled />
          </Form.Item>
          <Form.Item
            name="period_month"
            label="Month"
            rules={[{ required: true, message: "Please select the month" }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              options={MONTH_NAMES.map((name, i) => ({
                label: name,
                value: i + 1,
              }))}
            />
          </Form.Item>
          <Form.Item name="status" label="Status">
            <Select
              options={[
                { label: "Open", value: "Open" },
                { label: "Closed", value: "Closed" },
              ]}
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
