import { useEffect, useMemo, useRef, useState } from "react";
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
  Row,
  Col,
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
  LoadingOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import { loadExcelJS } from "../src/utils/loadExcelJS";
import { useSearchParams } from "react-router-dom";
import { getLogoBuffer } from "../src/utils/companyLogo";
import { useAuth } from "../src/context/AuthContext";
import { vehicleSelectOptions } from "../src/utils/vehicleLabel";

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

// Must match the `category` ENUM on vehicle_expenses and
// ExpenseCategoryEnum in app/routes/vehicle_expense_route.py. Order is the
// order the Monthly Vehicle Financial & KPI Performance Report shows the
// expense columns in, so keep the two in step.
const CATEGORIES = [
  "Repair Expenses / Maintenance Cost",
  "Engine Oil, Pump & Brake",
  "Diesel Fuel",
  "Other Expense",
] as const;

interface VehicleOption {
  id: number;
  /** Wialon unit name -- in practice the plate number. */
  name: string;
  /** Fleet code, e.g. VID-385. Supplied by /vehicle-logs/vehicle-options. */
  code?: string;
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

  // --- Fuel Filling x Amount per Unit = Total Fuel Cost ----------------
  const [fuelLookupLoading, setFuelLookupLoading] = useState(false);
  const [fuelLookupNote, setFuelLookupNote] = useState<string | null>(null);

  // Guards the SAVED Fuel Filling on an existing Diesel Fuel record.
  //
  // Opening the edit modal populates vehicle + date, which fires the lookup
  // effect below -- and without this guard that lookup immediately
  // overwrites the stored litres with a freshly fetched figure, before the
  // user has touched anything. Editing an old record would silently change
  // its cost.
  //
  // So: openEdit records the record's own vehicle|date here, the effect
  // skips exactly that one combination once, then clears the guard. Any
  // later change to vehicle or date -- including changing back -- fetches
  // normally. Only set for Diesel Fuel records, so switching a non-fuel
  // record's category TO Diesel Fuel still triggers a fresh lookup.
  const skipInitialLookupKeyRef = useRef<string | null>(null);

  const watchedVehicleId = Form.useWatch("vehicles_id", form);
  const watchedExpenseDate = Form.useWatch("expense_date", form);
  const watchedCategory = Form.useWatch("category", form);
  const watchedFuelFilling = Form.useWatch("fuel_filling", form);
  const watchedAmountPerUnit = Form.useWatch("amount_per_unit", form);

  // Only Diesel Fuel is measured in units and priced per unit. Every other
  // category is a plain amount, so the fuel fields are hidden rather than
  // shown empty -- an inapplicable field invites a meaningless entry.
  const isDieselFuel = watchedCategory === CATEGORIES[2];

  // Live total. Only shown once BOTH halves are present -- a total derived
  // from one input would be a made-up number, not a calculation.
  const totalFuelCost = useMemo(() => {
    const litres = Number(watchedFuelFilling);
    const price = Number(watchedAmountPerUnit);
    if (
      watchedFuelFilling == null ||
      watchedAmountPerUnit == null ||
      !Number.isFinite(litres) ||
      !Number.isFinite(price) ||
      litres < 0 ||
      price < 0
    ) {
      return null;
    }
    return Math.round(litres * price * 100) / 100;
  }, [watchedFuelFilling, watchedAmountPerUnit]);

  // Retrieve Fuel Filling for the selected vehicle whenever the vehicle,
  // date or category changes -- but only for Diesel Fuel, the one category
  // the figure applies to. The value is ALWAYS written into the field,
  // including 0 when the unit has no reading, so it never sits blank or
  // stale after a vehicle is picked. Choosing a different vehicle is an
  // explicit user action, so overwriting a previously typed figure is
  // correct here; the field stays editable afterwards.
  useEffect(() => {
    if (!isModalVisible || !isDieselFuel || !watchedVehicleId || !watchedExpenseDate) return;

    const lookupKey = `${watchedVehicleId}|${dayjs(watchedExpenseDate).format(DATE_FORMAT)}`;
    if (skipInitialLookupKeyRef.current === lookupKey) {
      // Freshly opened an existing record and nothing has changed yet --
      // keep the value that was saved to the database. Clear the guard so
      // the very next vehicle/date change does fetch.
      skipInitialLookupKeyRef.current = null;
      setFuelLookupNote("Saved value. Change the vehicle or date to refresh it.");
      return;
    }

    let cancelled = false;
    setFuelLookupLoading(true);
    setFuelLookupNote(null);

    (async () => {
      let litres = 0;
      let note = "No fuel filling recorded for this vehicle on this date -- shown as 0.";
      try {
        const params = new URLSearchParams({
          vehicles_id: String(watchedVehicleId),
          expense_date: dayjs(watchedExpenseDate).format(DATE_FORMAT),
        });
        const response = await fetch(`/api/vehicle-expenses/fuel-filling?${params}`);
        if (!response.ok) throw new Error(response.statusText);
        const data = await response.json();

        // The API is contracted to always send a number, but coerce anyway:
        // a null slipping through would render an empty field, which is the
        // exact ambiguity this is meant to remove.
        litres = Number(data?.fuel_filling ?? 0);
        if (!Number.isFinite(litres) || litres < 0) litres = 0;
        if (data?.found) note = `Fuel filling for this vehicle on this date: ${litres} L.`;
      } catch {
        note = "Fuel filling could not be loaded -- shown as 0, please enter it manually.";
      } finally {
        if (!cancelled) {
          form.setFieldsValue({ fuel_filling: litres });
          setFuelLookupNote(note);
          setFuelLookupLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isModalVisible, isDieselFuel, watchedVehicleId, watchedExpenseDate, form]);

  // Search filters -- Category (searchable dropdown) and an Expense Date
  // range (From Date / To Date), defaulting to today.
  const [filterCategory, setFilterCategory] = useState<string | undefined>(() => {
    const c = searchParams.get("category");
    return c && (CATEGORIES as readonly string[]).includes(c) ? c : undefined;
  });
  const [filterDateRange, setFilterDateRange] = useState<[string, string]>(() => {
    const start = searchParams.get("start_date");
    const end = searchParams.get("end_date");
    if (start && end) return [start, end];
    // Default to TODAY. A Dashboard drill-down (?start_date=&end_date=)
    // still wins, so those links keep opening on their own period.
    const today = dayjs().format(DATE_FORMAT);
    return [today, today];
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
    // New record: nothing saved to protect, so the first vehicle + date
    // selection should fetch straight away.
    skipInitialLookupKeyRef.current = null;
    setFuelLookupNote(null);
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
      // Diesel Fuel rows saved before these fields existed carry only
      // `amount`. Seeding them as 1 x amount preserves the figure exactly,
      // so opening an old fuel expense and saving it cannot silently
      // change its cost. Non-fuel rows just use Amount, which is why this
      // only applies to Diesel Fuel.
      ...(record.category === CATEGORIES[2] &&
      record.fuel_filling == null &&
      record.amount_per_unit == null
        ? { fuel_filling: 1, amount_per_unit: Number(record.amount ?? 0) }
        : {
            fuel_filling: record.fuel_filling != null ? Number(record.fuel_filling) : undefined,
            amount_per_unit:
              record.amount_per_unit != null ? Number(record.amount_per_unit) : undefined,
          }),
      remarks: record.remarks,
    });

    // Protect the stored litres on a Diesel Fuel record until the user
    // actually changes the vehicle or the date (see the ref's comment).
    skipInitialLookupKeyRef.current =
      record.category === CATEGORIES[2] && record.vehicles_id && record.expense_date
        ? `${record.vehicles_id}|${dayjs(record.expense_date).format(DATE_FORMAT)}`
        : null;

    setFuelLookupNote(null);
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
        // Diesel Fuel: send the two inputs and let the server derive both
        // the total and the amount. Any other category: send the amount and
        // explicitly null the fuel fields, so switching a record's category
        // clears figures that no longer apply instead of leaving them
        // stranded on the row.
        //
        // total_fuel_cost is never sent -- the server recomputes it, so the
        // stored total can never disagree with its own inputs.
        ...(isDieselFuel
          ? {
              fuel_filling: values.fuel_filling,
              amount_per_unit: values.amount_per_unit,
              amount: totalFuelCost ?? 0,
            }
          : {
              fuel_filling: null,
              amount_per_unit: null,
              amount: values.amount,
            }),
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
    // Fuel columns render "-" rather than 0.00 when empty, so a non-fuel
    // expense reads as "not applicable" instead of "zero litres".
    {
      title: "Fuel Filling",
      dataIndex: "fuel_filling",
      key: "fuel_filling",
      width: 110,
      render: (v: any) => (v == null ? "-" : `${Number(v).toLocaleString()} L`),
      sorter: (a: any, b: any) => Number(a.fuel_filling ?? 0) - Number(b.fuel_filling ?? 0),
    },
    {
      title: "Amount per Unit",
      dataIndex: "amount_per_unit",
      key: "amount_per_unit",
      width: 130,
      render: (v: any) =>
        v == null
          ? "-"
          : `$ ${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`,
      sorter: (a: any, b: any) => Number(a.amount_per_unit ?? 0) - Number(b.amount_per_unit ?? 0),
    },
    {
      title: "Total Fuel Cost",
      dataIndex: "total_fuel_cost",
      key: "total_fuel_cost",
      width: 130,
      render: (v: any) => (v == null ? "-" : money(Number(v))),
      sorter: (a: any, b: any) => Number(a.total_fuel_cost ?? 0) - Number(b.total_fuel_cost ?? 0),
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
      // four template columns (Repair / Engine Oil / Diesel / Other),
      // matching the uploaded Monthly Report layout exactly.
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
            other: 0,
            // Fuel figures are per-expense-row, not per-category, so they
            // are summed across the group the same way the amounts are.
            fuelFilling: 0,
            totalFuelCost: 0,
            remarksList: [] as string[],
          });
        }
        const g = groups.get(key);
        const amount = Number(r.amount ?? 0);
        if (r.category === CATEGORIES[0]) g.repair += amount;
        else if (r.category === CATEGORIES[1]) g.engineOil += amount;
        else if (r.category === CATEGORIES[2]) g.diesel += amount;
        else if (r.category === CATEGORIES[3]) g.other += amount;
        if (r.fuel_filling != null) g.fuelFilling += Number(r.fuel_filling);
        if (r.total_fuel_cost != null) g.totalFuelCost += Number(r.total_fuel_cost);
        if (r.remarks) g.remarksList.push(r.remarks);
      });
      const pivoted = Array.from(groups.values()).sort((a, b) =>
        String(a.expense_date ?? "").localeCompare(String(b.expense_date ?? ""))
      );

      const ExcelJS = await loadExcelJS();
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
        "Other Expense",
        "Fuel Filling (L)",
        "Total Fuel Cost",
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
        row.getCell(10).value = g.other || 0;
        row.getCell(11).value = g.fuelFilling || 0;
        row.getCell(12).value = g.totalFuelCost || 0;
        row.getCell(13).value = g.remarksList.join("; ");
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
      sheet.getColumn(10).width = 16;
      sheet.getColumn(11).width = 14;
      sheet.getColumn(12).width = 16;
      sheet.getColumn(13).width = 30;

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
            {/* "VID-385 - TT10 3A-3893" via the shared helper, so this
                dropdown matches every other module. Only the LABEL
                changes -- the option value is still vehicles_id, so what
                is saved, reloaded on edit, and read by the reports and the
                Excel export is byte-for-byte unchanged. */}
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="Search vehicle code or plate number..."
              options={vehicleSelectOptions(vehicleOptions)}
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
          {/* Diesel Fuel is measured and priced per unit, so it gets the
              three fuel fields. Fuel Filling is looked up for the selected
              vehicle and date but stays editable -- the metered figure and
              the litres actually invoiced legitimately differ.

              Every other category gets a single Amount field instead. The
              fields are mounted conditionally (not just hidden) so an
              inapplicable value can never be left behind in the form and
              submitted by accident. */}
          {isDieselFuel ? (
            <Row gutter={12}>
              <Col span={8}>
                <Form.Item
                  name="fuel_filling"
                  label="Fuel Filling"
                  rules={[
                    { required: true, message: "Fuel Filling is required" },
                    { type: "number", min: 0, message: "Fuel Filling cannot be negative" },
                  ]}
                  extra={
                    fuelLookupLoading
                      ? "Loading fuel filling for this vehicle..."
                      : fuelLookupNote || "Units. Filled in automatically for the selected vehicle."
                  }
                >
                  <InputNumber
                    style={{ width: "100%" }}
                    min={0}
                    step={0.01}
                    addonAfter={fuelLookupLoading ? <LoadingOutlined /> : "L"}
                    disabled={fuelLookupLoading}
                    placeholder={fuelLookupLoading ? "Loading..." : undefined}
                  />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item
                  name="amount_per_unit"
                  label="Amount per Unit"
                  rules={[
                    { required: true, message: "Amount per Unit is required" },
                    { type: "number", min: 0, message: "Amount per Unit cannot be negative" },
                  ]}
                  extra="Price per unit."
                >
                  <InputNumber style={{ width: "100%" }} min={0} step={0.0001} prefix="$" />
                </Form.Item>
              </Col>
              <Col span={8}>
                {/* Read-only: recomputed live from the two fields above, and
                    recomputed again on save. This is what the expense is
                    recorded at. */}
                <Form.Item label="Total Fuel Cost" extra="Saved as this expense's amount.">
                  <InputNumber
                    style={{ width: "100%", fontWeight: 600, color: "#051650" }}
                    disabled
                    value={totalFuelCost ?? undefined}
                    prefix="$"
                  />
                </Form.Item>
              </Col>
            </Row>
          ) : (
            <Form.Item
              name="amount"
              label="Amount"
              rules={[
                { required: true, message: "Please enter the amount" },
                { type: "number", min: 0, message: "Amount cannot be negative" },
              ]}
            >
              <InputNumber style={{ width: "100%" }} min={0} step={0.01} prefix="$" />
            </Form.Item>
          )}
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
