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
  FileTextOutlined,
  FileExcelOutlined,
  SaveOutlined,
  CloseOutlined,
} from "@ant-design/icons";
import { useAuth } from "../src/context/AuthContext";
import dayjs from "dayjs";
import ExcelJS from "exceljs";
import { getLogoBuffer } from "../src/utils/companyLogo";

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

const money = (v: number | null | undefined) => `$ ${Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

// "Ms. Chem Pisey" -- salutation (gender) first, with a trailing period,
// followed by the employee's name.
const staffName = (gender: string | null | undefined, name: string | null | undefined) => {
  const fullName = name ?? "";
  if (!gender) return fullName || "-";
  const salutation = gender.endsWith(".") ? gender : `${gender}.`;
  return `${salutation} ${fullName}`.trim() || "-";
};

export default function PayrollEntryManagement() {
  const { can } = useAuth();
  const canCreate = can("payroll-entries", "create");
  const canEdit = can("payroll-entries", "edit");
  const canDelete = can("payroll-entries", "delete");
  const canExport = can("payroll-entries", "export");
  const [rows, setRows] = useState<any[]>([]);
  const [employees, setEmployees] = useState<any[]>([]);
  const [periods, setPeriods] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingRow, setEditingRow] = useState<any>(null);
  const [filterPeriod, setFilterPeriod] = useState<number | undefined>(undefined);
  const [searchText, setSearchText] = useState("");
  const [exportLoading, setExportLoading] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    loadEmployees();
    loadPeriods();
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

  const loadPeriods = async () => {
    try {
      const response = await fetch("/api/payroll-periods");
      if (!response.ok) throw new Error(`Failed to fetch periods: ${response.statusText}`);
      const result = await response.json();
      const loadedPeriods = Array.isArray(result.data) ? result.data : [];
      setPeriods(loadedPeriods);

      // Default the period filter to the current month's period, if one exists.
      const now = dayjs();
      const currentPeriod = loadedPeriods.find(
        (p: any) => p.period_year === now.year() && p.period_month === now.month() + 1
      );
      if (currentPeriod) {
        setFilterPeriod(currentPeriod.payroll_period_id);
        loadRows(currentPeriod.payroll_period_id);
      } else {
        loadRows(undefined);
      }
    } catch (error: any) {
      console.error("Error loading payroll periods:", error);
      notifyError("Couldn't load payroll periods", error.message);
      loadRows(undefined);
    }
  };

  const loadRows = async (periodId: number | undefined = filterPeriod) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (periodId != null) params.append("payroll_period_id", String(periodId));
      const response = await fetch(`/api/payroll-entries?${params}`);
      if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
      const result = await response.json();
      setRows(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading payroll entries:", error);
      notifyError("Couldn't load payroll entries", error.message);
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

  const periodLabel = (id: number) => {
    const p = periods.find((x) => x.payroll_period_id === id);
    return p ? `${MONTH_NAMES[p.period_month - 1] ?? p.period_month} ${p.period_year}` : `#${id}`;
  };

  const filteredRows = useMemo(() => {
    if (!searchText.trim()) return rows;
    const q = searchText.trim().toLowerCase();
    return rows.filter(
      (r) =>
        employeeName(r.employee_id).toLowerCase().includes(q) ||
        String(r.notes ?? "").toLowerCase().includes(q)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, searchText, employees]);

  const openCreate = () => {
    setEditingRow(null);
    form.resetFields();
    const now = dayjs();
    const currentPeriod = periods.find(
      (p) => p.period_year === now.year() && p.period_month === now.month() + 1
    );
    form.setFieldsValue({
      ot_hours: 0,
      ot_amount: 0,
      other_allowance: 0,
      payroll_period_id: currentPeriod?.payroll_period_id ?? filterPeriod,
    });
    setIsModalVisible(true);
  };

  const openEdit = (record: any) => {
    setEditingRow(record);
    form.setFieldsValue({
      employee_id: record.employee_id,
      payroll_period_id: record.payroll_period_id,
      ot_hours: Number(record.ot_hours ?? 0),
      ot_amount: Number(record.ot_amount ?? 0),
      other_allowance: Number(record.other_allowance ?? 0),
      notes: record.notes ?? "",
    });
    setIsModalVisible(true);
  };

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const payload = {
        employee_id: values.employee_id,
        payroll_period_id: values.payroll_period_id,
        ot_hours: values.ot_hours ?? 0,
        ot_amount: values.ot_amount ?? 0,
        other_allowance: values.other_allowance ?? 0,
        notes: values.notes || undefined,
      };
      const isEditing = Boolean(editingRow);
      const url = isEditing
        ? `/api/payroll-entries/${editingRow.payroll_entry_id}`
        : "/api/payroll-entries";
      const response = await fetch(url, {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const detail = errBody.detail || response.statusText;
        if (response.status === 409) {
          notifyError("Duplicate entry", detail);
          return;
        }
        throw new Error(detail);
      }
      notifySuccess(isEditing ? "Payroll entry updated" : "Payroll entry added");
      setIsModalVisible(false);
      setEditingRow(null);
      loadRows();
    } catch (error: any) {
      console.error("Error saving payroll entry:", error);
      notifyError("Save failed", error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const response = await fetch(`/api/payroll-entries/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess("Payroll entry deleted");
      loadRows();
    } catch (error: any) {
      console.error("Error deleting payroll entry:", error);
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
      title: "Period",
      dataIndex: "payroll_period_id",
      key: "payroll_period_id",
      render: (v: number) => periodLabel(v),
      sorter: (a: any, b: any) => Number(a.payroll_period_id) - Number(b.payroll_period_id),
    },
    {
      title: "OT Hours",
      dataIndex: "ot_hours",
      key: "ot_hours",
      render: (v: number) => Number(v).toFixed(2),
      sorter: (a: any, b: any) => Number(a.ot_hours ?? 0) - Number(b.ot_hours ?? 0),
    },
    {
      title: "OT Amount",
      dataIndex: "ot_amount",
      key: "ot_amount",
      render: (v: number) => `$${Number(v).toFixed(2)}`,
      sorter: (a: any, b: any) => Number(a.ot_amount ?? 0) - Number(b.ot_amount ?? 0),
    },
    {
      title: "Other Allowance",
      dataIndex: "other_allowance",
      key: "other_allowance",
      render: (v: number) => `$${Number(v).toFixed(2)}`,
      sorter: (a: any, b: any) => Number(a.other_allowance ?? 0) - Number(b.other_allowance ?? 0),
    },
    { title: "Notes", dataIndex: "notes", key: "notes", render: (v: string) => v ?? "-" },
    {
      title: "Action",
      key: "action",
      width: 100,
      render: (_: any, record: any) => (
        <Space>
          {canEdit && <Button icon={<EditOutlined />} onClick={() => openEdit(record)} />}
          {canDelete && (
            <Popconfirm
              title="Delete this payroll entry?"
              onConfirm={() => handleDelete(record.payroll_entry_id)}
            >
              <Button icon={<DeleteOutlined />} danger />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  // Sum of currency-related columns across every filtered row.
  const totals = useMemo(
    () => ({
      ot_amount: filteredRows.reduce((sum, r) => sum + Number(r.ot_amount ?? 0), 0),
      other_allowance: filteredRows.reduce((sum, r) => sum + Number(r.other_allowance ?? 0), 0),
    }),
    [filteredRows]
  );

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
      const sheet = workbook.addWorksheet("Payroll Entries");

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
      titleCell.value = "Payroll Entries";
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
          case "payroll_period_id":
            return periodLabel(record.payroll_period_id);
          case "ot_hours":
            return Number(record.ot_hours ?? 0);
          case "ot_amount":
            return Number(record.ot_amount ?? 0);
          case "other_allowance":
            return Number(record.other_allowance ?? 0);
          case "notes":
            return record.notes ?? "";
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

      const staffNameIdx = exportColumns.findIndex((col) => col.key === "staff_name");
      const otAmountIdx = exportColumns.findIndex((col) => col.key === "ot_amount");
      const otherAllowanceIdx = exportColumns.findIndex((col) => col.key === "other_allowance");
      if (staffNameIdx !== -1 || otAmountIdx !== -1 || otherAllowanceIdx !== -1) {
        const totalRow = sheet.getRow(currentRow);
        if (staffNameIdx !== -1) {
          const cell = totalRow.getCell(staffNameIdx + 1);
          cell.value = "TOTAL";
          cell.font = { bold: true };
        }
        if (otAmountIdx !== -1) {
          const cell = totalRow.getCell(otAmountIdx + 1);
          cell.value = totals.ot_amount;
          cell.font = { bold: true };
        }
        if (otherAllowanceIdx !== -1) {
          const cell = totalRow.getCell(otherAllowanceIdx + 1);
          cell.value = totals.other_allowance;
          cell.font = { bold: true };
        }
        for (let c = 1; c <= exportColumns.length; c++) {
          const cell = totalRow.getCell(c);
          cell.border = thinBorder;
          cell.alignment = { vertical: "middle" };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F5F5" } };
        }
        currentRow += 1;
      }

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
      link.download = `PayrollEntries_${dayjs().format("YYYY-MM-DD")}.xlsx`;
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
          <FileTextOutlined style={{ marginRight: 8 }} />
          Payroll Entries
        </span>
      }
      extra={
        <Space>
          <Input
            allowClear
            placeholder="Search employee or notes..."
            style={{ width: 200 }}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="Filter by period..."
            style={{ width: 180 }}
            value={filterPeriod}
            onChange={(value) => {
              setFilterPeriod(value);
              loadRows(value);
            }}
            options={periods.map((p) => ({
              label: `${MONTH_NAMES[p.period_month - 1] ?? p.period_month} ${p.period_year}`,
              value: p.payroll_period_id,
            }))}
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
            <Tooltip title="Add Entry">
              <Button
                aria-label="Add Entry"
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
        rowKey="payroll_entry_id"
        bordered
        pagination={{ pageSize: 20, showSizeChanger: true }}
        summary={() => (
          <Table.Summary fixed>
            <Table.Summary.Row>
              {columns.map((col, idx) => {
                const key = col.key as string;
                let content: React.ReactNode = null;
                if (key === "staff_name") content = <strong>TOTAL</strong>;
                else if (key === "ot_amount") content = <strong>{money(totals.ot_amount)}</strong>;
                else if (key === "other_allowance") content = <strong>{money(totals.other_allowance)}</strong>;
                return (
                  <Table.Summary.Cell key={key} index={idx} align={key === "staff_name" ? "left" : "center"}>
                    {content}
                  </Table.Summary.Cell>
                );
              })}
            </Table.Summary.Row>
          </Table.Summary>
        )}
      />

      <Modal
        title={editingRow ? "Edit Payroll Entry" : "Add Payroll Entry"}
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
            name="payroll_period_id"
            label="Payroll Period"
            rules={[{ required: true, message: "Please select a period" }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="Select a period..."
              options={periods.map((p) => ({
                label: `${MONTH_NAMES[p.period_month - 1] ?? p.period_month} ${p.period_year}`,
                value: p.payroll_period_id,
              }))}
            />
          </Form.Item>
          <Form.Item name="ot_hours" label="OT Hours">
            <InputNumber style={{ width: "100%" }} min={0} step={0.25} />
          </Form.Item>
          <Form.Item name="ot_amount" label="OT Amount">
            <InputNumber style={{ width: "100%" }} min={0} step={0.01} />
          </Form.Item>
          <Form.Item name="other_allowance" label="Other Allowance">
            <InputNumber style={{ width: "100%" }} min={0} step={0.01} />
          </Form.Item>
          <Form.Item name="notes" label="Notes">
            <Input placeholder="Optional note" />
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
