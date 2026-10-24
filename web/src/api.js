export async function api(path, opt = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opt,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
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

export async function copyText(text) {
  if (!text) return false;
  // 安全上下文（HTTPS / localhost）才有 navigator.clipboard；
  // HTTP 部署下它是 undefined，必须走 execCommand 兜底。
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* 权限被拒时继续走兜底 */
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;';
  document.body.appendChild(ta);
  const sel = document.getSelection();
  const prev = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  let ok = false;
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  if (prev && sel) {
    sel.removeAllRanges();
    sel.addRange(prev);
  }
  return ok;
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
