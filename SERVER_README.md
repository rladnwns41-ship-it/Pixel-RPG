# 배포 가이드 — Firebase 영구저장 + s.js 권위 서버

## 구조
```
브라우저 ──WebSocket──▶ s.js (검증·게임로직·실시간) ──Admin SDK──▶ Firebase (영구저장)
```
- **Firebase** = 영구 저장만 (인벤토리·프로필·맵). 클라는 직접 못 씀.
- **s.js** = 유일한 관문. 골드·XP·레벨·아이템을 서버가 소유·검증.
- MongoDB 불필요 — 기존 Firebase 그대로 사용.

## 콜드 스타트
- Render 무료: 15분 무접속 → 첫 접속 30~60초 지연. 유료(starter $7/월): 항상 켜짐.

## 1. Firebase 서비스 계정 키 발급
1. Firebase 콘솔 → ⚙️ 프로젝트 설정 → **서비스 계정** 탭
2. **새 비공개 키 생성** → JSON 다운로드
3. 그 JSON 전체를 **한 줄**로 만들어 Render 환경변수 `FIREBASE_SERVICE_ACCOUNT` 에 붙여넣기
4. `FIREBASE_DB_URL` = Realtime Database URL (예: `https://xxx-default-rtdb.firebaseio.com`)
   - ⚠️ 이 JSON은 **비밀**. GitHub에 절대 올리지 말 것 (`.gitignore`가 `.env` 제외).

## 2. GitHub 구조
```
medieval-realm/
├── admin_panel.html            게임 (s.js가 서빙)
├── s.js                        ★ 권위 서버 (Firebase Admin)
├── server-gamedata.js          ★ 서버 규칙 (212아이템·150제작법·보상)
├── package.json
├── render.yaml
├── .gitignore
├── .env.example
├── firebase-rules-LOCKED.json  클라 쓰기 차단 규칙 (이전 완료 후 적용)
└── SERVER_README.md
```

## 3. Render 배포
1. 위 파일 GitHub push
2. render.com → New → **Web Service** → 저장소 연결
3. Build: `npm install` / Start: `node s.js`
4. Environment 에 `FIREBASE_SERVICE_ACCOUNT`, `FIREBASE_DB_URL` 입력
5. Deploy → `https://<이름>.onrender.com`
6. **코드 바꾸면 git push 만 하면 자동 재배포.**

## 4. s.js가 강제하는 것 (해킹 차단)
| 항목 | 처리 |
|---|---|
| 골드/XP/레벨 | 서버 소유. save는 무시. 레벨은 XP로 서버가 계산 |
| 아이템 획득 | 채굴/제작/구매/판매/처치보상 전부 서버 규칙 검증 |
| 알 수 없는 아이템 | 212개 화이트리스트 밖이면 거부 |
| 봇/스팸 | 액션별 레이트리밋 (채굴 25/3초 등) |
| 비밀번호 | bcrypt 해시, 해시는 클라로 안 보냄 |
| 맵 영구저장 | s.js(Admin)만 Firebase에 씀 |

## 5. ⚠️ 남은 작업 — 클라이언트 연동 (필수)
지금 `admin_panel.html` 은 아직 Firebase에 직접 씁니다. 아래처럼 **s.js 호출로 교체**해야 실제로 잠깁니다:

```js
const ws = new WebSocket(location.origin.replace(/^http/, 'ws'));
let TOKEN = null, _rid = 0; const _p = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data);
  if (m.rid && _p.has(m.rid)) { _p.get(m.rid)(m); _p.delete(m.rid); }
  if (m.t === 'relay') onRemote(m.event, m.payload, m.from); };
const call = (t, o={}) => new Promise(r => { const rid=++_rid; _p.set(rid,r); ws.send(JSON.stringify({t,rid,token:TOKEN,...o})); });

// 로그인: const r = await call('login',{user_id,password}); TOKEN=r.token; // r.user.inventory 사용
// 저장:   await call('save',{data:{x,y,hp,mp,hotbar,equipment,skills,bio}});
// 채굴:   const r = await call('mine',{tile:'iron_ore'});  // r.inventory 로 갱신
// 제작:   const r = await call('craft',{result:'iron_ingot'});
// 처치:   const r = await call('kill',{mob:'wolf'}); player.gold=r.gold;
// 상점:   await call('buy',{id:'sword',count:1}); await call('sell',{id:'wood',count:10});
// 입장:   await call('join',{room:'official'});
// 위치:   ws.send(JSON.stringify({t:'broadcast',token:TOKEN,event:'pos',payload:{x,y}}));
```

교체 순서(단계 권장): 1) 로그인·저장·골드 → 2) 채굴·제작·상점 → 3) 위치·타일 중계.
완료 후 **`firebase-rules-LOCKED.json`** 을 Firebase 규칙에 적용하면 클라 직접 쓰기가 완전히 막힙니다.

원하면 1단계(로그인·저장·골드)부터 클라이언트에 직접 붙여드립니다.
