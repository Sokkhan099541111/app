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
  Input,
  InputNumber,
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
  CalculatorOutlined,
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

const money = (v: number) => `$ ${Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

export default function FormulaManagement() {
  const { can } = useAuth();
  const canCreate = can("settings-formula", "create");
  const canEdit = can("settings-formula", "edit");
  const canDelete = can("settings-formula", "delete");
  const canExport = can("settings-formula", "export");

  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingRow, setEditingRow] = useState<any>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    loadRows();
  }, []);

  const loadRows = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/formulas");
      if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
      const result = await response.json();
      setRows(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading formulas:", error);
      notifyError("Couldn't load formulas", error.message);
    } finally {
      setLoading(false);
    }
  };

  const openCreate = () => {
    setEditingRow(null);
    form.resetFields();
    setIsModalVisible(true);
  };

  const openEdit = (record: any) => {
    setEditingRow(record);
    form.setFieldsValue({
      description: record.description,
      unit: record.unit,
      distance: record.distance,
      unit_price: Number(record.unit_price ?? 0),
      quantity: Number(record.quantity ?? 0),
    });
    setIsModalVisible(true);
  };

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const isEditing = Boolean(editingRow);
      const url = isEditing ? `/api/formulas/${editingRow.formula_id}` : "/api/formulas";
      const response = await fetch(url, {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess(isEditing ? "Formula updated" : "Formula added");
      setIsModalVisible(false);
      setEditingRow(null);
      loadRows();
    } catch (error: any) {
      console.error("Error saving formula:", error);
      notifyError("Save failed", error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const response = await fetch(`/api/formulas/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess("Formula deleted");
      loadRows();
    } catch (error: any) {
      console.error("Error deleting formula:", error);
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
      title: "Description",
      dataIndex: "description",
      key: "description",
      sorter: (a: any, b: any) => String(a.description ?? "").localeCompare(String(b.description ?? "")),
    },
    {
      title: "Unit",
      dataIndex: "unit",
      key: "unit",
      width: 90,
      sorter: (a: any, b: any) => String(a.unit ?? "").localeCompare(String(b.unit ?? "")),
    },
    {
      title: "Distance",
      dataIndex: "distance",
      key: "distance",
      width: 110,
      render: (v: string) => v || "-",
    },
    {
      title: "Unit Price",
      dataIndex: "unit_price",
      key: "unit_price",
      width: 110,
      render: money,
      sorter: (a: any, b: any) => Number(a.unit_price ?? 0) - Number(b.unit_price ?? 0),
    },
    {
      title: "Quantity",
      dataIndex: "quantity",
      key: "quantity",
      width: 110,
      render: (v: number) => Number(v ?? 0).toLocaleString(),
      sorter: (a: any, b: any) => Number(a.quantity ?? 0) - Number(b.quantity ?? 0),
    },
    {
      title: "Amount",
      dataIndex: "amount",
      key: "amount",
      width: 120,
      render: money,
      sorter: (a: any, b: any) => Number(a.amount ?? 0) - Number(b.amount ?? 0),
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
            <Popconfirm title="Delete this formula?" onConfirm={() => handleDelete(record.formula_id)}>
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
      const sheet = workbook.addWorksheet("Formula");

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
      titleCell.value = "Formula";
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
          case "description":
            return record.description || "";
          case "unit":
            return record.unit || "";
          case "distance":
            return record.distance || "";
          case "unit_price":
            return Number(record.unit_price ?? 0);
          case "quantity":
            return Number(record.quantity ?? 0);
          case "amount":
            return Number(record.amount ?? 0);
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
        const width = col.key === "description" ? 45 : Math.max(String(col.title).length + 4, 12);
        sheet.getColumn(i + 1).width = width;
      });

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Formula_${dayjs().format("YYYY-MM-DD")}.xlsx`;
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
          <CalculatorOutlined style={{ marginRight: 8 }} />
          Formula
        </span>
      }
      extra={
        <Space>
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
            <Tooltip title="Add Formula">
              <Button
                aria-label="Add Formula"
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
        rowKey="formula_id"
        bordered
        scroll={{ x: "max-content" }}
        pagination={{ pageSize: 20, showSizeChanger: true }}
      />

      <Modal
        title={editingRow ? "Edit Formula" : "Add Formula"}
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
            name="description"
            label="Description"
            rules={[{ required: true, message: "Please enter a description" }]}
          >
            <Input.TextArea rows={2} placeholder="e.g. ការងារសម្អាតទីតាំង (អេស្គា)" />
          </Form.Item>
          <Form.Item name="unit" label="Unit" rules={[{ required: true, message: "Please enter the unit" }]}>
            <Input placeholder="e.g. m2, m3, pcs" />
          </Form.Item>
          <Form.Item name="distance" label="Distance">
            <Input placeholder="Optional" />
          </Form.Item>
          <Form.Item
            name="unit_price"
            label="Unit Price"
            rules={[{ required: true, message: "Please enter the unit price" }]}
          >
            <InputNumber style={{ width: "100%" }} min={0} step={0.01} prefix="$" />
          </Form.Item>
          <Form.Item
            name="quantity"
            label="Quantity"
            rules={[{ required: true, message: "Please enter the quantity" }]}
          >
            <InputNumber style={{ width: "100%" }} min={0} step={1} />
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
