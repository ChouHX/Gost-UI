'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CFG = {
  port: Number(process.env.PANEL_PORT || 8080),
  user: process.env.PANEL_USER || 'admin',
  pass: process.env.PANEL_PASS || 'admin',
  api: (process.env.GOST_API || 'http://127.0.0.1:18080').replace(/\/+$/, ''),
  apiUser: process.env.GOST_API_USER || '',
  apiPass: process.env.GOST_API_PASS || '',
  metrics: process.env.GOST_METRICS || 'http://127.0.0.1:9000/metrics',
  publicHost: process.env.PUBLIC_HOST || '',
  portStart: Number(process.env.PORT_RANGE_START || 18100),
  portEnd: Number(process.env.PORT_RANGE_END || 18199),
  dataDir: process.env.DATA_DIR || '/data',
  publicDir: process.env.PUBLIC_DIR || path.join(__dirname, 'public'),
  interval: Number(process.env.COLLECT_INTERVAL || 3000),
  gostManaged: process.env.GOST_MANAGED === '1',
  gostBin: process.env.GOST_BIN || 'gost',
  gostConfig: process.env.GOST_CONFIG || '/etc/gost/gost.yml',
};

const MIN = 60000;
const KEEP_MS = 24 * 3600 * 1000;
const META_FILE = path.join(CFG.dataDir, 'services.json');
const CONF_FILE = path.join(CFG.dataDir, 'config.json');
const SESSION_TTL = 24 * 3600 * 1000;
const FORWARD_TYPES = new Set(['tcp', 'udp']);
const PROXY_TYPES = new Set(['socks5', 'http', 'socks4', 'relay']);

let authCfg = { username: 'admin', salt: '', hash: '', publicHost: '' };
const sessions = new Map();

let meta = new Map();
let prev = new Map();
let rates = new Map();
let buckets = new Map();
let totals = { rx: 0, tx: 0 };
let lastCollect = 0;
let lastError = '';
let gostOnline = false;
let collecting = false;
let reconciling = false;
let gostChild = null;
let gostRestarts = 0;

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

/* ---------- gost 进程托管（单容器） ---------- */

function startGost() {
  if (!CFG.gostManaged) return;
  try {
    gostChild = spawn(CFG.gostBin, ['-C', CFG.gostConfig], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    log('gost spawn failed', e.message);
    return;
  }
  gostChild.stdout.on('data', (d) => process.stdout.write(`[gost] ${d}`));
  gostChild.stderr.on('data', (d) => process.stderr.write(`[gost] ${d}`));
  gostChild.on('error', (e) => log('gost error', e.message));
  gostChild.on('exit', (code, sig) => {
    gostChild = null;
    gostRestarts += 1;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(gostRestarts, 5));
    log(`gost exited code=${code} sig=${sig}, restart in ${delay}ms`);
    setTimeout(startGost, delay);
  });
  log('gost started', CFG.gostConfig);
}

function stopGost() {
  if (gostChild) {
    gostChild.removeAllListeners('exit');
    gostChild.kill('SIGTERM');
    gostChild = null;
  }
}

/* ---------- 元数据持久化 ---------- */

async function loadMeta() {
  try {
    const raw = await fsp.readFile(META_FILE, 'utf8');
    for (const item of JSON.parse(raw)) meta.set(item.name, item);
    log('meta loaded', meta.size);
  } catch (e) {
    if (e.code !== 'ENOENT') log('meta load failed', e.message);
  }
}

async function saveMeta() {
  try {
    await fsp.mkdir(CFG.dataDir, { recursive: true });
    await fsp.writeFile(META_FILE, JSON.stringify([...meta.values()], null, 2));
  } catch (e) {
    log('meta save failed', e.message);
  }
}

/* ---------- 账号 / 会话 / 设置 ---------- */

function hashPass(pass, salt) {
  return crypto.scryptSync(String(pass), salt, 32).toString('hex');
}

async function loadConfig() {
  try {
    authCfg = JSON.parse(await fsp.readFile(CONF_FILE, 'utf8'));
    if (!authCfg.salt || !authCfg.hash) throw new Error('bad config');
    log('config loaded, user =', authCfg.username);
  } catch {
    const salt = crypto.randomBytes(16).toString('hex');
    authCfg = {
      username: CFG.user,
      salt,
      hash: hashPass(CFG.pass, salt),
      publicHost: CFG.publicHost || '',
    };
    await saveConfig();
    log('config initialized from env, user =', authCfg.username);
  }
}

async function saveConfig() {
  await fsp.mkdir(CFG.dataDir, { recursive: true });
  await fsp.writeFile(CONF_FILE, JSON.stringify(authCfg, null, 2));
}

function verifyPassword(user, pass) {
  if (String(user) !== authCfg.username) return false;
  const h = Buffer.from(hashPass(pass, authCfg.salt), 'hex');
  const t = Buffer.from(authCfg.hash, 'hex');
  return h.length === t.length && crypto.timingSafeEqual(h, t);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function issueSession(res) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  res.setHeader('Set-Cookie', `gp_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`);
  return token;
}

function currentSession(req) {
  const t = parseCookies(req).gp_session;
  if (!t) return null;
  const exp = sessions.get(t);
  if (!exp) return null;
  if (exp < Date.now()) { sessions.delete(t); return null; }
  return t;
}

/* ---------- gost API ---------- */

async function gostFetch(method, apiPath, body) {
  const headers = {};
  if (CFG.apiUser) {
    headers.Authorization = 'Basic ' + Buffer.from(`${CFG.apiUser}:${CFG.apiPass}`).toString('base64');
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(CFG.api + apiPath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) {
      const msg = (data && (data.msg || data.message)) || text || `HTTP ${res.status}`;
      throw new Error(String(msg));
    }
    return data && typeof data === 'object' && 'data' in data ? data.data : data;
  } finally {
    clearTimeout(timer);
  }
}

async function listServices() {
  const data = await gostFetch('GET', '/config/services');
  return (data && data.list) || [];
}

async function listChains() {
  const data = await gostFetch('GET', '/config/chains');
  return (data && data.list) || [];
}

/* ---------- 流量采集 ---------- */

const LABEL_RE = /([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
const METRIC_RE = /^gost_service_transfer_(input|output)_bytes_total\{([^}]*)\}\s+([0-9.eE+-]+)/;

function parseLabels(s) {
  const out = {};
  let m;
  LABEL_RE.lastIndex = 0;
  while ((m = LABEL_RE.exec(s)) !== null) out[m[1]] = m[2];
  return out;
}

function addBucket(name, drx, dtx, now) {
  const minute = Math.floor(now / MIN) * MIN;
  let b = buckets.get(name);
  if (!b) { b = new Map(); buckets.set(name, b); }
  const cur = b.get(minute) || { rx: 0, tx: 0 };
  cur.rx += drx;
  cur.tx += dtx;
  b.set(minute, cur);
  totals.rx += drx;
  totals.tx += dtx;
}

async function collect() {
  if (collecting) return;
  collecting = true;
  try {
    const res = await fetch(CFG.metrics, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`metrics HTTP ${res.status}`);
    const txt = await res.text();
    const cur = new Map();
    for (const line of txt.split('\n')) {
      const m = METRIC_RE.exec(line);
      if (!m) continue;
      const name = parseLabels(m[2]).service;
      if (!name) continue;
      const v = Number(m[3]);
      if (!Number.isFinite(v)) continue;
      const e = cur.get(name) || { rx: 0, tx: 0 };
      if (m[1] === 'input') e.rx = v; else e.tx = v;
      cur.set(name, e);
    }
    const now = Date.now();
    for (const [name, v] of cur) {
      const p = prev.get(name);
      let drx = 0;
      let dtx = 0;
      let dt = CFG.interval / 1000;
      if (p) {
        dt = Math.max(0.5, (now - p.ts) / 1000);
        drx = v.rx >= p.rx ? v.rx - p.rx : v.rx;
        dtx = v.tx >= p.tx ? v.tx - p.tx : v.tx;
      }
      prev.set(name, { rx: v.rx, tx: v.tx, ts: now });
      if (p) addBucket(name, drx, dtx, now);
      const r = rates.get(name) || { rx: 0, tx: 0 };
      const a = 0.4;
      rates.set(name, {
        rx: r.rx * (1 - a) + (drx / dt) * a,
        tx: r.tx * (1 - a) + (dtx / dt) * a,
      });
    }
    for (const name of [...prev.keys()]) {
      if (!cur.has(name)) { prev.delete(name); rates.delete(name); }
    }
    lastCollect = now;
    lastError = '';
    gostOnline = true;
  } catch (e) {
    lastError = `metrics: ${e.message}`;
    gostOnline = false;
  } finally {
    collecting = false;
  }
}

function pruneBuckets() {
  const cut = Math.floor((Date.now() - KEEP_MS) / MIN) * MIN;
  for (const b of buckets.values()) {
    for (const k of [...b.keys()]) if (k < cut) b.delete(k);
  }
}

function cumOf(name) {
  const p = prev.get(name);
  return { rx: p ? p.rx : 0, tx: p ? p.tx : 0 };
}

function normAddr(addr) {
  if (!addr) return '';
  const s = String(addr);
  const i = s.lastIndexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}

function formatChain(chain) {
  if (!chain || !chain.hops) return '';
  return chain.hops
    .map((hop) => (hop.nodes || [])
      .map((n) => `${(n.connector && n.connector.type) || 'socks5'}://${n.addr}`)
      .join(' | '))
    .join(' → ');
}

function shapeService(s, chainMap) {
  const c = cumOf(s.name);
  const r = rates.get(s.name) || { rx: 0, tx: 0 };
  const chainName = (s.handler && s.handler.chain) || '';
  return {
    name: s.name,
    addr: s.addr,
    port: Number(normAddr(s.addr)) || 0,
    target: (s.forwarder && s.forwarder.nodes && s.forwarder.nodes[0] && s.forwarder.nodes[0].addr) || '',
    type: (s.handler && s.handler.type) || 'tcp',
    chain: chainName ? (chainMap.get(chainName) || chainName) : '',
    chainName,
    auth: (s.handler && s.handler.auth && s.handler.auth.username) || '',
    rx: c.rx,
    tx: c.tx,
    rxRate: Math.max(0, r.rx),
    txRate: Math.max(0, r.tx),
  };
}

function buildExportUrl(s) {
  const host = authCfg.publicHost || CFG.publicHost || '';
  if (!host) return '';
  const m = meta.get(s.name);
  if (PROXY_TYPES.has(s.type)) {
    const scheme = s.type === 'relay' ? 'socks5' : s.type;
    const u = s.auth || (m && m.authUser) || '';
    const pw = (m && m.authPass) || '';
    const auth = u && pw ? `${encodeURIComponent(u)}:${encodeURIComponent(pw)}@` : '';
    return `${scheme}://${auth}${host}:${s.port}`;
  }
  return `${host}:${s.port}`;
}

function tcpPing(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let settled = false;
    const sock = net.connect({ host, port });
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      sock.destroy();
      resolve({ ok, ms: Math.round(ms * 10) / 10, error });
    };
    sock.setTimeout(timeout, () => done(false, 'timeout'));
    sock.once('connect', () => done(true));
    sock.once('error', (e) => done(false, e.code || e.message));
  });
}

function splitHostPort(addr) {
  const s = String(addr || '');
  const i = s.lastIndexOf(':');
  if (i < 0) return { host: s, port: 0 };
  return { host: s.slice(0, i).replace(/^\[|\]$/g, ''), port: Number(s.slice(i + 1)) };
}

async function resolveProbeTarget(name) {
  const list = await listServices();
  const live = list.find((s) => s.name === name);
  if (!live) return '';
  const chainName = live.handler && live.handler.chain;
  if (chainName) {
    const chains = await listChains();
    const ch = chains.find((c) => c.name === chainName);
    const node = ch && ch.hops && ch.hops[0] && ch.hops[0].nodes && ch.hops[0].nodes[0];
    if (node && node.addr) return node.addr;
  }
  const fw = live.forwarder && live.forwarder.nodes && live.forwarder.nodes[0];
  if (fw && fw.addr) return fw.addr;
  return '';
}

async function pingService(name) {
  const target = await resolveProbeTarget(name);
  if (!target) return { ok: false, error: '该服务没有可探测的上游或目标' };
  const { host, port } = splitHostPort(target);
  if (!host || !port) return { ok: false, target, error: `无法解析目标 ${target}` };
  const samples = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await tcpPing(host, port);
    samples.push(r);
    if (!r.ok) break;
  }
  const good = samples.filter((r) => r.ok).map((r) => r.ms);
  if (!good.length) {
    return { ok: false, target, error: (samples[0] && samples[0].error) || '连接失败' };
  }
  return { ok: true, target, ms: Math.min(...good), samples };
}

async function buildState() {
  let list = [];
  let chains = [];
  let apiError = '';
  try {
    list = await listServices();
    chains = await listChains();
  } catch (e) {
    apiError = e.message;
  }
  const chainMap = new Map();
  for (const ch of chains) chainMap.set(ch.name, formatChain(ch));
  const services = list.map((s) => {
    const shaped = shapeService(s, chainMap);
    shaped.exportUrl = buildExportUrl(shaped);
    return shaped;
  });
  if (apiError) {
    for (const m of meta.values()) {
      services.push({
        name: m.name, addr: ':' + m.port, port: m.port, target: m.target || '',
        type: m.type || 'tcp', chain: m.chain || '', chainName: '', auth: m.authUser || '',
        rx: 0, tx: 0, rxRate: 0, txRate: 0, exportUrl: buildExportUrl({ ...m, auth: m.authUser }),
      });
    }
  }
  services.sort((a, b) => a.port - b.port);
  const agg = { count: services.length, rx: 0, tx: 0, rxRate: 0, txRate: 0, forward: 0, proxy: 0 };
  for (const s of services) {
    agg.rx += s.rx;
    agg.tx += s.tx;
    agg.rxRate += s.rxRate;
    agg.txRate += s.txRate;
    if (PROXY_TYPES.has(s.type)) agg.proxy += 1; else agg.forward += 1;
  }
  return {
    ok: true,
    gostOnline: !apiError,
    apiError,
    lastError,
    lastCollect,
    publicHost: authCfg.publicHost || CFG.publicHost || '',
    portRange: [CFG.portStart, CFG.portEnd],
    totals: agg,
    services,
  };
}

function series(minutes) {
  const now = Math.floor(Date.now() / MIN) * MIN;
  const start = now - (minutes - 1) * MIN;
  const points = [];
  const byService = {};
  for (const [name, b] of buckets) {
    const arr = [];
    for (let t = start; t <= now; t += MIN) {
      const v = b.get(t) || { rx: 0, tx: 0 };
      arr.push({ t, rx: v.rx, tx: v.tx });
    }
    byService[name] = arr;
  }
  const names = Object.keys(byService);
  for (let t = start; t <= now; t += MIN) {
    const idx = Math.round((t - start) / MIN);
    let rx = 0;
    let tx = 0;
    for (const n of names) {
      const p = byService[n][idx];
      if (p) { rx += p.rx; tx += p.tx; }
    }
    points.push({ t, rx, tx });
  }
  return { points, byService };
}

/* ---------- 服务编排 ---------- */

const TARGET_RE = /^[A-Za-z0-9._-]+:\d{1,5}$|^\[[0-9a-fA-F:]+\]:\d{1,5}$/;

function parseChainSpec(spec) {
  const parts = String(spec || '').split(',').map((x) => x.trim()).filter(Boolean);
  const hops = [];
  for (let i = 0; i < parts.length; i += 1) {
    let u;
    try { u = new URL(parts[i]); } catch { throw new Error(`上游链第 ${i + 1} 段格式错误，应为 socks5://user:pass@host:port`); }
    const proto = u.protocol.replace(':', '');
    if (!['socks5', 'http', 'https', 'ss', 'relay', 'sni'].includes(proto)) {
      throw new Error(`不支持的上游协议: ${proto}`);
    }
    if (!u.hostname || !u.port) throw new Error(`上游链第 ${i + 1} 段缺少主机或端口`);
    const connector = { type: proto };
    if (u.username) {
      connector.auth = { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
    }
    hops.push({ name: `hop-${i}`, nodes: [{ name: `node-${i}`, addr: `${u.hostname}:${u.port}`, connector }] });
  }
  return hops;
}

function validate(body, selfName) {
  const type = String(body.type || 'tcp').toLowerCase();
  if (!FORWARD_TYPES.has(type) && !PROXY_TYPES.has(type)) throw new Error(`不支持的服务类型: ${type}`);
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < CFG.portStart || port > CFG.portEnd) {
    throw new Error(`端口必须在 ${CFG.portStart}-${CFG.portEnd} 之间`);
  }
  const isForward = FORWARD_TYPES.has(type);
  const target = String(body.target || '').trim();
  if (isForward && !TARGET_RE.test(target)) throw new Error('目标地址格式应为 host:port');
  const authUser = String(body.authUser || '').trim();
  const authPass = String(body.authPass || '');
  const chain = String(body.chain || '').trim();
  if (chain) parseChainSpec(chain);
  if (authUser && !authPass && !selfName) throw new Error('填了用户名就必须填密码');
  return { type, port, target: isForward ? target : '', authUser, authPass, chain, isForward };
}

async function assertPortFree(port, selfName) {
  const existing = await listServices();
  for (const s of existing) {
    if (s.name !== selfName && normAddr(s.addr) === String(port)) {
      throw new Error(`端口 ${port} 已被服务 ${s.name} 占用`);
    }
  }
  for (const m of meta.values()) {
    if (m.name !== selfName && m.port === port) throw new Error(`端口 ${port} 已被 ${m.name} 占用`);
  }
}

async function applyService(m, mode = 'post') {
  const chainName = m.chain ? `ch-${m.name}` : '';
  if (chainName) {
    await gostFetch('DELETE', `/config/chains/${encodeURIComponent(chainName)}`).catch(() => {});
    await gostFetch('POST', '/config/chains', { name: chainName, hops: parseChainSpec(m.chain) });
  }
  const svc = {
    name: m.name,
    addr: `:${m.port}`,
    handler: { type: m.type },
    listener: { type: m.type === 'udp' ? 'udp' : 'tcp' },
  };
  if (chainName) svc.handler.chain = chainName;
  if (m.authUser) svc.handler.auth = { username: m.authUser, password: m.authPass };
  if (FORWARD_TYPES.has(m.type)) svc.forwarder = { nodes: [{ name: 'target-0', addr: m.target }] };

  if (mode === 'put') {
    try {
      await gostFetch('PUT', `/config/services/${encodeURIComponent(m.name)}`, svc);
      return;
    } catch (e) {
      log('put failed, fallback to recreate', m.name, e.message);
      await gostFetch('DELETE', `/config/services/${encodeURIComponent(m.name)}`).catch(() => {});
    }
  }
  await gostFetch('POST', '/config/services', svc);
}

async function createService(body) {
  const v = validate(body);
  await assertPortFree(v.port);

  const existing = await listServices();
  let name = `svc-${v.port}`;
  let i = 2;
  while (existing.some((s) => s.name === name)) name = `svc-${v.port}-${i++}`;

  const m = {
    name, port: v.port, type: v.type, target: v.target,
    chain: v.chain, authUser: v.authUser, authPass: v.authPass,
    createdAt: new Date().toISOString(),
  };
  await applyService(m, 'post');
  meta.set(name, m);
  await saveMeta();
  log('service created', name, v.type, v.target || v.chain || 'direct');
  return { name, port: v.port, type: v.type, target: v.target, chain: v.chain };
}

async function updateService(name, body) {
  const old = meta.get(name) || {};
  const v = validate(body, name);
  await assertPortFree(v.port, name);

  const authPass = v.authPass || (v.authUser === old.authUser ? old.authPass || '' : '');
  if (v.authUser && !authPass) throw new Error('修改用户名时必须同时填写密码');

  const m = {
    name, port: v.port, type: v.type, target: v.target,
    chain: v.chain, authUser: v.authUser, authPass,
    createdAt: old.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await applyService(m, 'put');
  meta.set(name, m);
  await saveMeta();
  log('service updated', name, v.type, v.target || v.chain || 'direct');
  return { name, port: v.port, type: v.type, target: v.target, chain: v.chain };
}

async function deleteService(name) {
  try {
    await gostFetch('DELETE', `/config/services/${encodeURIComponent(name)}`);
  } catch (e) {
    // 服务已不在 gost 里（例如重启后未重建），仍允许清理面板记录
    if (!/not found|不存在/i.test(e.message)) throw e;
  }
  const m = meta.get(name);
  if (m && m.chain) {
    await gostFetch('DELETE', `/config/chains/${encodeURIComponent(`ch-${name}`)}`).catch(() => {});
  }
  meta.delete(name);
  prev.delete(name);
  rates.delete(name);
  buckets.delete(name);
  await saveMeta();
  log('service deleted', name);
}

async function reconcile() {
  if (reconciling) return;
  reconciling = true;
  try {
    const list = await listServices();
    const names = new Set(list.map((s) => s.name));
    for (const m of [...meta.values()]) {
      if (names.has(m.name)) continue;
      try {
        await applyService(m, 'post');
        log('reconcile: restored', m.name);
      } catch (e) {
        log('reconcile: failed', m.name, e.message);
      }
    }
  } catch {
    /* gost 不可达，下一轮再试 */
  } finally {
    reconciling = false;
  }
}

/* ---------- HTTP ---------- */

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function requireAuth(req, res) {
  if (currentSession(req)) return true;
  json(res, 401, { ok: false, error: '未登录' });
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > 1e6) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const staticCache = new Map();
const PUBLIC = path.resolve(CFG.publicDir);

async function serveStatic(p, res) {
  const rel = p === '/' ? '/index.html' : p;
  const full = path.resolve(PUBLIC, '.' + rel);
  if (full !== PUBLIC && !full.startsWith(PUBLIC + path.sep)) return false;
  const ext = path.extname(full);
  if (ext === '.html') {
    try {
      const buf = await fsp.readFile(full);
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(buf);
      return true;
    } catch {
      return false;
    }
  }
  try {
    if (!staticCache.has(full)) staticCache.set(full, await fsp.readFile(full));
  } catch {
    return false;
  }
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(staticCache.get(full));
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/healthz') return json(res, 200, { ok: true, gostOnline, lastError });

  if (p === '/api/login' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      if (!verifyPassword(b.username, b.password)) {
        await new Promise((r) => { setTimeout(r, 400); });
        return json(res, 401, { ok: false, error: '用户名或密码错误' });
      }
      issueSession(res);
      log('login ok', authCfg.username);
      return json(res, 200, { ok: true, username: authCfg.username });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  // 静态资源（含登录页）不鉴权，接口才鉴权
  if (req.method === 'GET' && !p.startsWith('/api/')) {
    if (await serveStatic(p, res)) return;
    if (!path.extname(p) && await serveStatic('/index.html', res)) return;
  }

  if (!requireAuth(req, res)) return;

  try {
    if (p === '/api/me') return json(res, 200, { ok: true, username: authCfg.username });

    if (p === '/api/logout' && req.method === 'POST') {
      const t = currentSession(req);
      if (t) sessions.delete(t);
      res.setHeader('Set-Cookie', 'gp_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      return json(res, 200, { ok: true });
    }

    if (p === '/api/settings') {
      if (req.method === 'GET') {
        return json(res, 200, {
          ok: true,
          username: authCfg.username,
          publicHost: authCfg.publicHost || '',
          portRange: [CFG.portStart, CFG.portEnd],
        });
      }
      if (req.method === 'PUT') {
        const b = await readBody(req);
        authCfg.publicHost = String(b.publicHost || '')
          .trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
        await saveConfig();
        log('settings saved, publicHost =', authCfg.publicHost);
        return json(res, 200, { ok: true, publicHost: authCfg.publicHost });
      }
    }

    if (p === '/api/settings/password' && req.method === 'POST') {
      const b = await readBody(req);
      if (!verifyPassword(authCfg.username, b.oldPassword)) {
        return json(res, 400, { ok: false, error: '原密码不正确' });
      }
      const next = String(b.newPassword || '');
      if (next.length < 6) return json(res, 400, { ok: false, error: '新密码至少 6 位' });
      authCfg.salt = crypto.randomBytes(16).toString('hex');
      authCfg.hash = hashPass(next, authCfg.salt);
      await saveConfig();
      sessions.clear();
      issueSession(res);
      log('password changed');
      return json(res, 200, { ok: true });
    }

    if (p.startsWith('/api/services/') && p.endsWith('/ping') && req.method === 'POST') {
      const name = decodeURIComponent(p.slice('/api/services/'.length, -'/ping'.length));
      return json(res, 200, await pingService(name));
    }

    if (p === '/api/state') return json(res, 200, await buildState());
    if (p === '/api/series') {
      const minutes = Math.min(1440, Math.max(5, Number(url.searchParams.get('minutes')) || 60));
      return json(res, 200, series(minutes));
    }
    if (p === '/api/services' && req.method === 'POST') {
      return json(res, 200, { ok: true, service: await createService(await readBody(req)) });
    }
    if (p.startsWith('/api/services/')) {
      const name = decodeURIComponent(p.slice('/api/services/'.length));
      if (req.method === 'GET') {
        const m = meta.get(name);
        if (m) {
          return json(res, 200, {
            ok: true,
            service: {
              name: m.name, port: m.port, type: m.type, target: m.target || '',
              chain: m.chain || '', authUser: m.authUser || '', managed: true,
            },
          });
        }
        const list = await listServices();
        const live = list.find((x) => x.name === name);
        if (!live) return json(res, 404, { ok: false, error: `服务 ${name} 不存在` });
        const shaped = shapeService(live, new Map());
        if (shaped.chainName) {
          return json(res, 409, {
            ok: false,
            error: `${name} 由配置文件定义且带转发链，面板无法读取链上的密码，请直接改 gost.yml 或先删除后重建`,
          });
        }
        return json(res, 200, {
          ok: true,
          service: {
            name: shaped.name, port: shaped.port, type: shaped.type, target: shaped.target,
            chain: '', authUser: shaped.auth, managed: false,
          },
        });
      }
      if (req.method === 'PUT') {
        return json(res, 200, { ok: true, service: await updateService(name, await readBody(req)) });
      }
      if (req.method === 'DELETE') {
        await deleteService(name);
        return json(res, 200, { ok: true });
      }
    }
    if (p === '/api/refresh') {
      await collect();
      return json(res, 200, await buildState());
    }

    json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    log('error', p, e.message);
    json(res, 400, { ok: false, error: e.message });
  }
});

(async () => {
  await fsp.mkdir(CFG.dataDir, { recursive: true }).catch(() => {});
  await loadConfig();
  await loadMeta();
  startGost();
  setTimeout(() => { collect(); reconcile(); }, 1500);
  setInterval(collect, CFG.interval);
  setInterval(reconcile, 15000);
  setInterval(pruneBuckets, 5 * MIN);
  server.listen(CFG.port, '0.0.0.0', () => {
    log(`panel on :${CFG.port} | gost api ${CFG.api} | ports ${CFG.portStart}-${CFG.portEnd} | managed=${CFG.gostManaged}`);
  });
})();

function shutdown() {
  log('shutting down');
  stopGost();
  saveMeta().finally(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
