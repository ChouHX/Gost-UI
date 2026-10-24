import React, { useState } from 'react';
import {
  Card, Form, Input, Button, Message, Typography,
} from '@arco-design/web-react';
import { IconThunderbolt, IconUser, IconLock } from '@arco-design/web-react/icon';
import { api } from '../api.js';

const { Text } = Typography;

export default function Login({ onSuccess }) {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    let values;
    try {
      values = await form.validate();
    } catch {
      return;
    }
    setLoading(true);
    try {
      const d = await api('/api/login', { method: 'POST', body: JSON.stringify(values) });
      onSuccess(d);
    } catch (e) {
      Message.error(e.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--color-bg-1)',
      }}
    >
      <Card bordered style={{ width: 360, padding: '8px 4px' }}>
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <IconThunderbolt style={{ fontSize: 26, color: 'rgb(var(--arcoblue-6))' }} />
          <div style={{ fontSize: 16, fontWeight: 500, marginTop: 10 }}>GOST 面板</div>
          <Text type="secondary" style={{ fontSize: 12 }}>登录后管理转发与代理服务</Text>
        </div>
        <Form form={form} layout="vertical" requiredSymbol={false}>
          <Form.Item field="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<IconUser />} placeholder="用户名" size="large" />
          </Form.Item>
          <Form.Item field="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password
              prefix={<IconLock />}
              placeholder="密码"
              size="large"
              onPressEnter={submit}
            />
          </Form.Item>
          <Button type="primary" long size="large" loading={loading} onClick={submit}>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
