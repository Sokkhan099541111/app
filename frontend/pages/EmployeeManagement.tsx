import { useEffect, useMemo, useState } from "react";
import {
  Card,
  Table,
  Button,
  Space,
  Modal,
  Popconfirm,
  notification,
  Select,
  Input,
  Tag,
  Popover,
  Checkbox,
  Divider,
  Tooltip,
  message,
} from "antd";
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  SearchOutlined,
  ReloadOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  TeamOutlined,
  FileExcelOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import ExcelJS from "exceljs";
import { getLogoBuffer } from "../src/utils/companyLogo";
import { useAuth } from "../src/context/AuthContext";
import EmployeeForm from "./EmployeeForm";
import type { EmployeeFormValues, OptionRecord } from "./EmployeeForm";
import type { VehicleOption } from "./VehicleOperationLogForm";

const DATE_FORMAT = "YYYY-MM-DD";

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

type StatusFilter = "Active" | "Inactive" | "Terminated" | "All";

const money = (v: number | null | undefined) =>
  `$ ${Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

// "Ms. Chem Pisey" -- salutation (gender) first, with a trailing period,
// followed by the full name.
const staffName = (record: any) => {
  const fullName = record?.full_name ?? "";
  const gender = record?.gender ?? "";
  if (!gender) return fullName || "-";
  const salutation = gender.endsWith(".") ? gender : `${gender}.`;
  return `${salutation} ${fullName}`.trim() || "-";
};

// Ordered to match the table's column order: Code, Staff Name, Phone
// Number, Driving License, Position, Department, Assign To, Hire Date,
// Basic Salary, Termination Date, Employment Status, Action.
const TOGGLEABLE_COLUMNS = [
  { key: "phone_number", label: "Phone Number" },
  { key: "driving_license", label: "Driving License" },
  { key: "position_title", label: "Position" },
  { key: "department_name", label: "Department" },
  { key: "vehicles_id", label: "Assign To" },
  { key: "hire_date", label: "Hire Date" },
  { key: "basic_salary", label: "Basic Salary" },
  { key: "termination_date", label: "Termination Date" },
];
const ALL_TOGGLEABLE_KEYS = TOGGLEABLE_COLUMNS.map((c) => c.key);
// Show everything by default -- the list is short enough that Manage
// Columns is mainly for hiding, not revealing.
const DEFAULT_VISIBLE_KEYS = ALL_TOGGLEABLE_KEYS;

export default function EmployeeManagement() {
  const { can } = useAuth();
  const canCreate = can("employees", "create");
  const canEdit = can("employees", "edit");
  const canDelete = can("employees", "delete");
  const canExport = can("employees", "export");

  const [employees, setEmployees] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);

  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<any>(null);

  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [visibleColumns, setVisibleColumns] = useState<string[]>(DEFAULT_VISIBLE_KEYS);

  const [departments, setDepartments] = useState<any[]>([]);
  const [positions, setPositions] = useState<any[]>([]);
  const [vehicleOptions, setVehicleOptions] = useState<VehicleOption[]>([]);

  const [filterName, setFilterName] = useState("");
  const [filterVehicleId, setFilterVehicleId] = useState<number | undefined>(undefined);
  const [filterStatus, setFilterStatus] = useState<StatusFilter>("Active");

  useEffect(() => {
    loadDepartments();
    loadPositions();
    loadVehicleOptions();
    loadEmployees();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadVehicleOptions = async () => {
    try {
      const response = await fetch("/api/vehicle-logs/vehicle-options");
      if (!response.ok) throw new Error(`Failed to fetch vehicles: ${response.statusText}`);
      const result = await response.json();
      setVehicleOptions(Array.isArray(result.vehicles) ? result.vehicles : []);
    } catch (error) {
      console.error("Error loading vehicle options:", error);
      notifyError("Couldn't load vehicles", "Could not load the vehicle list.");
    }
  };

  const loadDepartments = async () => {
    try {
      const response = await fetch("/api/departments");
      if (!response.ok) throw new Error(`Failed to fetch departments: ${response.statusText}`);
      const result = await response.json();
      setDepartments(Array.isArray(result.data) ? result.data : []);
    } catch (error) {
      console.error("Error loading departments:", error);
      notifyError("Couldn't load departments", "Could not load the department list.");
    }
  };

  const loadPositions = async () => {
    try {
      const response = await fetch("/api/positions");
      if (!response.ok) throw new Error(`Failed to fetch positions: ${response.statusText}`);
      const result = await response.json();
      setPositions(Array.isArray(result.data) ? result.data : []);
    } catch (error) {
      console.error("Error loading positions:", error);
      notifyError("Couldn't load positions", "Could not load the position list.");
    }
  };

  const departmentOptions: OptionRecord[] = departments.map((d) => ({
    label: d.name,
    value: d.department_id,
  }));
  const positionOptions: OptionRecord[] = positions.map((p) => ({
    label: p.title,
    value: p.position_id,
  }));

  const loadEmployees = async (
    name: string = filterName,
    status: StatusFilter = filterStatus,
    vehicleId: number | undefined = filterVehicleId
  ) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (name) params.append("full_name", name);
      if (vehicleId != null) params.append("vehicle_id", String(vehicleId));
      if (status !== "All") params.append("status", status);

      const response = await fetch(`/api/employees?${params}`);
      if (!response.ok) throw new Error(`Failed to fetch employees: ${response.statusText}`);
      const result = await response.json();
      setEmployees(Array.isArray(result.data) ? result.data : []);
      setCurrentPage(1);
    } catch (error) {
      console.error("Error loading employees:", error);
      notifyError("Couldn't load employees", "Could not load the employee list.");
    } finally {
      setLoading(false);
    }
  };

  const handleFilterSearch = () => {
    loadEmployees(filterName, filterStatus, filterVehicleId);
  };

  const handleRefresh = () => {
    loadDepartments();
    loadPositions();
    loadVehicleOptions();
    loadEmployees(filterName, filterStatus, filterVehicleId);
  };

  const handleSave = async (values: EmployeeFormValues) => {
    setSaving(true);
    try {
      const isEditing = Boolean(editingEmployee);
      const url = isEditing
        ? `/api/employees/${editingEmployee.employee_id}`
        : "/api/employees";
      const response = await fetch(url, {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const detail = errBody.detail || response.statusText;
        if (response.status === 409) {
          notifyError("Duplicate record", detail);
          return;
        }
        throw new Error(detail);
      }

      notifySuccess(
        isEditing ? "Employee updated" : "Employee created",
        isEditing
          ? "The employee record was updated successfully."
          : "The new employee was saved successfully."
      );
      setIsModalVisible(false);
      setEditingEmployee(null);
      loadEmployees();
    } catch (error: any) {
      console.error("Error saving employee:", error);
      notifyError("Save failed", error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (employeeId: number) => {
    try {
      const response = await fetch(`/api/employees/${employeeId}`, { method: "DELETE" });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess("Employee terminated", "The record was kept for audit history.");
      loadEmployees();
    } catch (error: any) {
      console.error("Error deleting employee:", error);
      notifyError("Delete failed", error.message);
    }
  };

  const toggleColumn = (key: string) => {
    setVisibleColumns((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };
  const showAllColumns = () => setVisibleColumns(ALL_TOGGLEABLE_KEYS);
  const hideAllColumns = () => setVisibleColumns([]);

  const statusColor = (status: string) => {
    if (status === "Active") return "green";
    if (status === "Inactive") return "gold";
    return "default";
  };

  const vehicleDisplay = (vehiclesId: number | null | undefined) => {
    if (vehiclesId == null) return "-";
    const match = vehicleOptions.find((v) => v.id === vehiclesId);
    return match ? match.name : String(vehiclesId);
  };

  const allColumns = [
    {
      title: "No",
      key: "no",
      width: 60,
      fixed: "left" as const,
      render: (_: any, __: any, index: number) => index + 1,
    },
    {
      title: "Code",
      dataIndex: "employee_code",
      key: "employee_code",
      fixed: "left" as const,
      render: (v: string) => v ?? "-",
      sorter: (a: any, b: any) => String(a.employee_code ?? "").localeCompare(String(b.employee_code ?? "")),
    },
    {
      title: "Staff Name",
      key: "staff_name",
      fixed: "left" as const,
      render: (_: any, record: any) => staffName(record),
      sorter: (a: any, b: any) => String(a.full_name ?? "").localeCompare(String(b.full_name ?? "")),
    },
    { title: "Phone Number", dataIndex: "phone_number", key: "phone_number" },
    {
      title: "Driving License",
      dataIndex: "driving_license",
      key: "driving_license",
      render: (v: string) => v ?? "-",
    },
    {
      title: "Position",
      dataIndex: "position_title",
      key: "position_title",
      sorter: (a: any, b: any) => String(a.position_title ?? "").localeCompare(String(b.position_title ?? "")),
      render: (v: string) => v ?? "-",
    },
    {
      title: "Department",
      dataIndex: "department_name",
      key: "department_name",
      sorter: (a: any, b: any) => String(a.department_name ?? "").localeCompare(String(b.department_name ?? "")),
      render: (v: string) => v ?? "-",
    },
    {
      title: "Assign To",
      dataIndex: "vehicles_id",
      key: "vehicles_id",
      render: (v: number | null) => vehicleDisplay(v),
    },
    {
      title: "Hire Date",
      dataIndex: "hire_date",
      key: "hire_date",
      sorter: (a: any, b: any) => String(a.hire_date ?? "").localeCompare(String(b.hire_date ?? "")),
      render: (v: string) => v ?? "-",
    },
    {
      title: "Basic Salary",
      dataIndex: "basic_salary",
      key: "basic_salary",
      sorter: (a: any, b: any) => (a.basic_salary ?? 0) - (b.basic_salary ?? 0),
      render: (v: number) => (v != null ? `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : "-"),
    },
    {
      title: "Termination Date",
      dataIndex: "termination_date",
      key: "termination_date",
      render: (v: string) => v ?? "-",
    },
    {
      title: "Employment Status",
      dataIndex: "employment_status",
      key: "employment_status",
      render: (status: string) => <Tag color={statusColor(status)}>{status?.toUpperCase()}</Tag>,
    },
    {
      title: "Action",
      key: "action",
      fixed: "right" as const,
      width: 100,
      render: (_: any, record: any) => (
        <Space>
          {canEdit && (
            <Button
              icon={<EditOutlined />}
              onClick={() => {
                setEditingEmployee(record);
                setIsModalVisible(true);
              }}
            />
          )}
          {canDelete && record.employment_status !== "Terminated" && (
            <Popconfirm
              title="Terminate this employee?"
              description="This marks the employee Terminated -- the record is kept for audit history."
              onConfirm={() => handleDelete(record.employee_id)}
            >
              <Button icon={<DeleteOutlined />} danger />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const isColumnVisible = (key?: string) =>
    !key ||
    key === "no" ||
    key === "employee_code" ||
    key === "staff_name" ||
    key === "employment_status" ||
    key === "action" ||
    visibleColumns.includes(key);

  const columns = allColumns.filter((col) => isColumnVisible(col.key));

  // Sum of currency-related columns across every filtered employee (not
  // just the current page) -- Basic Salary is currently the only one.
  const totals = useMemo(
    () => ({
      basic_salary: employees.reduce((sum, e) => sum + Number(e.basic_salary ?? 0), 0),
    }),
    [employees]
  );

  const columnPickerContent = (
    <div style={{ maxHeight: 320, overflowY: "auto", width: 240 }}>
      <Space style={{ marginBottom: 8 }}>
        <a onClick={showAllColumns}>Select all</a>
        <Divider type="vertical" />
        <a onClick={hideAllColumns}>Clear all</a>
      </Space>
      {TOGGLEABLE_COLUMNS.map((item) => (
        <div key={item.key} style={{ padding: "2px 0" }}>
          <Checkbox
            checked={visibleColumns.includes(item.key)}
            onChange={() => toggleColumn(item.key)}
          >
            {item.label}
          </Checkbox>
        </div>
      ))}
    </div>
  );

  const formatCellValue = (key: string, record: any, index: number): string | number => {
    switch (key) {
      case "no":
        return index + 1;
      case "employee_code":
        return record.employee_code ?? "";
      case "staff_name":
        return staffName(record);
      case "vehicles_id":
        return vehicleDisplay(record.vehicles_id);
      case "department_name":
        return record.department_name ?? "";
      case "position_title":
        return record.position_title ?? "";
      case "phone_number":
        return record.phone_number ?? "";
      case "driving_license":
        return record.driving_license ?? "";
      case "hire_date":
        return record.hire_date ?? "";
      case "basic_salary":
        return record.basic_salary != null ? Number(record.basic_salary) : "";
      case "termination_date":
        return record.termination_date ?? "";
      case "employment_status":
        return record.employment_status ?? "";
      default:
        return "";
    }
  };

  const handleExportExcel = async () => {
    if (employees.length === 0) {
      message.warning("There is no data to export.");
      return;
    }

    setExportLoading(true);
    try {
      const exportColumns = columns.filter((col) => col.key !== "action");
      const totalColumns = Math.max(exportColumns.length, 4);

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Employees");

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
      titleCell.value = "Employees";
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

      employees.forEach((record, index) => {
        const row = sheet.getRow(currentRow);
        exportColumns.forEach((col, colIdx) => {
          const cell = row.getCell(colIdx + 1);
          cell.value = formatCellValue(col.key as string, record, index);
          cell.alignment = { vertical: "middle" };
          cell.border = thinBorder;
        });
        currentRow += 1;
      });

      const staffNameIdx = exportColumns.findIndex((col) => col.key === "staff_name");
      const basicSalaryIdx = exportColumns.findIndex((col) => col.key === "basic_salary");
      if (staffNameIdx !== -1 || basicSalaryIdx !== -1) {
        const totalRow = sheet.getRow(currentRow);
        if (staffNameIdx !== -1) {
          const cell = totalRow.getCell(staffNameIdx + 1);
          cell.value = "TOTAL";
          cell.font = { bold: true };
        }
        if (basicSalaryIdx !== -1) {
          const cell = totalRow.getCell(basicSalaryIdx + 1);
          cell.value = totals.basic_salary;
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
      link.download = `Employees_${dayjs().format(DATE_FORMAT)}.xlsx`;
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
    <Card>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 16,
          marginBottom: 16,
          padding: "12px 16px",
          background: "#fafafa",
          border: "1px solid #f0f0f0",
          borderRadius: 8,
        }}
      >
        <span style={{ fontSize: 16, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
          <TeamOutlined style={{ marginRight: 8 }} />
          Employees
        </span>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 10,
            marginLeft: "auto",
          }}
        >
          <Input
            placeholder="Search name..."
            value={filterName}
            onChange={(e) => setFilterName(e.target.value)}
            allowClear
            style={{ width: 170, flexShrink: 0 }}
          />

          <Select
            allowClear
            showSearch
            value={filterVehicleId}
            onChange={(value) => setFilterVehicleId(value)}
            placeholder="Filter by vehicle..."
            optionFilterProp="label"
            style={{ width: 180, flexShrink: 0 }}
            options={vehicleOptions.map((v) => ({ value: v.id, label: v.name }))}
          />

          <Select
            value={filterStatus}
            onChange={(value) => setFilterStatus(value)}
            style={{ width: 130, flexShrink: 0 }}
            options={[
              { label: "Active", value: "Active" },
              { label: "Inactive", value: "Inactive" },
              { label: "Terminated", value: "Terminated" },
              { label: "All", value: "All" },
            ]}
          />

          <Tooltip title="Search">
            <Button
              aria-label="Search"
              type="primary"
              icon={<SearchOutlined />}
              onClick={handleFilterSearch}
              style={{ flexShrink: 0 }}
            />
          </Tooltip>

          <Tooltip title="Refresh">
            <Button aria-label="Refresh" icon={<ReloadOutlined />} onClick={handleRefresh} style={{ flexShrink: 0 }} />
          </Tooltip>

          {canExport && (
            <Tooltip title="Export Excel">
              <Button
                aria-label="Export Excel"
                icon={<FileExcelOutlined />}
                onClick={handleExportExcel}
                loading={exportLoading}
                disabled={employees.length === 0}
                style={{ background: "#217346", borderColor: "#217346", color: "#fff", flexShrink: 0 }}
              />
            </Tooltip>
          )}

          <Popover content={columnPickerContent} title="Show / hide columns" trigger="click" placement="bottomRight">
            <Tooltip title="Manage columns">
              <Button aria-label="Manage columns" icon={<SettingOutlined />} style={{ flexShrink: 0 }} />
            </Tooltip>
          </Popover>

          {canCreate && (
            <Tooltip title="Add Employee">
              <Button
                aria-label="Add Employee"
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => {
                  setEditingEmployee(null);
                  setIsModalVisible(true);
                }}
                style={{ backgroundColor: "#051650", flexShrink: 0 }}
              />
            </Tooltip>
          )}
        </div>
      </div>

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
        dataSource={employees}
        rowKey="employee_id"
        bordered
        scroll={{ x: "max-content" }}
        pagination={{
          current: currentPage,
          pageSize: pageSize,
          showSizeChanger: true,
          pageSizeOptions: ["10", "20", "50", "100"],
          showQuickJumper: true,
          showTotal: (total) => `Total ${total} Employees`,
          onChange: (page, size) => {
            setCurrentPage(page);
            setPageSize(size);
          },
        }}
        summary={() => (
          <Table.Summary fixed>
            <Table.Summary.Row>
              {columns.map((col, idx) => {
                const key = col.key as string;
                let content: React.ReactNode = null;
                if (key === "staff_name") content = <strong>TOTAL</strong>;
                else if (key === "basic_salary") content = <strong>{money(totals.basic_salary)}</strong>;
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
        title={
          <Space>
            {editingEmployee ? (
              <EditOutlined style={{ color: "#051650" }} />
            ) : (
              <PlusOutlined style={{ color: "#051650" }} />
            )}
            {editingEmployee ? "Edit Employee" : "Create Employee"}
          </Space>
        }
        open={isModalVisible}
        onCancel={() => {
          setIsModalVisible(false);
          setEditingEmployee(null);
        }}
        footer={null}
        destroyOnClose
        width={860}
      >
        <EmployeeForm
          initialValues={editingEmployee}
          departmentOptions={departmentOptions}
          positionOptions={positionOptions}
          vehicleOptions={vehicleOptions}
          onSave={handleSave}
          onCancel={() => {
            setIsModalVisible(false);
            setEditingEmployee(null);
          }}
          saving={saving}
        />
      </Modal>
    </Card>
  );
}
