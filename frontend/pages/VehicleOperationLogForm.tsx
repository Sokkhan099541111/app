import { useEffect, useRef, useState } from "react";
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
  AutoComplete,
} from "antd";
import { SaveOutlined, CloseOutlined, ExclamationCircleFilled } from "@ant-design/icons";
import dayjs, { Dayjs } from "dayjs";
import { vehicleSelectOptions } from "../src/utils/vehicleLabel";

const { TextArea } = Input;

export interface VehicleOption {
  id: number;
  /** Wialon unit name -- in practice the plate number. */
  name: string;
  /** Fleet code, e.g. VID-385. Supplied by /vehicle-logs/vehicle-options. */
  code?: string;
}

export interface VehicleOperationLogFormValues {
  vehicle_id: number;
  operation_date: string; // YYYY-MM-DD
  project_code?: string;
  /** Required, manually entered -- where the vehicle is based. */
  base_location: string;
  start_time: string; // YYYY-MM-DD HH:mm:ss
  end_time: string; // YYYY-MM-DD HH:mm:ss
  working_hours: number; // manually entered by the user
  initial_mileage: number;
  final_mileage: number;
  /** The user's figure. Defaults to final - initial, but may be overridden. */
  total_mileage: number;
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

/**
 * Total Mileage implied by the odometer readings: Final - Initial.
 *
 * Floored at 0 and rounded to 2dp to match DECIMAL(10,2). Returns null
 * when either reading is missing, so the caller can tell "cannot be
 * calculated yet" apart from "calculates to zero" -- prefilling 0 from an
 * empty form would look like a real reading.
 */
function calculateTotalMileage(
  initial: number | null | undefined,
  final: number | null | undefined
): number | null {
  if (initial == null || final == null) return null;
  if (!Number.isFinite(initial) || !Number.isFinite(final)) return null;
  return Math.round(Math.max(final - initial, 0) * 100) / 100;
}

// Working hours between two time-of-day values on the same operation_date.
// Returns null if end isn't after start (nothing to show yet, or invalid).
function computeWorkingHours(start?: Dayjs | null, end?: Dayjs | null): number | null {
  if (!start || !end) return null;
  const minutes = end.diff(start, "minute");
  return minutes >= 0 ? minutes / 60 : null;
}


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
 * Total Mileage stays read-only and auto-calculated from Final/Initial
 * Mileage -- it mirrors the MySQL GENERATED column `distance_travelled`,
 * so it cannot drift out of sync with the readings it comes from.
 *
 * Working Hours is MANUALLY ENTERED. It used to be derived from Start/End
 * Time (and was a generated column in MySQL), but the elapsed clock time
 * and the hours actually worked routinely differ -- breaks, idle periods,
 * a shift crossing midnight -- so the operator now records the real
 * figure. The Start/End times are still surfaced next to the field as a
 * non-binding hint, but nothing overwrites what was typed.
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
  const [projectCodeOptions, setProjectCodeOptions] = useState<string[]>([]);

  // Project codes already used on other logs, offered as suggestions.
  // Failure here is non-fatal -- the field degrades to plain free text.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/vehicle-logs/project-codes");
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && Array.isArray(data.project_codes)) {
          setProjectCodeOptions(data.project_codes);
        }
      } catch {
        // Suggestions are a convenience, not a requirement.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
        project_code: initialValues.project_code ?? "",
        start_time: initialValues.start_time ? dayjs(initialValues.start_time) : null,
        end_time: initialValues.end_time ? dayjs(initialValues.end_time) : null,
        // Load the SAVED hours -- never recompute them from the times, or
        // editing a log would silently rewrite a figure the user chose.
        working_hours:
          initialValues.working_hours != null ? Number(initialValues.working_hours) : undefined,
        base_location: initialValues.base_location ?? "",
        initial_mileage: Number(initialValues.initial_mileage ?? 0),
        final_mileage: Number(initialValues.final_mileage ?? 0),
        // Load the SAVED total, exactly as stored. If it was overridden,
        // that override is the whole point of having the column.
        total_mileage:
          initialValues.total_mileage != null
            ? Number(initialValues.total_mileage)
            : calculateTotalMileage(
                Number(initialValues.initial_mileage ?? 0),
                Number(initialValues.final_mileage ?? 0)
              ) ?? 0,
        fuel_filling_liters: Number(initialValues.fuel_filling_liters ?? 0),
        remarks: initialValues.remarks ?? "",
      });
      // Opening an existing log counts as manual: the stored figure is a
      // decision someone already made, so editing an unrelated field must
      // not quietly recompute it.
      totalMileageIsManualRef.current = true;
    } else {
      form.resetFields();
      totalMileageIsManualRef.current = false;
    }
  }, [initialValues, form]);

  /**
   * Has the user typed their own Total Mileage?
   *
   * While false, Total Mileage tracks Final - Initial automatically. Once
   * true, their figure is left alone: changing Initial or Final only
   * OFFERS a recalculation (the "Use this" button below the field), which
   * is the confirmation step -- it never silently overwrites.
   *
   * A ref rather than state because nothing renders from it directly, and
   * it must be readable inside onValuesChange without going stale.
   */
  const totalMileageIsManualRef = useRef(false);

  // Keeps Total Mileage in step with the odometer readings, unless the
  // user has taken it over. Invoked from the form's onValuesChange so it
  // sees every edit to either reading, typed or stepped.
  const syncTotalMileage = (changed: Record<string, any>) => {
    if ("total_mileage" in changed) {
      // Only a user edit reaches here -- the automatic updates below go
      // through setFieldsValue, which does not fire onValuesChange.
      totalMileageIsManualRef.current = true;
      return;
    }
    if (!("initial_mileage" in changed) && !("final_mileage" in changed)) return;
    if (totalMileageIsManualRef.current) return;

    const total = calculateTotalMileage(
      form.getFieldValue("initial_mileage"),
      form.getFieldValue("final_mileage")
    );
    if (total != null) form.setFieldsValue({ total_mileage: total });
  };

  const handleFinishFailed = ({ errorFields }: { errorFields: { name: any; errors: string[] }[] }) => {
    setErrorCount(errorFields.length);
  };

  const handleFinish = (values: any) => {
    setErrorCount(0);
    const initialMileage = values.initial_mileage ?? 0;
    const finalMileage = values.final_mileage ?? 0;
    // Whatever is in the field -- the auto-calculated value or the user's
    // override. Recomputing here would throw away a deliberate override at
    // the last moment, which is exactly what must not happen.
    const totalMileage =
      values.total_mileage ?? calculateTotalMileage(initialMileage, finalMileage) ?? 0;

    onSave({
      vehicle_id: values.vehicle_id,
      operation_date: values.operation_date.format("YYYY-MM-DD"),
      // Always send a string (never undefined) so clearing the field
      // actually clears it -- the backend's PUT skips keys that arrive as
      // null, so an omitted key would silently keep the old code.
      project_code: (values.project_code ?? "").trim(),
      base_location: (values.base_location ?? "").trim(),
      start_time: combineDateAndTime(values.operation_date, values.start_time).format(
        "YYYY-MM-DD HH:mm:ss"
      ),
      end_time: combineDateAndTime(values.operation_date, values.end_time).format(
        "YYYY-MM-DD HH:mm:ss"
      ),
      working_hours: values.working_hours,
      initial_mileage: initialMileage,
      final_mileage: finalMileage,
      total_mileage: Number(totalMileage),
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
      onValuesChange={(changed) => {
        if (errorCount > 0) setErrorCount(0);
        syncTotalMileage(changed);
      }}
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
            {/* Same "VID-385 - TT10 3A-3893" label the toolbar filter and
                every other module uses, via the shared helper -- so the
                two dropdowns on this page cannot drift apart. Because the
                label carries both parts, optionFilterProp="label" lets
                either the code or the plate narrow the list. */}
            <Select
              showSearch
              placeholder="Search vehicle code or plate number..."
              optionFilterProp="label"
              options={vehicleSelectOptions(vehicleOptions)}
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
          {/* Free text, with previously-used codes offered as suggestions --
              this system does not own a master project list, so the field
              must accept a brand-new code while still making it easy to
              reuse an existing one consistently. */}
          <Form.Item
            name="project_code"
            label="Project Code"
            rules={[{ max: 50, message: "Project Code cannot exceed 50 characters" }]}
          >
            <AutoComplete
              allowClear
              options={projectCodeOptions.map((c) => ({ value: c }))}
              filterOption={(input, option) =>
                String(option?.value ?? "").toLowerCase().includes(input.toLowerCase())
              }
              placeholder="Type or select a project code..."
            />
          </Form.Item>
        </Col>
        <Col span={8}>
          {/* Required. The whitespace rule matters as much as `required`:
              a space satisfies "not empty" while telling a later reader
              nothing, and the backend rejects it too, so catching it here
              saves a round trip. */}
          <Form.Item
            name="base_location"
            label="Base Location"
            rules={[
              { required: true, message: "Please enter the base location" },
              {
                validator: (_, value) =>
                  value == null || String(value).trim().length > 0
                    ? Promise.resolve()
                    : Promise.reject(new Error("Base Location cannot be only spaces")),
              },
              { max: 255, message: "Base Location cannot exceed 255 characters" },
            ]}
          >
            <Input placeholder="e.g. Phnom Penh Yard" maxLength={255} />
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
          {/* Manually entered. It is no longer derived from Start/End Time --
              the two often disagree in practice (breaks, idle time, a shift
              that spans midnight), so the operator records the real figure.
              The times are still shown as a non-binding hint below the
              field, and nothing ever overwrites what was typed. */}
          <Form.Item shouldUpdate noStyle>
            {({ getFieldValue }) => {
              const suggested = computeWorkingHours(
                getFieldValue("start_time"),
                getFieldValue("end_time")
              );
              return (
                <Form.Item
                  name="working_hours"
                  label="Working Hours"
                  rules={[
                    { required: true, message: "Please enter the working hours" },
                    {
                      type: "number",
                      min: 0,
                      max: 24,
                      message: "Working Hours must be between 0 and 24",
                    },
                  ]}
                  extra={
                    suggested != null
                      ? `Start/End times suggest ${suggested.toFixed(2)} h.`
                      : undefined
                  }
                >
                  <InputNumber
                    style={{ width: "100%" }}
                    min={0}
                    max={24}
                    step={0.25}
                    addonAfter="h"
                    placeholder="Enter hours"
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
          {/* Editable, not derived-and-locked.
              It fills itself in from Final - Initial while untouched. Once
              the user types their own figure it stops following, and a
              later change to either reading only OFFERS to recalculate --
              that "Use this" click is the confirmation, so a deliberate
              override is never overwritten behind the user's back. */}
          <Form.Item shouldUpdate noStyle>
            {({ getFieldValue }) => {
              const suggested = calculateTotalMileage(
                getFieldValue("initial_mileage"),
                getFieldValue("final_mileage")
              );
              const current = getFieldValue("total_mileage");
              const differs =
                suggested != null && current != null && Number(current) !== suggested;

              return (
                <Form.Item
                  name="total_mileage"
                  label="Total Mileage (km)"
                  rules={[
                    { required: true, message: "Please enter the total mileage" },
                    {
                      type: "number",
                      min: 0,
                      message: "Total Mileage cannot be negative",
                    },
                  ]}
                  extra={
                    differs ? (
                      <span>
                        Odometer readings suggest {suggested.toFixed(2)} km.{" "}
                        <Button
                          type="link"
                          size="small"
                          style={{ padding: 0, height: "auto" }}
                          onClick={() => {
                            form.setFieldsValue({ total_mileage: suggested });
                            totalMileageIsManualRef.current = false;
                          }}
                        >
                          Use this
                        </Button>
                      </span>
                    ) : undefined
                  }
                >
                  <InputNumber
                    style={{ width: "100%" }}
                    min={0}
                    step={0.1}
                    addonAfter="km"
                    placeholder="Auto-calculated"
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

      {/* Optional by design -- no `required` rule, and the backend accepts
          null/blank. Free text the operator adds when there is something
          worth saying; it surfaces as the Remark column on the Daily
          Machinery Operation Report. Distinct from Status, which comes
          from Rental Attendance and is not editable here. */}
      <Form.Item name="remarks" label="Remark">
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
