import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Form,
  Select,
  DatePicker,
  TimePicker,
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
import dayjs, { Dayjs } from "dayjs";

const { TextArea } = Input;

export interface VehicleOption {
  id: number;
  name: string;
}

export interface VehicleOperationLogFormValues {
  vehicle_id: number;
  operation_date: string; // YYYY-MM-DD
  start_time: string; // YYYY-MM-DD HH:mm:ss
  end_time: string; // YYYY-MM-DD HH:mm:ss
  initial_mileage: number;
  final_mileage: number;
  total_mileage?: string;
  fuel_filling_liters: number;
  remarks?: string;
}

interface Props {
  initialValues?: any; // raw row from the API (snake_case), or undefined for "create"
  vehicleOptions: VehicleOption[];
  onSave: (values: VehicleOperationLogFormValues) => void;
  onCancel?: () => void;
  saving?: boolean;
}

// Combines a date-only Dayjs with a time-only Dayjs into one full timestamp.
function combineDateAndTime(date: Dayjs, time: Dayjs): Dayjs {
  return date.hour(time.hour()).minute(time.minute()).second(time.second());
}

// Working hours between two time-of-day values on the same operation_date.
// Returns null if end isn't after start (nothing to show yet, or invalid).
function computeWorkingHours(start?: Dayjs | null, end?: Dayjs | null): number | null {
  if (!start || !end) return null;
  const minutes = end.diff(start, "minute");
  return minutes >= 0 ? minutes / 60 : null;
}

const disabledFieldStyle = { width: "100%", fontWeight: 600, color: "#051650" };

// Renders a bold red asterisk next to every required field's label so
// required fields are unmistakable at a glance, instead of antd's
// default (fairly subtle) small red dot.
const renderRequiredMark = (label: ReactNode, { required }: { required: boolean }) => (
  <span>
    {label}
    {required && (
      <span style={{ color: "#ff4d4f", fontWeight: 700, marginLeft: 4, fontSize: 15 }}>*</span>
    )}
  </span>
);

/**
 * Insert/update form for a single vehicle_operation_logs row.
 *
 * Working Hours and Total Mileage are read-only, auto-calculated fields
 * (Start/End Time and Final/Initial Mileage respectively) -- they mirror
 * the MySQL GENERATED columns (working_hours, distance_travelled) that
 * the database computes on save, so nothing here needs to be typed
 * manually or can drift out of sync.
 */
export default function VehicleOperationLogForm({
  initialValues,
  vehicleOptions,
  onSave,
  onCancel,
  saving,
}: Props) {
  const [form] = Form.useForm();
  const [errorCount, setErrorCount] = useState(0);
  const [duplicateMessage, setDuplicateMessage] = useState<string | null>(null);

  // Live duplicate check -- as soon as both Plate Number and Operation
  // Date are picked, ask the backend whether an Active log already
  // exists for that combination, instead of only finding out after the
  // user hits Create/Update and gets a 409 back.
  const watchedVehicleId = Form.useWatch("vehicle_id", form);
  const watchedOperationDate = Form.useWatch("operation_date", form);

  useEffect(() => {
    if (!watchedVehicleId || !watchedOperationDate) {
      setDuplicateMessage(null);
      return;
    }

    let cancelled = false;
    const dateStr = watchedOperationDate.format("YYYY-MM-DD");
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          vehicle_id: String(watchedVehicleId),
          operation_date: dateStr,
        });
        if (initialValues?.log_id) {
          params.append("exclude_log_id", String(initialValues.log_id));
        }
        const response = await fetch(`/api/vehicle-logs/check-duplicate?${params}`);
        if (!response.ok || cancelled) return;
        const data = await response.json();
        if (!cancelled) {
          setDuplicateMessage(
            data.exists
              ? `An active operation log already exists for this vehicle on ${dateStr}. Edit or delete that log first.`
              : null
          );
        }
      } catch {
        // Silent -- the backend still enforces this on submit either way.
      }
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [watchedVehicleId, watchedOperationDate, initialValues?.log_id]);

  useEffect(() => {
    if (initialValues) {
      form.setFieldsValue({
        vehicle_id: initialValues.vehicle_id,
        operation_date: initialValues.operation_date
          ? dayjs(initialValues.operation_date)
          : null,
        start_time: initialValues.start_time ? dayjs(initialValues.start_time) : null,
        end_time: initialValues.end_time ? dayjs(initialValues.end_time) : null,
        initial_mileage: Number(initialValues.initial_mileage ?? 0),
        final_mileage: Number(initialValues.final_mileage ?? 0),
        fuel_filling_liters: Number(initialValues.fuel_filling_liters ?? 0),
        remarks: initialValues.remarks ?? "",
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
    const initialMileage = values.initial_mileage ?? 0;
    const finalMileage = values.final_mileage ?? 0;
    const totalMileage = Math.max(finalMileage - initialMileage, 0);

    onSave({
      vehicle_id: values.vehicle_id,
      operation_date: values.operation_date.format("YYYY-MM-DD"),
      start_time: combineDateAndTime(values.operation_date, values.start_time).format(
        "YYYY-MM-DD HH:mm:ss"
      ),
      end_time: combineDateAndTime(values.operation_date, values.end_time).format(
        "YYYY-MM-DD HH:mm:ss"
      ),
      initial_mileage: initialMileage,
      final_mileage: finalMileage,
      total_mileage: totalMileage.toFixed(2),
      fuel_filling_liters: values.fuel_filling_liters ?? 0,
      remarks: values.remarks || undefined,
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
    >
      {duplicateMessage && (
        <Alert
          type="error"
          showIcon
          icon={<ExclamationCircleFilled />}
          message="Duplicate record"
          description={duplicateMessage}
          style={{ marginBottom: 20, borderRadius: 8 }}
        />
      )}

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

      <Row gutter={16}>
        <Col span={16}>
          <Form.Item
            name="vehicle_id"
            label="Plate Number"
            rules={[{ required: true, message: "Please select a plate number" }]}
          >
            <Select
              showSearch
              placeholder="Select a plate number..."
              optionFilterProp="label"
              options={vehicleOptions.map((v) => ({ label: v.name, value: v.id }))}
            />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item
            name="operation_date"
            label="Operation Date"
            rules={[{ required: true, message: "Please select the operation date" }]}
          >
            <DatePicker
              style={{ width: "100%" }}
              format="YYYY-MM-DD"
              disabledDate={(current) => !!current && current > dayjs().endOf("day")}
            />
          </Form.Item>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={8}>
          <Form.Item
            name="start_time"
            label="Start Time"
            rules={[{ required: true, message: "Please select a start time" }]}
          >
            <TimePicker style={{ width: "100%" }} format="HH:mm" />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item
            name="end_time"
            label="End Time"
            dependencies={["start_time"]}
            rules={[
              { required: true, message: "Please select an end time" },
              {
                validator: (_, value) => {
                  const start = form.getFieldValue("start_time");
                  if (value && start && value.isBefore(start)) {
                    return Promise.reject(new Error("End time must be after start time"));
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <TimePicker style={{ width: "100%" }} format="HH:mm" />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item shouldUpdate noStyle>
            {({ getFieldValue }) => {
              const hours = computeWorkingHours(
                getFieldValue("start_time"),
                getFieldValue("end_time")
              );
              return (
                <Form.Item label="Working Hours">
                  <InputNumber
                    style={disabledFieldStyle}
                    disabled
                    value={hours != null ? Number(hours.toFixed(2)) : undefined}
                    addonAfter="h"
                  />
                </Form.Item>
              );
            }}
          </Form.Item>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={8}>
          <Form.Item name="initial_mileage" label="Initial Mileage (km)">
            <InputNumber style={{ width: "100%" }} min={0} step={0.1} />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item
            name="final_mileage"
            label="Final Mileage (km)"
            dependencies={["initial_mileage"]}
            rules={[
              {
                validator: (_, value) => {
                  const initial = form.getFieldValue("initial_mileage") ?? 0;
                  if (value != null && value < initial) {
                    return Promise.reject(
                      new Error("Final mileage cannot be less than initial mileage")
                    );
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <InputNumber style={{ width: "100%" }} min={0} step={0.1} />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item shouldUpdate noStyle>
            {({ getFieldValue }) => {
              const initial = getFieldValue("initial_mileage") ?? 0;
              const final = getFieldValue("final_mileage") ?? 0;
              const total = final >= initial ? final - initial : 0;
              return (
                <Form.Item label="Total Mileage (km)">
                  <InputNumber
                    style={disabledFieldStyle}
                    disabled
                    value={Number(total.toFixed(2))}
                    addonAfter="km"
                  />
                </Form.Item>
              );
            }}
          </Form.Item>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={8}>
          <Form.Item name="fuel_filling_liters" label="Fuel Filled (L)">
            <InputNumber style={{ width: "100%" }} min={0} step={0.1} />
          </Form.Item>
        </Col>
      </Row>

      <Form.Item name="remarks" label="Remarks">
        <TextArea rows={3} placeholder="Optional notes..." />
      </Form.Item>

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
          disabled={!!duplicateMessage}
          style={{ backgroundColor: "#051650" }}
        >
          {initialValues ? "Update Log" : "Create Log"}
        </Button>
      </Space>
    </Form>
  );
}
