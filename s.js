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
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';   // 없으면 휴리스틱만, 있으면 AI 판정
const ADMIN_IDS = new Set((process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean)); // 관리자 아이디 목록 (쉼표구분)
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
// 🤖 AI 안티치트 (Groq) — 수상한 유저를 AI가 판정 → 정지
// ============================================================
const BAN_EMAIL = 'rladnwns54@gmail.com';
async function aiJudge(stats) {
  if (!GROQ_API_KEY) return null;
  const prompt =
    '너는 픽셀 MMORPG 안티치트 판정관이다. 아래 플레이어 통계를 보고 핵/조작 사용이 명백한지 판단하라. ' +
    '정상 기준: 대략 분당 골드 2000 이하, 2분당 1레벨 이하, 분당 킬 30 이하. ' +
    '플레이시간 대비 골드/레벨/킬이 물리적으로 불가능할 때만 cheat=true. 애매하면 false. ' +
    '반드시 JSON만 출력: {"cheat":true|false,"reason":"짧은 한국어 사유"}. ' +
    '통계: ' + JSON.stringify(stats);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_API_KEY },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', temperature: 0, max_tokens: 120, messages: [{ role: 'user', content: prompt }] })
    });
    const j = await res.json();
    const txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    const mm = txt.match(/\{[\s\S]*\}/); if (!mm) return null;
    return JSON.parse(mm[0]);
  } catch (e) { console.warn('groq 판정 실패:', e.message); return null; }
}
// 수상 휴리스틱: 플레이시간 대비 골드/레벨/킬이 과도하면 AI 검사 트리거
function looksSuspicious(s, playSec) {
  const m = Math.max(1, playSec / 60);
  return (s.gold > 30000 && playSec < 1800)
      || (s.gold / m > 4000)
      || (s.level > 25 && playSec < 1800)
      || (s.kills > 1500 && playSec < 1800);
}
// 정지 처리 (Firebase에 기록 → 해제는 Firebase 콘솔에서 banned=false 로만)
async function banUser(uid, reason) {
  await setUser(uid, { banned: true, ban_reason: safeStr(reason || '이상 행동 감지', 200), banned_at: Date.now() });
  console.warn(`⛔ ${uid} 정지: ${reason}`);
}

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
    play_seconds: 0, sessions: 0, banned: false,
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
  if (u.banned) return { error: '정지된 계정', banned: true, reason: u.ban_reason || '이상 행동 감지', email: BAN_EMAIL };
  await setUser(u.user_id, { sessions: (u.sessions || 0) + 1, last_login: new Date().toISOString() });
  const token = makeToken(u.user_id);
  const { pw_hash, ...safe } = u;     // 비번 해시는 절대 클라로 안 보냄
  return { ok: true, token, user: safe };
}

// ============================================================
// save — 서버가 변화량 검증 (급증 차단), 진짜 값 반환 → 클라 동기화
// ============================================================
const LIM = { GOLD_PS: 60, GOLD_BUF: 3000, XP_PS: 120, XP_BUF: 4000, LV_JUMP: 3, ITEM_CAP: 200, SLOTS: 90 };
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
// ============================================================
// 👑 관리자 액션 (서버에서 직접 지급 → 저장 검증에 막히지 않음)
// ============================================================
async function actAdminGive(uid, target, kind, value, count) {
  if (!ADMIN_IDS.has(uid)) return { error: '관리자 아님' };       // 관리자만
  const tid = safeStr(target, 16);
  const tu = await getUser(tid); if (!tu) return { error: '대상 없음' };
  if (kind === 'gold') {
    const amt = clampNum(value, -1e9, 1e9, 0);
    tu.gold = Math.max(0, Math.min(1e9, (tu.gold || 0) + amt));
    await setUser(tid, { gold: tu.gold });
    return { ok: true, target: tid, gold: tu.gold };
  }
  if (kind === 'level') {
    tu.level = clampNum(value, 1, 999, tu.level || 1);
    await setUser(tid, { level: tu.level });
    return { ok: true, target: tid, level: tu.level };
  }
  if (kind === 'item') {
    const id = safeStr(value, 32);
    if (!RULES.ITEM_IDS.has(id)) return { error: '없는 아이템: ' + id };
    const n = Math.max(1, Math.min(9999, Math.floor(Number(count) || 1)));
    const inv = parseInv(tu.inventory);
    const slot = inv.find(s => s.id === id);
    if (slot) slot.count = Math.min(99999, slot.count + n); else inv.push({ id, count: n });
    await setUser(tid, { inventory: JSON.stringify(inv) });
    return { ok: true, target: tid, item: id, count: n };
  }
  return { error: 'bad_kind' };
}
// 아이템 검색 (관리자 지급 UI용)
function adminSearchItems(q) {
  q = String(q || '').toLowerCase();
  const out = [];
  for (const id of RULES.ITEM_IDS) { if (!q || id.toLowerCase().includes(q)) out.push(id); if (out.length >= 40) break; }
  return out;
}

// ============================================================
// 🔄 시즌 초기화 (관리자 전용) — 유저/맵/사설서버 데이터 전체 삭제 + 전체 팀김
// ============================================================
async function actSeasonReset(uid) {
  if (!ADMIN_IDS.has(uid)) return { error: '관리자 아님' };
  // 전체에 알림 + 팀김 예고
  for (const room of ROOMS.keys()) {
    const out = JSON.stringify({ t: 'relay', event: 'season_reset', from: 'SERVER', payload: { msg: '새 시즌 초기화 중… 잠시 후 다시 접속해주세요!' } });
    for (const ws of ROOMS.get(room)) { try { ws.send(out); } catch (e) {} }
  }
  // 데이터 삭제 (잠시 대기 후 — 클라가 메시지 보게)
  await new Promise(r => setTimeout(r, 1500));
  await rtdb.ref('users').remove().catch(() => {});
  await rtdb.ref('map_tiles').remove().catch(() => {});
  await rtdb.ref('chests').remove().catch(() => {});
  await rtdb.ref('corpses').remove().catch(() => {});
  await rtdb.ref('parked_vehicles').remove().catch(() => {});
  await rtdb.ref('animals_state').remove().catch(() => {});
  await rtdb.ref('map_meta').remove().catch(() => {});
  await rtdb.ref('server_registry').remove().catch(() => {});
  await rtdb.ref('channels').remove().catch(() => {});
  TOKENS.clear();
  console.warn('🔄 시즌 초기화 완료 by ' + uid);
  return { ok: true };
}

// ============================================================
// 💰 서버 권위 경제 (econ) — 골드는 서버가 계산·지급. 클라는 "행동"만 보냄.
//   처치/판매/구매 = 서버 테이블로 고정. 클라가 골드 액수를 못 정함.
// ============================================================
const KILL_GOLD = { chicken: 1, cow: 2, pig: 2, sheep: 2, wolf: 6, bear: 12, slime: 3, zombie: 8, skeleton: 9, spider: 5, boss: 80, _default: 4 };
const SELL_PRICE = { _default: 1 };   // 아이템별 판매가(추후 확장). 기본 1G
const BUY_PRICE = { _default: 10 };

async function actKill(uid, mob) {
  if (!rateOk(uid, 'kill', 25, 4000)) return { error: 'rate' };   // 4초에 25키만 인정 → 드립 차단
  const g = KILL_GOLD[mob] != null ? KILL_GOLD[mob] : KILL_GOLD._default;
  const xp = Math.max(2, Math.round(g * 1.3));
  const u = await getUser(uid); if (!u) return { error: 'no_user' };
  const gold = Math.min(1e9, (u.gold || 0) + g);
  const nxp = (u.xp || 0) + xp;
  await setUser(uid, { gold, xp: nxp, kills: (u.kills || 0) + 1 });
  return { ok: true, gold, xp: nxp };
}
async function actSell(uid, id, count) {
  id = safeStr(id, 32); count = Math.max(1, Math.min(9999, Math.floor(Number(count) || 1)));
  if (!RULES.ITEM_IDS.has(id)) return { error: 'bad_item' };
  const u = await getUser(uid); if (!u) return { error: 'no_user' };
  const inv = parseInv(u.inventory);
  const slot = inv.find(s => s.id === id);
  if (!slot || slot.count < count) return { error: 'no_item' };
  slot.count -= count; if (slot.count <= 0) inv.splice(inv.indexOf(slot), 1);
  const price = SELL_PRICE[id] != null ? SELL_PRICE[id] : SELL_PRICE._default;
  const gold = Math.min(1e9, (u.gold || 0) + price * count);
  await setUser(uid, { inventory: JSON.stringify(inv), gold });
  return { ok: true, gold, inventory: JSON.stringify(inv) };
}
async function actBuy(uid, id, count) {
  id = safeStr(id, 32); count = Math.max(1, Math.min(9999, Math.floor(Number(count) || 1)));
  if (!RULES.ITEM_IDS.has(id)) return { error: 'bad_item' };
  const u = await getUser(uid); if (!u) return { error: 'no_user' };
  const price = BUY_PRICE[id] != null ? BUY_PRICE[id] : BUY_PRICE._default;
  const cost = price * count;
  if ((u.gold || 0) < cost) return { error: 'no_gold' };
  const inv = parseInv(u.inventory);
  const slot = inv.find(s => s.id === id);
  if (slot) slot.count = Math.min(99999, slot.count + count); else inv.push({ id, count });
  const gold = (u.gold || 0) - cost;
  await setUser(uid, { inventory: JSON.stringify(inv), gold });
  return { ok: true, gold, inventory: JSON.stringify(inv) };
}

async function handleSave(uid, d) {
  const u = await getUser(uid); if (!u) return { error: 'no_user' };
  if (u.banned) return { banned: true, reason: u.ban_reason || '이상 행동 감지', email: BAN_EMAIL };
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
  for (const f of ['skills', 'costume', 'hair_unlocked', 'outfit_unlocked', 'accessory_unlocked', 'farm_plots', 'dungeon_cleared'])
    if (typeof d[f] === 'string') set[f] = safeStr(d[f], 8000);
  // 🔒 핫바: 존재하는 아이템 id만 허용 (가짜 id 주입 차단)
  if (typeof d.hotbar === 'string') {
    try { const h = JSON.parse(d.hotbar); set.hotbar = JSON.stringify(Array.isArray(h) ? h.slice(0, 10).map(x => (x && RULES.ITEM_IDS.has(x) ? x : null)) : []); }
    catch (e) { set.hotbar = u.hotbar || '[]'; }
  }
  // 🔒 장비: 값이 아이템 id면 화이트리스트 검증
  if (typeof d.equipment === 'string') {
    try { const e = JSON.parse(d.equipment); const out = {};
      if (e && typeof e === 'object') for (const k in e) { const v = e[k]; if (v == null) continue; if (typeof v === 'string' && RULES.ITEM_IDS.has(v)) out[k] = v; else if (typeof v === 'object') out[k] = v; }
      set.equipment = JSON.stringify(out);
    } catch (e2) { set.equipment = u.equipment || '{}'; }
  }
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
  // 🔒 레벨: 1회 저장에 +1만 (점프 차단). 정상 레벨업은 1씩 올라감
  const reqLv = clampNum(d.level, 1, 999, u.level);
  set.level = reqLv > (u.level || 1) + 1 ? (u.level || 1) : reqLv;
  // 🔒 킬: 1회 +200 이내
  const reqK = clampNum(d.kills, 0, 1e8, u.kills || 0);
  set.kills = reqK > (u.kills || 0) + 200 ? (u.kills || 0) : reqK;
  // 🔒 인벤토리: 화이트리스트 + 아이템당 급증 상한
  if (typeof d.inventory === 'string') set.inventory = validateInvDelta(u.inventory, d.inventory);

  // 🤖 플레이시간 누적 + AI 안티치트 (수상할 때만, 비동기 — 저장 속도 안 느려짐)
  set.play_seconds = (u.play_seconds || 0) + Math.min(elapsed, 300);
  if (GROQ_API_KEY && looksSuspicious(set, set.play_seconds) && rateOk(uid, 'ai', 1, 300000)) {
    aiJudge({ gold: set.gold, level: set.level, kills: set.kills, play_minutes: Math.round(set.play_seconds / 60), sessions: u.sessions || 0 })
      .then(v => { if (v && v.cheat) banUser(uid, v.reason); })
      .catch(() => {});
  }

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

// 🔒 보안: 저장소 루트를 통째로 서빙하지 않는다 (.git/.env/s.js 노출 방지).
//    클라이언트에 필요한 파일만 화이트리스트로 내보낸다.
const PUBLIC_FILES = new Set([
  'admin_panel.html',
  'net-client.js',
]);
// 클라이언트가 직접 요청할 수 있는 정적 자산 확장자 (이미지/폰트/사운드 등)
const PUBLIC_EXT = /\.(png|jpg|jpeg|gif|webp|svg|ico|mp3|ogg|wav|woff2?|ttf|css)$/i;
// 절대 노출 금지 (서버 코드/비밀/버전관리)
const BLOCKED = /(^|\/)(\.git|\.env|node_modules|s\.js|server-gamedata\.js|package(-lock)?\.json|render\.yaml|\.gitignore|firebase-.*\.json|SERVER_README\.md|.*\.example)(\/|$)/i;

app.get('/health', (req, res) => res.send('ok'));
// 🤖 Groq 작동 확인: /groq-test 열면 키 설정·응답 여부를 JSON으로 보여줌
app.get('/groq-test', async (req, res) => {
  if (!GROQ_API_KEY) return res.json({ ok: false, reason: 'GROQ_API_KEY 환경변수 없음' });
  const v = await aiJudge({ gold: 999999999, level: 999, kills: 99999, play_minutes: 2, sessions: 1 });
  if (v) return res.json({ ok: true, key: 'OK', sample_verdict: v });
  return res.json({ ok: false, reason: 'Groq 응답 없음 (키 오류 또는 네트워크)' });
});
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'admin_panel.html')));

app.get(/.*/, (req, res) => {
  // URL 디코드 + 경로 정규화로 ../ 트래버설 차단
  let rel;
  try { rel = decodeURIComponent(req.path).replace(/^\/+/, ''); } catch (e) { return res.status(400).end(); }
  const full = path.normalize(path.join(__dirname, rel));
  if (!full.startsWith(__dirname)) return res.status(403).end();          // 경로 탈출 차단
  if (BLOCKED.test(rel) || rel.split('/').some(seg => seg.startsWith('.'))) return res.status(404).end(); // 닷파일/금지목록 차단
  const base = rel.split('/').pop();
  if (PUBLIC_FILES.has(rel) || PUBLIC_EXT.test(base)) return res.sendFile(full, err => { if (err) res.status(404).end(); });
  return res.status(404).end();
});
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
        case 'load': { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); const usr = await getUser(u); if (!usr) return reply({ error: 'no_user' }); const { pw_hash, ...safe } = usr; return reply({ ok: true, user: safe }); }
        case 'kill': { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); return reply(await actKill(u, safeStr(m.mob, 32))); }
        case 'sell': { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); return reply(await actSell(u, m.id, m.count)); }
        case 'buy': { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); return reply(await actBuy(u, m.id, m.count)); }
        case 'tile': { const u = auth(); if (!u) return; await actTile(u, m.wid, m.changes); relay(ws, 'tile_changes', { changes: m.changes }); return; }
        case 'join': { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); sess.user_id = u; joinRoom(ws, safeStr(m.room, 40) || 'official'); return reply({ ok: true }); }
        case 'broadcast': { if (!sess.user_id) return; relay(ws, safeStr(m.event, 40), m.payload); return; }
        case 'admin_give': { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); return reply(await actAdminGive(u, m.target, m.kind, m.value, m.count)); }
        case 'admin_search': { const u = auth(); if (!u || !ADMIN_IDS.has(u)) return reply({ error: 'unauthorized' }); return reply({ ok: true, items: adminSearchItems(m.q) }); }
        case 'season_reset': { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); return reply(await actSeasonReset(u)); }
        default: return;
      }
    } catch (e) { console.error('handler', e); return reply({ error: 'server_error' }); }
  });
  ws.on('close', () => { leaveRoom(ws); SESSION.delete(ws); });
});

server.listen(PORT, () => console.log(`🚀 서버 실행 :${PORT} (Firebase 영구저장 + 검증)`));
