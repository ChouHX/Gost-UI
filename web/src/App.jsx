import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Layout, Card, Grid, Table, Button, Tag, Badge, Space, Typography,
  Message, Popconfirm, Tooltip, Empty, Spin, Tabs,
} from '@arco-design/web-react';
import {
  IconPlus, IconRefresh, IconEdit, IconDelete, IconThunderbolt, IconCopy,
} from '@arco-design/web-react/icon';
import {
  api, fmtBytes, fmtRate, hhmm, copyText, PROXY_TYPES, TYPE_LABEL,
} from './api.js';
import Login from './components/Login.jsx';
import Settings from './components/Settings.jsx';
import ServiceCards from './components/ServiceCards.jsx';
import ServiceDrawer from './components/ServiceDrawer.jsx';
import { useMedia } from './useMedia.js';

const { Header, Content } = Layout;
const { Row, Col } = Grid;
const { Text } = Typography;

function StatCard({ label, value, extra }) {
  return (
    <Card bordered bodyStyle={{ padding: '14px 16px' }}>
      <div style={{ color: 'var(--color-text-3)', fontSize: 12, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ color: 'var(--color-text-3)', fontSize: 12, marginTop: 2 }}>{extra}</div>
    </Card>
  );
}

function pingColor(ms) {
  if (ms < 100) return 'green';
  if (ms < 300) return 'gold';
  return 'red';
}

function Main({ me, onLogout }) {
  const [state, setState] = useState(null);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('dashboard');
  const [drawer, setDrawer] = useState({ visible: false, editName: null });
  const [pings, setPings] = useState({});
  // 窄屏只固定「操作」列，否则两列固定后中间可滚动区域太窄
  const narrow = useMedia('(max-width: 767px)');

  const handleAuthError = useCallback((e) => {
    if (e && e.status === 401) {
      onLogout();
      return true;
    }
    return false;
  }, [onLogout]);

  const loadState = useCallback(async () => {
    try {
      setState(await api('/api/state'));
    } catch (e) {
      if (!handleAuthError(e)) Message.error({ content: e.message, id: 'state-err' });
    } finally {
      setLoading(false);
    }
  }, [handleAuthError]);

  const loadSettings = useCallback(async () => {
    try {
      setSettings(await api('/api/settings'));
    } catch (e) {
      handleAuthError(e);
    }
  }, [handleAuthError]);

  useEffect(() => {
    loadState();
    loadSettings();
    const t = setInterval(loadState, 3000);
    return () => clearInterval(t);
  }, [loadState, loadSettings]);

  const suggestPort = useMemo(() => {
    if (!state) return 18101;
    const used = new Set(state.services.map((s) => s.port));
    const [from, to] = state.portRange;
    for (let p = from; p <= to; p += 1) if (!used.has(p)) return p;
    return from;
  }, [state]);

  const doPing = async (name) => {
    setPings((prev) => ({ ...prev, [name]: { loading: true } }));
    try {
      const r = await api(`/api/services/${encodeURIComponent(name)}/ping`, { method: 'POST' });
      setPings((prev) => ({ ...prev, [name]: r.ok ? { ms: r.ms, target: r.target } : { error: r.error, target: r.target } }));
    } catch (e) {
      if (!handleAuthError(e)) {
        setPings((prev) => ({ ...prev, [name]: { error: e.message } }));
      }
    }
  };

  const doCopy = async (s) => {
    if (!s.exportUrl) {
      Message.warning('请先在设置里填写对外地址');
      return;
    }
    const ok = await copyText(s.exportUrl);
    if (ok) Message.success(`已复制 ${s.exportUrl}`);
    else Message.error('复制失败，请手动选择文本');
  };

  const remove = async (name) => {
    try {
      await api(`/api/services/${encodeURIComponent(name)}`, { method: 'DELETE' });
      Message.success(`已删除 ${name}`);
      loadState();
    } catch (e) {
      if (!handleAuthError(e)) Message.error(e.message);
    }
  };

  const logout = async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
    onLogout();
  };

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      width: narrow ? 132 : 168,
      fixed: narrow ? undefined : 'left',
      render: (v) => <Text code>{v}</Text>,
    },
    {
      title: '类型',
      dataIndex: 'type',
      width: 104,
      render: (v) => (
        <Tag size="small" color={PROXY_TYPES.includes(v) ? 'green' : 'arcoblue'}>
          {TYPE_LABEL[v] || v}
        </Tag>
      ),
    },
    {
      title: '监听',
      dataIndex: 'port',
      width: 84,
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
      width: 96,
      render: (v) => (v ? <Text>{v}</Text> : <Text type="secondary">-</Text>),
    },
    { title: '入站', dataIndex: 'rx', width: 92, align: 'right', render: (v) => fmtBytes(v) },
    { title: '出站', dataIndex: 'tx', width: 92, align: 'right', render: (v) => fmtBytes(v) },
    {
      title: '延迟',
      width: 84,
      align: 'right',
      render: (_, r) => {
        const p = pings[r.name] || {};
        if (p.loading) return <Text type="secondary" style={{ fontSize: 12 }}>…</Text>;
        if (p.error) return <Tooltip content={p.error}><Text type="danger" style={{ fontSize: 12 }}>失败</Text></Tooltip>;
        if (p.ms != null) return <Tag size="small" color={pingColor(p.ms)}>{p.ms} ms</Tag>;
        return <Text type="secondary" style={{ fontSize: 12 }}>-</Text>;
      },
    },
    {
      title: '操作',
      width: 132,
      align: 'right',
      fixed: 'right',
      render: (_, r) => (
        <Space size={2}>
          <Tooltip content={r.exportUrl || '未设置对外地址'}>
            <Button size="mini" type="text" icon={<IconCopy />} onClick={() => doCopy(r)} />
          </Tooltip>
          <Tooltip content="测试延迟">
            <Button
              size="mini"
              type="text"
              icon={<IconThunderbolt />}
              loading={(pings[r.name] || {}).loading}
              onClick={() => doPing(r.name)}
            />
          </Tooltip>
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
      <Row gutter={10}>
        <Col xs={12} sm={12} md={12} lg={6}>
          <StatCard label="服务总数" value={totals.count} extra={`转发 ${totals.forward} · 代理 ${totals.proxy}`} />
        </Col>
        <Col xs={12} sm={12} md={12} lg={6}>
          <StatCard label="入站流量" value={fmtBytes(totals.rx)} extra={fmtRate(totals.rxRate)} />
        </Col>
        <Col xs={12} sm={12} md={12} lg={6}>
          <StatCard label="出站流量" value={fmtBytes(totals.tx)} extra={fmtRate(totals.txRate)} />
        </Col>
        <Col xs={12} sm={12} md={12} lg={6}>
          <StatCard
            label="采集状态"
            value={state?.lastCollect ? hhmm(state.lastCollect) : '等待中'}
            extra={state?.apiError ? `API 异常：${state.apiError}` : '每 3 秒采集一次'}
          />
        </Col>
      </Row>

      <Card
        bordered
        className="app-card"
        style={{ marginTop: 10 }}
        title="服务概览"
        extra={(
          <Text type="secondary" className="hide-sm" style={{ fontSize: 12 }}>
            复制链接需先在设置中填写对外地址
          </Text>
        )}
      >
        <ServiceCards
          services={services}
          pings={pings}
          onPing={doPing}
          onCopyDone={(ok, url) => {
            if (!url) return Message.warning('请先在设置里填写对外地址');
            return ok
              ? Message.success(`已复制 ${url}`)
              : Message.error('复制失败，请手动选择文本');
          }}
        />
      </Card>
    </>
  );

  const manage = (
    <Card
      bordered
      className="app-card"
      title="转发管理"
      extra={(
        <Space className="card-extra">
          <Text type="secondary" className="hide-sm" style={{ fontSize: 12 }}>
            端口池 {state ? `${state.portRange[0]}-${state.portRange[1]}` : '-'}
          </Text>
          <Button className="hide-sm" icon={<IconRefresh />} onClick={loadState}>刷新</Button>
          <Button type="primary" icon={<IconPlus />} onClick={() => setDrawer({ visible: true, editName: null })}>
            <span className="hide-xs">新建服务</span>
            <span className="show-xs">新建</span>
          </Button>
        </Space>
      )}
    >
      <Table
        rowKey="name"
        className="gost-table"
        size="small"
        pagination={false}
        data={services}
        columns={columns}
        scroll={{ x: 'max-content' }}
        noDataElement={<Empty description="暂无服务，点击右上角新建" />}
      />
    </Card>
  );

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header className="app-header">
        <IconThunderbolt style={{ fontSize: 18, color: 'rgb(var(--arcoblue-6))', flexShrink: 0 }} />
        <span style={{ fontSize: 15, fontWeight: 500, whiteSpace: 'nowrap' }}>GOST 面板</span>
        <Badge
          status={state?.gostOnline ? 'success' : 'danger'}
          text={state?.gostOnline ? '在线' : '离线'}
        />
        <Tag bordered className="hide-md">{state?.publicHost || '未设置对外地址'}</Tag>
        <div style={{ flex: 1 }} />
        <Text type="secondary" className="hide-sm" style={{ fontSize: 12 }}>{me?.username}</Text>
        <Button icon={<IconRefresh />} onClick={loadState} className="hide-sm">刷新</Button>
        <Button icon={<IconRefresh />} onClick={loadState} className="show-sm" aria-label="刷新" />
      </Header>

      <Content className="app-content">
        <Spin loading={loading} style={{ width: '100%' }}>
          <Tabs activeTab={tab} onChange={setTab} type="line" style={{ marginTop: 4 }}>
            <Tabs.TabPane key="dashboard" title="概览">{dashboard}</Tabs.TabPane>
            <Tabs.TabPane key="services" title="转发管理">{manage}</Tabs.TabPane>
            <Tabs.TabPane key="settings" title="设置">
              <Settings settings={settings} onSaved={loadSettings} onLogout={logout} />
            </Tabs.TabPane>
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

export default function App() {
  const [me, setMe] = useState(undefined);

  useEffect(() => {
    api('/api/me')
      .then((d) => setMe(d))
      .catch(() => setMe(null));
  }, []);

  if (me === undefined) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size={28} />
      </div>
    );
  }
  if (!me) return <Login onSuccess={setMe} />;
  return <Main me={me} onLogout={() => setMe(null)} />;
}
