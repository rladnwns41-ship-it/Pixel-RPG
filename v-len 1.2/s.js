// ============================================================
// s.js - Medieval Realm LAN server (no Firebase, no npm install)
//   Pure Node.js: HTTP static serving + WebSocket realtime + JSON file DB.
//   Run:  node s.js   -> share the printed link on the same Wi-Fi.
//   Each ?world=NAME in the link is a fully separated world.
// ============================================================
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

let PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
let VERBOSE = process.env.QUIET !== '1';   // set QUIET=1 to reduce logs

// ============================================================
// HOST PERFORMANCE SETTINGS - edit these numbers to tune the game for everyone.
//   Lower posRateMs  = smoother movement but more network traffic.
//   Higher posRateMs = less traffic but choppier movement on slow Wi-Fi.
// These are sent to every client on connect, so changing them here changes it
// for ALL players. You can also override with environment variables.
// ============================================================
let CONFIG = {
  posRateMs: Number(process.env.POS_RATE_MS) || 100,   // min ms between position updates (was 150). 50=very smooth, 150=light
  idleMs:    Number(process.env.IDLE_MS)     || 2000,  // heartbeat interval when standing still
  timeoutMs: Number(process.env.TIMEOUT_MS)  || 6000,  // remove a player after this many ms of silence
  adminIds:  (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean), // game IDs that get admin (host on localhost is always admin)
};

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- logging helpers (plain English, timestamped) ----
function ts() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function log(line) { console.log('[' + ts() + '] ' + line); }
function warn(line) { console.warn('[' + ts() + '] WARN ' + line); }

// throttle repeated noisy log lines (e.g. high-frequency position writes)
const _logThrottle = new Map();
function logThrottled(keyTag, line, ms) {
  const now = Date.now();
  const last = _logThrottle.get(keyTag) || 0;
  if (now - last < (ms || 3000)) return;
  _logThrottle.set(keyTag, now);
  log(line);
}

// rolling counters for the periodic summary line
const stats = { writes: 0, events: 0, gets: 0, msgs: 0 };

// ============================================================
// 1) Static file serving (whitelist of extensions only)
// ============================================================
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};
const PUBLIC_EXT = /\.(html|js|css|png|jpg|jpeg|gif|webp|svg|ico|mp3|ogg|wav|woff2?|ttf)$/i;
const BLOCKED = /(^|\/)(\.|node_modules|s\.js|data|package(-lock)?\.json)(\/|$)/i;

function sendFile(res, rel) {
  let full;
  try { full = path.normalize(path.join(ROOT, decodeURIComponent(rel))); }
  catch (e) { res.writeHead(400).end(); return; }
  if (!full.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  const r = path.relative(ROOT, full).replace(/\\/g, '/');
  if (BLOCKED.test(r) || !PUBLIC_EXT.test(full)) { res.writeHead(404).end(); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/health') { res.writeHead(200).end('ok'); return; }
  if (u === '/' || u === '') { sendFile(res, 'admin_panel.html'); return; }
  sendFile(res, u.replace(/^\/+/, ''));
});

// ============================================================
// 2) In-memory realtime DB per world (+ JSON file persistence)
// ============================================================
const worlds = new Map();   // world -> { tree, conns:Set, saveTimer }

function safeWorld(w) { w = String(w || 'main').toLowerCase(); return /^[a-z0-9_-]{1,40}$/.test(w) ? w : 'main'; }

function loadWorld(w) {
  if (worlds.has(w)) return worlds.get(w);
  let tree = {};
  const f = path.join(DATA_DIR, w + '.json');
  try { if (fs.existsSync(f)) { tree = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; log('world "' + w + '" loaded from disk (' + Object.keys(tree).length + ' top-level keys)'); } }
  catch (e) { tree = {}; warn('world "' + w + '" failed to load, starting empty: ' + e.message); }
  const W = { tree, conns: new Set(), saveTimer: null };
  worlds.set(w, W);
  return W;
}
function scheduleSave(w) {
  const W = worlds.get(w); if (!W || W.saveTimer) return;
  W.saveTimer = setTimeout(() => {
    W.saveTimer = null;
    try { fs.writeFileSync(path.join(DATA_DIR, w + '.json'), JSON.stringify(W.tree)); logThrottled('save:' + w, 'world "' + w + '" saved to disk', 4000); }
    catch (e) { warn('world "' + w + '" save failed: ' + e.message); }
  }, 1500);
}

function P(p) { return String(p == null ? '' : p).split('/').filter(s => s.length); }

function resolveTs(v) {
  if (v && typeof v === 'object') {
    if (v.__ts__ === true) return Date.now();
    if (Array.isArray(v)) return v.map(resolveTs);
    const o = {}; for (const k in v) o[k] = resolveTs(v[k]); return o;
  }
  return v;
}
function getNode(tree, arr) {
  let n = tree;
  for (const k of arr) { if (n == null || typeof n !== 'object') return undefined; n = n[k]; }
  return n;
}
function setNode(tree, arr, val) {
  if (arr.length === 0) return { existed: false };
  let n = tree;
  for (let i = 0; i < arr.length - 1; i++) {
    const k = arr[i];
    if (n[k] == null || typeof n[k] !== 'object') n[k] = {};
    n = n[k];
  }
  const last = arr[arr.length - 1];
  const existed = Object.prototype.hasOwnProperty.call(n, last);
  if (val === null || val === undefined) delete n[last]; else n[last] = val;
  return { existed };
}

function applyWrite(world, pathStr, val) {
  const W = loadWorld(world);
  val = resolveTs(val);
  const arr = P(pathStr);
  if (arr.length === 0) return;
  const parentPath = arr.slice(0, -1).join('/');
  const key = arr[arr.length - 1];
  const { existed } = setNode(W.tree, arr, val);
  scheduleSave(world);
  stats.writes++;
  const evt = (val === null || val === undefined) ? 'child_removed' : (existed ? 'child_changed' : 'child_added');
  const notified = emitChild(W, parentPath, evt, key, getNode(W.tree, arr));
  // Detailed but throttled write log. Broadcast/position writes are high-frequency, so throttle per path.
  if (VERBOSE) {
    const isHot = parentPath.endsWith('/broadcast');
    const line = 'write  world=' + world + ' path=' + pathStr + ' evt=' + evt + ' notified=' + notified;
    if (isHot) logThrottled('w:' + world + ':' + key, line, 3000);
    else log(line);
  }
  return notified;
}

function emitChild(W, parentPath, evt, key, val) {
  let notified = 0;
  for (const conn of W.conns) {
    for (const [subId, s] of conn.subs) {
      if (s.child && s.path === parentPath) {
        send(conn.ws, { evt, subId, key, val: val === undefined ? null : val });
        notified++; stats.events++;
      }
    }
  }
  return notified;
}

function applyUpdate(world, basePath, obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const k in obj) {
    const full = [basePath, k].filter(s => s && s.length).join('/');
    applyWrite(world, full, obj[k]);
  }
}

// ============================================================
// 3) WebSocket (RFC6455) implemented in pure Node (no ws package)
// ============================================================
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function send(ws, obj) {
  if (!ws || ws.destroyed) return;
  let payload;
  try { payload = Buffer.from(JSON.stringify(obj)); } catch (e) { return; }
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
  try { ws.write(Buffer.concat([header, payload])); } catch (e) {}
}
function sendClose(ws) { try { ws.write(Buffer.from([0x88, 0x00])); ws.end(); } catch (e) {} }
function sendPong(ws, data) { const l = data.length; try { ws.write(Buffer.concat([Buffer.from([0x8a, l]), data])); } catch (e) {} }

function worldClientCount(world) { const W = worlds.get(world); return W ? W.conns.size : 0; }

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );

  const params = new URLSearchParams(req.url.split('?')[1] || '');
  const world = safeWorld(params.get('world'));
  const W = loadWorld(world);
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

  const conn = { ws: socket, world, subs: new Map(), ip };
  W.conns.add(conn);
  const isHost = (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost');   // host plays on the same machine as the server
  log('client connected   world=' + world + ' ip=' + ip + (isHost ? ' (HOST - admin granted)' : '') + ' clients_in_world=' + W.conns.size);
  send(socket, { evt: 'config', val: Object.assign({}, CONFIG, { host: isHost }) });   // host flag + performance + admin list

  let buf = Buffer.alloc(0);
  let fragData = [];

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) break;
      const b0 = buf[0], b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < off + 2) break; len = buf.readUInt16BE(off); off += 2; }
      else if (len === 127) { if (buf.length < off + 8) break; const hi = buf.readUInt32BE(off); const lo = buf.readUInt32BE(off + 4); len = hi * 4294967296 + lo; off += 8; }
      let mask = null;
      if (masked) { if (buf.length < off + 4) break; mask = buf.slice(off, off + 4); off += 4; }
      if (buf.length < off + len) break;
      let data = buf.slice(off, off + len);
      if (masked) { const out = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) out[i] = data[i] ^ mask[i & 3]; data = out; }
      buf = buf.slice(off + len);

      if (opcode === 0x8) { cleanup('close frame'); sendClose(socket); return; }
      if (opcode === 0x9) { sendPong(socket, data); continue; }
      if (opcode === 0xa) { continue; }
      if (opcode === 0x1 || opcode === 0x0) {
        fragData.push(data);
        if (fin) { const full = Buffer.concat(fragData).toString('utf8'); fragData = []; handleMsg(full); }
        continue;
      }
    }
  });

  function handleMsg(text) {
    let m; try { m = JSON.parse(text); } catch (e) { return; }
    stats.msgs++;
    try {
      switch (m.op) {
        case 'get': {
          stats.gets++;
          const val = getNode(W.tree, P(m.path));
          send(socket, { rid: m.rid, ok: true, val: val === undefined ? null : val });
          if (VERBOSE) logThrottled('get:' + world + ':' + m.path, 'get    world=' + world + ' path=' + m.path, 3000);
          return;
        }
        case 'set': { applyWrite(world, m.path, m.val); send(socket, { rid: m.rid, ok: true }); return; }
        case 'update': { applyUpdate(world, m.path || '', m.val || {}); send(socket, { rid: m.rid, ok: true }); return; }
        case 'remove': { applyWrite(world, m.path, null); send(socket, { rid: m.rid, ok: true }); return; }
        case 'sub': {
          conn.subs.set(m.subId, { path: P(m.path).join('/'), child: !!m.child });
          log('subscribe  world=' + world + ' ip=' + ip + ' path=' + P(m.path).join('/') + ' child=' + (!!m.child) + ' (this client now has ' + conn.subs.size + ' subs)');
          return;
        }
        case 'unsub': { conn.subs.delete(m.subId); return; }
        default: return;
      }
    } catch (e) { warn('handler error: ' + e.message); send(socket, { rid: m.rid, ok: false, error: 'err' }); }
  }

  function cleanup(reason) {
    if (!W.conns.has(conn)) return;
    W.conns.delete(conn);
    log('client disconnected world=' + world + ' ip=' + ip + ' reason=' + (reason || 'close') + ' clients_in_world=' + W.conns.size);
  }
  socket.on('close', () => cleanup('socket close'));
  socket.on('error', (e) => cleanup('socket error ' + (e && e.message)));
});

// periodic summary so it is obvious the server is alive and how many players are connected
setInterval(() => {
  let total = 0; const parts = [];
  for (const [w, W] of worlds) { if (W.conns.size > 0) { total += W.conns.size; parts.push(w + '=' + W.conns.size); } }
  if (total > 0) log('status  connected_clients=' + total + ' [' + parts.join(' ') + ']  writes/10s=' + stats.writes + ' events_relayed/10s=' + stats.events + ' gets/10s=' + stats.gets);
  stats.writes = 0; stats.events = 0; stats.gets = 0; stats.msgs = 0;
}, 10000);

// ============================================================
// 4) Start - print LAN links
// ============================================================
function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name in ifs) for (const i of ifs[name]) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}
function startServer() {
  server.listen(PORT, '0.0.0.0', () => {
    const ips = lanIPs();
    console.log('');
    console.log('Medieval Realm LAN server started (no Firebase).');
    console.log('  Local test:        http://localhost:' + PORT + '/');
    if (ips.length) {
      console.log('  Share on Wi-Fi:    http://' + ips[0] + ':' + PORT + '/');
      for (let i = 1; i < ips.length; i++) console.log('                     http://' + ips[i] + ':' + PORT + '/');
      console.log('  Separate world:    http://' + ips[0] + ':' + PORT + '/?world=myroom');
    } else {
      console.log('  No LAN IPv4 address found. Check your network connection.');
    }
    console.log('  Performance: posRateMs=' + CONFIG.posRateMs + ' idleMs=' + CONFIG.idleMs + ' timeoutMs=' + CONFIG.timeoutMs);
    console.log('  Stop: press Ctrl + C');
    console.log('');
  });
}

// ============================================================
// Interactive setup menu. Runs BEFORE the server starts.
//   Type a number + Enter to change an option, or just Enter to launch.
//   If not a real terminal (piped / hosting), it starts with defaults.
// ============================================================
const SPEEDS = [
  { name: 'Smooth', posRateMs: 50 },
  { name: 'Normal', posRateMs: 100 },
  { name: 'Light',  posRateMs: 150 },
];
let speedIdx = 1; // Normal

function drawMenu() {
  console.clear();
  console.log('============================================');
  console.log('  Medieval Realm LAN Server - SETUP');
  console.log('============================================');
  console.log('   1)  Speed :  ' + SPEEDS[speedIdx].name + '  (' + SPEEDS[speedIdx].posRateMs + ' ms)');
  console.log('   2)  Port  :  ' + PORT);
  console.log('   3)  Logs  :  ' + (VERBOSE ? 'detailed' : 'quiet'));
  console.log('   4)  Admins:  ' + (CONFIG.adminIds.length ? CONFIG.adminIds.join(', ') : '(host on localhost only)'));
  console.log('--------------------------------------------');
  console.log('  Type a number to change it, then Enter.');
  console.log('  Just press Enter to START the server.');
  console.log('  Type q + Enter to quit.');
  console.log('============================================');
}

function ask(rl, q) { return new Promise((res) => rl.question(q, (a) => res(a))); }

async function setupMenu() {
  if (!process.stdin.isTTY) { startServer(); return; }   // piped / hosting -> just start
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  while (true) {
    drawMenu();
    const ans = (await ask(rl, '> ')).trim().toLowerCase();
    if (ans === '' ) { CONFIG.posRateMs = SPEEDS[speedIdx].posRateMs; rl.close(); console.clear(); startServer(); return; }
    if (ans === 'q') { rl.close(); console.log('bye'); process.exit(0); }
    if (ans === '1') { speedIdx = (speedIdx + 1) % SPEEDS.length; continue; }
    if (ans === '3') { VERBOSE = !VERBOSE; continue; }
    if (ans === '4') {
      const a = (await ask(rl, '  Admin game IDs (comma separated, Enter for none): ')).trim();
      CONFIG.adminIds = a ? a.split(',').map(s => s.trim()).filter(Boolean) : [];
      continue;
    }
    if (ans === '2') {
      const p = (await ask(rl, '  New port (Enter to keep ' + PORT + '): ')).trim();
      const n = parseInt(p, 10);
      if (n >= 1 && n <= 65535) PORT = n;
      continue;
    }
    // anything else: redraw
  }
}

setupMenu();
