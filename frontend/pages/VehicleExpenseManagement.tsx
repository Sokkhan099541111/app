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
} from "antd";
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  SearchOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  WalletOutlined,
  FileExcelOutlined,
  SaveOutlined,
  CloseOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import ExcelJS from "exceljs";
import { useSearchParams } from "react-router-dom";
import { getLogoBuffer } from "../src/utils/companyLogo";
import { useAuth } from "../src/context/AuthContext";

const { RangePicker } = DatePicker;
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

const money = (v: number) => `$ ${Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

const CATEGORIES = ["Repair Expenses / Maintenance Cost", "Engine Oil, Pump & Brake", "Diesel Fuel"] as const;

interface VehicleOption {
  id: number;
  name: string;
}

export default function VehicleExpenseManagement() {
  const { can } = useAuth();
  const canCreate = can("vehicle-expenses", "create");
  const canEdit = can("vehicle-expenses", "edit");
  const canDelete = can("vehicle-expenses", "delete");
  const canExport = can("vehicle-expenses", "export");

  const [searchParams] = useSearchParams();
  const [rows, setRows] = useState<any[]>([]);
  const [vehicleOptions, setVehicleOptions] = useState<VehicleOption[]>([]);
  const [vendors, setVendors] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingRow, setEditingRow] = useState<any>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [form] = Form.useForm();

  // Search filters -- Category (searchable dropdown) and an Expense Date
  // range (From Date / To Date), defaulting to the current month.
  const [filterCategory, setFilterCategory] = useState<string | undefined>(() => {
    const c = searchParams.get("category");
    return c && (CATEGORIES as readonly string[]).includes(c) ? c : undefined;
  });
  const [filterDateRange, setFilterDateRange] = useState<[string, string]>(() => {
    const start = searchParams.get("start_date");
    const end = searchParams.get("end_date");
    if (start && end) return [start, end];
    return [dayjs().startOf("month").format(DATE_FORMAT), dayjs().endOf("month").format(DATE_FORMAT)];
  });

  useEffect(() => {
    loadVehicleOptions();
    loadVendors();
    loadRows();
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

  const loadVendors = async () => {
    try {
      const response = await fetch("/api/vendors");
      if (!response.ok) throw new Error(`Failed to fetch vendors: ${response.statusText}`);
      const result = await response.json();
      setVendors(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading vendors:", error);
      notifyError("Couldn't load vendors", error.message);
    }
  };

  const loadRows = async (
    category: string | undefined = filterCategory,
    dateRange: [string, string] = filterDateRange
  ) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (category) params.append("category", category);
      if (dateRange) {
        params.append("start", dateRange[0]);
        params.append("end", dateRange[1]);
      }
      const response = await fetch(`/api/vehicle-expenses?${params}`);
      if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
      const result = await response.json();
      setRows(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading vehicle expenses:", error);
      notifyError("Couldn't load vehicle expenses", error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = () => {
    loadRows(filterCategory, filterDateRange);
  };

  const openCreate = () => {
    setEditingRow(null);
    form.resetFields();
    form.setFieldsValue({ expense_date: dayjs() });
    setIsModalVisible(true);
  };

  const openEdit = (record: any) => {
    setEditingRow(record);
    form.setFieldsValue({
      vehicles_id: record.vehicles_id,
      vendor_id: record.vendor_id,
      expense_date: record.expense_date ? dayjs(record.expense_date) : undefined,
      category: record.category,
      amount: Number(record.amount ?? 0),
      remarks: record.remarks,
    });
    setIsModalVisible(true);
  };

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const isEditing = Boolean(editingRow);
      const url = isEditing ? `/api/vehicle-expenses/${editingRow.expense_id}` : "/api/vehicle-expenses";
      const payload = {
        ...values,
        expense_date: values.expense_date ? values.expense_date.format("YYYY-MM-DD") : undefined,
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
      notifySuccess(isEditing ? "Vehicle expense updated" : "Vehicle expense added");
      setIsModalVisible(false);
      setEditingRow(null);
      loadRows();
    } catch (error: any) {
      console.error("Error saving vehicle expense:", error);
      notifyError("Save failed", error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const response = await fetch(`/api/vehicle-expenses/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess("Vehicle expense deleted");
      loadRows();
    } catch (error: any) {
      console.error("Error deleting vehicle expense:", error);
      notifyError("Delete failed", error.message);
    }
  };

  const vendorOptions = useMemo(
    () => vendors.map((v) => ({ value: v.vendor_id, label: v.name })),
    [vendors]
  );

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
      render: (v: string) => v || "-",
      sorter: (a: any, b: any) => String(a.code ?? "").localeCompare(String(b.code ?? "")),
    },
    {
      title: "Plate Number",
      dataIndex: "plate_number",
      key: "plate_number",
      width: 110,
      render: (v: string) => v || "-",
    },
    {
      title: "Vendor Name",
      dataIndex: "vendor_name",
      key: "vendor_name",
      width: 160,
      sorter: (a: any, b: any) => String(a.vendor_name ?? "").localeCompare(String(b.vendor_name ?? "")),
    },
    {
      title: "Phone Number",
      dataIndex: "vendor_phone",
      key: "vendor_phone",
      width: 130,
      render: (v: string) => v || "-",
    },
    {
      title: "Expense Date",
      dataIndex: "expense_date",
      key: "expense_date",
      width: 120,
      render: (v: string) => (v ? dayjs(v).format("DD MMM YYYY") : "-"),
      sorter: (a: any, b: any) => String(a.expense_date ?? "").localeCompare(String(b.expense_date ?? "")),
    },
    {
      title: "Category",
      dataIndex: "category",
      key: "category",
      width: 220,
    },
    {
      title: "Amount",
      dataIndex: "amount",
      key: "amount",
      width: 110,
      render: money,
      sorter: (a: any, b: any) => Number(a.amount ?? 0) - Number(b.amount ?? 0),
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
            <Popconfirm title="Delete this expense entry?" onConfirm={() => handleDelete(record.expense_id)}>
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
      // Pivot rows sharing the same vehicle + vendor + date back into the
      // three template columns (Repair / Engine Oil / Diesel), matching
      // the uploaded Monthly Report layout exactly.
      const groups = new Map<string, any>();
      rows.forEach((r) => {
        const key = `${r.vehicles_id}|${r.vendor_id}|${r.expense_date}`;
        if (!groups.has(key)) {
          groups.set(key, {
            vendor_name: r.vendor_name,
            vendor_phone: r.vendor_phone,
            code: r.code,
            plate_number: r.plate_number,
            expense_date: r.expense_date,
            repair: 0,
            engineOil: 0,
            diesel: 0,
            remarksList: [] as string[],
          });
        }
        const g = groups.get(key);
        const amount = Number(r.amount ?? 0);
        if (r.category === CATEGORIES[0]) g.repair += amount;
        else if (r.category === CATEGORIES[1]) g.engineOil += amount;
        else if (r.category === CATEGORIES[2]) g.diesel += amount;
        if (r.remarks) g.remarksList.push(r.remarks);
      });
      const pivoted = Array.from(groups.values()).sort((a, b) =>
        String(a.expense_date ?? "").localeCompare(String(b.expense_date ?? ""))
      );

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Vehicle Expenses");

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

      const headers = [
        "No.",
        "Code",
        "Plate Number",
        "Vendor Name",
        "Phone Number",
        "Expense Date",
        "Repair Expenses / Maintenance Cost",
        "Engine Oil, Pump & Brake",
        "Diesel Fuel",
        "Remarks",
      ];
      const totalColumns = headers.length;

      const rangeText = `${dayjs(filterDateRange[0]).format("DD MMM YYYY")} - ${dayjs(filterDateRange[1]).format("DD MMM YYYY")}`;

      const logoBuffer = await getLogoBuffer();
      const logoImageId = workbook.addImage({ buffer: logoBuffer as any, extension: "png" });
      sheet.addImage(logoImageId, { tl: { col: 0, row: 0 }, ext: { width: 90, height: 55 } });
      sheet.getRow(1).height = 42;

      sheet.mergeCells(1, 2, 1, totalColumns);
      const titleCell = sheet.getCell(1, 2);
      titleCell.value = `Vehicle Expense Report - ${rangeText}`;
      titleCell.font = { size: 16, bold: true };
      titleCell.alignment = { vertical: "middle", horizontal: "center" };

      sheet.getRow(2).height = 8;

      const headerRow = 3;
      headers.forEach((label, i) => {
        const cell = sheet.getCell(headerRow, i + 1);
        cell.value = label;
        cell.font = { bold: true };
        cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
        cell.fill = headerFill;
        cell.border = thinBorder;
      });

      pivoted.forEach((g, index) => {
        const row = sheet.getRow(headerRow + 1 + index);
        row.getCell(1).value = index + 1;
        row.getCell(2).value = g.code || "";
        row.getCell(3).value = g.plate_number || "";
        row.getCell(4).value = g.vendor_name || "";
        row.getCell(5).value = g.vendor_phone || "";
        row.getCell(6).value = g.expense_date ? dayjs(g.expense_date).format("DD MMM YYYY") : "";
        row.getCell(7).value = g.repair || 0;
        row.getCell(8).value = g.engineOil || 0;
        row.getCell(9).value = g.diesel || 0;
        row.getCell(10).value = g.remarksList.join("; ");
        for (let c = 1; c <= totalColumns; c++) {
          row.getCell(c).border = thinBorder;
          row.getCell(c).alignment = { vertical: "middle" };
        }
      });

      sheet.getColumn(1).width = 6;
      sheet.getColumn(2).width = 10;
      sheet.getColumn(3).width = 14;
      sheet.getColumn(4).width = 20;
      sheet.getColumn(5).width = 16;
      sheet.getColumn(6).width = 14;
      sheet.getColumn(7).width = 20;
      sheet.getColumn(8).width = 18;
      sheet.getColumn(9).width = 14;
      sheet.getColumn(10).width = 30;

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Vehicle_Expense_Report_${filterDateRange[0]}_to_${filterDateRange[1]}.xlsx`;
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
    <Card>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 16,
          marginBottom: 16,
          padding: "12px 16px",
          background: "#fafafa",
          border: "1px solid #f0f0f0",
          borderRadius: 8,
        }}
      >
        <span style={{ fontSize: 16, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
          <WalletOutlined style={{ marginRight: 8 }} />
          Vehicle Expense Entry
        </span>
        <Space size={12} wrap align="center" style={{ marginLeft: "auto" }}>
          <Select
            showSearch
            allowClear
            placeholder="All categories"
            optionFilterProp="label"
            style={{ width: 220 }}
            value={filterCategory}
            onChange={setFilterCategory}
            options={CATEGORIES.map((c) => ({ value: c, label: c }))}
          />
          <RangePicker
            allowClear={false}
            format="DD MMM YYYY"
            value={[dayjs(filterDateRange[0]), dayjs(filterDateRange[1])]}
            onChange={(dates) => {
              if (dates && dates[0] && dates[1]) {
                setFilterDateRange([dates[0].format(DATE_FORMAT), dates[1].format(DATE_FORMAT)]);
              }
            }}
          />
          <Tooltip title="Search">
            <Button aria-label="Search" type="primary" icon={<SearchOutlined />} onClick={handleSearch} />
          </Tooltip>
          <Tooltip title="Refresh">
            <Button aria-label="Refresh" icon={<ReloadOutlined />} onClick={handleSearch} />
          </Tooltip>
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
            <Tooltip title="Add Expense">
              <Button
                aria-label="Add Expense"
                type="primary"
                icon={<PlusOutlined />}
                onClick={openCreate}
                style={{ backgroundColor: "#051650" }}
              />
            </Tooltip>
          )}
        </Space>
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
        dataSource={rows}
        rowKey="expense_id"
        bordered
        scroll={{ x: "max-content" }}
        pagination={{ pageSize: 20, showSizeChanger: true }}
      />

      <Modal
        title={editingRow ? "Edit Vehicle Expense" : "Add Vehicle Expense"}
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
            name="vendor_id"
            label="Vendor Name"
            rules={[{ required: true, message: "Please select or add a vendor" }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="Select a vendor..."
              options={vendorOptions}
              notFoundContent="No vendors yet -- add one from the Vendors page."
            />
          </Form.Item>
          <Form.Item
            name="expense_date"
            label="Expense Date"
            rules={[{ required: true, message: "Please select the expense date" }]}
          >
            <DatePicker style={{ width: "100%" }} format="DD MMM YYYY" />
          </Form.Item>
          <Form.Item
            name="category"
            label="Expense Category"
            rules={[{ required: true, message: "Please select an expense category" }]}
          >
            <Select
              placeholder="Select a category..."
              options={CATEGORIES.map((c) => ({ value: c, label: c }))}
            />
          </Form.Item>
          <Form.Item
            name="amount"
            label="Amount"
            rules={[{ required: true, message: "Please enter the amount" }]}
          >
            <InputNumber style={{ width: "100%" }} min={0} step={0.01} prefix="$" />
          </Form.Item>
          <Form.Item name="remarks" label="Remarks">
            <Input.TextArea rows={2} placeholder="Optional" />
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
