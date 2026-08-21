import { useEffect, useState } from "react";
import {
  Card,
  Table,
  Button,
  Space,
  Modal,
  Popconfirm,
  notification,
  Select,
  DatePicker,
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
  FileTextOutlined,
  FileExcelOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import ExcelJS from "exceljs";
import { getLogoBuffer } from "../src/utils/companyLogo";
import { useAuth } from "../src/context/AuthContext";
import VehicleOperationLogForm from "./VehicleOperationLogForm";
import type {
  VehicleOption,
  VehicleOperationLogFormValues,
} from "./VehicleOperationLogForm";

const { RangePicker } = DatePicker;
const DATE_FORMAT = "YYYY-MM-DD";

// Consistent, more prominent success/error toasts (card-style with icon +
// title + description) instead of antd's plain single-line `message`.
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

type StatusFilter = "Active" | "Inactive" | "All";

// Toggleable columns for the "Manage Columns" picker. "No", "Status" and
// "Action" are intentionally left out -- always shown.
const TOGGLEABLE_COLUMNS = [
  { key: "operation_date", label: "Date" },
  { key: "vehicle_id", label: "Plate Number" },
  { key: "vehicle_type", label: "Vehicle Type" },
  { key: "start_time", label: "Start Time" },
  { key: "end_time", label: "End Time" },
  { key: "working_hours", label: "Working Hours" },
  { key: "initial_mileage", label: "Initial Mileage" },
  { key: "final_mileage", label: "Final Mileage" },
  { key: "total_mileage", label: "Total Mileage" },
  { key: "fuel_filling_liters", label: "Fuel Filled (L)" },
  { key: "remarks", label: "Remarks" },
];
const ALL_TOGGLEABLE_KEYS = TOGGLEABLE_COLUMNS.map((c) => c.key);

export default function VehicleOperationLogManagement() {
  const { can } = useAuth();
  const canCreate = can("operation-logs", "create");
  const canEdit = can("operation-logs", "edit");
  const canDelete = can("operation-logs", "delete");
  const canExport = can("operation-logs", "export");

  const [logs, setLogs] = useState<any[]>([]);
  const [vehicleOptions, setVehicleOptions] = useState<VehicleOption[]>([]);
  const [vehicleTypes, setVehicleTypes] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);

  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingLog, setEditingLog] = useState<any>(null);

  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [visibleColumns, setVisibleColumns] = useState<string[]>(ALL_TOGGLEABLE_KEYS);

  // Filters -- status defaults to "Active" so soft-deleted logs stay
  // hidden unless the user explicitly asks to see them. Date range
  // defaults to yesterday on first load (see useEffect below).
  const [filterVehicleId, setFilterVehicleId] = useState<number | undefined>(undefined);
  const [filterDateRange, setFilterDateRange] = useState<[string, string] | null>(null);
  const [filterStatus, setFilterStatus] = useState<StatusFilter>("Active");

  useEffect(() => {
    const yesterday = dayjs().subtract(1, "day").format(DATE_FORMAT);
    const defaultRange: [string, string] = [yesterday, yesterday];
    setFilterDateRange(defaultRange);

    loadVehicleOptions();
    loadVehicleTypes();
    loadLogs(filterVehicleId, defaultRange, filterStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadVehicleOptions = async () => {
    try {
      const response = await fetch("/api/vehicle-logs/vehicle-options");
      if (!response.ok) throw new Error(`Failed to fetch vehicles: ${response.statusText}`);
      const data = await response.json();
      setVehicleOptions(Array.isArray(data.vehicles) ? data.vehicles : []);
    } catch (error) {
      console.error("Error loading vehicle options:", error);
      notifyError("Couldn't load vehicles", "Could not load the vehicle list from Wialon.");
    }
  };

  const loadVehicleTypes = async () => {
    try {
      const response = await fetch("/api/vehicle-logs/vehicle-types");
      if (!response.ok) throw new Error(`Failed to fetch vehicle types: ${response.statusText}`);
      const data = await response.json();
      setVehicleTypes(data.vehicle_types || {});
    } catch (error) {
      console.error("Error loading vehicle types:", error);
    }
  };

  const loadLogs = async (
    vehicleId: number | undefined = filterVehicleId,
    dateRange: [string, string] | null = filterDateRange,
    status: StatusFilter = filterStatus
  ) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (vehicleId) params.append("vehicle_id", String(vehicleId));
      if (dateRange) {
        params.append("start", dateRange[0]);
        params.append("end", dateRange[1]);
      }
      params.append("status", status);

      const response = await fetch(`/api/vehicle-logs?${params}`);
      if (!response.ok) throw new Error(`Failed to fetch logs: ${response.statusText}`);
      const result = await response.json();
      setLogs(Array.isArray(result.data) ? result.data : []);
      setCurrentPage(1);
    } catch (error) {
      console.error("Error loading vehicle logs:", error);
      notifyError("Couldn't load logs", "Could not load the operation log list.");
    } finally {
      setLoading(false);
    }
  };

  const handleFilterSearch = () => {
    loadLogs(filterVehicleId, filterDateRange, filterStatus);
  };

  // Reloads the latest data using whatever filters are currently set --
  // unlike the old "Reset" behavior, this does NOT clear the filters.
  const handleRefresh = () => {
    loadLogs(filterVehicleId, filterDateRange, filterStatus);
  };

  const vehicleName = (vehicleId: number) =>
    vehicleOptions.find((v) => v.id === vehicleId)?.name ?? vehicleId;

  const vehicleType = (vehicleId: number) => vehicleTypes[vehicleId] || "-";

  const handleSave = async (values: VehicleOperationLogFormValues) => {
    setSaving(true);
    try {
      const isEditing = Boolean(editingLog);
      const url = isEditing ? `/api/vehicle-logs/${editingLog.log_id}` : "/api/vehicle-logs";
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
        isEditing ? "Log updated" : "Log created",
        isEditing
          ? "The operation log was updated successfully."
          : "The new operation log was saved successfully."
      );
      setIsModalVisible(false);
      setEditingLog(null);
      loadLogs();
    } catch (error: any) {
      console.error("Error saving log:", error);
      notifyError("Save failed", error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (logId: number) => {
    try {
      const response = await fetch(`/api/vehicle-logs/${logId}`, { method: "DELETE" });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess("Log marked inactive", "The record was kept for audit history.");
      loadLogs();
    } catch (error: any) {
      console.error("Error deleting log:", error);
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

  const allColumns = [
    {
      title: "No",
      key: "no",
      width: 60,
      fixed: "left" as const,
      render: (_: any, __: any, index: number) => index + 1,
    },
    {
      title: "Date",
      dataIndex: "operation_date",
      key: "operation_date",
      sorter: (a: any, b: any) => String(a.operation_date).localeCompare(String(b.operation_date)),
    },
    {
      title: "Plate Number",
      dataIndex: "vehicle_id",
      key: "vehicle_id",
      fixed: "left" as const,
      sorter: (a: any, b: any) =>
        String(vehicleName(a.vehicle_id)).localeCompare(String(vehicleName(b.vehicle_id))),
      render: (vehicleId: number) => vehicleName(vehicleId),
    },
    {
      title: "Vehicle Type",
      dataIndex: "vehicle_id",
      key: "vehicle_type",
      sorter: (a: any, b: any) =>
        String(vehicleType(a.vehicle_id)).localeCompare(String(vehicleType(b.vehicle_id))),
      render: (vehicleId: number) => vehicleType(vehicleId),
    },
    {
      title: "Start Time",
      dataIndex: "start_time",
      key: "start_time",
      render: (v: string) => (v ? dayjs(v).format("HH:mm") : "-"),
    },
    {
      title: "End Time",
      dataIndex: "end_time",
      key: "end_time",
      render: (v: string) => (v ? dayjs(v).format("HH:mm") : "-"),
    },
    {
      title: "Working Hours",
      dataIndex: "working_hours",
      key: "working_hours",
      sorter: (a: any, b: any) => (a.working_hours ?? 0) - (b.working_hours ?? 0),
      render: (v: number) => (v != null ? `${Number(v).toFixed(2)} h` : "-"),
    },
    {
      title: "Initial Mileage",
      dataIndex: "initial_mileage",
      key: "initial_mileage",
      render: (v: number) => (v != null ? `${Number(v).toLocaleString()} km` : "-"),
    },
    {
      title: "Final Mileage",
      dataIndex: "final_mileage",
      key: "final_mileage",
      render: (v: number) => (v != null ? `${Number(v).toLocaleString()} km` : "-"),
    },
    {
      title: "Total Mileage",
      dataIndex: "total_mileage",
      key: "total_mileage",
      render: (v: string) => (v ? `${Number(v).toLocaleString()} km` : "-"),
    },
    {
      title: "Fuel Filled (L)",
      dataIndex: "fuel_filling_liters",
      key: "fuel_filling_liters",
      render: (v: number) => (v != null ? `${Number(v).toLocaleString()} l` : "-"),
    },
    { title: "Remarks", dataIndex: "remarks", key: "remarks" },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (status: string) => (
        <Tag color={status === "Active" ? "green" : "default"}>{status?.toUpperCase()}</Tag>
      ),
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
                setEditingLog(record);
                setIsModalVisible(true);
              }}
            />
          )}
          {canDelete && record.status === "Active" && (
            <Popconfirm
              title="Remove this log?"
              description="This marks the log Inactive -- it's kept for audit history and can be viewed via the Status filter."
              onConfirm={() => handleDelete(record.log_id)}
            >
              <Button icon={<DeleteOutlined />} danger />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const isColumnVisible = (key?: string) =>
    !key || key === "no" || key === "status" || key === "action" || visibleColumns.includes(key);

  const columns = allColumns.filter((col) => isColumnVisible(col.key));

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

  // Mirrors each column's on-screen render() formatting so the export
  // shows the same values as the table (only for currently visible
  // columns, in the same left-to-right order).
  const formatCellValue = (key: string, record: any, index: number): string | number => {
    switch (key) {
      case "no":
        return index + 1;
      case "vehicle_id":
        return vehicleName(record.vehicle_id);
      case "vehicle_type":
        return vehicleType(record.vehicle_id);
      case "operation_date":
        return record.operation_date ?? "";
      case "start_time":
        return record.start_time ? dayjs(record.start_time).format("HH:mm") : "-";
      case "end_time":
        return record.end_time ? dayjs(record.end_time).format("HH:mm") : "-";
      case "working_hours":
        return record.working_hours != null ? `${Number(record.working_hours).toFixed(2)} h` : "-";
      case "initial_mileage":
        return record.initial_mileage != null
          ? `${Number(record.initial_mileage).toLocaleString()} km`
          : "-";
      case "final_mileage":
        return record.final_mileage != null
          ? `${Number(record.final_mileage).toLocaleString()} km`
          : "-";
      case "total_mileage":
        return record.total_mileage ? `${Number(record.total_mileage).toLocaleString()} km` : "-";
      case "fuel_filling_liters":
        return record.fuel_filling_liters != null
          ? `${Number(record.fuel_filling_liters).toLocaleString()} l`
          : "-";
      case "remarks":
        return record.remarks ?? "";
      case "status":
        return record.status ?? "";
      default:
        return "";
    }
  };

  // Builds a .xlsx mirroring the currently visible columns/rows exactly
  // as shown on screen (respecting Manage Columns + active filters).
  //
  // Header layout matches the Daily Activities report: SNKRP logo top-left
  // + centered title (title + selected date range, e.g. "Vehicle Operation
  // Logs 25-Jul-2026 to 25-Jul-2026") on row 1, then the (bordered, shaded)
  // column header row, then the data.
  const handleExportExcel = async () => {
    if (logs.length === 0) {
      message.warning("There is no data to export.");
      return;
    }

    setExportLoading(true);
    try {
      const exportColumns = columns.filter((col) => col.key !== "action");
      const totalColumns = Math.max(exportColumns.length, 4);

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Vehicle Operation Logs");

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

      // --- Row 1: logo (top-left) + centered "title + date range" -----
      const dateRangeText = filterDateRange
        ? `${dayjs(filterDateRange[0]).format("DD-MMM-YYYY")} to ${dayjs(filterDateRange[1]).format(
            "DD-MMM-YYYY"
          )}`
        : "All Dates";

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
      titleCell.value = `Vehicle Operation Logs ${dateRangeText}`;
      titleCell.font = { size: 16, bold: true };
      titleCell.alignment = { vertical: "middle", horizontal: "center" };

      sheet.getRow(2).height = 8; // spacer, matches Daily Activities

      let currentRow = 3;

      // --- Column header row --------------------------------------------
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

      // --- Data rows ------------------------------------------------------
      logs.forEach((record, index) => {
        const row = sheet.getRow(currentRow);
        exportColumns.forEach((col, colIdx) => {
          const cell = row.getCell(colIdx + 1);
          cell.value = formatCellValue(col.key as string, record, index);
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
      link.download = `Vehicle_Operation_Logs_${dayjs().format(DATE_FORMAT)}.xlsx`;
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
          gap: 10,
          marginBottom: 16,
          padding: "12px 16px",
          background: "#fafafa",
          border: "1px solid #f0f0f0",
          borderRadius: 8,
        }}
      >
        <span style={{ fontSize: 16, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
          <FileTextOutlined style={{ marginRight: 8 }} />
          Vehicle Operation Logs
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
          <Select
            placeholder="Filter by plate number..."
            value={filterVehicleId}
            onChange={setFilterVehicleId}
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ width: 200, flexShrink: 0 }}
            options={vehicleOptions.map((v) => ({ label: v.name, value: v.id }))}
          />

          <RangePicker
            value={
              filterDateRange
                ? [dayjs(filterDateRange[0]), dayjs(filterDateRange[1])]
                : null
            }
            onChange={(_, dateStrings) => {
              if (dateStrings[0] && dateStrings[1]) {
                setFilterDateRange([dateStrings[0], dateStrings[1]]);
              } else {
                setFilterDateRange(null);
              }
            }}
            style={{ flexShrink: 0 }}
          />

          <Select
            value={filterStatus}
            onChange={(value) => setFilterStatus(value)}
            style={{ width: 130, flexShrink: 0 }}
            options={[
              { label: "Active", value: "Active" },
              { label: "Inactive", value: "Inactive" },
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
            <Button
              aria-label="Refresh"
              icon={<ReloadOutlined />}
              onClick={handleRefresh}
              style={{ flexShrink: 0 }}
            />
          </Tooltip>

          {canExport && (
            <Tooltip title="Export Excel">
              <Button
                aria-label="Export Excel"
                icon={<FileExcelOutlined />}
                onClick={handleExportExcel}
                loading={exportLoading}
                disabled={logs.length === 0}
                style={{
                  background: "#217346",
                  borderColor: "#217346",
                  color: "#fff",
                  flexShrink: 0,
                }}
              />
            </Tooltip>
          )}

          <Popover
            content={columnPickerContent}
            title="Show / hide columns"
            trigger="click"
            placement="bottomRight"
          >
            <Tooltip title="Manage columns">
              <Button aria-label="Manage columns" icon={<SettingOutlined />} style={{ flexShrink: 0 }} />
            </Tooltip>
          </Popover>

          {canCreate && (
            <Tooltip title="Add Log">
              <Button
                aria-label="Add Log"
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => {
                  setEditingLog(null);
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
        dataSource={logs}
        rowKey="log_id"
        bordered
        scroll={{ x: "max-content" }}
        pagination={{
          current: currentPage,
          pageSize: pageSize,
          showSizeChanger: true,
          pageSizeOptions: ["10", "20", "50", "100"],
          showQuickJumper: true,
          showTotal: (total) => `Total ${total} Logs`,
          onChange: (page, size) => {
            setCurrentPage(page);
            setPageSize(size);
          },
        }}
      />

      <Modal
        title={
          <Space>
            {editingLog ? (
              <EditOutlined style={{ color: "#051650" }} />
            ) : (
              <PlusOutlined style={{ color: "#051650" }} />
            )}
            {editingLog ? "Edit Operation Log" : "Create Operation Log"}
          </Space>
        }
        open={isModalVisible}
        onCancel={() => {
          setIsModalVisible(false);
          setEditingLog(null);
        }}
        footer={null}
        destroyOnClose
        width={720}
      >
        <VehicleOperationLogForm
          initialValues={editingLog}
          vehicleOptions={vehicleOptions}
          onSave={handleSave}
          onCancel={() => {
            setIsModalVisible(false);
            setEditingLog(null);
          }}
          saving={saving}
        />
      </Modal>
    </Card>
  );
}
