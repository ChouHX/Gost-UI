import React from 'react';
import { Empty } from '@arco-design/web-react';
import { fmtBytes, hhmm } from '../api.js';

const W = 900;
const H = 240;
const L = 64;
const R = 14;
const T = 14;
const B = 26;

function niceMax(v) {
  if (v <= 0) return 1024;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  const n = v / base;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * base;
}

export default function TrafficChart({ points }) {
  if (!points || !points.length) return <Empty description="暂无数据" />;

  const iw = W - L - R;
  const ih = H - T - B;
  const n = points.length;
  const max = niceMax(points.reduce((m, p) => Math.max(m, p.rx, p.tx), 0));
  const x = (i) => L + (n <= 1 ? 0 : (i / (n - 1)) * iw);
  const y = (v) => T + ih - (v / max) * ih;
  const line = (key) => points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');
  const area = `${line('rx')} L${x(n - 1).toFixed(1)} ${T + ih} L${L} ${T + ih} Z`;

  const grid = [];
  for (let i = 0; i <= 4; i += 1) {
    const v = (max / 4) * i;
    const yy = y(v);
    grid.push(<line key={`g${i}`} x1={L} y1={yy} x2={W - R} y2={yy} stroke="#2a2a2e" strokeWidth="1" />);
    grid.push(
      <text key={`t${i}`} x={L - 8} y={yy + 3.5} fill="#7d7d85" fontSize="11" textAnchor="end">
        {fmtBytes(v)}
      </text>,
    );
  }

  const ticks = 5;
  const labels = [];
  for (let i = 0; i < ticks; i += 1) {
    const idx = Math.round((i / (ticks - 1)) * (n - 1));
    if (points[idx]) {
      labels.push(
        <text key={`x${i}`} x={x(idx)} y={H - 8} fill="#7d7d85" fontSize="11" textAnchor="middle">
          {hhmm(points[idx].t)}
        </text>,
      );
    }
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img">
      <defs>
        <linearGradient id="rxFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3491fa" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#3491fa" stopOpacity="0" />
        </linearGradient>
      </defs>
      {grid}
      {labels}
      <path d={area} fill="url(#rxFill)" />
      <path d={line('rx')} fill="none" stroke="#3491fa" strokeWidth="1.6" strokeLinejoin="round" />
      <path d={line('tx')} fill="none" stroke="#00b42a" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}
