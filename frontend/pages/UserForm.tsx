import { useEffect } from "react";
import { Form, Input, Select, Switch, Button } from "antd";

export default function UserForm({ initialValues, onSave }: any) {
  const [form] = Form.useForm();

  // Reset form when editing a different user
  useEffect(() => {
    form.setFieldsValue(initialValues || { role: "user", status: true });
  }, [initialValues, form]);

  return (
    <Form form={form} layout="vertical" onFinish={onSave}>
      <Form.Item name="username" label="Username" rules={[{ required: true }]}>
        <Input />
      </Form.Item>
      <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email' }]}>
        <Input />
      </Form.Item>
      <Form.Item name="role" label="Role" rules={[{ required: true }]}>
        <Select>
          <Select.Option value="admin">Administrator</Select.Option>
          <Select.Option value="manager">Manager</Select.Option>
          <Select.Option value="user">User</Select.Option>
        </Select>
      </Form.Item>
      <Form.Item name="status" label="Active" valuePropName="checked">
        <Switch />
      </Form.Item>
      <Button type="primary" htmlType="submit" block style={{ backgroundColor: "#051650" }}>
        Submit
      </Button>
    </Form>
  );
}