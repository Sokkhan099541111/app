import { useState, useEffect } from 'react';
import dayjs from 'dayjs';
import ExcelJS from 'exceljs';
import { getLogoBuffer } from "../src/utils/companyLogo";
import {
  Card,
  Table,
  Select,
  DatePicker,
  Button,
  Space,
  Alert,
  Popover,
  Checkbox,
  Divider,
  message,
  Tooltip,
} from "antd";

import {
  SearchOutlined,
  ReloadOutlined,
  FileExcelOutlined,
  ToolOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { useAuth } from "../src/context/AuthContext";
//const GROUP_API_URL = "http://127.0.0.1:8080/api/objects/group_snkrp";

const DATE_FORMAT = "YYYY-MM-DD";
const REQUIRED_FIELDS_MESSAGE =
  "Please select an Object ID and Date before searching.";

// Toggleable columns, grouped for display in the "Columns" picker.
// "No" is intentionally excluded -- it's always shown as the row index.
const COLUMN_GROUPS = [
  {
    title: "General",
    items: [
      { key: "searchDate", label: "Date" },
      { key: "code", label: "Code" },
      { key: "plate", label: "Plate Number" },
      { key: "vehicleTypeEng", label: "Vehicle Type" },
      { key: "fullName", label: "Driver Name" },
      { key: "phoneNumber", label: "Phone Number" },
      { key: "drivingLicense", label: "Driving License" },
      { key: "baseLocation", label: "Base Location" },
      { key: "projectCode", label: "Project Code" },
    ],
  },
  {
    title: "Driver Daily Operation Report",
    items: [
      { key: "startTime", label: "Start Time" },
      { key: "endTime", label: "End Time" },
      { key: "workingHours", label: "Working Hours" },
      { key: "fuelFilledLiters", label: "Fuel Filled (L)" },
      { key: "initialMileage", label: "Initial Mileage" },
      { key: "finalMileage", label: "Final Mileage" },
      { key: "totalMileage", label: "Total Mileage" },
    ],
  },
  {
    title: "Variance",
    items: [
      { key: "variance", label: "Variance" },
      { key: "percentage", label: "Percentage" },
    ],
  },
  {
    title: "GPS Daily Operation Report",
    items: [
      { key: "mileage", label: "Mileage" },
      { key: "engineHours", label: "Engine Hours" },
      { key: "initialFuel", label: "Initial Fuel" },
      { key: "fuelFilling", label: "Fuel Filling" },
      { key: "fuelConsumed", label: "Fuel Consumed" },
      { key: "finalFuelLevel", label: "Final Fuel Level" },
      { key: "fuelStandard", label: "Fuel Standard" },
      { key: "actualFuelConsumption", label: "Actual Fuel Consumption (L/h)" },
      { key: "overStandardFuelConsumption", label: "Over Standard Fuel Consumption per Hour" },
    ],
  },
  {
    title: "Other",
    items: [{ key: "remarks", label: "Remark" }],
  },
];

const ALL_TOGGLEABLE_KEYS = COLUMN_GROUPS.flatMap((group) => group.items.map((item) => item.key));


function daily_Activities() {
  const { can } = useAuth();
  const canExport = can("daily-activities", "export");
  const [unitGroups, setUnitGroups] = useState<any[]>([]);
  const [selectedUnitGroup, setSelectedUnitGroup] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [vehicleData, setVehicleData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [visibleColumns, setVisibleColumns] = useState<string[]>(ALL_TOGGLEABLE_KEYS);
  const [exportLoading, setExportLoading] = useState(false);

  // Initial load: fetch object groups, pick a default, and auto-run a
  // search for today's date. Runs once on mount.
  useEffect(() => {
    initializeDefaults();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const initializeDefaults = async () => {
    const groups = await loadUnitGroups();
    const today = dayjs().format(DATE_FORMAT);
    const defaultGroupId = groups.length > 0 ? String(groups[0].id) : '';

    setSelectedUnitGroup(defaultGroupId);
    setStartDate(today);
    setEndDate(today);
    setValidationMessage(null);

    await fetchData(defaultGroupId, today, today);
    setHasLoadedOnce(true);
  };

  const loadUnitGroups = async (): Promise<any[]> => {
    try {
      const response = await fetch('/api/objects/group_snkrp');
      if (!response.ok) {
        throw new Error(`Failed to fetch unit groups: ${response.statusText}`);
      }
      const data = await response.json();
      // Backend returns { status: "success", objects: [...] }
      const groups = Array.isArray(data.objects) ? data.objects : [];
      setUnitGroups(groups);
      return groups;
    } catch (error) {
      console.error('Error loading unit groups:', error);
      return [];
    }
  };

  const fetchData = async (groupId: string, start: string, end: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (groupId) params.append('groupId', groupId);
      if (start) params.append('start', start);
      if (end) params.append('end', end);

      const response = await fetch(`/api/reports/vehicles?${params}`);
      if (!response.ok) throw new Error(`Failed to fetch vehicles: ${response.statusText}`);
      const result = await response.json();
      setVehicleData(Array.isArray(result) ? result : []);
    } catch (error) {
      console.error('Error loading vehicle data:', error);
    } finally {
      setLoading(false);
    }
  };

  // Gate every search after the initial load behind full validation.
  const handleSearch = () => {
    if (!selectedUnitGroup || !startDate) {
      setValidationMessage(REQUIRED_FIELDS_MESSAGE);
      return;
    }
    setValidationMessage(null);
    setCurrentPage(1);
    fetchData(selectedUnitGroup, startDate, endDate);
  };

  const handleGroupChange = (value: string) => {
    setSelectedUnitGroup(value);
    setValidationMessage(null);
  };

  // Single date select: the same date is used for both start and end,
  // since /reports/vehicles still takes a start/end range under the hood.
  // antd's DatePicker passes null for dateString when the user clears the
  // field, so the parameter must be nullable. startDate/endDate are plain
  // strings, so a cleared date becomes "" -- which the Search button's
  // disabled check already treats as "no date selected".
  const handleDateChange = (_: unknown, dateString: string | null) => {
    setStartDate(dateString ?? "");
    setEndDate(dateString ?? "");
    setValidationMessage(null);
  };

  const searchDisabled = loading || (hasLoadedOnce && (!selectedUnitGroup || !startDate));

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
      key: "searchDate",
      // Every row in this report is the single searched date, so there is
      // nothing to order by -- returning 0 keeps the sort arrows visible
      // for visual consistency with the other columns without reordering.
      sorter: () => 0,
      render: () => (startDate ? dayjs(startDate).format("DD-MMM-YYYY") : "-"),
    },
    {
      title: "Code",
      dataIndex: "code",
      fixed: "left" as const,
      sorter: (a: any, b: any) => String(a.code ?? "").localeCompare(String(b.code ?? "")),
    },
    {
      title: "Plate Number",
      dataIndex: "plate",
      fixed: "left" as const,
      sorter: (a: any, b: any) => a.plate.localeCompare(b.plate),
    },
    {
      title: "Vehicle Type",
      dataIndex: "vehicleTypeEng",
      sorter: (a: any, b: any) => String(a.vehicleTypeEng ?? "").localeCompare(String(b.vehicleTypeEng ?? "")),
    },
    {
      title: "Driver Name",
      dataIndex: "fullName",
      sorter: (a: any, b: any) => String(a.fullName ?? "").localeCompare(String(b.fullName ?? "")),
    },
    {
      title: "Phone Number",
      dataIndex: "phoneNumber",
      sorter: (a: any, b: any) => String(a.phoneNumber ?? "").localeCompare(String(b.phoneNumber ?? "")),
    },
    {
      title: "Driving License",
      dataIndex: "drivingLicense",
      sorter: (a: any, b: any) => String(a.drivingLicense ?? "").localeCompare(String(b.drivingLicense ?? "")),
    },
    {
      title: "Base Location",
      dataIndex: "baseLocation",
      sorter: (a: any, b: any) => String(a.baseLocation ?? "").localeCompare(String(b.baseLocation ?? "")),
    },
    {
      title: "Project Code",
      dataIndex: "projectCode",
      sorter: (a: any, b: any) => String(a.projectCode ?? "").localeCompare(String(b.projectCode ?? "")),
    },
    {
      title: "Driver Daily Operation Report",
      children: [
        {
          title: "Start Time",
          dataIndex: "startTime",
          sorter: (a: any, b: any) => String(a.startTime ?? "").localeCompare(String(b.startTime ?? "")),
          render: (startTime: string) => (startTime ? dayjs(startTime).format("HH:mm") : "00:00"),
        },
        {
          title: "End Time",
          dataIndex: "endTime",
          sorter: (a: any, b: any) => String(a.endTime ?? "").localeCompare(String(b.endTime ?? "")),
          render: (endTime: string) => (endTime ? dayjs(endTime).format("HH:mm") : "00:00"),
        },
        {
          title: "Working Hours",
          dataIndex: "workingHours",
          sorter: (a: any, b: any) => (a.workingHours ?? 0) - (b.workingHours ?? 0),
          render: (workingHours: number) => `${(workingHours ?? 0).toFixed(2)} h`,
        },
        {
          title: "Fuel Filled (L)",
          dataIndex: "fuelFilledLiters",
          sorter: (a: any, b: any) => (a.fuelFilledLiters ?? 0) - (b.fuelFilledLiters ?? 0),
          render: (fuelFilledLiters: number) => `${(fuelFilledLiters ?? 0).toLocaleString()} l`,
        },
        {
          title: "Initial Mileage",
          dataIndex: "initialMileage",
          sorter: (a: any, b: any) => (a.initialMileage ?? 0) - (b.initialMileage ?? 0),
          render: (initialMileage: number) => `${(initialMileage ?? 0).toLocaleString()} km`,
        },
        {
          title: "Final Mileage",
          dataIndex: "finalMileage",
          sorter: (a: any, b: any) => (a.finalMileage ?? 0) - (b.finalMileage ?? 0),
          render: (finalMileage: number) => `${(finalMileage ?? 0).toLocaleString()} km`,
        },
        {
          title: "Total Mileage",
          dataIndex: "totalMileage",
          sorter: (a: any, b: any) => (a.totalMileage ?? 0) - (b.totalMileage ?? 0),
          render: (totalMileage: number) => `${(totalMileage ?? 0).toLocaleString()} km`,
        },
      ],
    },
    {
      title: "Variance",
      key: "variance",
      sorter: (a: any, b: any) =>
        ((a.fuelFilledLiters ?? 0) - (a.fuelFilling ?? 0)) -
        ((b.fuelFilledLiters ?? 0) - (b.fuelFilling ?? 0)),
      render: (_: any, record: any) => {
        const variance = (record.fuelFilledLiters ?? 0) - (record.fuelFilling ?? 0);
        return `${variance.toLocaleString()} l`;
      },
    },
    {
      title: "Percentage",
      key: "percentage",
      sorter: (a: any, b: any) => {
        const pctA = (a.fuelFilledLiters ?? 0) !== 0
          ? (((a.fuelFilledLiters ?? 0) - (a.fuelFilling ?? 0)) / (a.fuelFilledLiters ?? 0)) * 100
          : 0;
        const pctB = (b.fuelFilledLiters ?? 0) !== 0
          ? (((b.fuelFilledLiters ?? 0) - (b.fuelFilling ?? 0)) / (b.fuelFilledLiters ?? 0)) * 100
          : 0;
        return pctA - pctB;
      },
      render: (_: any, record: any) => {
        const fuelFilledLiters = record.fuelFilledLiters ?? 0;
        const fuelFilling = record.fuelFilling ?? 0;
        if (fuelFilledLiters === 0) return "0%";
        const percentage = Math.round(((fuelFilledLiters - fuelFilling) / fuelFilledLiters) * 100);
        return `${percentage}%`;
      },
    },
    {
      title: "GPS Daily Operation Report",
      children: [
        {
          title: "Mileage",
          dataIndex: "mileage",
          sorter: (a: any, b: any) => a.mileage - b.mileage,
          render: (mileage: number) => `${mileage.toLocaleString()} km`,
        },
        {
          title: "Engine Hours",
          dataIndex: "engineHours",
          sorter: (a: any, b: any) => (a.engineHours ?? 0) - (b.engineHours ?? 0),
          render: (engineHours: number) => `${(engineHours ?? 0).toFixed(2)} h`,
        },
        {
          title: "Initial Fuel",
          dataIndex: "initialFuel",
          sorter: (a: any, b: any) => (a.initialFuel ?? 0) - (b.initialFuel ?? 0),
          render: (initialFuel: number) => `${(initialFuel ?? 0).toLocaleString()} l`,
        },
        {
          title: "Fuel Filling",
          dataIndex: "fuelFilling",
          sorter: (a: any, b: any) => (a.fuelFilling ?? 0) - (b.fuelFilling ?? 0),
          render: (fuelFilling: number) => `${(fuelFilling ?? 0).toLocaleString()} l`,
        },
        {
          title: "Fuel Consumed",
          dataIndex: "fuelConsumed",
          sorter: (a: any, b: any) => (a.fuelConsumed ?? 0) - (b.fuelConsumed ?? 0),
          render: (fuelConsumed: number) => `${(fuelConsumed ?? 0).toLocaleString()} l`,
        },
        {
          title: "Final Fuel Level",
          dataIndex: "finalFuelLevel",
          sorter: (a: any, b: any) => (a.finalFuelLevel ?? 0) - (b.finalFuelLevel ?? 0),
          render: (finalFuelLevel: number) => `${(finalFuelLevel ?? 0).toLocaleString()} l`,
        },
        {
          title: "Fuel Standard",
          dataIndex: "fuelStandard",
          sorter: (a: any, b: any) => String(a.fuelStandard ?? "").localeCompare(String(b.fuelStandard ?? "")),
          render: (fuelStandard: string) => (fuelStandard ? fuelStandard : "0 L"),
        },
        {
          title: "Actual Fuel Consumption (L/h)",
          key: "actualFuelConsumption",
          sorter: (a: any, b: any) => {
            const rateA = (a.engineHours ?? 0) !== 0 ? (a.fuelConsumed ?? 0) / a.engineHours : 0;
            const rateB = (b.engineHours ?? 0) !== 0 ? (b.fuelConsumed ?? 0) / b.engineHours : 0;
            return rateA - rateB;
          },
          render: (_: any, record: any) => {
            const fuelConsumed = record.fuelConsumed ?? 0;
            const engineHours = record.engineHours ?? 0;
            if (engineHours === 0) return "0 L";
            return `${(fuelConsumed / engineHours).toFixed(2)} L`;
          },
        },
        {
          title: "Over Standard Fuel Consumption per Hour",
          key: "overStandardFuelConsumption",
          sorter: (a: any, b: any) => {
            const calc = (record: any) => {
              const engineHours = record.engineHours ?? 0;
              const fuelConsumed = record.fuelConsumed ?? 0;
              const actual = engineHours !== 0 ? fuelConsumed / engineHours : 0;
              const standard =
                parseFloat(String(record.fuelStandard ?? "").replace(/[^0-9.]/g, "")) || 0;
              return actual <= 0 ? 0 : actual - standard;
            };
            return calc(a) - calc(b);
          },
          render: (_: any, record: any) => {
            const engineHours = record.engineHours ?? 0;
            const fuelConsumed = record.fuelConsumed ?? 0;
            const actual = engineHours !== 0 ? fuelConsumed / engineHours : 0;
            const standard =
              parseFloat(String(record.fuelStandard ?? "").replace(/[^0-9.]/g, "")) || 0;
            const over = actual <= 0 ? 0 : actual - standard;
            return `${over.toFixed(2)} L`;
          },
        },
      ],
    },
    {
      title: "Remark",
      dataIndex: "remarks",
      sorter: (a: any, b: any) => String(a.remarks ?? "").localeCompare(String(b.remarks ?? "")),
    },
  ];

  const isColumnVisible = (key?: string) =>
    !key || key === "no" || visibleColumns.includes(key);

  const columns = allColumns
    .map((col: any) => {
      if (col.children) {
        const children = col.children.filter((child: any) =>
          isColumnVisible(child.key ?? child.dataIndex)
        );
        if (children.length === 0) return null;
        return { ...col, children };
      }
      return isColumnVisible(col.key ?? col.dataIndex) ? col : null;
    })
    .filter(Boolean) as any[];

  const columnPickerContent = (
    <div style={{ maxHeight: 360, overflowY: "auto", width: 280 }}>
      <Space style={{ marginBottom: 8 }}>
        <a onClick={showAllColumns}>Select all</a>
        <Divider type="vertical" />
        <a onClick={hideAllColumns}>Clear all</a>
      </Space>
      {COLUMN_GROUPS.map((group) => (
        <div key={group.title} style={{ marginBottom: 8 }}>
          <div style={{ fontWeight: 500, fontSize: 12, color: "#8c8c8c", margin: "4px 0" }}>
            {group.title}
          </div>
          {group.items.map((item) => (
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
      ))}
    </div>
  );

  // Mirrors each column's on-screen render() formatting so the Excel
  // export shows the same values as the table (only for currently
  // visible columns -- see `columns` above).
  const formatCellValue = (key: string, record: any, index: number): string | number => {
    switch (key) {
      case "no":
        return index + 1;
      case "searchDate":
        return startDate ? dayjs(startDate).format("DD-MMM-YYYY") : "-";
      case "code":
        return record.code ?? "";
      case "plate":
        return record.plate ?? "";
      case "vehicleTypeEng":
        return record.vehicleTypeEng ?? "";
      case "fullName":
        return record.fullName ?? "";
      case "phoneNumber":
        return record.phoneNumber ?? "";
      case "drivingLicense":
        return record.drivingLicense ?? "";
      case "baseLocation":
        return record.baseLocation ?? "";
      case "projectCode":
        return record.projectCode ?? "";
      case "startTime":
        return record.startTime ? dayjs(record.startTime).format("HH:mm") : "00:00";
      case "endTime":
        return record.endTime ? dayjs(record.endTime).format("HH:mm") : "00:00";
      case "workingHours":
        return `${(record.workingHours ?? 0).toFixed(2)} h`;
      case "fuelFilledLiters":
        return `${(record.fuelFilledLiters ?? 0).toLocaleString()} l`;
      case "initialMileage":
        return `${(record.initialMileage ?? 0).toLocaleString()} km`;
      case "finalMileage":
        return `${(record.finalMileage ?? 0).toLocaleString()} km`;
      case "totalMileage":
        return `${(record.totalMileage ?? 0).toLocaleString()} km`;
      case "variance": {
        const variance = (record.fuelFilledLiters ?? 0) - (record.fuelFilling ?? 0);
        return `${variance.toLocaleString()} l`;
      }
      case "percentage": {
        const fuelFilledLiters = record.fuelFilledLiters ?? 0;
        const fuelFilling = record.fuelFilling ?? 0;
        if (fuelFilledLiters === 0) return "0%";
        return `${Math.round(((fuelFilledLiters - fuelFilling) / fuelFilledLiters) * 100)}%`;
      }
      case "mileage":
        return `${(record.mileage ?? 0).toLocaleString()} km`;
      case "engineHours":
        return `${(record.engineHours ?? 0).toFixed(2)} h`;
      case "initialFuel":
        return `${(record.initialFuel ?? 0).toLocaleString()} l`;
      case "fuelFilling":
        return `${(record.fuelFilling ?? 0).toLocaleString()} l`;
      case "fuelConsumed":
        return `${(record.fuelConsumed ?? 0).toLocaleString()} l`;
      case "finalFuelLevel":
        return `${(record.finalFuelLevel ?? 0).toLocaleString()} l`;
      case "fuelStandard":
        return record.fuelStandard ? record.fuelStandard : "0 L";
      case "actualFuelConsumption": {
        const fuelConsumed = record.fuelConsumed ?? 0;
        const engineHours = record.engineHours ?? 0;
        if (engineHours === 0) return "0 L";
        return `${(fuelConsumed / engineHours).toFixed(2)} L`;
      }
      case "overStandardFuelConsumption": {
        const engineHours = record.engineHours ?? 0;
        const fuelConsumed = record.fuelConsumed ?? 0;
        const actual = engineHours !== 0 ? fuelConsumed / engineHours : 0;
        const standard =
          parseFloat(String(record.fuelStandard ?? "").replace(/[^0-9.]/g, "")) || 0;
        const over = actual <= 0 ? 0 : actual - standard;
        return `${over.toFixed(2)} L`;
      }
      case "remarks":
        return record.remarks ?? "";
      default:
        return "";
    }
  };

  // Builds an .xlsx that mirrors the current table: SNKRP logo + report
  // title in the header, the same grouped column layout (with only the
  // currently visible columns), and one row per vehicle.
  const handleExportExcel = async () => {
    if (vehicleData.length === 0) {
      message.warning("There is no data to export.");
      return;
    }

    setExportLoading(true);
    try {
      // Flatten the currently visible `columns` into a leaf list, keeping
      // track of each leaf's parent group (if any) for the header merge.
      const leafColumns: { key: string; title: string; group?: string }[] = [];
      columns.forEach((col: any) => {
        if (col.children) {
          col.children.forEach((child: any) => {
            leafColumns.push({
              key: child.key ?? child.dataIndex,
              title: child.title,
              group: col.title,
            });
          });
        } else {
          leafColumns.push({ key: col.key ?? col.dataIndex, title: col.title });
        }
      });

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Daily Machinery Operation Report");

      const formattedDate = startDate ? dayjs(startDate).format("DD-MMM-YYYY") : "";
      const totalColumns = leafColumns.length;

      // Logo, top-left. The image is a normal Vite asset -- to change it,
      // just replace src/assets/snkrp/Picture1.png (or update the import).
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

      // Title, next to the logo.
      sheet.mergeCells(1, 2, 1, Math.max(totalColumns, 4));
      const titleCell = sheet.getCell(1, 2);
      titleCell.value = `Daily Machinery Operation Report - ${formattedDate}`;
      titleCell.font = { size: 16, bold: true };
      titleCell.alignment = { vertical: "middle", horizontal: "center" };

      const GROUP_ROW = 3;
      const LEAF_ROW = 4;
      sheet.getRow(2).height = 8;

      const headerFill = {
        type: "pattern" as const,
        pattern: "solid" as const,
        fgColor: { argb: "FFE6E6E6" },
      };
      const thinBorder = {
        top: { style: "thin" as const },
        left: { style: "thin" as const },
        bottom: { style: "thin" as const },
        right: { style: "thin" as const },
      };

      let colCursor = 1;
      let i = 0;
      while (i < leafColumns.length) {
        const group = leafColumns[i].group;
        if (group) {
          let span = 1;
          while (i + span < leafColumns.length && leafColumns[i + span].group === group) {
            span++;
          }
          sheet.mergeCells(GROUP_ROW, colCursor, GROUP_ROW, colCursor + span - 1);
          const groupCell = sheet.getCell(GROUP_ROW, colCursor);
          groupCell.value = group;
          groupCell.font = { bold: true };
          groupCell.alignment = { horizontal: "center", vertical: "middle" };
          groupCell.fill = headerFill;
          groupCell.border = thinBorder;

          for (let j = 0; j < span; j++) {
            const leafCell = sheet.getCell(LEAF_ROW, colCursor + j);
            leafCell.value = leafColumns[i + j].title;
            leafCell.font = { bold: true };
            leafCell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
            leafCell.fill = headerFill;
            leafCell.border = thinBorder;
          }
          colCursor += span;
          i += span;
        } else {
          sheet.mergeCells(GROUP_ROW, colCursor, LEAF_ROW, colCursor);
          const cell = sheet.getCell(GROUP_ROW, colCursor);
          cell.value = leafColumns[i].title;
          cell.font = { bold: true };
          cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
          cell.fill = headerFill;
          cell.border = thinBorder;
          colCursor += 1;
          i += 1;
        }
      }

      vehicleData.forEach((record: any, index: number) => {
        const rowNumber = LEAF_ROW + 1 + index;
        leafColumns.forEach((leaf, colIdx) => {
          const cell = sheet.getCell(rowNumber, colIdx + 1);
          cell.value = formatCellValue(leaf.key, record, index);
          cell.alignment = { vertical: "middle" };
          cell.border = thinBorder;
        });
      });

      for (let col = 1; col <= totalColumns; col++) {
        sheet.getColumn(col).width = 16;
      }

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Daily_Machinery_Operation_Report_${startDate || dayjs().format(DATE_FORMAT)}.xlsx`;
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
      {/* Search Toolbar */}

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
          <ToolOutlined style={{ marginRight: 8 }} />
          Daily Machinery Operation Report
        </span>

        <Space size={20} wrap align="end" style={{ marginLeft: "auto" }}>
          <Select
            placeholder="Select an Object ID..."
            value={selectedUnitGroup || undefined}
            onChange={handleGroupChange}
            allowClear
            style={{ width: 200 }}
            options={unitGroups.map((group: any) => ({
              label: group.nm,
              value: String(group.id),
            }))}
          />

          <DatePicker
            format={DATE_FORMAT}
            value={startDate ? dayjs(startDate) : null}
            onChange={handleDateChange}
            style={{ width: 160 }}
          />
        </Space>

        <Space size={8} wrap>
          <Tooltip title="Search">
            <Button
              aria-label="Search"
              type="primary"
              icon={<SearchOutlined />}
              onClick={handleSearch}
              disabled={searchDisabled}
            />
          </Tooltip>

          <Tooltip title="Refresh">
            <Button
              aria-label="Refresh"
              icon={<ReloadOutlined />}
              onClick={handleSearch}
              disabled={searchDisabled}
            />
          </Tooltip>

          {canExport && (
            <Tooltip title="Export Excel">
              <Button
                aria-label="Export Excel"
                icon={<FileExcelOutlined />}
                style={{ background: "#217346", borderColor: "#217346", color: "#fff" }}
                onClick={handleExportExcel}
                loading={exportLoading}
                disabled={vehicleData.length === 0}
              />
            </Tooltip>
          )}

          <Popover
            content={columnPickerContent}
            title="Show / hide columns"
            trigger="click"
            placement="bottomRight"
          >
            <Tooltip title="Manage Columns">
              <Button aria-label="Manage Columns" icon={<SettingOutlined />} />
            </Tooltip>
          </Popover>
        </Space>
      </div>

      {validationMessage && (
        <Alert
          type="warning"
          showIcon
          message={validationMessage}
          style={{ marginBottom: 12 }}
          closable
          onClose={() => setValidationMessage(null)}
        />
      )}

      {/* Table */}

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
        dataSource={vehicleData}
        rowKey="key"
        bordered
        scroll={{ x: "max-content" }}
        pagination={{
          current: currentPage,
          pageSize: pageSize,
          showSizeChanger: true,
          pageSizeOptions: ["10", "20", "50", "100"],
          showQuickJumper: true,
          showTotal: (total) => `Total ${total} Vehicles`,
          onChange: (page, size) => {
            setCurrentPage(page);
            setPageSize(size);
          },
        }}
      />
    </Card>
  );
}

export default daily_Activities;
