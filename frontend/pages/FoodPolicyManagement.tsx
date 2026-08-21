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
  ShopOutlined,
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

export default function FoodPolicyManagement() {
  const { can } = useAuth();
  const canCreate = can("payroll-food-policy", "create");
  const canEdit = can("payroll-food-policy", "edit");
  const canDelete = can("payroll-food-policy", "delete");
  const canExport = can("payroll-food-policy", "export");
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingRow, setEditingRow] = useState<any>(null);
  const [searchText, setSearchText] = useState("");
  const [exportLoading, setExportLoading] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    loadRows();
  }, []);

  const filteredRows = useMemo(() => {
    if (!searchText.trim()) return rows;
    const q = searchText.trim().toLowerCase();
    return rows.filter(
      (r) =>
        String(r.note ?? "").toLowerCase().includes(q) ||
        String(r.updated_by ?? "").toLowerCase().includes(q)
    );
  }, [rows, searchText]);

  const loadRows = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/food-policy");
      if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
      const result = await response.json();
      setRows(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading food policy history:", error);
      notifyError("Couldn't load food policy history", error.message);
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
      effective_date: record.effective_date ? dayjs(record.effective_date) : null,
      basic_food_amount: Number(record.basic_food_amount ?? 0),
      note: record.note ?? "",
      updated_by: record.updated_by ?? "",
    });
    setIsModalVisible(true);
  };

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const payload = {
        effective_date: values.effective_date.format("YYYY-MM-DD"),
        basic_food_amount: values.basic_food_amount,
        note: values.note || undefined,
        updated_by: values.updated_by || undefined,
      };
      const isEditing = Boolean(editingRow);
      const url = isEditing ? `/api/food-policy/${editingRow.food_policy_id}` : "/api/food-policy";
      const response = await fetch(url, {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const detail = errBody.detail || response.statusText;
        if (response.status === 409) {
          notifyError("Duplicate date", detail);
          return;
        }
        throw new Error(detail);
      }
      notifySuccess(isEditing ? "Food policy updated" : "Food policy added");
      setIsModalVisible(false);
      setEditingRow(null);
      loadRows();
    } catch (error: any) {
      console.error("Error saving food policy:", error);
      notifyError("Save failed", error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const response = await fetch(`/api/food-policy/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess("Food policy row deleted");
      loadRows();
    } catch (error: any) {
      console.error("Error deleting food policy row:", error);
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
      title: "Effective Date",
      dataIndex: "effective_date",
      key: "effective_date",
      sorter: (a: any, b: any) => String(a.effective_date).localeCompare(String(b.effective_date)),
    },
    {
      title: "Basic of Food ($/month)",
      dataIndex: "basic_food_amount",
      key: "basic_food_amount",
      render: (v: number) => `$${Number(v).toFixed(2)}`,
      sorter: (a: any, b: any) => Number(a.basic_food_amount ?? 0) - Number(b.basic_food_amount ?? 0),
    },
    { title: "Note", dataIndex: "note", key: "note", render: (v: string) => v ?? "-" },
    { title: "Updated By", dataIndex: "updated_by", key: "updated_by", render: (v: string) => v ?? "-" },
    {
      title: "Action",
      key: "action",
      width: 100,
      render: (_: any, record: any) => (
        <Space>
          {canEdit && <Button icon={<EditOutlined />} onClick={() => openEdit(record)} />}
          {canDelete && (
            <Popconfirm
              title="Delete this food policy row?"
              onConfirm={() => handleDelete(record.food_policy_id)}
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
      const sheet = workbook.addWorksheet("Food Policy History");

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
      titleCell.value = "Food Policy History";
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
          case "effective_date":
            return record.effective_date ?? "";
          case "basic_food_amount":
            return Number(record.basic_food_amount ?? 0);
          case "note":
            return record.note ?? "";
          case "updated_by":
            return record.updated_by ?? "";
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
      link.download = `FoodPolicyHistory_${dayjs().format("YYYY-MM-DD")}.xlsx`;
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
          <ShopOutlined style={{ marginRight: 8 }} />
          Food Policy History
        </span>
      }
      extra={
        <Space>
          <Input
            allowClear
            placeholder="Search note or updated by..."
            style={{ width: 200 }}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
          <Button icon={<ReloadOutlined />} onClick={loadRows} />
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
            <Tooltip title="Add Rate Change">
              <Button
                aria-label="Add Rate Change"
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
        rowKey="food_policy_id"
        bordered
        pagination={{ pageSize: 20, showSizeChanger: true }}
      />

      <Modal
        title={editingRow ? "Edit Food Policy Row" : "Add Food Policy Row"}
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
            name="effective_date"
            label="Effective Date"
            rules={[{ required: true, message: "Please pick the effective date" }]}
          >
            <DatePicker style={{ width: "100%" }} format="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item
            name="basic_food_amount"
            label="Basic of Food ($/month)"
            rules={[{ required: true, message: "Please enter the amount" }]}
          >
            <InputNumber style={{ width: "100%" }} min={0} step={0.01} />
          </Form.Item>
          <Form.Item name="note" label="Note">
            <Input placeholder="e.g. Annual policy update" />
          </Form.Item>
          <Form.Item name="updated_by" label="Updated By">
            <Input placeholder="Your name" />
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
