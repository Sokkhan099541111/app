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
  Tooltip,
  message,
  Tag,
  DatePicker,
} from "antd";
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  CarOutlined,
  FileExcelOutlined,
  SaveOutlined,
  CloseOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import ExcelJS from "exceljs";
import { getLogoBuffer } from "../src/utils/companyLogo";
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

const money = (v: number) => `$${Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

interface VehicleOption {
  id: number;
  name: string;
}

export default function RentalVehicleManagement() {
  const { can } = useAuth();
  const canCreate = can("rental-vehicles", "create");
  const canEdit = can("rental-vehicles", "edit");
  const canDelete = can("rental-vehicles", "delete");
  const canExport = can("rental-vehicles", "export");

  const [rows, setRows] = useState<any[]>([]);
  const [vehicleOptions, setVehicleOptions] = useState<VehicleOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingRow, setEditingRow] = useState<any>(null);
  const [filterStatus, setFilterStatus] = useState<string>("Active");
  const [exportLoading, setExportLoading] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    loadVehicleOptions();
    loadRows("Active");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadVehicleOptions = async () => {
    try {
      const response = await fetch("/api/vehicle-logs/vehicle-options");
      if (!response.ok) throw new Error(`Failed to fetch vehicles: ${response.statusText}`);
      const result = await response.json();
      setVehicleOptions(Array.isArray(result.vehicles) ? result.vehicles : []);
    } catch (error: any) {
      console.error("Error loading vehicle options:", error);
      notifyError("Couldn't load vehicles", "Could not load the vehicle list.");
    }
  };

  const loadRows = async (status: string = filterStatus) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status) params.append("status", status);
      const response = await fetch(`/api/vehicle-rentals?${params}`);
      if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
      const result = await response.json();
      setRows(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading vehicle rentals:", error);
      notifyError("Couldn't load rental vehicles", error.message);
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
      vehicles_id: record.vehicles_id,
      arrival_date: record.arrival_date ? dayjs(record.arrival_date) : undefined,
      monthly_rental: Number(record.monthly_rental ?? 0),
      status: record.status,
    });
    setIsModalVisible(true);
  };

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const isEditing = Boolean(editingRow);
      const url = isEditing ? `/api/vehicle-rentals/${editingRow.rental_id}` : "/api/vehicle-rentals";
      const payload = {
        ...values,
        arrival_date: values.arrival_date ? values.arrival_date.format("YYYY-MM-DD") : undefined,
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
          notifyError("Vehicle already on a rental", detail);
          return;
        }
        throw new Error(detail);
      }
      notifySuccess(isEditing ? "Rental vehicle updated" : "Rental vehicle added");
      setIsModalVisible(false);
      setEditingRow(null);
      loadRows();
    } catch (error: any) {
      console.error("Error saving rental vehicle:", error);
      notifyError("Save failed", error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const response = await fetch(`/api/vehicle-rentals/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess("Rental vehicle deleted");
      loadRows();
    } catch (error: any) {
      console.error("Error deleting rental vehicle:", error);
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
      dataIndex: "code",
      key: "code",
      render: (v: string) => v || "-",
      sorter: (a: any, b: any) => String(a.code ?? "").localeCompare(String(b.code ?? "")),
    },
    {
      title: "Plate Number",
      dataIndex: "plate_number",
      key: "plate_number",
      render: (v: string) => v || "-",
      sorter: (a: any, b: any) => String(a.plate_number ?? "").localeCompare(String(b.plate_number ?? "")),
    },
    {
      title: "Vehicle Type",
      dataIndex: "vehicle_type",
      key: "vehicle_type",
      render: (v: string) => v || "-",
    },
    {
      title: "Driver Name",
      dataIndex: "driver_name",
      key: "driver_name",
      render: (v: string) => v || "-",
      sorter: (a: any, b: any) => String(a.driver_name ?? "").localeCompare(String(b.driver_name ?? "")),
    },
    {
      title: "Arrival Date",
      dataIndex: "arrival_date",
      key: "arrival_date",
      render: (v: string) => (v ? dayjs(v).format("DD MMM YYYY") : "-"),
      sorter: (a: any, b: any) => String(a.arrival_date ?? "").localeCompare(String(b.arrival_date ?? "")),
    },
    {
      title: "Monthly Rental",
      dataIndex: "monthly_rental",
      key: "monthly_rental",
      render: money,
      sorter: (a: any, b: any) => Number(a.monthly_rental ?? 0) - Number(b.monthly_rental ?? 0),
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (v: string) => <Tag color={v === "Active" ? "green" : "default"}>{v}</Tag>,
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
              title="Delete this rental vehicle?"
              description="Blocked if it already has attendance history -- mark it Inactive instead."
              onConfirm={() => handleDelete(record.rental_id)}
            >
              <Button icon={<DeleteOutlined />} danger />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const handleExportExcel = async () => {
    if (rows.length === 0) {
      message.warning("There is no data to export.");
      return;
    }
    setExportLoading(true);
    try {
      const exportColumns = columns.filter((col) => col.key !== "action");
      const totalColumns = Math.max(exportColumns.length, 4);

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Rental Vehicles");

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
      const logoImageId = workbook.addImage({ buffer: logoBuffer as any, extension: "png" });
      sheet.addImage(logoImageId, { tl: { col: 0, row: 0 }, ext: { width: 90, height: 55 } });
      sheet.getRow(1).height = 42;

      sheet.mergeCells(1, 2, 1, totalColumns);
      const titleCell = sheet.getCell(1, 2);
      titleCell.value = "Rental Vehicles";
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
          case "monthly_rental":
            return Number(record.monthly_rental ?? 0);
          case "code":
            return record.code || "";
          case "plate_number":
            return record.plate_number || "";
          case "vehicle_type":
            return record.vehicle_type || "";
          case "arrival_date":
            return record.arrival_date ? dayjs(record.arrival_date).format("DD MMM YYYY") : "";
          case "driver_name":
            return record.driver_name || "";
          case "status":
            return record.status || "";
          default:
            return "";
        }
      };

      rows.forEach((record, index) => {
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
      link.download = `RentalVehicles_${dayjs().format("YYYY-MM-DD")}.xlsx`;
      link.click();
      window.URL.revokeObjectURL(url);
      notifySuccess("Exported to Excel");
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
          <CarOutlined style={{ marginRight: 8 }} />
          Rental Vehicles
        </span>
      }
      extra={
        <Space>
          <Select
            style={{ width: 130 }}
            value={filterStatus}
            onChange={(value) => {
              setFilterStatus(value);
              loadRows(value);
            }}
            options={[
              { label: "Active", value: "Active" },
              { label: "Inactive", value: "Inactive" },
              { label: "All", value: "All" },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={() => loadRows()} />
          {canExport && (
            <Tooltip title="Export Excel">
              <Button
                aria-label="Export Excel"
                icon={<FileExcelOutlined />}
                onClick={handleExportExcel}
                loading={exportLoading}
                disabled={rows.length === 0}
                style={{ background: "#217346", borderColor: "#217346", color: "#fff" }}
              />
            </Tooltip>
          )}
          {canCreate && (
            <Tooltip title="Add Rental Vehicle">
              <Button
                aria-label="Add Rental Vehicle"
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
        rowKey="rental_id"
        bordered
        scroll={{ x: "max-content" }}
        pagination={{ pageSize: 20, showSizeChanger: true }}
      />

      <Modal
        title={editingRow ? "Edit Rental Vehicle" : "Add Rental Vehicle"}
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
            name="vehicles_id"
            label="Vehicle"
            validateTrigger="onChange"
            rules={[
              { required: true, message: "Please select a vehicle" },
              {
                validator: async (_, value) => {
                  if (!value) return Promise.resolve();
                  const params = new URLSearchParams({ vehicles_id: String(value) });
                  if (editingRow?.rental_id) {
                    params.append("exclude_rental_id", String(editingRow.rental_id));
                  }
                  try {
                    const response = await fetch(`/api/vehicle-rentals/check-vehicle?${params}`);
                    if (!response.ok) return Promise.resolve();
                    const data = await response.json();
                    if (data.exists) {
                      return Promise.reject(new Error("This vehicle is already on another active rental record"));
                    }
                  } catch {
                    // Silent -- the backend still enforces this on submit either way.
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="Select a vehicle..."
              options={vehicleOptions.map((v) => ({ value: v.id, label: v.name }))}
            />
          </Form.Item>
          <Form.Item
            name="arrival_date"
            label="Arrival Date"
            rules={[{ required: true, message: "Please select the arrival date" }]}
          >
            <DatePicker style={{ width: "100%" }} format="DD MMM YYYY" />
          </Form.Item>
          <Form.Item
            name="monthly_rental"
            label="Monthly Rental"
            rules={[{ required: true, message: "Please enter the monthly rental amount" }]}
          >
            <InputNumber style={{ width: "100%" }} min={0} step={0.01} />
          </Form.Item>
          <Form.Item name="status" label="Status">
            <Select
              options={[
                { label: "Active", value: "Active" },
                { label: "Inactive", value: "Inactive" },
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
