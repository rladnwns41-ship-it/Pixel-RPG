// ============================================================
// s.js — 권위 서버 (Firebase 영구저장 + s.js 검증/실시간)
//
//   구조:
//     클라이언트 → WebSocket → s.js (검증·게임로직) → Firebase (영구저장)
//
//   철칙:
//   - 클라이언트는 Firebase에 직접 쓰지 않는다 (규칙으로 차단).
//   - s.js만 Firebase Admin SDK(서비스 계정)로 읽고 쓴다 → 규칙 우회.
//   - 골드/XP/레벨/인벤토리 = 서버가 소유. save는 위치/설정만 받는다.
//   - 모든 아이템 획득·소비 = 서버가 규칙으로 검증 (212아이템 화이트리스트).
// ============================================================

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const admin = require('firebase-admin');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const RULES = require('./server-gamedata.js');

const PORT = process.env.PORT || 3000;

// ---- Firebase Admin (서비스 계정 = 비밀, 환경변수로만) ----
// Render Environment 에 등록:
//   FIREBASE_SERVICE_ACCOUNT = 서비스계정 JSON 전체 (한 줄)
//   FIREBASE_DB_URL          = https://<프로젝트>-default-rtdb.firebaseio.com
let svc;
try { svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}'); }
catch (e) { console.error('❌ FIREBASE_SERVICE_ACCOUNT JSON 파싱 실패'); process.exit(1); }
if (!svc.project_id || !process.env.FIREBASE_DB_URL) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT / FIREBASE_DB_URL 환경변수가 필요합니다.');
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(svc), databaseURL: process.env.FIREBASE_DB_URL });
const rtdb = admin.database();

// ---- DB 헬퍼 (Firebase RTDB) ----
async function getUser(uid) { const s = await rtdb.ref('users/' + uid).get(); return s.exists() ? s.val() : null; }
async function setUser(uid, patch) { await rtdb.ref('users/' + uid).update(patch); }
async function createUser(uid, doc) { await rtdb.ref('users/' + uid).set(doc); }

// ============================================================
// 세션 / 토큰 / 룸 / 레이트리밋
// ============================================================
const TOKENS = new Map();
const SESSION = new Map();
const ROOMS = new Map();
const RATE = new Map();

function makeToken(uid) { const t = crypto.randomBytes(24).toString('hex'); TOKENS.set(t, { uid, exp: Date.now() + 432e5 }); return t; } // 12h
function tokenUser(t) { const s = TOKENS.get(t); if (!s || s.exp < Date.now()) { TOKENS.delete(t); return null; } return s.uid; }
function validId(id) { return typeof id === 'string' && /^[a-zA-Z0-9]{4,16}$/.test(id); }
function safeStr(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }
function clampNum(v, min, max, d) { v = Number(v); if (!Number.isFinite(v)) return d; return Math.max(min, Math.min(max, v)); }
function rateOk(uid, action, max, win) {
  const now = Date.now();
  if (!RATE.has(uid)) RATE.set(uid, {});
  const u = RATE.get(uid); if (!u[action]) u[action] = [];
  u[action] = u[action].filter(t => now - t < win);
  if (u[action].length >= max) return false;
  u[action].push(now); return true;
}

// ============================================================
// 서버측 인벤토리 (Firebase에 inv 배열로 영구 저장)
// ============================================================
function invAdd(inv, id, n) { if (!RULES.ITEM_IDS.has(id)) return false; n = Math.floor(n); if (n <= 0) return false; const s = inv.find(x => x.id === id); if (s) s.count = Math.min(99999, s.count + n); else inv.push({ id, count: n }); return true; }
function invCount(inv, id) { const s = inv.find(x => x.id === id); return s ? s.count : 0; }
function invRemove(inv, id, n) { const s = inv.find(x => x.id === id); if (!s || s.count < n) return false; s.count -= n; if (s.count <= 0) inv.splice(inv.indexOf(s), 1); return true; }
function cleanInv(arr) { return Array.isArray(arr) ? arr.filter(x => x && RULES.ITEM_IDS.has(x.id) && x.count > 0).map(x => ({ id: x.id, count: Math.min(99999, Math.floor(x.count)) })) : []; }
function syncDerived(u) { u.level = RULES.levelForXp(u.xp || 0); }

// ============================================================
// 인증
// ============================================================
async function handleRegister(m) {
  if (!validId(m.user_id)) return { error: '아이디: 영문/숫자 4~16자' };
  if (typeof m.password !== 'string' || m.password.length < 4 || m.password.length > 64) return { error: '비밀번호 4~64자' };
  if (await getUser(m.user_id)) return { error: '이미 존재하는 아이디입니다' };
  const pw_hash = await bcrypt.hash(m.password, 10);
  await createUser(m.user_id, {
    user_id: m.user_id, nickname: safeStr(m.nickname, 24) || m.user_id, pw_hash,
    gold: 50, xp: 0, level: 1, hp: 100, max_hp: 100, mp: 50, max_mp: 50, atk: 5, def_stat: 2, skill_points: 3,
    inv: [{ id: 'wooden_sword', count: 1 }, { id: 'pickaxe_wood', count: 1 }],
    hotbar: '[]', equipment: '{}', skills: '{}', bio: '', x: 0, y: 0, created: Date.now(), updated: Date.now(),
  });
  return { ok: true };
}
async function handleLogin(m) {
  if (!validId(m.user_id)) return { error: '아이디 형식 오류' };
  const u = await getUser(m.user_id);
  if (!u) return { error: '아이디 또는 비밀번호가 틀렸습니다' };
  if (!(await bcrypt.compare(String(m.password || ''), u.pw_hash || ''))) return { error: '아이디 또는 비밀번호가 틀렸습니다' };
  u.inv = cleanInv(u.inv); syncDerived(u);
  await setUser(u.user_id, { level: u.level });
  const token = makeToken(u.user_id);
  const { pw_hash, ...safe } = u;
  safe.inventory = JSON.stringify(u.inv || []);
  return { ok: true, token, user: safe };
}

// ============================================================
// save: 위치/설정만 (경제/진행 값은 무시 — 서버 액션으로만 변경)
// ============================================================
async function handleSave(uid, data) {
  const set = { updated: Date.now() };
  set.x = clampNum(data.x, -1e7, 1e7, 0);
  set.y = clampNum(data.y, -1e7, 1e7, 0);
  set.hp = clampNum(data.hp, 0, 100000, 100);
  set.mp = clampNum(data.mp, 0, 100000, 50);
  if (typeof data.hotbar === 'string') set.hotbar = safeStr(data.hotbar, 4000);
  if (typeof data.equipment === 'string') set.equipment = safeStr(data.equipment, 4000);
  if (typeof data.skills === 'string') set.skills = safeStr(data.skills, 4000);
  if (typeof data.bio === 'string') set.bio = safeStr(data.bio, 500);
  await setUser(uid, set);
  return { ok: true };
}

// ============================================================
// 권위 액션 — 경제/아이템 변동은 전부 여기서 (Firebase 트랜잭션 저장)
// ============================================================
async function actKill(uid, mob) {
  if (!rateOk(uid, 'kill', 30, 5000)) return { error: 'rate' };
  const r = RULES.KILL_REWARD[mob] || RULES.KILL_REWARD.default;
  const u = await getUser(uid); if (!u) return { error: 'no_user' };
  u.gold = Math.min(1e9, (u.gold || 0) + r.g); u.xp = (u.xp || 0) + r.xp; syncDerived(u);
  await setUser(uid, { gold: u.gold, xp: u.xp, level: u.level });
  return { ok: true, gold: u.gold, xp: u.xp, level: u.level, reward: r };
}
async function actMine(uid, tile) {
  if (!rateOk(uid, 'mine', 25, 3000)) return { error: 'rate' };
  const drop = RULES.MINE_DROP[tile]; if (!drop) return { ok: true, drop: null };
  const u = await getUser(uid); if (!u) return { error: 'no_user' };
  const inv = cleanInv(u.inv); invAdd(inv, drop, 1);
  await setUser(uid, { inv });
  return { ok: true, drop, inventory: JSON.stringify(inv) };
}
async function actCraft(uid, result) {
  if (!rateOk(uid, 'craft', 20, 3000)) return { error: 'rate' };
  const rec = RULES.RECIPE_BY_RESULT[result]; if (!rec) return { error: 'bad_recipe' };
  const u = await getUser(uid); if (!u) return { error: 'no_user' };
  const inv = cleanInv(u.inv);
  for (const [id, c] of Object.entries(rec.ing)) if (invCount(inv, id) < c) return { error: 'no_ingredients' };
  for (const [id, c] of Object.entries(rec.ing)) invRemove(inv, id, c);
  invAdd(inv, rec.result, rec.amount);
  await setUser(uid, { inv });
  return { ok: true, inventory: JSON.stringify(inv) };
}
async function actSell(uid, id, count) {
  count = clampNum(count, 1, 9999, 1);
  const u = await getUser(uid); if (!u) return { error: 'no_user' };
  const inv = cleanInv(u.inv);
  if (!invRemove(inv, id, count)) return { error: 'no_item' };
  u.gold = (u.gold || 0) + 1 * count; // TODO: 아이템별 판매가
  await setUser(uid, { inv, gold: u.gold });
  return { ok: true, gold: u.gold, inventory: JSON.stringify(inv) };
}
async function actBuy(uid, id, count) {
  count = clampNum(count, 1, 9999, 1);
  if (!RULES.ITEM_IDS.has(id)) return { error: 'bad_item' };
  const u = await getUser(uid); if (!u) return { error: 'no_user' };
  const cost = 10 * count; // TODO: 아이템별 구매가
  if ((u.gold || 0) < cost) return { error: 'no_gold' };
  const inv = cleanInv(u.inv); u.gold -= cost; invAdd(inv, id, count);
  await setUser(uid, { inv, gold: u.gold });
  return { ok: true, gold: u.gold, inventory: JSON.stringify(inv) };
}

// ============================================================
// 룸 중계 (위치/타일 — s.js가 실시간 처리, Firebase 안 거침)
// ============================================================
function joinRoom(ws, room) { leaveRoom(ws); if (!ROOMS.has(room)) ROOMS.set(room, new Set()); ROOMS.get(room).add(ws); const s = SESSION.get(ws); if (s) s.room = room; }
function leaveRoom(ws) { const s = SESSION.get(ws); if (s && s.room && ROOMS.has(s.room)) { ROOMS.get(s.room).delete(ws); if (!ROOMS.get(s.room).size) ROOMS.delete(s.room); } }
function relay(ws, event, payload) { const s = SESSION.get(ws); if (!s || !s.room) return; const out = JSON.stringify({ t: 'relay', event, from: s.user_id, payload }); for (const p of ROOMS.get(s.room) || []) if (p !== ws && p.readyState === 1) p.send(out); }

// 맵 타일 영구저장(영구 필요 → Firebase). 검증: 좌표/타일 숫자만.
async function actTile(uid, wid, changes) {
  if (!Array.isArray(changes) || changes.length > 500) return;
  const up = {};
  for (const c of changes) {
    const x = Math.floor(Number(c.x)), y = Math.floor(Number(c.y)), t = Math.floor(Number(c.t));
    if (!Number.isFinite(x) || !Number.isFinite(y) || t < 0 || t > 999) continue;
    up[`map_tiles/${safeStr(wid, 40) || 'main'}/${x}_${y}`] = { x, y, tile: t };
  }
  if (Object.keys(up).length) await rtdb.ref().update(up);
}

// ============================================================
// HTTP + WebSocket
// ============================================================
const app = express();
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'admin_panel.html')));
app.get('/health', (req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  SESSION.set(ws, { user_id: null, room: null });
  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const reply = (o) => { try { ws.send(JSON.stringify({ ...o, rid: m.rid })); } catch (e) {} };
    const sess = SESSION.get(ws);
    const auth = () => tokenUser(m.token);
    try {
      switch (m.t) {
        case 'register': return reply(await handleRegister(m));
        case 'login': { const r = await handleLogin(m); if (r.ok) sess.user_id = r.user.user_id; return reply(r); }
        case 'save':  { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); return reply(await handleSave(u, m.data || {})); }
        case 'kill':  { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); return reply(await actKill(u, safeStr(m.mob, 32))); }
        case 'mine':  { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); return reply(await actMine(u, safeStr(m.tile, 32))); }
        case 'craft': { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); return reply(await actCraft(u, safeStr(m.result, 32))); }
        case 'sell':  { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); return reply(await actSell(u, safeStr(m.id, 32), m.count)); }
        case 'buy':   { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); return reply(await actBuy(u, safeStr(m.id, 32), m.count)); }
        case 'tile':  { const u = auth(); if (!u) return; await actTile(u, m.wid, m.changes); relay(ws, 'tile_changes', { changes: m.changes }); return; }
        case 'join':  { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); sess.user_id = u; joinRoom(ws, safeStr(m.room, 40) || 'official'); return reply({ ok: true }); }
        case 'broadcast': { if (!sess.user_id) return; relay(ws, safeStr(m.event, 40), m.payload); return; }
        default: return;
      }
    } catch (e) { console.error('handler', e); return reply({ error: 'server_error' }); }
  });
  ws.on('close', () => { leaveRoom(ws); SESSION.delete(ws); });
});

server.listen(PORT, () => console.log(`🚀 서버 실행 :${PORT} (Firebase 영구저장)`));
