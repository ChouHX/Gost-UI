export async function api(path, opt = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opt,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function fmtBytes(v) {
  v = Number(v) || 0;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let i = -1;
  do { v /= 1024; i += 1; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

export function fmtRate(v) {
  return `${fmtBytes(v)}/s`;
}

export function hhmm(t) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const PROXY_TYPES = ['socks5', 'http', 'socks4', 'relay'];

export const TYPE_LABEL = {
  tcp: 'TCP 转发',
  udp: 'UDP 转发',
  socks5: 'SOCKS5',
  http: 'HTTP 代理',
  socks4: 'SOCKS4',
  relay: '中继',
};
