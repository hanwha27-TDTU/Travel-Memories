// sw.js — 서비스워커. 앱 껍데기(HTML·JS·CSS·폰트)를 캐시해 재방문·오프라인을 빠르게 한다.
//
// 이 파일이 위험한 이유를 먼저 적는다. 서비스워커는 **네트워크 앞에 서는 코드**라, 잘못 만들면
// 되돌리기 어려운 방식으로 사용자를 다치게 한다:
//   · 낡은 앱이 영원히 뜬다(새 배포가 사용자에게 닿지 않음)
//   · 서버 응답이 캐시에 갇혀 **다른 기기에서 고친 기억이 안 보인다**(비타협 원칙 #1의 반대편)
//   · 서명 URL(R2)을 캐시하면 만료된 링크를 계속 내주거나, 남의 눈에 남는다
// 그래서 규칙은 좁고 분명하다. **아래 세 줄이 이 파일의 전부다.**
//
//   ① 교차 출처(cross-origin)는 **손대지 않는다.** Supabase·R2·지도 타일·환율·지오코딩은
//      전부 그대로 네트워크로 간다. 기억의 진실은 서버에 있고, 그건 캐시가 판단할 일이 아니다.
//   ② 해시가 박힌 자산(`/assets/…-a1b2c3d4.js`)만 **캐시 우선**. 내용이 바뀌면 이름이 바뀌므로
//      낡을 수가 없다 — 이게 캐시 우선이 안전한 유일한 이유다.
//   ③ 그 밖의 같은 출처 요청(HTML·manifest·아이콘)은 **네트워크 우선**, 실패할 때만 캐시.
//      HTML이 늘 신선해야 새 배포의 새 자산 이름이 사용자에게 닿는다.
//
// skipWaiting을 **쓰지 않는다**: 화면을 지연 로드 청크로 쪼개 둔 상태(check-lazy-screens)라,
// 세션 도중에 워커를 갈아치우면 열려 있던 탭이 사라진 옛 청크를 요청할 수 있다. 새 배포는
// ③ 덕분에 워커를 갈아끼우지 않아도 도달한다 — 급할 이유가 없다.

// 캐시 **형식** 버전. 앱 버전이 아니다 — 해시 자산은 릴리스가 바뀌어도 그대로 유효하므로
// 릴리스마다 캐시를 비우면 이 워커의 존재 이유가 사라진다. 캐싱 규칙을 바꿀 때만 올린다.
const CACHE = 'journey-shell-v1';

// 자산 캐시 상한(개수). 배포를 거듭하면 사라진 해시 자산이 쌓이는데, 이 앱은 사용자의 사진이
// 같은 저장소 예산을 쓴다 — 껍데기가 기억의 자리를 잠식하면 안 된다. 넘치면 **가장 오래
// 넣은 것부터** 버린다(Cache API의 keys()는 삽입 순서를 지킨다). 버려져도 다시 받으면 그만이다.
const MAX_ENTRIES = 60;

self.addEventListener('install', () => {
  // 미리 받아둘 목록을 두지 않는다: 자산 이름에 해시가 박혀 있어 빌드마다 달라지고,
  // 그 목록을 손으로 유지하면 반드시 낡는다(이 저장소가 여러 번 겪은 형태).
  //
  // 대가는 **한 번의 예열**이다(실측): 첫 방문엔 워커가 아직 제어를 시작하기 전이라
  // 자산이 그냥 네트워크로 가고, 두 번째 방문에서 워커가 받아 캐시에 넣는다.
  //   ① 첫 방문 555KB → ② 두 번째 343KB → ③ 세 번째부터 7.7KB(HTML+워커 파일만)
  // index.html에서 자산 목록을 긁어 미리 받는 방법도 있지만, CSS의 폰트 조각까지 따라가면
  // **안 쓰는 희귀 한글 442KB를 미리 받아** unicode-range로 아낀 것을 되돌린다. 예열 한 번이 싸다.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim(); // 이미 열려 있는 탭도 다음 요청부터 이 워커를 쓴다
    })(),
  );
});

/** 상한을 넘으면 오래된 것부터 버린다. */
async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_ENTRIES; i++) await cache.delete(keys[i]);
}

/** 캐시에 넣어도 되는 응답인가. 부분/오류/불투명 응답을 넣으면 그 뒤로 계속 그걸 내준다. */
function isCacheable(response) {
  return Boolean(response) && response.status === 200 && response.type === 'basic';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // GET이 아니면 손대지 않는다(POST/PATCH는 기억을 바꾸는 요청이다 — 재생·중복은 재앙이다).
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // ① 교차 출처는 통째로 통과시킨다. Supabase·R2·타일·환율·지오코딩이 전부 여기 해당한다.
  if (url.origin !== self.location.origin) return;

  // ② 해시 자산 — 캐시 우선. 이름이 곧 내용의 지문이라 낡을 수 없다.
  if (url.pathname.includes('/assets/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (isCacheable(res)) {
          await cache.put(req, res.clone());
          await trim(cache);
        }
        return res;
      })(),
    );
    return;
  }

  // ③ 그 밖(HTML·manifest·아이콘) — 네트워크 우선, 오프라인일 때만 캐시.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (isCacheable(res)) {
          await cache.put(req, res.clone());
          await trim(cache);
        }
        return res;
      } catch (err) {
        const hit = await cache.match(req);
        if (hit) return hit;
        // 화면 이동인데 캐시에도 없다 = 한 번도 연 적 없는 경로. 앱 껍데기로 되돌린다
        // (라우터가 알 수 없는 경로를 홈으로 안전 폴백하므로 빈 화면이 되지 않는다).
        if (req.mode === 'navigate') {
          const shell = await cache.match(new URL('./', self.location).pathname);
          if (shell) return shell;
        }
        throw err;
      }
    })(),
  );
});
