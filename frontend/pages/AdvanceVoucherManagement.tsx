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
  Input,
  Tag,
  Tooltip,
  Spin,
  Dropdown,
} from "antd";
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  SearchOutlined,
  FileExcelOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  FileDoneOutlined,
  FilePdfOutlined,
  DownOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import { loadExcelJS } from "../src/utils/loadExcelJS";
import { getLogoBuffer } from "../src/utils/companyLogo";
import { useAuth } from "../src/context/AuthContext";
import AdvanceVoucherForm from "./AdvanceVoucherForm";
import type { MasterOption } from "./AdvanceVoucherForm";

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
    duration: 5,
    style: { borderRadius: 10 },
  });

const money = (v: number) =>
  `$ ${Number(v ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/**
 * The sign-off actions, and which status each one may be performed from.
 * Mirrors WORKFLOW in app/routes/advance_clearance_route.py.
 *
 * Held here so a button the user cannot use is never offered -- the
 * server enforces the same rules and is the authority, but an action that
 * can only fail should not be presented as available.
 */
const WORKFLOW: { action: string; label: string; from: string[]; danger?: boolean }[] = [
  { action: "Submit", label: "Submit", from: ["Draft"] },
  { action: "Check", label: "Check (Acc)", from: ["Submitted"] },
  { action: "Acknowledge", label: "Acknowledge (FM)", from: ["Checked"] },
  { action: "Approve", label: "Approve (CFO)", from: ["Acknowledged"] },
  { action: "Complete", label: "Complete", from: ["Approved"] },
  { action: "Reject", label: "Reject", from: ["Submitted", "Checked", "Acknowledged"], danger: true },
  { action: "Reopen", label: "Reopen", from: ["Approved", "Completed"], danger: true },
];

const STATUS_COLOR: Record<string, string> = {
  Draft: "default",
  Submitted: "blue",
  Checked: "cyan",
  Acknowledged: "purple",
  Approved: "green",
  Completed: "green",
  Cancelled: "red",
};

export default function AdvanceVoucherManagement() {
  const { can } = useAuth();
  const canCreate = can("advance-vouchers", "create");
  const canEdit = can("advance-vouchers", "edit");
  const canDelete = can("advance-vouchers", "delete");
  const canExport = can("advance-vouchers", "export");

  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingVoucher, setEditingVoucher] = useState<any>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [approvalTarget, setApprovalTarget] = useState<any>(null);
  const [approvalAction, setApprovalAction] = useState<string>("");
  const [approvalComments, setApprovalComments] = useState("");
  const [approvalSaving, setApprovalSaving] = useState(false);
  // Voucher IDs ticked for export. Pruned on every reload -- see
  // loadVouchers -- so a filter change cannot leave a voucher selected
  // that is no longer on screen.
  const [selectedIds, setSelectedIds] = useState<number[]>([]);

  // Filters
  const [period, setPeriod] = useState<any>(dayjs());
  const [departmentId, setDepartmentId] = useState<number | undefined>();
  const [personId, setPersonId] = useState<number | undefined>();
  const [status, setStatus] = useState<string>("All");
  const [search, setSearch] = useState("");

  // Master data
  const [departments, setDepartments] = useState<MasterOption[]>([]);
  const [persons, setPersons] = useState<(MasterOption & { department_id?: number | null })[]>([]);
  const [categories, setCategories] = useState<MasterOption[]>([]);
  const [expenseByOptions, setExpenseByOptions] = useState<MasterOption[]>([]);
  const [defaultRate, setDefaultRate] = useState<number>(4100);

  useEffect(() => {
    loadMasters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadVouchers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, departmentId, personId, status]);

  const loadMasterList = async (kind: string) => {
    const response = await fetch(`/api/advance/master/${kind}?status=Active`);
    if (!response.ok) throw new Error(response.statusText);
    const result = await response.json();
    return Array.isArray(result.data) ? result.data : [];
  };

  const loadMasters = async () => {
    try {
      const [deps, people, cats, by, settings] = await Promise.all([
        loadMasterList("departments"),
        loadMasterList("persons"),
        loadMasterList("categories"),
        loadMasterList("expense-by"),
        fetch("/api/advance/settings").then((r) => (r.ok ? r.json() : null)),
      ]);
      setDepartments(deps.map((d: any) => ({ id: d.department_id, name: d.name })));
      setPersons(
        people.map((p: any) => ({
          id: p.person_id,
          name: p.name,
          department_id: p.department_id ?? null,
        }))
      );
      setCategories(cats.map((c: any) => ({ id: c.category_id, name: c.name })));
      setExpenseByOptions(by.map((o: any) => ({ id: o.expense_by_id, name: o.name })));
      if (settings?.default_exchange_rate) setDefaultRate(Number(settings.default_exchange_rate));
    } catch (error: any) {
      console.error("Error loading advance master data:", error);
      notifyError("Couldn't load the dropdown lists", error.message);
    }
  };

  const loadVouchers = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (period) {
        params.append("period_year", String(period.year()));
        params.append("period_month", String(period.month() + 1));
      }
      if (departmentId != null) params.append("department_id", String(departmentId));
      if (personId != null) params.append("person_id", String(personId));
      if (status && status !== "All") params.append("status", status);
      const trimmed = search.trim();
      if (trimmed) params.append("search", trimmed);

      const response = await fetch(`/api/advance/vouchers?${params}`);
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      const result = await response.json();
      const list = Array.isArray(result.data) ? result.data : [];
      setRows(list);
      // Drop ticks for vouchers that are no longer listed (filter changed,
      // voucher deleted). Keeping them would export rows the user can no
      // longer see, which is exactly the surprise checkboxes are meant to
      // prevent. Ticks for vouchers still on screen survive the reload.
      setSelectedIds((prev) =>
        prev.filter((id) => list.some((r: any) => r.voucher_id === id))
      );
    } catch (error: any) {
      console.error("Error loading vouchers:", error);
      notifyError("Couldn't load vouchers", error.message);
      setRows([]);
      setSelectedIds([]);
    } finally {
      setLoading(false);
    }
  };

  const openCreate = () => {
    setEditingVoucher(null);
    setIsModalVisible(true);
  };

  const openEdit = async (record: any) => {
    // Refetched rather than reusing the list row: the listing carries
    // totals but not the expense rows, and editing needs the rows.
    try {
      const response = await fetch(`/api/advance/vouchers/${record.voucher_id}`);
      if (!response.ok) throw new Error(response.statusText);
      const result = await response.json();
      setEditingVoucher(result.data);
      setIsModalVisible(true);
    } catch (error: any) {
      notifyError("Couldn't open that voucher", error.message);
    }
  };

  const handleSave = async (payload: any) => {
    setSaving(true);
    try {
      const isEditing = Boolean(editingVoucher);
      const url = isEditing
        ? `/api/advance/vouchers/${editingVoucher.voucher_id}`
        : "/api/advance/vouchers";
      const response = await fetch(url, {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(
          typeof errBody.detail === "string" ? errBody.detail : response.statusText
        );
      }
      const result = await response.json();
      notifySuccess(
        isEditing ? "Voucher updated" : "Voucher created",
        result?.data?.voucher_no ? `Voucher No. ${result.data.voucher_no}` : undefined
      );
      setIsModalVisible(false);
      setEditingVoucher(null);
      loadVouchers();
    } catch (error: any) {
      console.error("Error saving voucher:", error);
      notifyError("Save failed", error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (record: any) => {
    try {
      const response = await fetch(`/api/advance/vouchers/${record.voucher_id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      const result = await response.json();
      notifySuccess(result.message ?? "Done");
      loadVouchers();
    } catch (error: any) {
      notifyError("Delete failed", error.message);
    }
  };

  /**
   * Query string shared by both exports.
   *
   * Sends the ticked voucher IDs *and* the current filters. The server
   * applies both, so a stale ID -- a voucher deleted in another tab, say
   * -- drops out rather than appearing in the file.
   *
   * Returns null when nothing is ticked, having already told the user.
   * Guarding here rather than in each export means the two downloads
   * cannot end up with different rules about what an empty selection
   * means.
   */
  const buildExportParams = (): URLSearchParams | null => {
    if (selectedIds.length === 0) {
      notifyError(
        "Nothing selected",
        "Please select at least one voucher to export."
      );
      return null;
    }
    const params = new URLSearchParams();
    if (period) {
      params.append("period_year", String(period.year()));
      params.append("period_month", String(period.month() + 1));
    }
    if (departmentId != null) params.append("department_id", String(departmentId));
    if (personId != null) params.append("person_id", String(personId));
    if (status && status !== "All") params.append("status", status);
    const trimmed = search.trim();
    if (trimmed) params.append("search", trimmed);
    params.append("voucher_ids", selectedIds.join(","));
    return params;
  };

  /**
   * Excel export -- the expense DETAIL, not just the voucher summary.
   *
   * Two sheets:
   *   "Expense Detail"  one row per expense line, with the voucher's
   *                     columns repeated on every row. Flat and
   *                     rectangular, so it sorts, filters and pivots in
   *                     Excel. A nested layout (voucher header, then its
   *                     rows, then a gap) prints nicely but is useless to
   *                     anyone who wants to pivot by category.
   *   "Voucher Summary" one row per voucher, matching the screen.
   *
   * The rows come from /advance/vouchers/export, which applies the SAME
   * filters as the listing -- so what is exported is what is on screen,
   * not merely the page currently visible.
   */
  const handleExportExcel = async () => {
    const params = buildExportParams();
    if (!params) return;
    setExportLoading(true);
    try {
      const response = await fetch(`/api/advance/vouchers/export?${params}`);
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.detail || response.statusText);
      }
      const result = await response.json();
      const vouchers: any[] = Array.isArray(result.data) ? result.data : [];

      if (vouchers.length === 0) {
        notifyError(
          "Nothing to export",
          "None of the selected vouchers are available. They may have been deleted, or they fall outside the current filters."
        );
        return;
      }

      const ExcelJS = await loadExcelJS();
      const workbook = new ExcelJS.Workbook();

      const headerFill = {
        type: "pattern" as const,
        pattern: "solid" as const,
        fgColor: { argb: "FF051650" },
      };
      const headerFont = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      const thinBorder = {
        top: { style: "thin" as const },
        left: { style: "thin" as const },
        bottom: { style: "thin" as const },
        right: { style: "thin" as const },
      };

      // Logo + title block, shared by both sheets.
      const logoBuffer = await getLogoBuffer();
      const logoImageId = workbook.addImage({ buffer: logoBuffer as any, extension: "png" });

      // --- The Voucher Form: the paper layout, and the only sheet ------
      //
      // Reproduces the printed Advance Clearance Form: the company logo,
      // the same five columns, the same three total lines, and the same
      // four signature blocks. One voucher per printed page, separated by
      // page breaks, so File > Print gives one form per voucher.
      //
      // This is now the ONLY sheet in the workbook. The flat data sheets
      // were dropped: the export is the signable form, not a dataset.
      //
      // The paper form has no Category / Expense By / Currency columns --
      // those were added by the system spec and live on the Expense Detail
      // sheet instead. Keeping this sheet faithful to the paper matters
      // more than showing everything: it is the one people sign.
      const formSheet = workbook.addWorksheet("Voucher Form", {
        pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1 },
      });
      [16, 14, 46, 14, 26].forEach((w, i) => (formSheet.getColumn(i + 1).width = w));

      const labelFont = { bold: true, size: 10 };
      let r = 1;

      vouchers.forEach((v, vIndex) => {
        if (vIndex > 0) {
          r += 2;
          formSheet.getRow(r).addPageBreak();
        }

        // Company logo on its own row, title on the row beneath.
        //
        // An Excel image is anchored, not laid out -- nothing pushes it
        // aside. At this size, sitting it beside the title would run the
        // artwork under the text, so it gets a row to itself and can be
        // enlarged freely.
        //
        // 205x65 holds the source's 466x148 proportions (3.15:1), so the
        // Khmer script and the "FLEET SOLUTIONS" rule stay sharp rather
        // than stretched.
        //
        // The image is anchored per voucher rather than once for the sheet
        // because each voucher starts on its own printed page -- a single
        // logo at the top would appear on page 1 only.
        //
        // tl is 0-BASED (row 1 is index 0), unlike everything else here,
        // which is why it is r - 1.
        formSheet.addImage(logoImageId, {
          tl: { col: 0, row: r - 1 },
          ext: { width: 205, height: 65 },
        });
        // Row height is in POINTS: 65px / 1.333 = 49pt, plus a little air.
        formSheet.getRow(r).height = 52;
        r += 1;

        formSheet.mergeCells(r, 1, r, 5);
        const title = formSheet.getCell(r, 1);
        title.value = "Advance Clearance Form";
        title.font = { bold: true, size: 16 };
        title.alignment = { horizontal: "center", vertical: "middle" };
        formSheet.getRow(r).height = 24;
        r += 2;

        // Department / Voucher No, then Name / Voucher date -- the same
        // two-column header arrangement as the paper form.
        const headerPairs: [string, any, string, any][] = [
          ["Department :", v.department_name ?? "", "Voucher No:", v.voucher_no ?? ""],
          [
            "Name :",
            v.person_name ?? "",
            // The Expense Period, not the single date the voucher was
            // raised on: the period is what the rows below are scoped to,
            // so it is the date range the form should assert.
            "Voucher Date:",
            v.expense_from_date && v.expense_to_date
              ? `${dayjs(v.expense_from_date).format("DD-MMM-YYYY")} - ${dayjs(v.expense_to_date).format("DD-MMM-YYYY")}`
              : v.voucher_date
                ? dayjs(v.voucher_date).format("DD-MMM-YYYY")
                : "",
          ],
        ];
        headerPairs.forEach(([l1, v1, l2, v2]) => {
          formSheet.getCell(r, 1).value = l1;
          formSheet.getCell(r, 1).font = labelFont;
          formSheet.getCell(r, 2).value = v1;
          formSheet.getCell(r, 4).value = l2;
          formSheet.getCell(r, 4).font = labelFont;
          formSheet.getCell(r, 5).value = v2;
          r += 1;
        });
        r += 1;

        // Column headings, worded as on the form.
        // The paper form's five columns exactly -- no Category column.
        // The rows are still GROUPED by category (see the sort above);
        // the grouping is simply implicit, as it is on the paper form.
        const formHeaders = [
          "Bill/Inv. Date",
          "Bill/Inv. No",
          "Description + Principal name related expense (if applicable)",
          "USD/RIELS",
          "Remarks",
        ];
        const headRow = formSheet.getRow(r);
        formHeaders.forEach((h, i) => {
          const cell = headRow.getCell(i + 1);
          cell.value = h;
          cell.font = headerFont;
          cell.fill = headerFill;
          cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
          cell.border = thinBorder;
        });
        headRow.height = 30;
        r += 1;

        // Sorted HERE as well as on save -- Expense Category, then
        // Bill/Invoice Date oldest first.
        //
        // The backend already stores this order in line_order, but only
        // for vouchers saved since that rule existed. Anything entered
        // before it still carries its original entry order, and would
        // export unsorted. Sorting at render time fixes those without
        // anyone having to re-save them, and is a no-op for the rest.
        //
        // Same tie-breaks as the entry form: uncategorised rows last,
        // undated rows at the end of their own category.
        const lines: any[] = [...(Array.isArray(v.lines) ? v.lines : [])].sort((a, b) => {
          const ca = a.category_name ?? "";
          const cb = b.category_name ?? "";
          if (!ca !== !cb) return ca ? -1 : 1;
          const byCategory = ca.toLowerCase().localeCompare(cb.toLowerCase());
          if (byCategory !== 0) return byCategory;
          // Sliced to the first 10 chars (YYYY-MM-DD). MySQL can hand
          // back a DATE as either "2026-08-05" or "2026-08-05T00:00:00"
          // depending on the driver, and mixing the two in one comparison
          // is the kind of thing that sorts right in testing and wrong in
          // production. Trimming to the date part makes the format
          // irrelevant, and ISO dates sort correctly as plain strings.
          const da = String(a.expense_date ?? "9999-12-31").slice(0, 10);
          const db = String(b.expense_date ?? "9999-12-31").slice(0, 10);
          return da.localeCompare(db);
        });

        lines.forEach((l) => {
          const row = formSheet.getRow(r);
          // A KHR row is totalled in USD like every other row, so the
          // original figure is noted alongside rather than replacing it --
          // otherwise the column would not add up to the total below.
          const khrNote =
            l.currency === "KHR"
              ? `KHR ${Number(l.amount ?? 0).toLocaleString()} @ ${Number(l.exchange_rate ?? 0).toLocaleString()}`
              : "";
          const remark = [l.remarks ?? "", khrNote].filter(Boolean).join(" | ");

          row.getCell(1).value = l.expense_date ? dayjs(l.expense_date).format("D-MMM-YY") : "";
          row.getCell(2).value = l.bill_no ?? "";
          row.getCell(3).value = l.description ?? "";
          row.getCell(4).value = Number(l.amount_usd ?? 0);
          row.getCell(4).numFmt = '"$" #,##0.00';
          row.getCell(5).value = remark;
          for (let c = 1; c <= 5; c++) {
            row.getCell(c).border = thinBorder;
            row.getCell(c).alignment = { vertical: "middle", wrapText: c === 3 || c === 5 };
          }
          r += 1;
        });

        if (lines.length === 0) {
          const row = formSheet.getRow(r);
          formSheet.mergeCells(r, 1, r, 5);
          row.getCell(1).value = "(no expense rows recorded)";
          row.getCell(1).font = { italic: true, color: { argb: "FF999999" } };
          row.getCell(1).alignment = { horizontal: "center" };
          row.getCell(1).border = thinBorder;
          r += 1;
        }

        // The three totals, in the form's own wording and order.
        const totals: [string, number][] = [
          ["Total Actual Expense", Number(v.total_actual_expense ?? 0)],
          ["Total Cash Advance", Number(v.total_cash_advance ?? 0)],
          [
            "Amount Return/Amount Refund",
            v.balance_status === "Refund"
              ? Number(v.amount_refund ?? 0)
              : Number(v.amount_return ?? 0),
          ],
        ];
        totals.forEach(([label, value], i) => {
          const row = formSheet.getRow(r);
          formSheet.mergeCells(r, 1, r, 3);
          row.getCell(1).value = label;
          row.getCell(1).font = { bold: true };
          row.getCell(1).alignment = { horizontal: "right", vertical: "middle" };
          row.getCell(4).value = value;
          row.getCell(4).numFmt = '"$" #,##0.00';
          row.getCell(4).font = { bold: true };
          // Which way the balance goes is not readable from the number
          // alone, so the last line says it in words.
          if (i === 2) row.getCell(5).value = v.balance_status ?? "";
          for (let c = 1; c <= 5; c++) row.getCell(c).border = thinBorder;
          r += 1;
        });

        // Signature blocks, filled from the APPROVAL TRAIL.
        //
        // Each name is read back from the row written when that person
        // clicked the button -- never typed into a form. A typed name
        // proves nothing; a name captured from the authenticated session,
        // with the moment it happened and a reference back to the stored
        // record, is something someone can stand behind.
        //
        // A step nobody has performed prints blank, to be signed by hand.
        // Printing a name the system cannot evidence would turn a signed
        // finance document into a false record.
        const signoffs: Record<string, any> = v.signoffs ?? {};
        const signoff = (action: string) => {
          const a = signoffs[action];
          if (!a) return { name: "", when: "", ref: "" };
          return {
            name: a.user_name ?? "",
            when: a.signed_at ? dayjs(a.signed_at).format("DD-MMM-YYYY HH:mm") : "",
            ref: a.reference ?? "",
          };
        };

        r += 2;
        const signatories: [string, string, string, string][] = [
          ["Requested by:", ...Object.values(signoff("Submit"))] as any,
          ["Checked by: Acc", ...Object.values(signoff("Check"))] as any,
          ["Acknowledged by: FM", ...Object.values(signoff("Acknowledge"))] as any,
          ["Approved by: CFO", ...Object.values(signoff("Approve"))] as any,
        ];

        const sigLabelRow = formSheet.getRow(r);
        signatories.forEach(([label], i) => {
          const cell = sigLabelRow.getCell(i + 1);
          cell.value = label;
          cell.font = labelFont;
          cell.alignment = { horizontal: "left", vertical: "top" };
        });
        r += 1;

        // Blank row to sign across. No border -- the signature goes in
        // the white space, and a rule under it only competes with the
        // Name and Date lines directly below.
        formSheet.getRow(r).height = 46;
        r += 1;

        // Name, then Date -- one row each, so the four blocks line up
        // across the page instead of drifting.
        const nameRow = formSheet.getRow(r);
        signatories.forEach(([, name], i) => {
          const cell = nameRow.getCell(i + 1);
          cell.value = name ? `Name: ${name}` : "Name:";
          cell.font = { size: 10 };
          cell.alignment = { horizontal: "left", vertical: "middle" };
        });
        nameRow.height = 18;
        r += 1;

        const dateRow = formSheet.getRow(r);
        signatories.forEach(([, , when], i) => {
          const cell = dateRow.getCell(i + 1);
          cell.value = when ? `Date: ${when}` : "Date:";
          cell.font = { size: 10 };
          cell.alignment = { horizontal: "left", vertical: "middle" };
        });
        dateRow.height = 18;
        r += 1;

        // The reference is what makes the printed name checkable: quote it
        // and the exact sign-off row can be found in the system. Small and
        // grey -- it is for verification, not for reading.
        const refRow = formSheet.getRow(r);
        signatories.forEach(([, , , ref], i) => {
          const cell = refRow.getCell(i + 1);
          cell.value = ref ? `Ref: ${ref}` : "";
          cell.font = { size: 8, color: { argb: "FF888888" } };
          cell.alignment = { horizontal: "left", vertical: "middle" };
        });
        refRow.height = 14;
        r += 2;
      });

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Advance_Clearance_${period ? period.format("YYYY-MM") : "all"}.xlsx`;
      link.click();
      window.URL.revokeObjectURL(url);
    } catch (error: any) {
      console.error("Error exporting advance clearance:", error);
      notifyError("Export failed", error.message);
    } finally {
      setExportLoading(false);
    }
  };

  /**
   * Records one sign-off. The name is NOT sent -- the server takes it
   * from the authenticated session, which is the whole point: a name the
   * client could choose would prove nothing.
   */
  const submitApproval = async () => {
    if (!approvalTarget || !approvalAction) return;
    setApprovalSaving(true);
    try {
      const response = await fetch(
        `/api/advance/vouchers/${approvalTarget.voucher_id}/approvals`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: approvalAction, comments: approvalComments || null }),
        }
      );
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(
          typeof errBody.detail === "string" ? errBody.detail : response.statusText
        );
      }
      const result = await response.json();
      notifySuccess(
        `${approvalAction} recorded`,
        `${approvalTarget.voucher_no} is now ${result?.data?.status ?? "updated"}.`
      );
      setApprovalTarget(null);
      setApprovalAction("");
      setApprovalComments("");
      loadVouchers();
    } catch (error: any) {
      notifyError(`Couldn't ${approvalAction.toLowerCase()} this voucher`, error.message);
    } finally {
      setApprovalSaving(false);
    }
  };

  const [pdfLoading, setPdfLoading] = useState(false);

  /**
   * PDF export. Built on the SERVER, unlike the Excel file -- reportlab
   * renders a fixed page, which is what "print-ready" means, and it is
   * also where a real document signature would later be applied. The
   * endpoint reuses the Excel export's own query, so the two downloads
   * cannot contain different data.
   */
  const handleExportPdf = async () => {
    const params = buildExportParams();
    if (!params) return;
    setPdfLoading(true);
    try {
      const response = await fetch(`/api/advance/vouchers/pdf?${params}`);
      if (!response.ok) {
        // The endpoint returns JSON on failure and a PDF on success, so
        // the error body has to be read as JSON explicitly.
        const errBody = await response.json().catch(() => ({}));
        throw new Error(
          typeof errBody.detail === "string" ? errBody.detail : response.statusText
        );
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      // One voucher selected -> name the file after it, which is what
      // someone downloading a single form to send on actually wants.
      const single =
        selectedIds.length === 1
          ? rows.find((r) => r.voucher_id === selectedIds[0])?.voucher_no
          : null;
      link.download = single
        ? `Advance_Clearance_${single}.pdf`
        : `Advance_Clearance_${selectedIds.length}_vouchers.pdf`;
      link.click();
      window.URL.revokeObjectURL(url);
    } catch (error: any) {
      console.error("Error exporting advance clearance PDF:", error);
      notifyError("PDF export failed", error.message);
    } finally {
      setPdfLoading(false);
    }
  };

  const columns = [
    { title: "No", key: "no", width: 55, render: (_: any, __: any, i: number) => i + 1 },
    {
      title: "Voucher No.",
      dataIndex: "voucher_no",
      key: "voucher_no",
      width: 150,
      render: (v: string) => <strong style={{ color: "#051650" }}>{v}</strong>,
      sorter: (a: any, b: any) => String(a.voucher_no).localeCompare(String(b.voucher_no)),
    },
    {
      title: "Voucher Date",
      dataIndex: "voucher_date",
      key: "voucher_date",
      width: 120,
      render: (v: string) => (v ? dayjs(v).format("DD-MMM-YYYY") : "-"),
      sorter: (a: any, b: any) => String(a.voucher_date).localeCompare(String(b.voucher_date)),
    },
    {
      title: "Name",
      dataIndex: "person_name",
      key: "person_name",
      width: 170,
      sorter: (a: any, b: any) =>
        String(a.person_name ?? "").localeCompare(String(b.person_name ?? "")),
    },
    {
      title: "Department",
      dataIndex: "department_name",
      key: "department_name",
      width: 150,
      render: (v: string) => v || <span style={{ color: "#bfbfbf" }}>-</span>,
    },
    {
      title: "Expense Period",
      key: "expense_period",
      width: 190,
      render: (_: any, r: any) =>
        r.expense_from_date && r.expense_to_date
          ? `${dayjs(r.expense_from_date).format("DD-MMM")} - ${dayjs(r.expense_to_date).format("DD-MMM-YYYY")}`
          : "-",
    },
    {
      title: "Cash Advance",
      dataIndex: "total_cash_advance",
      key: "total_cash_advance",
      width: 130,
      align: "right" as const,
      render: (v: number) => money(v),
      sorter: (a: any, b: any) => (a.total_cash_advance ?? 0) - (b.total_cash_advance ?? 0),
    },
    {
      title: "Actual Expense",
      dataIndex: "total_actual_expense",
      key: "total_actual_expense",
      width: 130,
      align: "right" as const,
      render: (v: number) => money(v),
      sorter: (a: any, b: any) => (a.total_actual_expense ?? 0) - (b.total_actual_expense ?? 0),
    },
    {
      // One column, because Return and Refund are mutually exclusive --
      // two columns would leave one of them blank on every single row.
      title: "Return / Refund",
      key: "balance",
      width: 190,
      align: "right" as const,
      render: (_: any, r: any) =>
        r.balance_status === "Cleared" ? (
          <Tag>Cleared</Tag>
        ) : (
          <span>
            <strong
              style={{ color: r.balance_status === "Return" ? "#389e0d" : "#cf1322" }}
            >
              {money(r.balance_status === "Return" ? r.amount_return : r.amount_refund)}
            </strong>{" "}
            <Tag color={r.balance_status === "Return" ? "green" : "red"}>
              {r.balance_status}
            </Tag>
          </span>
        ),
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      width: 120,
      render: (v: string) => <Tag color={STATUS_COLOR[v] ?? "default"}>{v}</Tag>,
    },
    {
      title: "Action",
      key: "action",
      width: 190,
      fixed: "right" as const,
      render: (_: any, record: any) => {
        const available = WORKFLOW.filter((w) => w.from.includes(record.status));
        return (
        <Space>
          {canEdit && available.length > 0 && (
            <Dropdown
              menu={{
                items: available.map((w) => ({
                  key: w.action,
                  label: w.label,
                  danger: w.danger,
                })),
                onClick: ({ key }) => {
                  setApprovalTarget(record);
                  setApprovalAction(String(key));
                  setApprovalComments("");
                },
              }}
            >
              <Button size="small" type="primary" style={{ backgroundColor: "#051650" }}>
                Sign off <DownOutlined />
              </Button>
            </Dropdown>
          )}
          {canEdit && (
            <Tooltip title="Edit">
              <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
            </Tooltip>
          )}
          {canDelete && (
            <Popconfirm
              title={record.status === "Draft" ? "Delete this draft?" : "Cancel this voucher?"}
              description={
                record.status === "Draft"
                  ? "A draft is removed completely."
                  : "A submitted voucher is cancelled, not deleted, so its number is never reused."
              }
              onConfirm={() => handleDelete(record)}
            >
              <Tooltip title={record.status === "Draft" ? "Delete" : "Cancel"}>
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Tooltip>
            </Popconfirm>
          )}
        </Space>
        );
      },
    },
  ];

  return (
    <Card
      title={
        <span>
          <FileDoneOutlined style={{ marginRight: 8 }} />
          Advance Clearance Vouchers
        </span>
      }
      extra={
        <Space wrap>
          <DatePicker
            picker="month"
            format="MMMM YYYY"
            value={period}
            onChange={setPeriod}
            style={{ width: 150 }}
            allowClear
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="Department"
            style={{ width: 150 }}
            value={departmentId}
            onChange={setDepartmentId}
            options={departments.map((d) => ({ value: d.id, label: d.name }))}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="Name"
            style={{ width: 150 }}
            value={personId}
            onChange={setPersonId}
            options={persons.map((p) => ({ value: p.id, label: p.name }))}
          />
          <Select
            style={{ width: 130 }}
            value={status}
            onChange={setStatus}
            options={[
              { value: "All", label: "All statuses" },
              ...Object.keys(STATUS_COLOR).map((s) => ({ value: s, label: s })),
            ]}
          />
          <Input
            allowClear
            placeholder="Voucher No. or name"
            prefix={<SearchOutlined style={{ color: "#bfbfbf" }} />}
            value={search}
            onChange={(e) => {
              const next = e.target.value;
              setSearch(next);
              if (next === "") loadVouchers();
            }}
            onPressEnter={loadVouchers}
            style={{ width: 200 }}
          />
          <Tooltip title="Refresh">
            <Button aria-label="Refresh" icon={<ReloadOutlined />} onClick={loadVouchers} />
          </Tooltip>
          {/* How many vouchers the export buttons will actually produce.
              Without this the buttons look identical whether one voucher
              is ticked or forty, and the count is the whole point of the
              checkboxes. */}
          {canExport && selectedIds.length > 0 && (
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              {selectedIds.length} selected
            </Tag>
          )}
          {canExport && (
            <Tooltip
              title={
                selectedIds.length === 0
                  ? "Tick at least one Voucher No. to export"
                  : `Export ${selectedIds.length} voucher(s) to PDF (print-ready form)`
              }
            >
              <Button
                aria-label="Export PDF"
                icon={<FilePdfOutlined />}
                style={
                  selectedIds.length === 0
                    ? undefined
                    : { background: "#b7302a", borderColor: "#b7302a", color: "#fff" }
                }
                onClick={handleExportPdf}
                loading={pdfLoading}
                // Deliberately NOT disabled when nothing is ticked: a
                // disabled button gives no reason, and "why is this grey?"
                // is a worse experience than a click that explains itself.
                disabled={rows.length === 0}
              />
            </Tooltip>
          )}
          {canExport && (
            <Tooltip
              title={
                selectedIds.length === 0
                  ? "Tick at least one Voucher No. to export"
                  : `Export ${selectedIds.length} voucher(s) to Excel (with expense detail)`
              }
            >
              <Button
                aria-label="Export Excel"
                icon={<FileExcelOutlined />}
                style={
                  selectedIds.length === 0
                    ? undefined
                    : { background: "#217346", borderColor: "#217346", color: "#fff" }
                }
                onClick={handleExportExcel}
                loading={exportLoading}
                disabled={rows.length === 0}
              />
            </Tooltip>
          )}
          {canCreate && (
            <Tooltip title="New Voucher">
              <Button
                aria-label="New Voucher"
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
      <Spin spinning={loading}>
        <Table
          className="compact-vehicle-table"
          size="small"
          bordered
          columns={columns}
          dataSource={rows}
          rowKey="voucher_id"
          // Checkbox per Voucher No., plus antd's own header checkbox for
          // Select All. preserveSelectedRowKeys keeps ticks alive across
          // pages, so selecting on page 1 and page 2 exports both --
          // without it antd drops keys it cannot currently see.
          rowSelection={
            canExport
              ? {
                  selectedRowKeys: selectedIds,
                  onChange: (keys) => setSelectedIds(keys as number[]),
                  preserveSelectedRowKeys: true,
                  columnWidth: 48,
                  // The header checkbox ticks the CURRENT PAGE, which is
                  // antd's behaviour and the one people expect from a
                  // header checkbox. The dropdown beside it adds "Select
                  // all data" for every voucher the filters match, which
                  // is the other thing people mean by Select All -- both
                  // are offered rather than guessing which was meant.
                  selections: [
                    Table.SELECTION_ALL,
                    Table.SELECTION_INVERT,
                    Table.SELECTION_NONE,
                  ],
                }
              : undefined
          }
          scroll={{ x: "max-content" }}
          locale={{ emptyText: "No records found." }}
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `Total ${t} vouchers` }}
        />
      </Spin>

      <Modal
        title={`${approvalAction} - ${approvalTarget?.voucher_no ?? ""}`}
        open={Boolean(approvalTarget)}
        onCancel={() => setApprovalTarget(null)}
        onOk={submitApproval}
        okText={`Confirm ${approvalAction}`}
        confirmLoading={approvalSaving}
        okButtonProps={{
          danger: WORKFLOW.find((w) => w.action === approvalAction)?.danger,
          style: WORKFLOW.find((w) => w.action === approvalAction)?.danger
            ? undefined
            : { backgroundColor: "#051650" },
        }}
        destroyOnClose
      >
        <p>
          This is recorded against <strong>your account</strong>, with the date and
          time, and is printed on the exported voucher form. It cannot be edited
          or removed afterwards.
        </p>
        <Input.TextArea
          rows={3}
          placeholder="Comments (optional)"
          value={approvalComments}
          onChange={(e) => setApprovalComments(e.target.value)}
        />
      </Modal>

      <Modal
        title={editingVoucher ? `Edit ${editingVoucher.voucher_no}` : "New Advance Clearance Voucher"}
        open={isModalVisible}
        onCancel={() => {
          setIsModalVisible(false);
          setEditingVoucher(null);
        }}
        footer={null}
        width={1400}
        destroyOnClose
      >
        <AdvanceVoucherForm
          initialValues={editingVoucher}
          departments={departments}
          persons={persons}
          categories={categories}
          expenseByOptions={expenseByOptions}
          defaultExchangeRate={defaultRate}
          onSave={handleSave}
          onCancel={() => {
            setIsModalVisible(false);
            setEditingVoucher(null);
          }}
          saving={saving}
        />
      </Modal>
    </Card>
  );
}
