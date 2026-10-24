import React, { useEffect, useState } from 'react';
import {
  Drawer, Form, Input, Select, InputNumber, Button, Space, Message, Spin, Alert,
} from '@arco-design/web-react';
import { api, PROXY_TYPES, TYPE_LABEL } from '../api.js';

const FormItem = Form.Item;

export default function ServiceDrawer({ visible, editName, portRange, suggestPort, onClose, onSaved }) {
  const [form] = Form.useForm();
  const [type, setType] = useState('tcp');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const isEdit = Boolean(editName);
  const isProxy = PROXY_TYPES.includes(type);

  useEffect(() => {
    if (!visible) return;
    form.resetFields();
    if (!isEdit) {
      setType('tcp');
      form.setFieldsValue({ type: 'tcp', port: suggestPort });
      return;
    }
    setLoading(true);
    api(`/api/services/${encodeURIComponent(editName)}`)
      .then((d) => {
        const s = d.service;
        setType(s.type);
        form.setFieldsValue({
          type: s.type,
          port: s.port,
          target: s.target || '',
          authUser: s.authUser || '',
          chain: s.chain || '',
        });
      })
      .catch((e) => Message.error(`读取配置失败：${e.message}`))
      .finally(() => setLoading(false));
  }, [visible, editName]);

  const submit = async () => {
    try {
      const values = await form.validate();
      setSaving(true);
      const body = {
        type: values.type,
        port: Number(values.port),
        target: PROXY_TYPES.includes(values.type) ? '' : (values.target || '').trim(),
        authUser: PROXY_TYPES.includes(values.type) ? (values.authUser || '').trim() : '',
        authPass: PROXY_TYPES.includes(values.type) ? (values.authPass || '') : '',
        chain: (values.chain || '').trim(),
      };
      if (isEdit) {
        await api(`/api/services/${encodeURIComponent(editName)}`, { method: 'PUT', body: JSON.stringify(body) });
        Message.success('已保存');
      } else {
        const r = await api('/api/services', { method: 'POST', body: JSON.stringify(body) });
        Message.success(`已创建 ${r.service.name}`);
      }
      onSaved();
      onClose();
    } catch (e) {
      if (e && e.message) Message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      width={480}
      title={isEdit ? `编辑 ${editName}` : '新建服务'}
      visible={visible}
      onCancel={onClose}
      footer={(
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={submit}>保存</Button>
        </Space>
      )}
      unmountOnExit
    >
      <Spin loading={loading} style={{ width: '100%' }}>
        <Form form={form} layout="vertical" requiredSymbol={false}>
          <FormItem label="类型" field="type" rules={[{ required: true, message: '请选择类型' }]}>
            <Select onChange={(v) => setType(v)}>
              {Object.entries(TYPE_LABEL).map(([k, v]) => (
                <Select.Option key={k} value={k}>{v}</Select.Option>
              ))}
            </Select>
          </FormItem>

          <FormItem
            label="监听端口"
            field="port"
            rules={[{ required: true, message: '请填写端口' }]}
            extra={`可用范围 ${portRange[0]}-${portRange[1]}`}
          >
            <InputNumber min={portRange[0]} max={portRange[1]} style={{ width: '100%' }} />
          </FormItem>

          {isProxy ? (
            <>
              <FormItem label="代理用户名" field="authUser" extra="留空表示不需要认证">
                <Input placeholder="例如 us1" allowClear />
              </FormItem>
              <FormItem
                label="代理密码"
                field="authPass"
                extra={isEdit ? '留空则保持原密码不变' : ''}
              >
                <Input.Password placeholder={isEdit ? '留空不修改' : '与用户名配套'} allowClear />
              </FormItem>
            </>
          ) : (
            <FormItem
              label="目标地址"
              field="target"
              rules={[{ required: true, message: '请填写目标地址' }]}
              extra="格式 host:port，例如 10.0.0.5:3306"
            >
              <Input placeholder="10.0.0.5:3306" allowClear />
            </FormItem>
          )}

          <FormItem
            label="上游转发链（可选）"
            field="chain"
            extra="socks5://user:pass@host:port，多级用英文逗号分隔"
          >
            <Input.TextArea
              placeholder="socks5://user:pass@107.158.18.123:6014"
              autoSize={{ minRows: 1, maxRows: 4 }}
            />
          </FormItem>

          <Alert
            type="info"
            content={isProxy
              ? '代理服务 = handler socks5/http，可挂上游链逐级转发'
              : '端口转发 = handler tcp/udp + forwarder，可挂上游链'}
          />
        </Form>
      </Spin>
    </Drawer>
  );
}
