import React, { useEffect, useState } from 'react';
import {
  Card, Form, Input, Button, Message, Space, Typography, Divider,
} from '@arco-design/web-react';
import { api } from '../api.js';

const { Text } = Typography;

export default function Settings({ settings, onSaved, onLogout }) {
  const [hostForm] = Form.useForm();
  const [pwdForm] = Form.useForm();
  const [savingHost, setSavingHost] = useState(false);
  const [savingPwd, setSavingPwd] = useState(false);

  useEffect(() => {
    hostForm.setFieldsValue({ publicHost: settings?.publicHost || '' });
  }, [settings, hostForm]);

  const saveHost = async () => {
    try {
      const v = await hostForm.validate();
      setSavingHost(true);
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ publicHost: v.publicHost }) });
      Message.success('已保存');
      onSaved();
    } catch (e) {
      if (e && e.message) Message.error(e.message);
    } finally {
      setSavingHost(false);
    }
  };

  const savePwd = async () => {
    try {
      const v = await pwdForm.validate();
      if (v.newPassword !== v.confirmPassword) {
        Message.error('两次输入的新密码不一致');
        return;
      }
      setSavingPwd(true);
      await api('/api/settings/password', {
        method: 'POST',
        body: JSON.stringify({ oldPassword: v.oldPassword, newPassword: v.newPassword }),
      });
      Message.success('密码已修改');
      pwdForm.resetFields();
    } catch (e) {
      if (e && e.message) Message.error(e.message);
    } finally {
      setSavingPwd(false);
    }
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card bordered title="节点设置" style={{ maxWidth: 620 }}>
        <Form form={hostForm} layout="vertical" requiredSymbol={false}>
          <Form.Item
            label="对外地址（Host）"
            field="publicHost"
            extra="用于生成复制链接，例如 154.64.249.32 或 proxy.example.com，不要带 http://"
          >
            <Input placeholder="154.64.249.32" allowClear />
          </Form.Item>
          <Button type="primary" loading={savingHost} onClick={saveHost}>保存</Button>
        </Form>
      </Card>

      <Card bordered title="修改密码" style={{ maxWidth: 620 }}>
        <Form form={pwdForm} layout="vertical" requiredSymbol={false}>
          <Form.Item
            label="当前密码"
            field="oldPassword"
            rules={[{ required: true, message: '请输入当前密码' }]}
          >
            <Input.Password placeholder="当前密码" allowClear />
          </Form.Item>
          <Form.Item
            label="新密码"
            field="newPassword"
            rules={[
              { required: true, message: '请输入新密码' },
              { minLength: 6, message: '至少 6 位' },
            ]}
          >
            <Input.Password placeholder="至少 6 位" allowClear />
          </Form.Item>
          <Form.Item
            label="确认新密码"
            field="confirmPassword"
            rules={[{ required: true, message: '请再次输入新密码' }]}
          >
            <Input.Password placeholder="再次输入" allowClear />
          </Form.Item>
          <Button type="primary" loading={savingPwd} onClick={savePwd}>修改密码</Button>
        </Form>
      </Card>

      <Card bordered title="会话" style={{ maxWidth: 620 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          当前账号：{settings?.username || '-'}
        </Text>
        <Divider style={{ margin: '12px 0' }} />
        <Button status="danger" onClick={onLogout}>退出登录</Button>
      </Card>
    </Space>
  );
}
