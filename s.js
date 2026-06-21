// ============================================================
// s.js — 권위 서버 (Firebase 영구저장 + s.js 검증/실시간)
//   클라이언트는 거짓말한다고 가정. 골드/XP/레벨/인벤은 서버가 검증.
//   스키마는 게임(admin_panel.html)과 동일한 필드명 사용 → 로드 호환.
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
let svc;
try { svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}'); }
catch (e) { console.error('❌ FIREBASE_SERVICE_ACCOUNT JSON 파싱 실패'); process.exit(1); }
if (!svc.project_id || !process.env.FIREBASE_DB_URL) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT / FIREBASE_DB_URL 환경변수 필요'); process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(svc), databaseURL: process.env.FIREBASE_DB_URL });
const rtdb = admin.database();
async function getUser(uid) { const s = await rtdb.ref('users/' + uid).get(); return s.exists() ? s.val() : null; }
async function setUser(uid, patch) { await rtdb.ref('users/' + uid).update(patch); }

// ---- 세션/토큰/룸/레이트 ----
const TOKENS = new Map(), SESSION = new Map(), ROOMS = new Map(), RATE = new Map();
function makeToken(uid) { const t = crypto.randomBytes(24).toString('hex'); TOKENS.set(t, { uid, exp: Date.now() + 432e5 }); return t; }
function tokenUser(t) { const s = TOKENS.get(t); if (!s || s.exp < Date.now()) { TOKENS.delete(t); return null; } return s.uid; }
function validId(id) { return typeof id === 'string' && /^[a-zA-Z0-9]{4,16}$/.test(id); }
function safeStr(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }
function clampNum(v, min, max, d) { v = Number(v); if (!Number.isFinite(v)) return d; return Math.max(min, Math.min(max, v)); }
function rateOk(uid, a, max, win) { const now = Date.now(); if (!RATE.has(uid)) RATE.set(uid, {}); const u = RATE.get(uid); if (!u[a]) u[a] = []; u[a] = u[a].filter(t => now - t < win); if (u[a].length >= max) return false; u[a].push(now); return true; }

// ---- 인벤토리(JSON 문자열 ⇄ 배열) ----
function parseInv(str) { try { const a = JSON.parse(str || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }

// ============================================================
// 인증
// ============================================================
async function handleRegister(m) {
  if (!validId(m.user_id)) return { error: '아이디: 영문/숫자 4~16자' };
  if (typeof m.password !== 'string' || m.password.length < 4 || m.password.length > 64) return { error: '비밀번호 4~64자' };
  if (await getUser(m.user_id)) return { error: '이미 존재하는 아이디입니다' };
  const pw_hash = await bcrypt.hash(m.password, 10);
  await rtdb.ref('users/' + m.user_id).set({
    user_id: m.user_id, nickname: safeStr(m.nickname, 24) || m.user_id, pw_hash,
    level: 1, xp: 0, max_xp: 100, gold: 50, hp: 100, max_hp: 100, mp: 50, max_mp: 50,
    atk: 5, def_stat: 2, skill_points: 3,
    inventory: JSON.stringify([{ id: 'wooden_sword', count: 1 }, { id: 'pickaxe_wood', count: 1 }]),
    hotbar: '[]', equipment: '{}', skills: '{}', costume: '{}',
    hair_unlocked: '[0]', outfit_unlocked: '[0]', accessory_unlocked: '[0]',
    last_x: 0, last_y: 0, last_login: new Date().toISOString(), team_id: null, bio: '',
    farm_plots: '[]', kills: 0, dungeon_cleared: '[]', hunger: 100,
    updated: Date.now(),
  });
  return { ok: true };
}
async function handleLogin(m) {
  if (!validId(m.user_id)) return { error: '아이디 형식 오류' };
  const u = await getUser(m.user_id);
  if (!u) return { error: '아이디 또는 비밀번호가 틀렸습니다' };
  if (!(await bcrypt.compare(String(m.password || ''), u.pw_hash || ''))) return { error: '아이디 또는 비밀번호가 틀렸습니다' };
  const token = makeToken(u.user_id);
  const { pw_hash, ...safe } = u;     // 비번 해시는 절대 클라로 안 보냄
  return { ok: true, token, user: safe };
}

// ============================================================
// save — 서버가 변화량 검증 (급증 차단), 진짜 값 반환 → 클라 동기화
// ============================================================
const LIM = { GOLD_PS: 60, GOLD_BUF: 3000, XP_PS: 120, XP_BUF: 4000, LV_JUMP: 3, ITEM_CAP: 600, SLOTS: 500 };
function validateInvDelta(prevStr, nextStr) {
  const prev = {}; for (const s of parseInv(prevStr)) prev[s.id] = s.count;
  const out = [];
  for (const s of parseInv(nextStr).slice(0, LIM.SLOTS)) {
    if (!s || !RULES.ITEM_IDS.has(s.id)) continue;            // 화이트리스트 밖 거부
    let c = Math.floor(Number(s.count)); if (!Number.isFinite(c) || c <= 0) continue;
    const cap = (prev[s.id] || 0) + LIM.ITEM_CAP;             // 아이템당 급증 차단
    out.push({ id: s.id, count: Math.min(99999, Math.min(c, cap)) });
  }
  return JSON.stringify(out);
}
async function handleSave(uid, d) {
  const u = await getUser(uid); if (!u) return { error: 'no_user' };
  const now = Date.now();
  const elapsed = Math.max(0.5, Math.min(600, (now - (u.updated || now)) / 1000));
  const set = { updated: now };
  set.last_x = clampNum(d.last_x, -1e7, 1e7, u.last_x || 0);
  set.last_y = clampNum(d.last_y, -1e7, 1e7, u.last_y || 0);
  set.hp = clampNum(d.hp, 0, 100000, u.hp);
  set.mp = clampNum(d.mp, 0, 100000, u.mp);
  set.max_hp = clampNum(d.max_hp, 1, 100000, u.max_hp);
  set.max_mp = clampNum(d.max_mp, 0, 100000, u.max_mp);
  set.atk = clampNum(d.atk, 0, 100000, u.atk);
  set.def_stat = clampNum(d.def_stat, 0, 100000, u.def_stat);
  set.skill_points = clampNum(d.skill_points, 0, 100000, u.skill_points);
  set.max_xp = clampNum(d.max_xp, 0, 1e9, u.max_xp);
  for (const f of ['hotbar', 'equipment', 'skills', 'costume', 'hair_unlocked', 'outfit_unlocked', 'accessory_unlocked', 'farm_plots', 'dungeon_cleared'])
    if (typeof d[f] === 'string') set[f] = safeStr(d[f], 8000);
  if (typeof d.bio === 'string') set.bio = safeStr(d.bio, 500);
  if (d.last_login != null) set.last_login = safeStr(String(d.last_login), 40);
  set.team_id = (typeof d.team_id === 'string') ? safeStr(d.team_id, 64) : null;
  set.hunger = clampNum(d.hunger, 0, 1000, u.hunger || 0);

  // 🔒 골드: 감소(소비) 허용, 증가는 속도 상한
  const reqGold = clampNum(d.gold, 0, 1e9, u.gold);
  const goldCap = (u.gold || 0) + LIM.GOLD_PS * elapsed + LIM.GOLD_BUF;
  set.gold = reqGold > goldCap ? u.gold : reqGold;
  if (reqGold > goldCap) console.warn(`⚠️ ${uid} 골드 급증 차단 ${u.gold}→${reqGold}`);
  // 🔒 XP
  const reqXp = clampNum(d.xp, 0, 1e9, u.xp);
  const xpCap = (u.xp || 0) + LIM.XP_PS * elapsed + LIM.XP_BUF;
  set.xp = reqXp > xpCap ? u.xp : reqXp;
  // 🔒 레벨: 1회 +3 이내
  const reqLv = clampNum(d.level, 1, 999, u.level);
  set.level = reqLv > (u.level || 1) + LIM.LV_JUMP ? u.level : reqLv;
  // 🔒 킬: 1회 +200 이내
  const reqK = clampNum(d.kills, 0, 1e8, u.kills || 0);
  set.kills = reqK > (u.kills || 0) + 200 ? (u.kills || 0) : reqK;
  // 🔒 인벤토리: 화이트리스트 + 아이템당 급증 상한
  if (typeof d.inventory === 'string') set.inventory = validateInvDelta(u.inventory, d.inventory);

  await setUser(uid, set);
  return { ok: true, gold: set.gold, xp: set.xp, level: set.level, kills: set.kills, inventory: set.inventory || u.inventory || '[]' };
}

// ============================================================
// 룸 중계 (위치/타일 실시간)
// ============================================================
function joinRoom(ws, room) { leaveRoom(ws); if (!ROOMS.has(room)) ROOMS.set(room, new Set()); ROOMS.get(room).add(ws); const s = SESSION.get(ws); if (s) s.room = room; }
function leaveRoom(ws) { const s = SESSION.get(ws); if (s && s.room && ROOMS.has(s.room)) { ROOMS.get(s.room).delete(ws); if (!ROOMS.get(s.room).size) ROOMS.delete(s.room); } }
function relay(ws, event, payload) { const s = SESSION.get(ws); if (!s || !s.room) return; const out = JSON.stringify({ t: 'relay', event, from: s.user_id, payload }); for (const p of ROOMS.get(s.room) || []) if (p !== ws && p.readyState === 1) p.send(out); }
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
        case 'save': { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); if (!rateOk(u, 'save', 10, 5000)) return reply({ error: 'rate' }); return reply(await handleSave(u, m.data || {})); }
        case 'tile': { const u = auth(); if (!u) return; await actTile(u, m.wid, m.changes); relay(ws, 'tile_changes', { changes: m.changes }); return; }
        case 'join': { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); sess.user_id = u; joinRoom(ws, safeStr(m.room, 40) || 'official'); return reply({ ok: true }); }
        case 'broadcast': { if (!sess.user_id) return; relay(ws, safeStr(m.event, 40), m.payload); return; }
        default: return;
      }
    } catch (e) { console.error('handler', e); return reply({ error: 'server_error' }); }
  });
  ws.on('close', () => { leaveRoom(ws); SESSION.delete(ws); });
});

server.listen(PORT, () => console.log(`🚀 서버 실행 :${PORT} (Firebase 영구저장 + 검증)`));
