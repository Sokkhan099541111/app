import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Form,
  Select,
  DatePicker,
  InputNumber,
  Input,
  Button,
  Row,
  Col,
  Divider,
  Space,
  Alert,
} from "antd";
import { SaveOutlined, CloseOutlined, ExclamationCircleFilled } from "@ant-design/icons";
import dayjs from "dayjs";
import type { VehicleOption } from "./VehicleOperationLogForm";

export interface EmployeeFormValues {
  employee_code: string;
  vehicles_id: number;
  department_id: number;
  position_id: number;
  first_name: string;
  last_name: string;
  gender: "Mr." | "Ms" | "Miss" | "Other";
  driving_license: "Yes" | "No";
  date_of_birth?: string; // YYYY-MM-DD
  phone_number?: string;
  address?: string;
  hire_date?: string; // YYYY-MM-DD
  termination_date?: string; // YYYY-MM-DD
  employment_status: "Active" | "Inactive" | "Terminated";
  basic_salary: number;
}

export interface OptionRecord {
  value: number;
  label: string;
}

interface Props {
  initialValues?: any; // raw row from the API (snake_case), or undefined for "create"
  departmentOptions: OptionRecord[];
  positionOptions: OptionRecord[];
  vehicleOptions: VehicleOption[];
  onSave: (values: EmployeeFormValues) => void;
  onCancel?: () => void;
  saving?: boolean;
}

// Bold red asterisk next to required field labels, matching the
// Vehicle Operation Log form's style.
const renderRequiredMark = (label: ReactNode, { required }: { required: boolean }) => (
  <span>
    {label}
    {required && (
      <span style={{ color: "#ff4d4f", fontWeight: 700, marginLeft: 4, fontSize: 15 }}>*</span>
    )}
  </span>
);

export default function EmployeeForm({
  initialValues,
  departmentOptions,
  positionOptions,
  vehicleOptions,
  onSave,
  onCancel,
  saving,
}: Props) {
  const [form] = Form.useForm();
  const [errorCount, setErrorCount] = useState(0);

  useEffect(() => {
    if (initialValues) {
      form.setFieldsValue({
        employee_code: initialValues.employee_code ?? "",
        vehicles_id: initialValues.vehicles_id ?? undefined,
        department_id: initialValues.department_id ?? undefined,
        position_id: initialValues.position_id ?? undefined,
        first_name: initialValues.first_name ?? "",
        last_name: initialValues.last_name ?? "",
        gender: initialValues.gender ?? undefined,
        driving_license: initialValues.driving_license ?? "Yes",
        date_of_birth: initialValues.date_of_birth ? dayjs(initialValues.date_of_birth) : null,
        phone_number: initialValues.phone_number ?? "",
        address: initialValues.address ?? "",
        hire_date: initialValues.hire_date ? dayjs(initialValues.hire_date) : null,
        termination_date: initialValues.termination_date
          ? dayjs(initialValues.termination_date)
          : null,
        employment_status: initialValues.employment_status ?? "Active",
        basic_salary: Number(initialValues.basic_salary ?? 0),
      });
    } else {
      form.resetFields();
    }
  }, [initialValues, form]);

  const handleFinishFailed = ({ errorFields }: { errorFields: { name: any; errors: string[] }[] }) => {
    setErrorCount(errorFields.length);
  };

  const handleFinish = (values: any) => {
    setErrorCount(0);
    onSave({
      employee_code: values.employee_code,
      vehicles_id: values.vehicles_id,
      department_id: values.department_id,
      position_id: values.position_id,
      first_name: values.first_name,
      last_name: values.last_name,
      gender: values.gender,
      driving_license: values.driving_license,
      date_of_birth: values.date_of_birth ? values.date_of_birth.format("YYYY-MM-DD") : undefined,
      phone_number: values.phone_number || undefined,
      address: values.address || undefined,
      hire_date: values.hire_date ? values.hire_date.format("YYYY-MM-DD") : undefined,
      termination_date: values.termination_date
        ? values.termination_date.format("YYYY-MM-DD")
        : undefined,
      employment_status: values.employment_status,
      basic_salary: values.basic_salary ?? 0,
    });
  };

  return (
    <Form
      form={form}
      layout="vertical"
      onFinish={handleFinish}
      onFinishFailed={handleFinishFailed}
      onValuesChange={() => errorCount > 0 && setErrorCount(0)}
      requiredMark={renderRequiredMark}
      scrollToFirstError
      initialValues={{ employment_status: "Active", driving_license: "Yes" }}
    >
      {errorCount > 0 && (
        <Alert
          type="error"
          showIcon
          icon={<ExclamationCircleFilled />}
          message="Please fix the highlighted field(s) before saving"
          description={`${errorCount} field${errorCount > 1 ? "s" : ""} still need${
            errorCount > 1 ? "" : "s"
          } your attention.`}
          style={{ marginBottom: 20, borderRadius: 8 }}
          closable
          onClose={() => setErrorCount(0)}
        />
      )}

      <Divider style={{ margin: "4px 0 20px" }} titlePlacement="left">
        Personal Information
      </Divider>

      <Row gutter={16}>
        <Col span={8}>
          <Form.Item
            name="first_name"
            label="First Name"
            rules={[{ required: true, message: "Please enter the first name" }]}
          >
            <Input placeholder="First name" />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item
            name="last_name"
            label="Last Name"
            rules={[{ required: true, message: "Please enter the last name" }]}
          >
            <Input placeholder="Last name" />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item
            name="gender"
            label="Gender"
            rules={[{ required: true, message: "Please select a gender" }]}
          >
            <Select
              placeholder="Select..."
              options={[
                { label: "Mr.", value: "Mr." },
                { label: "Ms", value: "Ms" },
                { label: "Miss", value: "Miss" },
                { label: "Other", value: "Other" },
              ]}
            />
          </Form.Item>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={8}>
          <Form.Item name="date_of_birth" label="Date of Birth">
            <DatePicker style={{ width: "100%" }} format="YYYY-MM-DD" />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item name="phone_number" label="Phone Number">
            <Input placeholder="Phone number" />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item
            name="driving_license"
            label="Driving License"
            rules={[{ required: true, message: "Please select whether the employee has a driving license" }]}
          >
            <Select
              options={[
                { label: "Yes", value: "Yes" },
                { label: "No", value: "No" },
              ]}
            />
          </Form.Item>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={24}>
          <Form.Item name="address" label="Address">
            <Input placeholder="Street, city" />
          </Form.Item>
        </Col>
      </Row>

      <Divider style={{ margin: "4px 0 20px" }} titlePlacement="left">
        Employment Details
      </Divider>

      <Row gutter={16}>
        <Col span={8}>
          <Form.Item
            name="employee_code"
            label="Employee Code"
            validateTrigger="onBlur"
            rules={[
              { required: true, message: "Please enter an employee code" },
              {
                validator: async (_, value) => {
                  if (!value) return Promise.resolve();
                  const params = new URLSearchParams({ employee_code: value });
                  if (initialValues?.employee_id) {
                    params.append("exclude_employee_id", String(initialValues.employee_id));
                  }
                  try {
                    const response = await fetch(`/api/employees/check-code?${params}`);
                    if (!response.ok) return Promise.resolve();
                    const data = await response.json();
                    if (data.exists) {
                      return Promise.reject(new Error("This employee code is already in use"));
                    }
                  } catch {
                    // Silent -- the backend still enforces this on submit either way.
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <Input placeholder="e.g. EMP-001" />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item
            name="department_id"
            label="Department"
            rules={[{ required: true, message: "Please select a department" }]}
          >
            <Select showSearch optionFilterProp="label" placeholder="Select a department..." options={departmentOptions} />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item
            name="position_id"
            label="Position"
            rules={[{ required: true, message: "Please select a position" }]}
          >
            <Select showSearch optionFilterProp="label" placeholder="Select a position..." options={positionOptions} />
          </Form.Item>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={8}>
          <Form.Item name="hire_date" label="Hire Date">
            <DatePicker style={{ width: "100%" }} format="YYYY-MM-DD" />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item
            name="vehicles_id"
            label="Assign To"
            validateTrigger="onChange"
            rules={[
              { required: true, message: "Please assign a vehicle" },
              {
                validator: async (_, value) => {
                  if (!value) return Promise.resolve();
                  const params = new URLSearchParams({ vehicles_id: String(value) });
                  if (initialValues?.employee_id) {
                    params.append("exclude_employee_id", String(initialValues.employee_id));
                  }
                  try {
                    const response = await fetch(`/api/employees/check-vehicle?${params}`);
                    if (!response.ok) return Promise.resolve();
                    const data = await response.json();
                    if (data.exists) {
                      return Promise.reject(
                        new Error("This vehicle is already assigned to another employee")
                      );
                    }
                  } catch {
                    // Silent -- the backend still enforces this on submit either way.
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="Select a vehicle..."
              options={vehicleOptions.map((v) => ({ value: v.id, label: v.name }))}
            />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item name="employment_status" label="Employment Status">
            <Select
              options={[
                { label: "Active", value: "Active" },
                { label: "Inactive", value: "Inactive" },
                { label: "Terminated", value: "Terminated" },
              ]}
            />
          </Form.Item>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={12}>
          <Form.Item name="termination_date" label="Termination Date">
            <DatePicker style={{ width: "100%" }} format="YYYY-MM-DD" />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item
            name="basic_salary"
            label="Basic Salary"
            rules={[{ required: true, message: "Please enter the basic salary" }]}
          >
            <InputNumber
              style={{ width: "100%" }}
              min={0}
              step={0.01}
              formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
              parser={(value) => Number((value || "").replace(/,/g, "")) as any}
            />
          </Form.Item>
        </Col>
      </Row>

      <Divider style={{ margin: "4px 0 20px" }} />

      <Space style={{ display: "flex", justifyContent: "flex-end" }}>
        {onCancel && (
          <Button icon={<CloseOutlined />} onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          type="primary"
          htmlType="submit"
          icon={<SaveOutlined />}
          loading={saving}
          style={{ backgroundColor: "#051650" }}
        >
          {initialValues ? "Update Employee" : "Create Employee"}
        </Button>
      </Space>
    </Form>
  );
}
