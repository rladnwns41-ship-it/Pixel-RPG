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
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const ADMIN_IDS = new Set((process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
const BOT_SERVER_URL = 'https://bot-oi7z.onrender.com';
const BOT_SERVER_TOKEN = process.env.BOT_SERVER_TOKEN || '';

// ─── 서버 시작 시 봇 학습 자동 트리거 (30초 후) ───
if (BOT_SERVER_TOKEN) {
  setTimeout(async () => {
    try {
      console.log('🤖 봇 서버 자동 학습 트리거 중...');
      // 봇 서버 깨우기 (콜드스타트 대응)
      await fetch(BOT_SERVER_URL + '/').catch(() => null);
      await new Promise(r => setTimeout(r, 5000)); // 5초 대기
      // 학습 상태 확인
      const status = await fetch(BOT_SERVER_URL + '/train/status').then(r => r.json()).catch(() => null);
      if (status && status.isTraining) { console.log('⏭️ 이미 학습 중 - 스킵'); return; }
      // 학습 시작
      const res = await fetch(BOT_SERVER_URL + '/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: BOT_SERVER_TOKEN, epochs: 10, limit: 10000 }),
      }).then(r => r.json()).catch(() => null);
      if (res && res.started) console.log('✅ 봇 자동 학습 시작됨!');
      else if (res && res.error) console.log('⚠️ 봇 학습 응답:', res.error);
    } catch(e) {
      console.warn('봇 자동 학습 트리거 실패:', e.message);
    }
  }, 30000);
}
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
// 🚫 서버측 검열 (클라 우회 방지) — 금지어·개인정보·광고 차단
// ============================================================
const BAD_WORDS = [
  '시발','씨발','ㅅㅂ','ㅆㅂ','병신','ㅄ','ㅂㅅ','존나','좆','ㅈㄴ','새끼','ㅅㄲ','개새','썅','미친','ㅁㅊ',
  '지랄','ㅈㄹ','꺼져','닥쳐','엿먹','fuck','shit','bitch','asshole','dick','pussy',
  '섹스','sex','야동','자위','창녀','걸레','매춘','포르노','porn','ㅅㅅ',
  '한남','한녀','급식충','틀딱','맘충','노슬아치','좌빨','우꼴','전라디언','일베','메갈',
  '왕따','따돌림','빵셔틀','괴롭혀','때려','폭행','자살해','뒤져','뒤져라','뒤져버','죽어','죽여',
  '디스코드 오세요','디코 오세요','텔레그램','텔레','카톡','카카오톡 아이디','인스타 팔로우','팔로우해',
  '토토','스포츠토토','바카라','슬롯','환전','충전 이벤트','불법','도박','먹튀'
];
const BAD_REGEX = [
  /01[016789][-\s]?\d{3,4}[-\s]?\d{4}/,
  /\d{6}[-\s]?\d{7}/,
  /https?:\/\/[^\s]+/i,
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  /디코[\s.]*[a-zA-Z0-9._-]{2,}/i,
  /카톡[\s.:]*[a-zA-Z0-9._-]{2,}/i
];
function serverCensor(raw, max) {
  if (typeof raw !== 'string') return { blocked: true, reason: 'bad_input' };
  let t = raw.normalize('NFKC');
  const compact = t.replace(/\s+/g, '').toLowerCase();
  for (const w of BAD_WORDS) if (compact.includes(w.toLowerCase())) return { blocked: true, reason: 'bad_word' };
  for (const r of BAD_REGEX) if (r.test(t)) return { blocked: true, reason: 'personal_info' };
  if (/(.)\1{7,}/.test(t)) return { blocked: true, reason: 'spam' };
  if (t.length > (max || 200)) t = t.slice(0, max || 200);
  return { ok: true, text: t };
}
function censorNick(raw) {
  const c = serverCensor(raw, 12);
  if (c.blocked) return c;
  if (/관리자|운영자|admin|GM|모드|mod|공식|official|system|시스템/i.test(c.text)) return { blocked: true, reason: 'impersonation' };
  return c;
}
// ⛔ 도배·욕설 반복시 경고 → 3회 초과 시 정지
async function warnUser(uid, reason) {
  const ref = rtdb.ref('users/' + uid);
  let count = 0;
  await ref.child('warnings').transaction(cur => { count = (cur || 0) + 1; return count; });
  if (count >= 3) await banUser(uid, '반복 위반 3회: ' + reason);
  return count;
}

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
  // 🚫 닉네임 검열 (사칭/욕설/개인정보 차단)
  const nc = censorNick(safeStr(m.nickname, 24) || m.user_id);
  if (nc.blocked) return { error: '닉네임 거부: ' + nc.reason };
  if (await getUser(m.user_id)) return { error: '이미 존재하는 아이디입니다' };
  const pw_hash = await bcrypt.hash(m.password, 10);
  await rtdb.ref('users/' + m.user_id).set({
    user_id: m.user_id, nickname: nc.text, pw_hash,
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
  return { ok: true, token, user: safe, is_admin: ADMIN_IDS.has(u.user_id) };
}

// ============================================================
// save — 서버가 변화량 검증 (급증 차단), 진짜 값 반환 → 클라 동기화
// ============================================================
const LIM = { GOLD_PS: 200, GOLD_BUF: 10000, XP_PS: 300, XP_BUF: 10000, LV_JUMP: 2, ITEM_CAP: 1000, SLOTS: 220 };
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
  let tid = safeStr(target, 24);
  let tu = await getUser(tid);
  if (!tu) {                                                  // user_id로 못 찾으면 닉네임으로 검색
    const snap = await rtdb.ref('users').get();
    const val = snap.exists() ? snap.val() : {};
    for (const k in val) { if ((val[k] && val[k].nickname) === target) { tid = k; tu = val[k]; break; } }
  }
  if (!tu) return { error: '대상 없음' };
  if (kind === 'gold') {
    const amt = clampNum(value, -1e9, 1e9, 0);
    tu.gold = Math.max(0, Math.min(1e9, (tu.gold || 0) + amt));
    await setUser(tid, { gold: tu.gold });
    pushToUser(tid, { t: 'relay', event: 'admin_give', payload: { target: tid, gift: { gold: amt }, giftId: 'srv' + Date.now() } });
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
    pushToUser(tid, { t: 'relay', event: 'admin_give', payload: { target: tid, gift: { itemId: id, count: n }, giftId: 'srv' + Date.now() } });
    return { ok: true, target: tid, item: id, count: n };
  }
  return { error: 'bad_kind' };
}
// 특정 유저(접속 중)에게 직접 메시지 푸시 — 온라인이면 선물 즉시 적용
function pushToUser(uid, obj) {
  const out = JSON.stringify(obj);
  for (const [ws, s] of SESSION) { if (s && s.user_id === uid && ws.readyState === 1) { try { ws.send(out); } catch (e) {} } }
}
// 아이템 검색 (관리자 지급 UI용)
function adminSearchItems(q) {
  q = String(q || '').toLowerCase();
  const out = [];
  for (const id of RULES.ITEM_IDS) { if (!q || id.toLowerCase().includes(q)) out.push(id); if (out.length >= 40) break; }
  return out;
}
// 전체 유저 목록 (관리자 전용) — users가 잠겨있어 클라가 직접 못 읽으므로 서버가 대신 반환
async function actAdminList() {
  const snap = await rtdb.ref('users').get();
  const val = snap.exists() ? snap.val() : {};
  const users = [];
  for (const uid in val) {
    const u = val[uid] || {};
    users.push({ user_id: uid, nickname: u.nickname || uid, level: u.level || 1, gold: u.gold || 0, kills: u.kills || 0, last_login: u.last_login || '', banned: !!u.banned });
    if (users.length >= 500) break;
  }
  return { ok: true, users };
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

async function actKill(uid, mob, boss) {
  if (!rateOk(uid, 'kill', 120, 3000)) return { error: 'rate' };   // 3초에 120키 상한 (AOE/콤보 여유). 초과시만 차단
  // 🔐 골드 금액은 서버가 결정 (클라는 몽 종류만 보냄)
  let g = boss ? (50 + Math.floor(Math.random() * 100))
               : ((KILL_GOLD[mob] != null ? KILL_GOLD[mob] : KILL_GOLD._default) + Math.floor(Math.random() * 4));
  const xp = Math.max(2, Math.round(g * 1.3));
  // 동시 처치 경합 방지: 트랜잭션으로 골드 증가
  let newGold = 0;
  await rtdb.ref('users/' + uid + '/gold').transaction(cur => { newGold = Math.min(1e9, (cur || 0) + g); return newGold; });
  let newXp = 0;
  await rtdb.ref('users/' + uid + '/xp').transaction(cur => { newXp = (cur || 0) + xp; return newXp; });
  await rtdb.ref('users/' + uid + '/kills').transaction(cur => (cur || 0) + 1);
  return { ok: true, gold: newGold, xp: newXp, gained: g };
}
// 🔐 서버 권위 제작: 서버 DB의 인벤토리에 재료가 실제로 있는지 확인 → 소비 → 결과 지급 (조작 불가)
async function actCraft(uid, result) {
  if (!rateOk(uid, 'craft', 30, 5000)) return { error: 'rate' };
  result = safeStr(result, 32);
  const recipe = RULES.RECIPE_BY_RESULT[result];
  if (!recipe) return { error: 'bad_recipe' };
  const u = await getUser(uid); if (!u) return { error: 'no_user' };
  const inv = parseInv(u.inventory);
  const map = {}; for (const s of inv) map[s.id] = s;
  // 재료 보유 확인
  for (const [mid, cnt] of Object.entries(recipe.ing || {})) {
    if (!map[mid] || map[mid].count < cnt) return { error: 'no_mat' };
  }
  // 재료 소비
  for (const [mid, cnt] of Object.entries(recipe.ing || {})) map[mid].count -= cnt;
  const out = inv.filter(s => s.count > 0);
  // 결과물 지급
  const ex = out.find(s => s.id === result);
  if (ex) ex.count = Math.min(99999, ex.count + (recipe.amount || 1));
  else out.push({ id: result, count: recipe.amount || 1 });
  await setUser(uid, { inventory: JSON.stringify(out) });
  return { ok: true, inventory: JSON.stringify(out) };
}
// 🔐 서버 권위 소비(음식/포션): 서버 DB에 아이템이 실제로 있는지 확인 후 소비 (무한 포션 차단)
async function actConsume(uid, id, count) {
  id = safeStr(id, 32); count = Math.max(1, Math.min(99, Math.floor(Number(count) || 1)));
  const u = await getUser(uid); if (!u) return { error: 'no_user' };
  const inv = parseInv(u.inventory);
  const slot = inv.find(s => s.id === id);
  if (!slot || slot.count < count) return { error: 'no_item' };   // 안 가지고 있으면 거부
  slot.count -= count; if (slot.count <= 0) inv.splice(inv.indexOf(slot), 1);
  await setUser(uid, { inventory: JSON.stringify(inv) });
  return { ok: true, inventory: JSON.stringify(inv) };
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

  // 👑 관리자는 검증 면제 (관리자 선물·테스트 자유) — 그외 유저만 상한 적용
  const isAdmin = ADMIN_IDS.has(uid);
  // 🔒 골드: 감소(소비) 허용, 증가는 속도 상한 (관리자 면제)
  const reqGold = clampNum(d.gold, 0, 1e9, u.gold);
  const goldCap = (u.gold || 0) + LIM.GOLD_PS * elapsed + LIM.GOLD_BUF;
  set.gold = (isAdmin || reqGold <= goldCap) ? reqGold : u.gold;
  if (!isAdmin && reqGold > goldCap) console.warn(`⚠️ ${uid} 골드 급증 차단 ${u.gold}→${reqGold}`);
  // 🔒 XP
  const reqXp = clampNum(d.xp, 0, 1e9, u.xp);
  const xpCap = (u.xp || 0) + LIM.XP_PS * elapsed + LIM.XP_BUF;
  set.xp = (isAdmin || reqXp <= xpCap) ? reqXp : u.xp;
  // 🔒 레벨: 1회 저장에 +2까지 (관리자 면제)
  const reqLv = clampNum(d.level, 1, 999, u.level);
  set.level = (isAdmin || reqLv <= (u.level || 1) + 2) ? reqLv : (u.level || 1);
  // 🔒 킬: 1회 +300 이내
  const reqK = clampNum(d.kills, 0, 1e8, u.kills || 0);
  set.kills = reqK > (u.kills || 0) + 300 ? (u.kills || 0) : reqK;
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
// 상자 쓰기/삭제 (구조 검증 + 레이트) — admin SDK로 Firebase에 써서 다른 클라가 읽게
async function actChest(uid, wid, chest) {
  if (!rateOk(uid, 'chest', 30, 5000)) return;
  if (!chest || typeof chest.id !== 'string') return;
  const w = safeStr(wid, 40) || 'main';
  const items = Array.isArray(chest.items) ? chest.items.slice(0, 60).filter(it => it && RULES.ITEM_IDS.has(it.id)).map(it => ({ id: it.id, count: Math.max(1, Math.min(99999, Math.floor(Number(it.count) || 1))) })) : [];
  await rtdb.ref(`chests/${w}/${safeStr(chest.id, 60)}`).set({
    id: safeStr(chest.id, 60), type: safeStr(chest.type, 24), ownerName: safeStr(chest.ownerName, 24),
    tx: Math.floor(Number(chest.tx) || 0), ty: Math.floor(Number(chest.ty) || 0), items
  });
}
async function actChestDelete(uid, wid, id) {
  if (!rateOk(uid, 'chestdel', 30, 5000)) return;
  await rtdb.ref(`chests/${safeStr(wid, 40) || 'main'}/${safeStr(id, 60)}`).remove();
}
async function actCorpse(uid, wid, corpse) {
  if (!rateOk(uid, 'corpse', 30, 5000)) return;
  if (!corpse || typeof corpse.id !== 'string') return;
  const w = safeStr(wid, 40) || 'main';
  const items = Array.isArray(corpse.items) ? corpse.items.slice(0, 60).filter(it => it && RULES.ITEM_IDS.has(it.id)).map(it => ({ id: it.id, count: Math.max(1, Math.min(99999, Math.floor(Number(it.count) || 1))) })) : [];
  await rtdb.ref(`corpses/${w}/${safeStr(corpse.id, 60)}`).set({
    id: safeStr(corpse.id, 60), ownerName: safeStr(corpse.ownerName, 24),
    x: Math.floor(Number(corpse.x) || 0), y: Math.floor(Number(corpse.y) || 0),
    spawnedAt: Number(corpse.spawnedAt) || Date.now(), items
  });
}
async function actCorpseDelete(uid, wid, id) {
  if (!rateOk(uid, 'corpsedel', 30, 5000)) return;
  await rtdb.ref(`corpses/${safeStr(wid, 40) || 'main'}/${safeStr(id, 60)}`).remove();
}

// ============================================================
// HTTP + WebSocket
// ============================================================
const app = express();
app.disable('x-powered-by');   // 🔒 Express 명시 숨김 (정보 노출 차단)

// 🔒 보안 헤더 일괄 적용 (CSP / 클릭잭킹 / HSTS / MIME / 정보노출)
app.use((req, res, next) => {
  // 클릭잭킹 방지 (iframe 삽입 차단)
  res.setHeader('X-Frame-Options', 'DENY');
  // MIME 스니핑 차단
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // 레퍼러 정보 최소화
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // 불필요한 브라우저 기능 차단
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  // HSTS — HTTPS 강제 (1년, 서브도메인 포함). HTTPS 요청에만 의미있음
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  // CSP — 게임이 인라인 스크립트/이벤트를 쓰므로 unsafe-inline 허용하되, 출처는 제한
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.gstatic.com https://cdn.jsdelivr.net https://unpkg.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com data:; " +
    "img-src 'self' data: blob:; " +
    "media-src 'self' data: blob:; " +
    "connect-src 'self' ws: wss: https://*.firebaseio.com https://*.googleapis.com https://api.groq.com https://*.onrender.com https://*.supabase.co; " +
    "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");
  next();
});

// 🔒 서버 에러는 상세 경로/스택을 클라에 노출하지 않음 (Information Disclosure - Full Path)

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
// 🔐 긴급 저장(beacon): 페이지 닫을 때 sendBeacon으로 호출. handleSave 검증을 그대로 거침 (직접 PATCH 우회 제거)
app.post('/save', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const uid = tokenUser(b.token);
    if (!uid) return res.json({ error: 'unauthorized' });
    if (!rateOk(uid, 'beacon', 6, 5000)) return res.json({ error: 'rate' });
    const r = await handleSave(uid, b.data || {});
    return res.json(r);
  } catch (e) { return res.json({ error: 'server_error' }); }
});
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
// 🔒 전역 에러 핸들러: 스택·풀패스를 클라에 노출하지 않음
app.use((err, req, res, next) => { console.error('http_err', err && err.message); if (res.headersSent) return next(err); res.status(500).json({ error: 'server_error' }); });
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
        case 'load': { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); const usr = await getUser(u); if (!usr) return reply({ error: 'no_user' }); const { pw_hash, ...safe } = usr; return reply({ ok: true, user: safe, is_admin: ADMIN_IDS.has(u) }); }
        case 'kill': { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); return reply(await actKill(u, safeStr(m.mob, 32), !!m.boss)); }
        case 'sell': { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); return reply(await actSell(u, m.id, m.count)); }
        case 'buy': { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); return reply(await actBuy(u, m.id, m.count)); }
        case 'craft': { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); return reply(await actCraft(u, m.result)); }
        case 'consume': { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); return reply(await actConsume(u, m.id, m.count)); }
        case 'tile': { const u = auth(); if (!u) return; await actTile(u, m.wid, m.changes); relay(ws, 'tile_changes', { changes: m.changes }); return; }
        case 'chest_set': { const u = auth(); if (!u) return; await actChest(u, m.wid, m.chest); return; }
        case 'chest_del': { const u = auth(); if (!u) return; await actChestDelete(u, m.wid, m.id); return; }
        case 'corpse_set': { const u = auth(); if (!u) return; await actCorpse(u, m.wid, m.corpse); return; }
        case 'corpse_del': { const u = auth(); if (!u) return; await actCorpseDelete(u, m.wid, m.id); return; }
        case 'join': { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); sess.user_id = u; joinRoom(ws, safeStr(m.room, 40) || 'official'); return reply({ ok: true }); }
        case 'broadcast': {
          if (!sess.user_id) return;
          const uid = sess.user_id;
          // 🚫 채팅 이벤트만 검열 (다른 broadcast는 시스템 이벤트라 통과)
          if (m.event === 'chat' && m.payload && typeof m.payload.text === 'string') {
            if (!rateOk(uid, 'chat', 6, 5000)) return;                 // 5초 6회 상한
            const c = serverCensor(m.payload.text, 200);
            if (c.blocked) {
              await warnUser(uid, c.reason).catch(() => {});
              return reply({ error: 'censored', reason: c.reason });
            }
            m.payload.text = c.text;
          }
          relay(ws, safeStr(m.event, 40), m.payload);
          return;
        }
        case 'report': {
          const u = auth(); if (!u) return reply({ error: 'unauthorized' });
          if (!rateOk(u, 'report', 5, 60000)) return reply({ error: 'rate' });   // 1분 5건
          const target = safeStr(m.target, 24);
          const reason = safeStr(m.reason, 500);
          if (!target || reason.length < 3) return reply({ error: 'bad_input' });
          const key = 'r' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
          await rtdb.ref('reports/' + key).set({
            target, reason, reporter: u, reporter_nick: safeStr(m.reporter_nick, 24),
            at: Date.now(), at_iso: new Date().toISOString(),
            ua: safeStr(m.ua, 200), handled: false
          });
          console.log(`📨 신고 접수: ${u} → ${target} (${reason.slice(0, 40)})`);
          return reply({ ok: true });
        }
        case 'admin_give': { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); return reply(await actAdminGive(u, m.target, m.kind, m.value, m.count)); }
        case 'admin_search': { const u = auth(); if (!u || !ADMIN_IDS.has(u)) return reply({ error: 'unauthorized' }); return reply({ ok: true, items: adminSearchItems(m.q) }); }
        case 'admin_reports': {
          const u = auth();
          if (!u || !ADMIN_IDS.has(u)) return reply({ error: 'unauthorized' });
          const snap = await rtdb.ref('reports').orderByChild('at').limitToLast(100).get();
          const val = snap.exists() ? snap.val() : {};
          const list = [];
          for (const k in val) { list.push({ id: k, ...val[k] }); }
          list.sort((a, b) => (b.at || 0) - (a.at || 0));
          return reply({ ok: true, reports: list });
        }
        case 'admin_report_handle': {
          const u = auth();
          if (!u || !ADMIN_IDS.has(u)) return reply({ error: 'unauthorized' });
          const id = safeStr(m.id, 60);
          if (!id) return reply({ error: 'bad_id' });
          await rtdb.ref('reports/' + id + '/handled').set(true);
          await rtdb.ref('reports/' + id + '/handled_at').set(Date.now());
          await rtdb.ref('reports/' + id + '/handled_by').set(u);
          return reply({ ok: true });
        }
        case 'season_reset': { const u = auth(); if (!u) return reply({ error: 'unauthorized' }); return reply(await actSeasonReset(u)); }
        default: return;
      }
    } catch (e) { console.error('handler', e); return reply({ error: 'server_error' }); }
  });
  ws.on('close', () => { leaveRoom(ws); SESSION.delete(ws); });
});

server.listen(PORT, () => console.log(`🚀 서버 실행 :${PORT} (Firebase 영구저장 + 검증)`));
