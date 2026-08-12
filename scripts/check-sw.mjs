// check-sw.mjs — 서비스워커 안전 계약 게이트.
//
// 서비스워커는 **네트워크 앞에 서는 코드**다. 여기서 실수하면 사용자가 다치는 방식이 다른
// 결함과 다르다 — 앱을 고쳐 배포해도 낡은 워커가 계속 옛 화면을 내주면, 고침 자체가 닿지 않는다.
// 그래서 이 게이트는 "동작하는가"가 아니라 **"위험한 짓을 안 하는가"**를 본다.
//
// 계약(정본: public/sw.js 머리주석):
//   ① 교차 출처를 캐시하지 않는다 — 서버 응답을 캐시에 가두면 **다른 기기에서 고친 기억이
//      안 보인다**(비타협 원칙 #1의 반대편). R2 서명 URL을 캐시하면 만료 링크를 계속 내준다.
//   ② GET이 아닌 요청에 손대지 않는다 — 기억을 바꾸는 요청의 재생·중복은 재앙이다.
//   ③ 캐시 이름이 버전을 갖고, activate에서 옛 캐시를 지운다(무한 증식 차단).
//   ④ 등록 코드가 실제로 있다 — M-0015의 근본형("만들어 놓고 안 부름")이 여기서도 가능하다.
//
// ①의 호스트 목록은 손으로 적지 않는다: `check-csp.mjs`의 connect-src가 이 앱이 말을 거는
// 외부 호스트의 SSOT다. 새 외부 의존이 생기면 거기 추가되고, 이 게이트가 자동으로 따라온다.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SW = join(ROOT, 'public/sw.js');
const MAIN = join(ROOT, 'src/main.ts');

/**
 * **주석만** 걷어낸 코드. 문자열은 남긴다 — 여기서 찾는 증거(호스트 이름·'GET')가 바로
 * 문자열 리터럴이기 때문이다. 문자열까지 지웠다가 호스트 검사가 통째로 공허해지는 것을
 * 자체검사가 잡았다(이 게이트를 만들며 실제로 낸 실수).
 * 오탐의 원인은 문자열이 아니라 **규칙을 서술하는 머리주석**이므로 그쪽만 지운다.
 */
export function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1 ');
}

// ── 비공허 자체검사(§4) ─────────────────────────────────────────────────────
// 🔴 왜 `codeOnly`부터 재나: 오늘 하루에 **주석을 코드로 센 결함이 세 번** 나왔다
//    (check-edge-cors · check-gate-control 두 번). 같은 함정이 여기에도 있다 —
//    sw.js는 계약을 주석으로 설명하는 파일이라, 주석을 안 지우면 **설명이 곧 위반**이 된다.
{
  const cases = [
    ['블록 주석을 지운다', () => !codeOnly('/* skipWaiting() 금지 */').includes('skipWaiting')],
    ['줄 주석을 지운다', () => !codeOnly('// self.skipWaiting();').includes('skipWaiting')],
    ['🔴 URL의 //는 주석이 아니다(오탐 금지)', () => codeOnly("const u = 'https://x.io/a';").includes('https://x.io/a')],
    ['진짜 코드는 남긴다', () => codeOnly('self.skipWaiting();').includes('skipWaiting')],
    ['주석 뒤 같은 줄의 코드는 이미 지나갔으므로 앞부분은 남는다', () => codeOnly('a(); // b()').includes('a()')],
  ];
  const broken = cases.filter(([, fn]) => !fn());
  if (broken.length) {
    console.error(`check-sw: 셀프테스트 실패 — 게이트가 공허하다(§4): ${broken.map((c) => c[0]).join(', ')}`);
    process.exit(2);
  }
}

/** sw.js 코드가 지켜야 할 계약 위반 목록(순수 — 자체검사가 직접 부른다). */
export function swViolations(source, externalHosts) {
  const code = codeOnly(source);
  const bad = [];

  // ① 교차 출처 가드: 출처가 다르면 손대지 않고 빠져나가야 한다.
  if (!/url\.origin\s*!==\s*self\.location\.origin/.test(code)) {
    bad.push('교차 출처 가드가 없습니다 — `url.origin !== self.location.origin`이면 즉시 return 해야 합니다.');
  }
  // 외부 호스트를 코드가 직접 언급하면(주석 아님) 그건 캐시하려는 시도다.
  for (const host of externalHosts) {
    const bare = host.replace(/^https?:\/\//, '').replace(/^\*\./, '').replace(/\*/g, '');
    if (bare && code.includes(bare)) {
      bad.push(`외부 호스트를 코드에서 다룹니다: ${host} — 서버 응답은 캐시가 판단할 일이 아닙니다.`);
    }
  }
  // ② GET 외 요청 차단
  if (!/method\s*!==\s*'GET'/.test(code)) {
    bad.push("GET 외 요청을 걸러내지 않습니다 — `req.method !== 'GET'`이면 return 해야 합니다.");
  }
  // ③ 버전 있는 캐시 이름 + 옛 캐시 삭제
  if (!/const\s+CACHE\s*=/.test(code)) bad.push('캐시 이름 상수(CACHE)가 없습니다.');
  if (!/v\d+/.test(code.match(/const\s+CACHE\s*=\s*'([^']+)'/)?.[1] ?? '')) {
    bad.push("캐시 이름에 형식 버전이 없습니다(예: 'journey-shell-v1') — 규칙을 바꿔도 옛 캐시가 안 지워집니다.");
  }
  if (!/caches\.delete/.test(code)) bad.push('옛 캐시를 지우는 코드가 없습니다(activate에서 caches.delete).');
  // 릴리스마다 캐시를 비우면 워커의 존재 이유가 사라진다 — 앱 버전을 캐시 이름에 넣지 않는다.
  if (/APP_VERSION|appVersion/.test(code)) {
    bad.push('캐시 이름에 앱 버전을 엮었습니다 — 릴리스마다 전부 다시 받게 되어 캐시가 무의미해집니다.');
  }
  // 지연 청크가 있는 앱에서 skipWaiting은 세션 도중 자산을 갈아치운다.
  if (/skipWaiting/.test(code)) {
    bad.push('skipWaiting을 씁니다 — 지연 로드 청크가 있어 세션 도중 교체는 옛 청크 404를 만듭니다.');
  }
  return bad;
}

/** 등록 코드가 실제로 있는가(M-0015: 만들어 놓고 안 부름). */
export function registrationViolations(mainSource) {
  const code = codeOnly(mainSource);
  const bad = [];
  if (!/serviceWorker\s*\.\s*register\s*\(/.test(code)) {
    bad.push('src/main.ts에 serviceWorker.register 호출이 없습니다 — 워커 파일만 있고 아무도 부르지 않습니다.');
  }
  if (!/import\.meta\.env\.PROD/.test(code)) {
    bad.push('등록이 PROD로 제한되지 않았습니다 — 개발 서버에서 캐시가 HMR을 가립니다.');
  }
  if (!/BASE_URL/.test(code)) {
    bad.push('등록 경로가 BASE_URL에서 파생되지 않았습니다 — 하위경로 배포(GitHub Pages)에서 404가 됩니다.');
  }
  return bad;
}

/** check-csp.mjs의 connect-src를 외부 호스트 SSOT로 읽는다(손으로 적지 않는다). */
function externalHostsFromCsp() {
  const src = readFileSync(join(ROOT, 'scripts/check-csp.mjs'), 'utf8');
  const block = src.match(/'connect-src':\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((h) => h.startsWith('http') || h.startsWith('wss'));
}

// ── 비공허 자체검사: 알려진 실패를 주입해 잡히는지 먼저 증명한다(§4) ──
//
// 기준(good)은 **인라인 표본**이지 살아 있는 sw.js가 아니다. 처음엔 실제 파일을 기준으로 삼았는데,
// 그러면 누가 sw.js에 결함을 넣는 순간 게이트가 "정상을 위반으로 봄(SELF-TEST 실패)"이라고
// **엉뚱한 진단**을 내놓는다 — 진짜 위반을 가린다. 자체검사는 자기 표본으로만 자기를 검사한다.
const GOOD_SAMPLE = [
  "const CACHE = 'shell-v1';",
  "self.addEventListener('activate', (e) => { caches.delete('old'); });",
  "self.addEventListener('fetch', (event) => {",
  "  const req = event.request;",
  "  if (req.method !== 'GET') return;",
  "  const url = new URL(req.url);",
  "  if (url.origin !== self.location.origin) return;",
  "});",
].join('\n');

const GOOD_MAIN = [
  "if (import.meta.env.PROD && 'serviceWorker' in navigator) {",
  "  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);",
  '}',
].join('\n');

(() => {
  const hosts = externalHostsFromCsp();
  if (hosts.length === 0) throw new Error('SELF-TEST 실패: CSP에서 외부 호스트를 하나도 못 읽음(대조가 공허해짐).');

  const clean = (src) => swViolations(src, hosts);
  if (clean(GOOD_SAMPLE).length !== 0) throw new Error(`SELF-TEST 실패: 정상 표본을 위반으로 봄(${clean(GOOD_SAMPLE)}).`);

  const cases = [
    ['교차 출처 가드 제거', GOOD_SAMPLE.replace(/url\.origin !== self\.location\.origin/, 'false')],
    ['외부 호스트를 코드에서 다룸', `const H = 'x.supabase.co';\n${GOOD_SAMPLE}`],
    ['GET 필터 제거', GOOD_SAMPLE.replace(/if \(req\.method !== 'GET'\) return;/, '')],
    ['캐시 이름에 버전 없음', GOOD_SAMPLE.replace("'shell-v1'", "'shell'")],
    ['옛 캐시 삭제 없음', GOOD_SAMPLE.replace(/caches\.delete\('old'\);/, '')],
    ['앱 버전을 캐시 이름에 엮음', GOOD_SAMPLE.replace("'shell-v1'", 'APP_VERSION')],
    ['skipWaiting 사용', `${GOOD_SAMPLE}\nself.skipWaiting();`],
  ];
  for (const [label, src] of cases) {
    if (clean(src).length === 0) throw new Error(`SELF-TEST 실패: ${label}을(를) 못 잡음(게이트 공허).`);
  }

  // 머리주석이 호스트를 **서술**하는 것은 위반이 아니다(이 저장소에서 3회 겪은 오탐 형태).
  if (clean(`// Supabase·tile.openstreetmap.org는 손대지 않는다\n${GOOD_SAMPLE}`).length !== 0) {
    throw new Error('SELF-TEST 실패: 주석 속 호스트 언급을 오탐한다.');
  }

  if (registrationViolations(GOOD_MAIN).length !== 0) throw new Error('SELF-TEST 실패: 정상 등록을 위반으로 봄.');
  if (registrationViolations('const x = 1;').length === 0) throw new Error('SELF-TEST 실패: 등록 부재를 못 잡음.');
  if (registrationViolations(GOOD_MAIN.replace('import.meta.env.PROD', 'true')).length === 0) {
    throw new Error('SELF-TEST 실패: PROD 제한 부재를 못 잡음.');
  }
})();

const problems = [];
if (!existsSync(SW)) {
  problems.push('public/sw.js가 없습니다.');
} else {
  problems.push(...swViolations(readFileSync(SW, 'utf8'), externalHostsFromCsp()));
}
problems.push(...registrationViolations(readFileSync(MAIN, 'utf8')));

if (problems.length > 0) {
  console.error('check-sw: 서비스워커 안전 계약 위반.');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('  → 규칙과 이유는 public/sw.js 머리주석에 있습니다.');
  process.exit(1);
}

console.log(`check-sw: OK — 교차 출처 무개입·GET 전용·버전 캐시·등록 확인(외부 호스트 ${externalHostsFromCsp().length}개 대조).`);
