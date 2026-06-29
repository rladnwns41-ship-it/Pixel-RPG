// ============================================================
// fb-shim.js — 진짜 Firebase 대신 끼우는 "가짜 firebase".
//   게임은 firebase.database().ref(...) 를 그대로 쓰고,
//   여기서 전부 우리 LAN 서버(s.js)의 WebSocket 으로 흘려보낸다.
//   → Firebase / 인터넷 / API키 전혀 필요 없음.
//   링크의 ?world=이름 으로 세계가 분리된다 (서버가 처리).
// ============================================================
(function () {
  'use strict';

  // ── 월드 이름: 현재 페이지 주소의 ?world= 사용 (없으면 main) ──
  const WORLD = (new URLSearchParams(location.search).get('world') || 'main')
    .toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'main';

  // ── 서버로 가는 WebSocket (페이지와 같은 호스트) ──
  const WS_URL = location.origin.replace(/^http/, 'ws') + '/?world=' + WORLD;

  const Sock = {
    ws: null, ready: false, connected: false,
    _rid: 0, _pending: new Map(),
    _subs: new Map(),          // subId -> {onEvt}
    _queue: [],                // 연결 전 보낼 것들
    _connCbs: [],              // .info/connected 리스너
  };

  function connect() {
    if (Sock.ws && (Sock.ws.readyState === 0 || Sock.ws.readyState === 1)) return; // 이미 연결/연결중이면 중복 방지
    if (!/^https?:/.test(location.protocol)) { console.warn('[net] must be opened over http(s), not file://'); return; }
    console.log('[net] connecting to ' + WS_URL);
    let ws;
    try { ws = new WebSocket(WS_URL); } catch (e) { setTimeout(connect, 1500); return; }
    Sock.ws = ws;
    ws.onopen = () => {
      Sock.ready = true; Sock.connected = true;
      console.log('[net] connected (world=' + WORLD + ')');
      // 큐 비우기
      const q = Sock._queue; Sock._queue = [];
      for (const s of q) { try { ws.send(s); } catch (e) {} }
      // .info/connected 리스너에게 true
      Sock._connCbs.forEach(cb => { try { cb(snapshot('connected', true)); } catch (e) {} });
    };
    ws.onclose = () => {
      Sock.ready = false; Sock.connected = false;
      console.warn('[net] disconnected, retrying in 1.5s (is s.js running?)');
      Sock._connCbs.forEach(cb => { try { cb(snapshot('connected', false)); } catch (e) {} });
      setTimeout(connect, 1500);   // 자동 재연결
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.rid != null && Sock._pending.has(m.rid)) {
        Sock._pending.get(m.rid)(m); Sock._pending.delete(m.rid); return;
      }
      if (m.evt === 'config' && m.val) {   // host performance settings
        window.SERVER_CONFIG = m.val;
        console.log('[net] server config: posRateMs=' + m.val.posRateMs + ' idleMs=' + m.val.idleMs + ' timeoutMs=' + m.val.timeoutMs);
        return;
      }
      if (m.evt && m.subId != null) {
        const s = Sock._subs.get(m.subId);
        if (s && s.onEvt) s.onEvt(m);
      }
    };
  }

  function rawSend(obj) {
    const str = JSON.stringify(obj);
    if (Sock.ready && Sock.ws && Sock.ws.readyState === 1) {
      try { Sock.ws.send(str); return; } catch (e) {}
    }
    Sock._queue.push(str);
  }

  // 요청/응답 (rid)
  function call(op, extra) {
    return new Promise((resolve) => {
      const rid = ++Sock._rid;
      const to = setTimeout(() => { Sock._pending.delete(rid); resolve({ ok: false, error: 'timeout' }); }, 12000);
      Sock._pending.set(rid, (m) => { clearTimeout(to); resolve(m); });
      rawSend(Object.assign({ op, rid }, extra));
    });
  }

  // ── 스냅샷 객체 (Firebase snapshot 흉내) ──
  function snapshot(key, val) {
    return {
      key: key,
      val: () => (val === undefined ? null : val),
      exists: () => val !== null && val !== undefined,
      numChildren: () => (val && typeof val === 'object') ? Object.keys(val).length : 0,
      hasChildren: () => (val && typeof val === 'object') && Object.keys(val).length > 0,
      child: (k) => snapshot(k, (val && typeof val === 'object') ? val[k] : null),
      forEach: (cb) => {
        if (val && typeof val === 'object') {
          for (const k of Object.keys(val)) { if (cb(snapshot(k, val[k]))) return true; }
        }
        return false;
      },
    };
  }

  // ── 쿼리 필터 적용 (orderByChild/equalTo/startAt/endAt/limitToFirst/limitToLast) ──
  function applyQuery(val, q) {
    if (!val || typeof val !== 'object' || !q) return val;
    let entries = Object.keys(val).map(k => [k, val[k]]);
    const field = q.order;
    const keyOf = (v) => (field === '$key') ? null : (v && typeof v === 'object' ? v[field] : undefined);
    if (field) entries.sort((a, b) => {
      const va = (field === '$key') ? a[0] : keyOf(a[1]);
      const vb = (field === '$key') ? b[0] : keyOf(b[1]);
      return (va > vb) - (va < vb);
    });
    if (q.hasEqual) entries = entries.filter(([k, v]) => ((field === '$key') ? k : keyOf(v)) === q.equalTo);
    if (q.hasStart) entries = entries.filter(([k, v]) => ((field === '$key') ? k : keyOf(v)) >= q.startAt);
    if (q.hasEnd) entries = entries.filter(([k, v]) => ((field === '$key') ? k : keyOf(v)) <= q.endAt);
    if (q.limitFirst != null) entries = entries.slice(0, q.limitFirst);
    if (q.limitLast != null) entries = entries.slice(-q.limitLast);
    if (entries.length === 0) return null;   // 쿼리 결과 없음 = Firebase 처럼 null (exists()=false)
    const out = {}; for (const [k, v] of entries) out[k] = v;
    return out;
  }

  // ── Ref / Query ──
  function makeRef(pathArr, query) {
    const pathStr = pathArr.join('/');
    const isInfoConnected = (pathStr === '.info/connected');

    const ref = {
      key: pathArr.length ? pathArr[pathArr.length - 1] : null,
      _path: pathStr,

      child(sub) { return makeRef(pathArr.concat(String(sub).split('/').filter(Boolean)), null); },

      // 쿼리 빌더 (체이닝)
      orderByChild(f) { return makeRef(pathArr, Object.assign({}, query, { order: f })); },
      orderByKey() { return makeRef(pathArr, Object.assign({}, query, { order: '$key' })); },
      equalTo(v) { return makeRef(pathArr, Object.assign({}, query, { hasEqual: true, equalTo: v })); },
      startAt(v) { return makeRef(pathArr, Object.assign({}, query, { hasStart: true, startAt: v })); },
      endAt(v) { return makeRef(pathArr, Object.assign({}, query, { hasEnd: true, endAt: v })); },
      limitToFirst(n) { return makeRef(pathArr, Object.assign({}, query, { limitFirst: n })); },
      limitToLast(n) { return makeRef(pathArr, Object.assign({}, query, { limitLast: n })); },

      async set(val) { await call('set', { path: pathStr, val }); return; },
      async update(val) { await call('update', { path: pathStr, val }); return; },
      async remove() { await call('remove', { path: pathStr }); return; },

      async get() {
        const r = await call('get', { path: pathStr });
        return snapshot(ref.key, applyQuery(r && r.val, query));
      },

      // once('value'[, cb]) — Promise 도 되고 콜백도 됨
      once(eventType, cb) {
        if (isInfoConnected) {
          const snap = snapshot('connected', Sock.connected);
          if (cb) cb(snap); return Promise.resolve(snap);
        }
        const p = call('get', { path: pathStr }).then(r => {
          const snap = snapshot(ref.key, applyQuery(r && r.val, query));
          if (cb) cb(snap);
          return snap;
        });
        return p;
      },

      // on('value'|'child_added'|'child_changed'|'child_removed', cb)
      on(eventType, cb) {
        if (isInfoConnected && eventType === 'value') {
          Sock._connCbs.push(cb);
          cb(snapshot('connected', Sock.connected));
          return cb;
        }
        const subId = 's' + (++Sock._rid);
        const child = (eventType !== 'value');
        Sock._subs.set(subId, {
          onEvt: (m) => {
            if (eventType === 'value') { cb(snapshot(ref.key, m.val)); return; }
            // child_* : 요청한 이벤트 종류만 (단, child_changed 핸들러가 added 도 받게 게임이 둘 다 등록함)
            if (m.evt === eventType) cb(snapshot(m.key, m.val));
          }
        });
        cb.__subId = (cb.__subId || []); cb.__subId.push(subId);
        rawSend({ op: 'sub', subId, path: pathStr, child });
        // value 구독이면 현재값 한번 보내줌
        if (eventType === 'value') {
          call('get', { path: pathStr }).then(r => cb(snapshot(ref.key, applyQuery(r && r.val, query))));
        }
        return cb;
      },

      off(eventType, cb) {
        if (cb && cb.__subId) {
          for (const subId of cb.__subId) {
            Sock._subs.delete(subId);
            rawSend({ op: 'unsub', subId });
          }
          cb.__subId = [];
        } else if (isInfoConnected) {
          Sock._connCbs = [];
        }
      },

      // 일부 코드가 push 쓸 수도 있어 대비 (랜덤 키 생성)
      push(val) {
        const k = 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const c = makeRef(pathArr.concat(k), null);
        const pr = (val !== undefined) ? c.set(val) : Promise.resolve();
        return Object.assign(c, { then: pr.then.bind(pr) });
      },
    };
    return ref;
  }

  // ── firebase 전역 ──
  const ServerValue = { TIMESTAMP: { __ts__: true } };

  const database = function () {
    return {
      ref(p) { return makeRef(String(p == null ? '' : p).split('/').filter(s => s.length), null); },
      goOnline() {}, goOffline() {},
    };
  };
  database.ServerValue = ServerValue;

  const firebase = {
    initializeApp() { connect(); return {}; },
    database,
    apps: [],
  };

  window.firebase = firebase;
  // 페이지가 바로 ref 를 쓸 수 있게 연결 시작
  connect();
})();
