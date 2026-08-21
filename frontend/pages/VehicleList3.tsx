import React, { useState, useEffect } from 'react';
import {
  Card,
  Table,
  Input,
  Select,
  DatePicker,
  Button,
  Space,
  Tag,
  Tooltip,
} from "antd";

import {
  PlusOutlined,
  SearchOutlined,
  ReloadOutlined,
  FileExcelOutlined,
  EyeOutlined,
  EditOutlined,
  EnvironmentOutlined,
  DeleteOutlined,
} from "@ant-design/icons";
//const GROUP_API_URL = "http://127.0.0.1:8080/api/objects/group_snkrp";

const sampleVehicleData = [
  {
    key: 1,
    plate: "2AB-1234",
    vehicle: "Toyota Hilux",
    driver: "Sok Dara",
    group: "Phnom Penh",
    speed: 62,
    mileage: 24560,
    status: "Moving",
  },
  {
    key: 2,
    plate: "2CD-5678",
    vehicle: "Ford Ranger",
    driver: "David Chan",
    group: "Siem Reap",
    speed: 0,
    mileage: 18450,
    status: "Stopped",
  },
  {
    key: 3,
    plate: "2EF-7890",
    vehicle: "Isuzu D-Max",
    driver: "Peter Lim",
    group: "Battambang",
    speed: 0,
    mileage: 38450,
    status: "Offline",
  },
  {
    key: 4,
    plate: "3GH-4521",
    vehicle: "Toyota Camry",
    driver: "Chhun Sopheak",
    group: "Phnom Penh",
    speed: 48,
    mileage: 15230,
    status: "Moving",
  },
  {
    key: 5,
    plate: "1KL-9087",
    vehicle: "Hyundai Tucson",
    driver: "Ly Ratana",
    group: "Sihanoukville",
    speed: 0,
    mileage: 29870,
    status: "Stopped",
  },
  {
    key: 6,
    plate: "2MN-3345",
    vehicle: "Kia Sorento",
    driver: "Heng Vibol",
    group: "Kampong Cham",
    speed: 75,
    mileage: 41200,
    status: "Moving",
  },
  {
    key: 7,
    plate: "4PQ-6712",
    vehicle: "Lexus RX350",
    driver: "Sophea Kunthea",
    group: "Phnom Penh",
    speed: 0,
    mileage: 9820,
    status: "Offline",
  },
  {
    key: 8,
    plate: "2RS-2298",
    vehicle: "Mitsubishi Triton",
    driver: "Vann Sokha",
    group: "Siem Reap",
    speed: 53,
    mileage: 33110,
    status: "Moving",
  },
  {
    key: 9,
    plate: "3TU-8834",
    vehicle: "Honda CR-V",
    driver: "Kim Chanthy",
    group: "Battambang",
    speed: 0,
    mileage: 21075,
    status: "Stopped",
  },
  {
    key: 10,
    plate: "1VW-5561",
    vehicle: "Ford Everest",
    driver: "Mao Piseth",
    group: "Kampong Cham",
    speed: 40,
    mileage: 27640,
    status: "Moving",
  },
];

function daily_Activities() {
  //  const [unit, setUnit] = useState([]);
    // const [selectedUnit, setSelectedUnit] = useState('');
    const [unitGroups, setUnitGroups] = useState<any[]>([]);
    const [selectedUnitGroup, setSelectedUnitGroup] = useState('');
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [vehicleData, setVehicleData] = useState<any[]>(sampleVehicleData);
    const [loading, setLoading] = useState(false);

useEffect(() => {
    loadUnitGroups();
}, []);

useEffect(() => {
    fetchData();
}, [selectedUnitGroup, startDate, endDate]);

  const loadUnitGroups = async () => {
        try {
            const response = await fetch('/api/objects/group_snkrp');
            if (!response.ok) {
                throw new Error(`Failed to fetch unit groups: ${response.statusText}`);
            }
            const data = await response.json();
            // Backend returns { status: "success", objects: [...] }
            setUnitGroups(Array.isArray(data.objects) ? data.objects : []);
        } catch (error) {
            console.error('Error loading unit groups:', error);
        }
    };

const fetchData = async () => {
  setLoading(true);
  try {
    const params = new URLSearchParams();
    if (selectedUnitGroup) params.append('groupId', selectedUnitGroup);
    if (startDate) params.append('start', startDate);
    if (endDate) params.append('end', endDate);

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


const { RangePicker } = DatePicker;

const columns = [
  {
    title: "Plate Number",
    dataIndex: "plate",
    sorter: (a: any, b: any) => a.plate.localeCompare(b.plate),
  },
  {
    title: "Vehicle",
    dataIndex: "vehicle",
    sorter: (a: any, b: any) => a.vehicle.localeCompare(b.vehicle),
  },
  {
    title: "Driver",
    dataIndex: "driver",
    sorter: (a: any, b: any) => a.driver.localeCompare(b.driver),
  },
  {
    title: "Group",
    dataIndex: "group",
    sorter: (a: any, b: any) => a.group.localeCompare(b.group),
  },
  {
    title: "Speed",
    dataIndex: "speed",
    sorter: (a: any, b: any) => a.speed - b.speed,
    render: (speed: number) => `${speed} km/h`,
  },
  {
    title: "Mileage",
    dataIndex: "mileage",
    sorter: (a: any, b: any) => a.mileage - b.mileage,
    render: (mileage: number) => `${mileage.toLocaleString()} km`,
  },
  {
    title: "Status",
    dataIndex: "status",
    filters: [
      { text: "Moving", value: "Moving" },
      { text: "Stopped", value: "Stopped" },
      { text: "Offline", value: "Offline" },
    ],
    onFilter: (value: any, record: any) => record.status === value,
    render: (status: string) => {
      switch (status) {
        case "Moving":
          return <Tag color="green">Moving</Tag>;
        case "Stopped":
          return <Tag color="orange">Stopped</Tag>;
        default:
          return <Tag color="red">Offline</Tag>;
      }
    },
  },
  {
    title: "Actions",
    render: () => (
      <Space>
        <Tooltip title="View">
          <Button icon={<EyeOutlined />} size="small" />
        </Tooltip>

        <Tooltip title="Edit">
          <Button icon={<EditOutlined />} size="small" />
        </Tooltip>

        <Tooltip title="Track">
          <Button
            icon={<EnvironmentOutlined />}
            size="small"
            type="primary"
          />
        </Tooltip>

        <Tooltip title="Delete">
          <Button
            icon={<DeleteOutlined />}
            size="small"
            danger
          />
        </Tooltip>
      </Space>
    ),
  },
];

  return (
    <Card
      title="Vehicle List"
      extra={
        <Button type="primary" icon={<PlusOutlined />}>
          Add Vehicle
        </Button>
      }
    >
      {/* Search Toolbar */}

      <Space
        wrap
        style={{
          marginBottom: 20,
          width: "100%",
          justifyContent: "space-between",
        }}
      >
        <Input
          placeholder="Search Vehicle..."
          prefix={<SearchOutlined />}
          style={{ width: 250 }}
        />
        <Select
          placeholder="Select a group..."
          value={selectedUnitGroup || undefined}
          onChange={(value) => setSelectedUnitGroup(value)}
          allowClear
          style={{ width: 180 }}
          options={unitGroups.map((group: any) => ({
            label: group.nm,
            value: group.id,
          }))}
        />

        <Select
          placeholder="Status"
          style={{ width: 150 }}
          options={[
            { label: "All", value: "" },
            { label: "Moving", value: "Moving" },
            { label: "Stopped", value: "Stopped" },
            { label: "Offline", value: "Offline" },
          ]}
        />


        <RangePicker
          onChange={(_, dateStrings) => {
            setStartDate(dateStrings[0]);
            setEndDate(dateStrings[1]);
          }}
        />

        <Button
          type="primary"
          icon={<SearchOutlined />}
          onClick={fetchData}
        >
          Search
        </Button>

        <Button
          icon={<ReloadOutlined />}
          onClick={fetchData}
        >
          Refresh
        </Button>

        <Button
          icon={<FileExcelOutlined />}
          type="primary"
        >
          Export Excel
        </Button>
      </Space>

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
        pagination={{
          pageSize: 10,
          showSizeChanger: true,
          showQuickJumper: true,
          showTotal: (total) => `Total ${total} Vehicles`,
        }}
      />
    </Card>
  );
}

export default daily_Activities;