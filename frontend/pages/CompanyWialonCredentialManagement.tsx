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
  Select,
  Switch,
  Tag,
  Tooltip,
  Upload,
  message,
} from "antd";
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  KeyOutlined,
  FileExcelOutlined,
  SaveOutlined,
  CloseOutlined,
  SearchOutlined,
  UploadOutlined,
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

const maskToken = (token: string | null | undefined) => {
  if (!token) return "-";
  const last4 = token.slice(-4);
  return `••••••••${last4}`;
};

// Every company record points at the standard Wialon hosting API endpoint --
// the Base URL field is shown disabled and always carries this value. Must
// be the full AJAX endpoint the backend posts to, not just the bare host.
const DEFAULT_WIALON_BASE_URL = "https://hst-api.wialon.com/wialon/ajax.html";

export default function CompanyWialonCredentialManagement() {
  const { can } = useAuth();
  const canCreate = can("settings-wialon-credentials", "create");
  const canEdit = can("settings-wialon-credentials", "edit");
  const canDelete = can("settings-wialon-credentials", "delete");
  const canExport = can("settings-wialon-credentials", "export");

  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingRow, setEditingRow] = useState<any>(null);
  const [searchText, setSearchText] = useState("");
  const [filterActive, setFilterActive] = useState<string | undefined>(undefined);
  const [logoPreview, setLogoPreview] = useState<string | undefined>(undefined);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadRows = async (search: string = searchText, active: string | undefined = filterActive) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.append("search", search.trim());
      if (active !== undefined) params.append("is_active", active);
      const response = await fetch(`/api/company-wialon-credentials?${params}`);
      if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
      const result = await response.json();
      setRows(Array.isArray(result.data) ? result.data : []);
    } catch (error: any) {
      console.error("Error loading company Wialon credentials:", error);
      notifyError("Couldn't load credentials", error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = () => loadRows(searchText, filterActive);

  const openCreate = () => {
    setEditingRow(null);
    form.resetFields();
    form.setFieldsValue({ is_active: true, base_url: DEFAULT_WIALON_BASE_URL });
    setLogoPreview(undefined);
    setIsModalVisible(true);
  };

  const openEdit = (record: any) => {
    setEditingRow(record);
    form.setFieldsValue({
      company_name: record.company_name,
      company_email: record.company_email,
      company_phone: record.company_phone,
      company_address: record.company_address,
      company_contact_person: record.company_contact_person,
      company_website: record.company_website,
      company_logo: record.company_logo,
      wialon_token: record.wialon_token,
      base_url: DEFAULT_WIALON_BASE_URL,
      is_active: Boolean(record.is_active),
    });
    setLogoPreview(record.company_logo || undefined);
    setIsModalVisible(true);
  };

  const handleLogoUpload = async (options: any) => {
    const { file, onSuccess, onError } = options;
    setUploadingLogo(true);
    try {
      const formData = new FormData();
      formData.append("file", file as File);
      const response = await fetch("/api/company-wialon-credentials/upload-logo", {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      const result = await response.json();
      form.setFieldsValue({ company_logo: result.url });
      setLogoPreview(result.url);
      notifySuccess("Logo uploaded");
      onSuccess?.(result);
    } catch (error: any) {
      console.error("Error uploading logo:", error);
      notifyError("Upload failed", error.message);
      onError?.(error);
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const isEditing = Boolean(editingRow);
      const url = isEditing ? `/api/company-wialon-credentials/${editingRow.id}` : "/api/company-wialon-credentials";
      const response = await fetch(url, {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const detail = errBody.detail || response.statusText;
        if (response.status === 409) {
          notifyError("Duplicate company", detail);
          return;
        }
        throw new Error(detail);
      }
      notifySuccess(isEditing ? "Credential updated" : "Credential added");
      setIsModalVisible(false);
      setEditingRow(null);
      loadRows();
    } catch (error: any) {
      console.error("Error saving credential:", error);
      notifyError("Save failed", error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const response = await fetch(`/api/company-wialon-credentials/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      notifySuccess("Credential deleted");
      loadRows();
    } catch (error: any) {
      console.error("Error deleting credential:", error);
      notifyError("Delete failed", error.message);
    }
  };

  const columns = useMemo(
    () => [
      {
        title: "No",
        key: "no",
        width: 60,
        fixed: "left" as const,
        render: (_: any, __: any, index: number) => index + 1,
      },
      {
        title: "Logo",
        dataIndex: "company_logo",
        key: "company_logo",
        width: 70,
        render: (v: string) =>
          v ? (
            <img src={v} alt="Company logo" style={{ height: 28, maxWidth: 60, objectFit: "contain" }} />
          ) : (
            "-"
          ),
      },
      {
        title: "Company Name",
        dataIndex: "company_name",
        key: "company_name",
        render: (v: string) => v || "-",
        sorter: (a: any, b: any) => String(a.company_name ?? "").localeCompare(String(b.company_name ?? "")),
      },
      {
        title: "Contact Person",
        dataIndex: "company_contact_person",
        key: "company_contact_person",
        render: (v: string) => v || "-",
      },
      {
        title: "Email",
        dataIndex: "company_email",
        key: "company_email",
        render: (v: string) => v || "-",
      },
      {
        title: "Phone Number",
        dataIndex: "company_phone",
        key: "company_phone",
        width: 150,
        render: (v: string) => v || "-",
      },
      {
        title: "Base URL",
        dataIndex: "base_url",
        key: "base_url",
        render: (v: string) => v || "-",
      },
      {
        title: "Wialon Token",
        dataIndex: "wialon_token",
        key: "wialon_token",
        width: 160,
        render: (v: string) => maskToken(v),
      },
      {
        title: "Status",
        dataIndex: "is_active",
        key: "is_active",
        width: 100,
        render: (v: boolean | number) => (
          <Tag color={v ? "green" : "default"}>{v ? "Active" : "Inactive"}</Tag>
        ),
        sorter: (a: any, b: any) => Number(a.is_active) - Number(b.is_active),
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
                title="Delete this credential?"
                description="This cannot be undone."
                onConfirm={() => handleDelete(record.id)}
              >
                <Button icon={<DeleteOutlined />} danger />
              </Popconfirm>
            )}
          </Space>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

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
      const sheet = workbook.addWorksheet("Wialon Credentials");

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
      titleCell.value = "Company Wialon Credentials";
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
          case "company_logo":
            return record.company_logo || "";
          case "company_name":
            return record.company_name || "";
          case "company_contact_person":
            return record.company_contact_person || "";
          case "company_email":
            return record.company_email || "";
          case "company_phone":
            return record.company_phone || "";
          case "base_url":
            return record.base_url || "";
          case "wialon_token":
            return maskToken(record.wialon_token);
          case "is_active":
            return record.is_active ? "Active" : "Inactive";
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
        sheet.getColumn(i + 1).width = Math.max(String(col.title).length + 4, 16);
      });

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Company_Wialon_Credentials_${dayjs().format("YYYY-MM-DD")}.xlsx`;
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
          padding: 12,
          background: "#fafafa",
          border: "1px solid #f0f0f0",
          borderRadius: 8,
        }}
      >
        <span style={{ fontSize: 16, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
          <KeyOutlined style={{ marginRight: 8 }} />
          Company Wialon Credentials
        </span>

        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, marginLeft: "auto" }}>
          <Input
            allowClear
            placeholder="Search company or contact..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onPressEnter={handleSearch}
            style={{ width: 220 }}
          />
          <Select
            allowClear
            placeholder="Status"
            style={{ width: 130 }}
            value={filterActive}
            onChange={(value) => {
              setFilterActive(value);
              loadRows(searchText, value);
            }}
            options={[
              { label: "Active", value: "true" },
              { label: "Inactive", value: "false" },
            ]}
          />
          <Tooltip title="Search">
            <Button aria-label="Search" icon={<SearchOutlined />} onClick={handleSearch} />
          </Tooltip>
          <Tooltip title="Refresh">
            <Button aria-label="Refresh" icon={<ReloadOutlined />} onClick={() => loadRows()} />
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
            <Tooltip title="Add Credential">
              <Button
                aria-label="Add Credential"
                type="primary"
                icon={<PlusOutlined />}
                onClick={openCreate}
                style={{ backgroundColor: "#051650" }}
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
        dataSource={rows}
        rowKey="id"
        bordered
        scroll={{ x: "max-content" }}
        pagination={{ pageSize: 20, showSizeChanger: true }}
      />

      <Modal
        title={editingRow ? "Edit Credential" : "Add Credential"}
        open={isModalVisible}
        onCancel={() => {
          setIsModalVisible(false);
          setEditingRow(null);
        }}
        footer={null}
        destroyOnClose
        width={640}
      >
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
            <Form.Item name="company_name" label="Company Name">
              <Input placeholder="e.g. SNKRP Co., Ltd" />
            </Form.Item>
            <Form.Item name="company_contact_person" label="Contact Person">
              <Input placeholder="Optional" />
            </Form.Item>
            <Form.Item name="company_email" label="Email">
              <Input type="email" placeholder="Optional" />
            </Form.Item>
            <Form.Item name="company_phone" label="Phone Number">
              <Input placeholder="Optional" />
            </Form.Item>
            <Form.Item name="company_website" label="Website">
              <Input placeholder="Optional" />
            </Form.Item>
          </div>

          <Form.Item name="company_address" label="Address">
            <Input placeholder="Optional" />
          </Form.Item>

          <Form.Item label="Company Logo">
            <Space align="center">
              {logoPreview ? (
                <img
                  src={logoPreview}
                  alt="Company logo"
                  style={{ height: 48, maxWidth: 120, objectFit: "contain", border: "1px solid #f0f0f0", borderRadius: 4, padding: 4 }}
                />
              ) : (
                <span style={{ color: "#999" }}>No logo uploaded</span>
              )}
              <Upload accept="image/png" showUploadList={false} customRequest={handleLogoUpload}>
                <Button icon={<UploadOutlined />} loading={uploadingLogo}>
                  {logoPreview ? "Replace Logo" : "Upload Logo"}
                </Button>
              </Upload>
            </Space>
            <div style={{ color: "#999", fontSize: 12, marginTop: 4 }}>
              PNG only -- used on this company's exported reports and payslips.
            </div>
          </Form.Item>
          <Form.Item name="company_logo" hidden>
            <Input />
          </Form.Item>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
            <Form.Item name="base_url" label="Wialon Base URL">
              <Input disabled />
            </Form.Item>
            <Form.Item
              name="wialon_token"
              label="Wialon Token"
              rules={[{ required: true, message: "Please enter the Wialon token" }]}
            >
              <Input.Password placeholder="Wialon API token" />
            </Form.Item>
          </div>

          <Form.Item name="is_active" label="Active" valuePropName="checked">
            <Switch />
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
