import { useState } from "react";
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

const data = [
  {
    key: 1,
    plate: "2AB-1234",
    vehicle: "Toyota Hilux",
    driver: "John",
    group: "Phnom Penh",
    speed: 65,
    mileage: 24560,
    status: "Moving",
  },
  {
    key: 2,
    plate: "2CD-5678",
    vehicle: "Ford Ranger",
    driver: "David",
    group: "Siem Reap",
    speed: 0,
    mileage: 18450,
    status: "Stopped",
  },
  {
    key: 3,
    plate: "2EF-7890",
    vehicle: "Isuzu D-Max",
    driver: "Peter",
    group: "Battambang",
    speed: 0,
    mileage: 38450,
    status: "Offline",
  },
];

export default function VehicleList() {
  const [loading] = useState(false);

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
          placeholder="Group"
          style={{ width: 180 }}
          options={[
            { label: "All Groups", value: "" },
            { label: "Phnom Penh", value: "pp" },
            { label: "Siem Reap", value: "sr" },
          ]}
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

        <RangePicker />

        <Button
          type="primary"
          icon={<SearchOutlined />}
        >
          Search
        </Button>

        <Button
          icon={<ReloadOutlined />}
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

      <Table
        loading={loading}
        columns={columns}
        dataSource={data}
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