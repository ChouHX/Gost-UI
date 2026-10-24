import React from 'react';
import {
  Grid, Card, Tag, Button, Tooltip, Empty, Typography,
} from '@arco-design/web-react';
import { IconCopy, IconThunderbolt } from '@arco-design/web-react/icon';
import {
  fmtBytes, fmtRate, PROXY_TYPES, TYPE_LABEL, copyText,
} from '../api.js';

const { Row, Col } = Grid;
const { Text } = Typography;

function pingColor(ms) {
  if (ms < 100) return 'green';
  if (ms < 300) return 'gold';
  return 'red';
}

export default function ServiceCards({ services, pings, onPing, onCopyDone }) {
  if (!services.length) return <Empty description="暂无服务" />;

  return (
    <Row gutter={[10, 10]}>
      {services.map((s) => {
        const isProxy = PROXY_TYPES.includes(s.type);
        const detail = isProxy
          ? (s.chain || '直连')
          : (s.target || '-');
        const p = pings[s.name] || {};
        return (
          <Col key={s.name} xs={24} sm={12} md={8} lg={6} xl={6}>
            <Card size="small" bordered bodyStyle={{ padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <Text code style={{ fontSize: 12 }}>{s.name}</Text>
                <Tag
                  size="small"
                  color={isProxy ? 'green' : 'arcoblue'}
                  style={{ marginRight: 0 }}
                >
                  {TYPE_LABEL[s.type] || s.type}
                </Tag>
              </div>

              <div
                style={{
                  fontSize: 12,
                  color: 'var(--color-text-2)',
                  marginTop: 6,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={detail}
              >
                <Text code style={{ fontSize: 12 }}>:{s.port}</Text>
                <span style={{ margin: '0 4px', color: 'var(--color-text-4)' }}>→</span>
                {detail}
              </div>

              <div style={{ fontSize: 11, color: 'var(--color-text-3)', marginTop: 4 }}>
                ↓{fmtBytes(s.rx)} · ↑{fmtBytes(s.tx)} · {fmtRate(s.rxRate + s.txRate)}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                <Button
                  size="mini"
                  icon={<IconCopy />}
                  onClick={async () => {
                    const ok = await copyText(s.exportUrl || '');
                    if (onCopyDone) onCopyDone(ok, s.exportUrl);
                  }}
                >
                  复制
                </Button>
                <Button
                  size="mini"
                  icon={<IconThunderbolt />}
                  loading={p.loading}
                  onClick={() => onPing(s.name)}
                >
                  延迟
                </Button>
                {p.loading ? null : p.error ? (
                  <Tooltip content={p.error}>
                    <Text type="danger" style={{ fontSize: 11 }}>失败</Text>
                  </Tooltip>
                ) : p.ms != null ? (
                  <Tag size="small" color={pingColor(p.ms)} style={{ marginRight: 0 }}>
                    {p.ms} ms
                  </Tag>
                ) : null}
              </div>
            </Card>
          </Col>
        );
      })}
    </Row>
  );
}
