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
  DatePicker,
  Tooltip,
  message,
  Descriptions,
} from "antd";
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  DashboardOutlined,
  FileExcelOutlined,
  SaveOutlined,
  CloseOutlined,
} from "@ant-design/icons";
import dayjs, { Dayjs } from "dayjs";
import ExcelJS from "exceljs";
import { useSearchParams } from "react-router-dom";
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

const money = (v: number) => `$ ${Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

interface VehicleOption {
  id: number;
  name: string;
}

export default function DailyKpiManagement() {
  const { can } = useAuth();
  const canCreate = can("daily-kpi", "create");
  const canEdit = can("daily-kpi", "edit");
  const canDelete = can("daily-kpi", "delete");
  const canExport = can("daily-kpi", "export");

  const [searchParams] = useSearchParams();
  const [rows, setRows] = useState<any[]>([]);
  const [vehicleOptions, setVehicleOptions] = useState<VehicleOption[]>([]);
  const [workTypes, setWorkTypes] = useState<any[]>([]);
  const [month, setMonth] = useState<Dayjs>(() => {
    const y = searchParams.get("year");
    const m = searchParams.get("month");
    if (y && m) return dayjs(`${y}-${String(m).padStart(2, "0")}-01`);
    return dayjs().startOf("month");
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingRow, setEditingRow] = useState<any>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [form] = Form.useForm();
  const selectedWorkTypeId = Form.useWatch("work_type_id", form);
  const dailyProductivity = Form.useWatch("daily_productivity", form);

  useEffect(() => {
    loadVehicleOptions();
    loadWorkTypes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

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

  const loadWorkTypes = async () => {
    try {
      // Work Type reuses the existing Formula master list (app/formulas.sql)
      // rather than a separate table -- normalize formula_id/unit_price into
      // the work_type_id/rate_per_unit shape this page already works with.
      const response = await fetch("/api/formulas");
      if (!response.ok) throw new Error(`Failed to fetch work types: ${response.statusText}`);
      const result = await response.json();
      const formulas = Array.isArray(result.data) ? result.data : [];
      setWorkTypes(
        formulas.map((f: any) => ({
          work_type_id: f.formula_id,
          description: f.description,
          quantity: f.quantity,
          unit: f.unit,
          rate_per_unit: f.unit_price,
        }))
      );
    } catch (error: any) {
      console.error("Error loading work types:", error);
      notifyError("Couldn't load work types", error.message);
    }
  };

  const loadRows = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        year: String(month.year()),
        month: String(month.month() + 1),
      });
      const response = await fetch(`/api/daily-kpi-entries?${params}`);
      if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
      const result = await response.json();
      setRows(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading daily KPI entries:", error);
      notifyError("Couldn't load daily KPI entries", error.message);
    } finally {
      setLoading(false);
    }
  };

  const openCreate = () => {
    setEditingRow(null);
    form.resetFields();
    form.setFieldsValue({ work_date: dayjs() });
    setIsModalVisible(true);
  };

  const openEdit = (record: any) => {
    setEditingRow(record);
    form.setFieldsValue({
      vehicles_id: record.vehicles_id,
      work_date: record.work_date ? dayjs(record.work_date) : undefined,
      work_type_id: record.work_type_id,
      daily_productivity: Number(record.daily_productivity ?? 0),
      remarks: record.remarks,
    });
    setIsModalVisible(true);
  };

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const isEditing = Boolean(editingRow);
      const url = isEditing ? `/api/daily-kpi-entries/${editingRow.entry_id}` : "/api/daily-kpi-entries";
      const payload = {
        ...values,
        work_date: values.work_date ? values.work_date.format("YYYY-MM-DD") : undefined,
      };
      const response = await fetch(url, {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess(isEditing ? "Daily KPI entry updated" : "Daily KPI entry added");
      setIsModalVisible(false);
      setEditingRow(null);
      loadRows();
    } catch (error: any) {
      console.error("Error saving daily KPI entry:", error);
      notifyError("Save failed", error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const response = await fetch(`/api/daily-kpi-entries/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess("Daily KPI entry deleted");
      loadRows();
    } catch (error: any) {
      console.error("Error deleting daily KPI entry:", error);
      notifyError("Delete failed", error.message);
    }
  };

  const workTypeOptions = useMemo(
    () => workTypes.map((w) => ({ value: w.work_type_id, label: w.description })),
    [workTypes]
  );

  const selectedWorkType = useMemo(
    () => workTypes.find((w) => w.work_type_id === selectedWorkTypeId),
    [workTypes, selectedWorkTypeId]
  );

  const previewKpi = useMemo(() => {
    if (!selectedWorkType) return null;
    const quantity = Number(selectedWorkType.quantity ?? 0);
    const productivity = Number(dailyProductivity ?? 0);
    const rate = Number(selectedWorkType.rate_per_unit ?? 0);
    const effective = quantity < productivity ? quantity : productivity;
    return effective * rate;
  }, [selectedWorkType, dailyProductivity]);

  const columns = [
    {
      title: "No",
      key: "no",
      width: 50,
      fixed: "left" as const,
      render: (_: any, __: any, index: number) => index + 1,
    },
    {
      title: "Code",
      dataIndex: "code",
      key: "code",
      width: 90,
      fixed: "left" as const,
      render: (v: string) => v || "-",
      sorter: (a: any, b: any) => String(a.code ?? "").localeCompare(String(b.code ?? "")),
    },
    {
      title: "Plate Number",
      dataIndex: "plate_number",
      key: "plate_number",
      width: 110,
      fixed: "left" as const,
      render: (v: string) => v || "-",
    },
    {
      title: "Vehicles Type",
      dataIndex: "vehicle_type",
      key: "vehicle_type",
      width: 110,
      render: (v: string) => v || "-",
    },
    {
      title: "Driver Name",
      dataIndex: "driver_name",
      key: "driver_name",
      width: 140,
      render: (v: string) => v || "-",
      sorter: (a: any, b: any) => String(a.driver_name ?? "").localeCompare(String(b.driver_name ?? "")),
    },
    {
      title: "Work Date",
      dataIndex: "work_date",
      key: "work_date",
      width: 110,
      render: (v: string) => (v ? dayjs(v).format("DD MMM YYYY") : "-"),
      sorter: (a: any, b: any) => String(a.work_date ?? "").localeCompare(String(b.work_date ?? "")),
    },
    {
      title: "Work Type",
      dataIndex: "work_type_description",
      key: "work_type_description",
      width: 220,
    },
    {
      title: "Daily Productivity",
      dataIndex: "daily_productivity",
      key: "daily_productivity",
      width: 130,
      render: (v: number) => Number(v ?? 0).toLocaleString(),
      sorter: (a: any, b: any) => Number(a.daily_productivity ?? 0) - Number(b.daily_productivity ?? 0),
    },
    {
      title: "Quantity",
      dataIndex: "quantity",
      key: "quantity",
      width: 100,
      render: (v: number) => Number(v ?? 0).toLocaleString(),
    },
    {
      title: "Unit",
      dataIndex: "unit",
      key: "unit",
      width: 70,
    },
    {
      title: "Calculated Rate / Unit",
      dataIndex: "rate_per_unit",
      key: "rate_per_unit",
      width: 140,
      render: money,
    },
    {
      title: "Daily KPI",
      dataIndex: "kpi",
      key: "kpi",
      width: 110,
      render: money,
      sorter: (a: any, b: any) => Number(a.kpi ?? 0) - Number(b.kpi ?? 0),
    },
    {
      title: "Remarks",
      dataIndex: "remarks",
      key: "remarks",
      width: 160,
      render: (v: string) => v || "-",
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
            <Popconfirm title="Delete this daily KPI entry?" onConfirm={() => handleDelete(record.entry_id)}>
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
      const sheet = workbook.addWorksheet("Daily KPI");

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
      titleCell.value = `Monthly Report - ${month.format("MMMM YYYY")}`;
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
          case "code":
            return record.code || "";
          case "vehicle_type":
            return record.vehicle_type || "";
          case "plate_number":
            return record.plate_number || "";
          case "driver_name":
            return record.driver_name || "";
          case "work_date":
            return record.work_date ? dayjs(record.work_date).format("DD MMM YYYY") : "";
          case "work_type_description":
            return record.work_type_description || "";
          case "daily_productivity":
            return Number(record.daily_productivity ?? 0);
          case "quantity":
            return Number(record.quantity ?? 0);
          case "unit":
            return record.unit || "";
          case "rate_per_unit":
            return Number(record.rate_per_unit ?? 0);
          case "kpi":
            return Number(record.kpi ?? 0);
          case "remarks":
            return record.remarks || "";
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
        const width = col.key === "work_type_description" || col.key === "remarks" ? 30 : Math.max(String(col.title).length + 4, 12);
        sheet.getColumn(i + 1).width = width;
      });

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Monthly_Report_${month.format("YYYY-MM")}.xlsx`;
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
          <DashboardOutlined style={{ marginRight: 8 }} />
          Daily KPI Entry
        </span>
      }
      extra={
        <Space>
          <DatePicker
            picker="month"
            format="MMMM YYYY"
            allowClear={false}
            value={month}
            onChange={(value) => value && setMonth(value.startOf("month"))}
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
        dataSource={rows}
        rowKey="entry_id"
        bordered
        scroll={{ x: "max-content" }}
        pagination={{ pageSize: 20, showSizeChanger: true }}
      />

      <Modal
        title={editingRow ? "Edit Daily KPI Entry" : "Add Daily KPI Entry"}
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
            rules={[{ required: true, message: "Please select a vehicle" }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="Select a vehicle..."
              options={vehicleOptions.map((v) => ({ value: v.id, label: v.name }))}
            />
          </Form.Item>
          <Form.Item
            name="work_date"
            label="Work Date"
            rules={[{ required: true, message: "Please select the work date" }]}
          >
            <DatePicker style={{ width: "100%" }} format="DD MMM YYYY" />
          </Form.Item>
          <Form.Item
            name="work_type_id"
            label="Work Type"
            rules={[{ required: true, message: "Please select a work type" }]}
          >
            <Select showSearch optionFilterProp="label" placeholder="Select a work type..." options={workTypeOptions} />
          </Form.Item>
          <Form.Item
            name="daily_productivity"
            label="Daily Productivity"
            rules={[{ required: true, message: "Please enter the daily productivity" }]}
          >
            <InputNumber style={{ width: "100%" }} min={0} step={1} />
          </Form.Item>

          {selectedWorkType && (
            <Descriptions
              size="small"
              column={1}
              bordered
              style={{ marginBottom: 16 }}
              items={[
                { key: "quantity", label: "Quantity", children: Number(selectedWorkType.quantity ?? 0).toLocaleString() },
                { key: "unit", label: "Unit", children: selectedWorkType.unit },
                { key: "rate", label: "Calculated Rate / Unit", children: money(selectedWorkType.rate_per_unit) },
                { key: "kpi", label: "Daily KPI (preview)", children: previewKpi != null ? money(previewKpi) : "-" },
              ]}
            />
          )}

          <Form.Item name="remarks" label="Remarks">
            <Input placeholder="Optional" />
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
