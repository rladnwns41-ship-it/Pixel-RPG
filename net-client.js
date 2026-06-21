// ============================================================
// net-client.js — s.js(권위 서버) WebSocket 클라이언트
//   s.js가 떠 있으면 로그인/회원가입을 서버 경유로, 없으면 자동 폴백.
//   2단계에서 mine/craft/kill/save도 이 NET.call 로 라우팅합니다.
// ============================================================
(function () {
  const NET = {
    ws: null, ready: false, token: null,
    _rid: 0, _pending: new Map(), _relayHandler: null,
    url: location.origin.replace(/^http/, 'ws'),
  };

  NET.connect = function () {
    return new Promise((resolve) => {
      // file:// 등 비-http 환경이면 시도 안 함 (폴백)
      if (!/^https?:/.test(location.protocol)) { resolve(false); return; }
      let done = false;
      try { NET.ws = new WebSocket(NET.url); }
      catch (e) { resolve(false); return; }
      const t = setTimeout(() => { if (!done) { done = true; resolve(false); } }, 4000);
      NET.ws.onopen = () => { NET.ready = true; if (!done) { done = true; clearTimeout(t); resolve(true); } };
      NET.ws.onerror = () => { NET.ready = false; if (!done) { done = true; clearTimeout(t); resolve(false); } };
      NET.ws.onclose = () => { NET.ready = false; };
      NET.ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch (_) { return; }
        if (m.rid && NET._pending.has(m.rid)) { NET._pending.get(m.rid)(m); NET._pending.delete(m.rid); return; }
        if (m.t === 'relay' && NET._relayHandler) NET._relayHandler(m.event, m.payload, m.from);
      };
    });
  };

  NET.call = function (t, obj) {
    return new Promise((resolve, reject) => {
      if (!NET.ready || !NET.ws || NET.ws.readyState !== 1) { reject(new Error('net_down')); return; }
      const rid = ++NET._rid;
      const to = setTimeout(() => { NET._pending.delete(rid); reject(new Error('timeout')); }, 8000);
      NET._pending.set(rid, (m) => { clearTimeout(to); resolve(m); });
      try { NET.ws.send(JSON.stringify({ t, rid, token: NET.token, ...(obj || {}) })); }
      catch (e) { clearTimeout(to); NET._pending.delete(rid); reject(e); }
    });
  };

  NET.onRelay = function (fn) { NET._relayHandler = fn; };

  window.NET = NET;
})();
