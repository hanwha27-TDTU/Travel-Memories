// hook-secret-guard.mjs — PreToolUse(Write|Edit): 자격증명 형태가 **파일에 쓰이기 전에** 막는다.
//
// 왜 게이트만으로 부족한가(헌법 S-09): `check-secret-leak`은 커밋·배포 전에 잡는다.
// 그건 최후 방어선이지 첫 방어선이 아니다 — 그 사이에 키가 디스크에 앉아 있고,
// 작업 디렉터리를 훑는 다른 도구·로그·스크린샷에 새어 나갈 수 있다. 훅은 **쓰기 자체**를 막는다.
//
// 탐지 로직은 `lib/secret-patterns.mjs` 한 곳이 정본이다(게이트와 같은 판정 · §7).
// 여기서는 **훅 입력을 어떻게 읽고 무엇을 차단하는가**만 정한다.
//
// 계약:
//  · 입력: stdin JSON `{tool_name, tool_input:{file_path, content?, new_string?}}`
//  · exit 0 = 통과 · exit 2 = 차단(stderr가 Claude에게 전달된다)
//  · **판정 불가는 통과시킨다** — 훅이 깨져서 모든 편집이 막히면 그게 더 큰 사고다
//    (§2-D 「돌지 못하는 게이트는 없는 게이트보다 나쁘다」의 훅판). 대신 게이트가 뒤에 있다.
//  · 예외: `docs/`는 계약 문서라 차단 대상 "형태"를 서술해야 한다(게이트와 같은 제외 사유).

import { scanText, fakeJwt } from './lib/secret-patterns.mjs';

const SKIP_PREFIX = ['docs/'];

/** 훅 입력에서 「이번에 쓰이는 텍스트」를 모은다. Write=content, Edit=new_string. */
export function writtenText(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const parts = [];
  for (const k of ['content', 'new_string']) {
    if (typeof toolInput[k] === 'string') parts.push(toolInput[k]);
  }
  return parts.join('\n');
}

/** 이 경로가 검사 대상인가(docs/는 제외 — 계약 문서는 형태를 서술한다). */
export function isGuardedPath(filePath) {
  if (typeof filePath !== 'string' || !filePath) return true; // 경로를 모르면 검사한다(보수적)
  const rel = filePath.replace(/\\/g, '/').replace(/^.*?\/Travel-Memories\//, '');
  return !SKIP_PREFIX.some((s) => rel.startsWith(s));
}

// ── 셀프테스트: 알려진 실패를 주입해 잡히는지 확인한 뒤에만 훅을 신뢰한다(§4) ──
export function selfTest() {
  const bad = fakeJwt('service_role');
  const ok = fakeJwt('anon');
  if (scanText(bad).length === 0) throw new Error('SELF-TEST 실패: service_role JWT를 못 잡는다(훅 공허).');
  if (scanText(ok).length !== 0) throw new Error('SELF-TEST 실패: anon JWT를 오탐한다(오탐도 결함).');
  // 낱말만으로는 막지 않는다 — 계약 문서가 이 낱말을 써야 한다
  if (scanText('service_role 키를 넣지 않는다').length !== 0) {
    throw new Error('SELF-TEST 실패: 낱말 언급을 차단한다(문서를 못 고치게 된다).');
  }
  if (writtenText({ content: 'a', new_string: 'b' }) !== 'a\nb') throw new Error('SELF-TEST 실패: writtenText');
  if (isGuardedPath('docs/SECURITY.md') !== false) throw new Error('SELF-TEST 실패: docs/ 제외');
  if (isGuardedPath('src/app.ts') !== true) throw new Error('SELF-TEST 실패: src 포함');
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  selfTest(); // 공허하면 여기서 throw → catch가 통과시키되 stderr에 남긴다
  const raw = await readStdin();
  const input = JSON.parse(raw);
  const filePath = input?.tool_input?.file_path ?? '';
  if (!isGuardedPath(filePath)) return;
  const findings = scanText(writtenText(input?.tool_input));
  if (findings.length === 0) return;
  const names = [...new Set(findings.map((f) => f.name))].join(', ');
  console.error(
    `🔴 쓰기 차단 — 자격증명 형태가 감지됐습니다: ${names}\n` +
      `  대상: ${filePath}\n` +
      `  헌법 §0: service_role 키·DB 비밀번호·관리자 JWT를 저장소·번들·로그에 넣지 않는다.\n` +
      `  클라이언트는 anon/publishable 키만 씁니다. 값을 환경변수로 옮기거나 예시값으로 바꾸세요.`,
  );
  process.exit(2);
}

// 직접 실행일 때만 stdin을 읽는다(테스트가 import할 수 있게).
if (process.argv[1] && process.argv[1].endsWith('hook-secret-guard.mjs')) {
  main().catch((e) => {
    // 🔴 판정 불가는 통과 — 훅이 깨져 모든 편집이 막히는 것이 더 큰 사고다.
    console.error(`hook-secret-guard: 검사 실패(통과 처리) — ${e instanceof Error ? e.message : String(e)}`);
    process.exit(0);
  });
}
