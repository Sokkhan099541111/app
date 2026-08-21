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
  DatePicker,
  InputNumber,
  Input,
  Select,
  Tooltip,
  message,
} from "antd";
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  DollarOutlined,
  FileExcelOutlined,
  SaveOutlined,
  CloseOutlined,
} from "@ant-design/icons";
import { useAuth } from "../src/context/AuthContext";
import dayjs from "dayjs";
import ExcelJS from "exceljs";
import { getLogoBuffer } from "../src/utils/companyLogo";

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

// "Ms. Chem Pisey" -- salutation (gender) first, with a trailing period,
// followed by the employee's name.
const staffName = (gender: string | null | undefined, name: string | null | undefined) => {
  const fullName = name ?? "";
  if (!gender) return fullName || "-";
  const salutation = gender.endsWith(".") ? gender : `${gender}.`;
  return `${salutation} ${fullName}`.trim() || "-";
};

export default function SalaryHistoryManagement() {
  const { can } = useAuth();
  const canCreate = can("payroll-salary-history", "create");
  const canEdit = can("payroll-salary-history", "edit");
  const canDelete = can("payroll-salary-history", "delete");
  const canExport = can("payroll-salary-history", "export");
  const [rows, setRows] = useState<any[]>([]);
  const [employees, setEmployees] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingRow, setEditingRow] = useState<any>(null);
  const [filterEmployee, setFilterEmployee] = useState<number | undefined>(undefined);
  const [searchText, setSearchText] = useState("");
  const [exportLoading, setExportLoading] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    loadEmployees();
    loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadEmployees = async () => {
    try {
      const response = await fetch("/api/employees?status=All");
      if (!response.ok) throw new Error(`Failed to fetch employees: ${response.statusText}`);
      const result = await response.json();
      setEmployees(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading employees:", error);
      notifyError("Couldn't load employees", error.message);
    }
  };

  const loadRows = async (employeeId: number | undefined = filterEmployee) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (employeeId != null) params.append("employee_id", String(employeeId));
      const response = await fetch(`/api/salary-history?${params}`);
      if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
      const result = await response.json();
      setRows(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading salary history:", error);
      notifyError("Couldn't load salary history", error.message);
    } finally {
      setLoading(false);
    }
  };

  const employeeName = (id: number) => {
    const e = employees.find((x) => x.employee_id === id);
    return e ? e.full_name : `#${id}`;
  };

  const employeeCode = (id: number) => {
    const e = employees.find((x) => x.employee_id === id);
    return e ? e.employee_code : "-";
  };

  const employeeGender = (id: number) => {
    const e = employees.find((x) => x.employee_id === id);
    return e ? e.gender : "-";
  };

  const filteredRows = useMemo(() => {
    if (!searchText.trim()) return rows;
    const q = searchText.trim().toLowerCase();
    return rows.filter(
      (r) =>
        employeeName(r.employee_id).toLowerCase().includes(q) ||
        String(r.note ?? "").toLowerCase().includes(q)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, searchText, employees]);

  const openCreate = () => {
    setEditingRow(null);
    form.resetFields();
    setIsModalVisible(true);
  };

  const openEdit = (record: any) => {
    setEditingRow(record);
    form.setFieldsValue({
      employee_id: record.employee_id,
      basic_salary: Number(record.basic_salary ?? 0),
      effective_date: record.effective_date ? dayjs(record.effective_date) : null,
      note: record.note ?? "",
    });
    setIsModalVisible(true);
  };

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const payload = {
        employee_id: values.employee_id,
        basic_salary: values.basic_salary,
        effective_date: values.effective_date.format("YYYY-MM-DD"),
        note: values.note || undefined,
      };
      const isEditing = Boolean(editingRow);
      const url = isEditing
        ? `/api/salary-history/${editingRow.salary_history_id}`
        : "/api/salary-history";
      const response = await fetch(url, {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const detail = errBody.detail || response.statusText;
        if (response.status === 409) {
          notifyError("Duplicate row", detail);
          return;
        }
        throw new Error(detail);
      }
      notifySuccess(isEditing ? "Salary history updated" : "Salary history added");
      setIsModalVisible(false);
      setEditingRow(null);
      loadRows();
    } catch (error: any) {
      console.error("Error saving salary history:", error);
      notifyError("Save failed", error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const response = await fetch(`/api/salary-history/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess("Salary history row deleted");
      loadRows();
    } catch (error: any) {
      console.error("Error deleting salary history row:", error);
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
      title: "Code",
      dataIndex: "employee_id",
      key: "employee_code",
      render: (v: number) => employeeCode(v),
      sorter: (a: any, b: any) => employeeCode(a.employee_id).localeCompare(employeeCode(b.employee_id)),
    },
    {
      title: "Staff Name",
      dataIndex: "employee_id",
      key: "staff_name",
      render: (v: number) => staffName(employeeGender(v), employeeName(v)),
      sorter: (a: any, b: any) => employeeName(a.employee_id).localeCompare(employeeName(b.employee_id)),
    },
    {
      title: "Basic Salary",
      dataIndex: "basic_salary",
      key: "basic_salary",
      render: (v: number) => `$${Number(v).toFixed(2)}`,
      sorter: (a: any, b: any) => Number(a.basic_salary ?? 0) - Number(b.basic_salary ?? 0),
    },
    {
      title: "Effective Date",
      dataIndex: "effective_date",
      key: "effective_date",
      sorter: (a: any, b: any) => String(a.effective_date).localeCompare(String(b.effective_date)),
    },
    { title: "Note", dataIndex: "note", key: "note", render: (v: string) => v ?? "-" },
    {
      title: "Action",
      key: "action",
      width: 100,
      render: (_: any, record: any) => (
        <Space>
          {canEdit && <Button icon={<EditOutlined />} onClick={() => openEdit(record)} />}
          {canDelete && (
            <Popconfirm
              title="Delete this salary history row?"
              onConfirm={() => handleDelete(record.salary_history_id)}
            >
              <Button icon={<DeleteOutlined />} danger />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const handleExportExcel = async () => {
    if (filteredRows.length === 0) {
      message.warning("There is no data to export.");
      return;
    }

    setExportLoading(true);
    try {
      const exportColumns = columns.filter((col) => col.key !== "action");
      const totalColumns = Math.max(exportColumns.length, 4);

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Salary History");

      const thinBorder = {
        top: { style: "thin" as const },
        left: { style: "thin" as const },
        bottom: { style: "thin" as const },
        right: { style: "thin" as const },
      };
      const headerFill = {
        type: "pattern" as const,
        pattern: "solid" as const,
        fgColor: { argb: "FFE6E6E6" },
      };

      const logoBuffer = await getLogoBuffer();
      const logoImageId = workbook.addImage({
        buffer: logoBuffer as any,
        extension: "png",
      });
      sheet.addImage(logoImageId, {
        tl: { col: 0, row: 0 },
        ext: { width: 90, height: 55 },
      });
      sheet.getRow(1).height = 42;

      sheet.mergeCells(1, 2, 1, totalColumns);
      const titleCell = sheet.getCell(1, 2);
      titleCell.value = "Salary History";
      titleCell.font = { size: 16, bold: true };
      titleCell.alignment = { vertical: "middle", horizontal: "center" };

      sheet.getRow(2).height = 8;

      let currentRow = 3;
      const headerRow = sheet.getRow(currentRow);
      exportColumns.forEach((col, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = col.title as string;
        cell.font = { bold: true };
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.fill = headerFill;
        cell.border = thinBorder;
      });
      currentRow += 1;

      const cellValue = (key: string, record: any, index: number): string | number => {
        switch (key) {
          case "no":
            return index + 1;
          case "employee_code":
            return employeeCode(record.employee_id);
          case "staff_name":
            return staffName(employeeGender(record.employee_id), employeeName(record.employee_id));
          case "basic_salary":
            return Number(record.basic_salary ?? 0);
          case "effective_date":
            return record.effective_date ?? "";
          case "note":
            return record.note ?? "";
          default:
            return "";
        }
      };

      filteredRows.forEach((record, index) => {
        const row = sheet.getRow(currentRow);
        exportColumns.forEach((col, colIdx) => {
          const cell = row.getCell(colIdx + 1);
          cell.value = cellValue(col.key as string, record, index);
          cell.alignment = { vertical: "middle" };
          cell.border = thinBorder;
        });
        currentRow += 1;
      });

      exportColumns.forEach((col, i) => {
        sheet.getColumn(i + 1).width = Math.max(String(col.title).length + 4, 14);
      });

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `SalaryHistory_${dayjs().format("YYYY-MM-DD")}.xlsx`;
      link.click();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Error exporting to Excel:", error);
      message.error("Failed to export Excel file.");
    } finally {
      setExportLoading(false);
    }
  };

  return (
    <Card
      title={
        <span>
          <DollarOutlined style={{ marginRight: 8 }} />
          Salary History
        </span>
      }
      extra={
        <Space>
          <Input
            allowClear
            placeholder="Search employee or note..."
            style={{ width: 200 }}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
          <Select
            allowClear
            showSearch
            placeholder="Filter by employee..."
            optionFilterProp="label"
            style={{ width: 220 }}
            value={filterEmployee}
            onChange={(value) => {
              setFilterEmployee(value);
              loadRows(value);
            }}
            options={employees.map((e) => ({ label: e.full_name, value: e.employee_id }))}
          />
          <Button icon={<ReloadOutlined />} onClick={() => loadRows()} />
          {canExport && (
            <Tooltip title="Export Excel">
              <Button
                aria-label="Export Excel"
                icon={<FileExcelOutlined />}
                onClick={handleExportExcel}
                loading={exportLoading}
                disabled={filteredRows.length === 0}
                style={{ background: "#217346", borderColor: "#217346", color: "#fff" }}
              />
            </Tooltip>
          )}
          {canCreate && (
            <Tooltip title="Add Salary Change">
              <Button
                aria-label="Add Salary Change"
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
        rowKey="salary_history_id"
        bordered
        pagination={{ pageSize: 20, showSizeChanger: true }}
      />

      <Modal
        title={editingRow ? "Edit Salary History Row" : "Add Salary History Row"}
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
            name="employee_id"
            label="Employee"
            rules={[{ required: true, message: "Please select an employee" }]}
          >
            <Select
              showSearch
              placeholder="Select an employee..."
              optionFilterProp="label"
              options={employees.map((e) => ({ label: e.full_name, value: e.employee_id }))}
            />
          </Form.Item>
          <Form.Item
            name="basic_salary"
            label="Basic Salary"
            rules={[{ required: true, message: "Please enter the basic salary" }]}
          >
            <InputNumber style={{ width: "100%" }} min={0} step={0.01} />
          </Form.Item>
          <Form.Item
            name="effective_date"
            label="Effective Date"
            rules={[{ required: true, message: "Please pick the effective date" }]}
          >
            <DatePicker style={{ width: "100%" }} format="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item name="note" label="Note">
            <Input placeholder="e.g. Annual raise" />
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
