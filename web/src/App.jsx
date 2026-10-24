import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Layout, Card, Grid, Table, Button, Tag, Badge, Space, Radio, Typography,
  Message, Popconfirm, Tooltip, Empty, Spin, Tabs,
} from '@arco-design/web-react';
import {
  IconPlus, IconRefresh, IconEdit, IconDelete, IconThunderbolt,
} from '@arco-design/web-react/icon';
import { api, fmtBytes, fmtRate, hhmm, PROXY_TYPES, TYPE_LABEL } from './api.js';
import TrafficChart from './components/TrafficChart.jsx';
import ServiceDrawer from './components/ServiceDrawer.jsx';

const { Header, Content } = Layout;
const { Row, Col } = Grid;
const { Text } = Typography;

const RANGES = [
  { label: '30 分钟', value: 30 },
  { label: '1 小时', value: 60 },
  { label: '3 小时', value: 180 },
  { label: '12 小时', value: 720 },
];

function StatCard({ label, value, extra }) {
  return (
    <Card bordered style={{ height: '100%' }}>
      <div style={{ color: 'var(--color-text-3)', fontSize: 12, marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ color: 'var(--color-text-3)', fontSize: 12, marginTop: 4 }}>{extra}</div>
    </Card>
  );
}

export default function App() {
  const [state, setState] = useState(null);
  const [points, setPoints] = useState([]);
  const [range, setRange] = useState(60);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('dashboard');
  const [drawer, setDrawer] = useState({ visible: false, editName: null });

  const loadState = useCallback(async () => {
    try {
      setState(await api('/api/state'));
    } catch (e) {
      Message.error({ content: e.message, id: 'state-err' });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSeries = useCallback(async (minutes) => {
    try {
      setPoints((await api(`/api/series?minutes=${minutes}`)).points);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadState();
    const t = setInterval(loadState, 3000);
    return () => clearInterval(t);
  }, [loadState]);

  useEffect(() => {
    loadSeries(range);
    const t = setInterval(() => loadSeries(range), 15000);
    return () => clearInterval(t);
  }, [range, loadSeries]);

  const suggestPort = useMemo(() => {
    if (!state) return 18101;
    const used = new Set(state.services.map((s) => s.port));
    const [from, to] = state.portRange;
    for (let p = from; p <= to; p += 1) if (!used.has(p)) return p;
    return from;
  }, [state]);

  const remove = async (name) => {
    try {
      await api(`/api/services/${encodeURIComponent(name)}`, { method: 'DELETE' });
      Message.success(`已删除 ${name}`);
      loadState();
    } catch (e) {
      Message.error(e.message);
    }
  };

  const commonColumns = [
    { title: '名称', dataIndex: 'name', render: (v) => <Text code>{v}</Text> },
    {
      title: '类型',
      dataIndex: 'type',
      width: 110,
      render: (v) => (
        <Tag color={PROXY_TYPES.includes(v) ? 'green' : 'arcoblue'} size="small">
          {TYPE_LABEL[v] || v}
        </Tag>
      ),
    },
    {
      title: '监听',
      dataIndex: 'port',
      width: 100,
      render: (v) => <Text code style={{ whiteSpace: 'nowrap' }}>:{v}</Text>,
    },
    {
      title: '目标 / 上游链',
      dataIndex: 'target',
      render: (_, r) => {
        if (PROXY_TYPES.includes(r.type)) {
          if (!r.chain) return <Text type="secondary">直连</Text>;
          return (
            <Tooltip content={r.chain}>
              <Text style={{ color: 'rgb(var(--gold-6))' }}>↳ {r.chain}</Text>
            </Tooltip>
          );
        }
        return <Text code>{r.target || '-'}</Text>;
      },
    },
    {
      title: '认证',
      dataIndex: 'auth',
      width: 90,
      render: (v) => (v ? <Text>{v}</Text> : <Text type="secondary">-</Text>),
    },
    { title: '入站', dataIndex: 'rx', width: 100, align: 'right', render: (v) => fmtBytes(v) },
    { title: '出站', dataIndex: 'tx', width: 100, align: 'right', render: (v) => fmtBytes(v) },
    { title: '速率', width: 110, align: 'right', render: (_, r) => fmtRate(r.rxRate + r.txRate) },
  ];

  const manageColumns = [
    ...commonColumns,
    {
      title: '操作',
      width: 110,
      align: 'right',
      render: (_, r) => (
        <Space size={4}>
          <Tooltip content="编辑">
            <Button
              size="mini"
              type="text"
              icon={<IconEdit />}
              onClick={() => setDrawer({ visible: true, editName: r.name })}
            />
          </Tooltip>
          <Popconfirm title={`删除 ${r.name}？`} onOk={() => remove(r.name)}>
            <Button size="mini" type="text" status="danger" icon={<IconDelete />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const totals = state?.totals || { count: 0, rx: 0, tx: 0, rxRate: 0, txRate: 0, forward: 0, proxy: 0 };
  const services = state?.services || [];

  const dashboard = (
    <>
      <Row gutter={12}>
        <Col span={6}>
          <StatCard label="服务总数" value={totals.count} extra={`转发 ${totals.forward} · 代理 ${totals.proxy}`} />
        </Col>
        <Col span={6}>
          <StatCard label="入站流量" value={fmtBytes(totals.rx)} extra={fmtRate(totals.rxRate)} />
        </Col>
        <Col span={6}>
          <StatCard label="出站流量" value={fmtBytes(totals.tx)} extra={fmtRate(totals.txRate)} />
        </Col>
        <Col span={6}>
          <StatCard
            label="采集状态"
            value={state?.lastCollect ? hhmm(state.lastCollect) : '等待中'}
            extra={state?.apiError ? `API 异常：${state.apiError}` : '每 3 秒采集一次'}
          />
        </Col>
      </Row>

      <Card
        bordered
        style={{ marginTop: 12 }}
        title="流量趋势"
        extra={(
          <Space size={16}>
            <Radio.Group type="button" size="small" value={range} onChange={setRange} options={RANGES} />
            <Space size={12}>
              <Space size={4}>
                <span style={{ width: 10, height: 2, background: '#3491fa', display: 'inline-block' }} />
                <Text type="secondary" style={{ fontSize: 12 }}>入站</Text>
              </Space>
              <Space size={4}>
                <span style={{ width: 10, height: 2, background: '#00b42a', display: 'inline-block' }} />
                <Text type="secondary" style={{ fontSize: 12 }}>出站</Text>
              </Space>
            </Space>
          </Space>
        )}
      >
        <TrafficChart points={points} />
      </Card>

      <Card bordered style={{ marginTop: 12 }} title="服务概览" extra={<Text type="secondary" style={{ fontSize: 12 }}>只读</Text>}>
        <Table
          rowKey="name"
          size="small"
          pagination={false}
          data={services}
          columns={commonColumns}
          noDataElement={<Empty description="暂无服务" />}
        />
      </Card>
    </>
  );

  const manage = (
    <Card
      bordered
      title="转发管理"
      extra={(
        <Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            端口池 {state ? `${state.portRange[0]}-${state.portRange[1]}` : '-'}
          </Text>
          <Button icon={<IconRefresh />} onClick={loadState}>刷新</Button>
          <Button type="primary" icon={<IconPlus />} onClick={() => setDrawer({ visible: true, editName: null })}>
            新建服务
          </Button>
        </Space>
      )}
    >
      <Table
        rowKey="name"
        size="small"
        pagination={false}
        data={services}
        columns={manageColumns}
        noDataElement={<Empty description="暂无服务，点击右上角新建" />}
      />
    </Card>
  );

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '0 20px', height: 56, borderBottom: '1px solid var(--color-border-2)',
        }}
      >
        <IconThunderbolt style={{ fontSize: 18, color: 'rgb(var(--arcoblue-6))' }} />
        <span style={{ fontSize: 15, fontWeight: 500 }}>GOST 面板</span>
        <Badge
          status={state?.gostOnline ? 'success' : 'danger'}
          text={state?.gostOnline ? '节点在线' : '节点离线'}
        />
        <Tag bordered>{state?.publicHost || location.host}</Tag>
        <div style={{ flex: 1 }} />
        <Button icon={<IconRefresh />} onClick={() => { loadState(); loadSeries(range); }}>刷新</Button>
      </Header>

      <Content style={{ padding: '0 20px 24px' }}>
        <Spin loading={loading} style={{ width: '100%' }}>
          <Tabs activeTab={tab} onChange={setTab} type="line" style={{ marginTop: 4 }}>
            <Tabs.TabPane key="dashboard" title="概览">{dashboard}</Tabs.TabPane>
            <Tabs.TabPane key="services" title="转发管理">{manage}</Tabs.TabPane>
          </Tabs>
        </Spin>
      </Content>

      <ServiceDrawer
        visible={drawer.visible}
        editName={drawer.editName}
        portRange={state?.portRange || [18100, 18199]}
        suggestPort={suggestPort}
        onClose={() => setDrawer({ visible: false, editName: null })}
        onSaved={loadState}
      />
    </Layout>
  );
}
