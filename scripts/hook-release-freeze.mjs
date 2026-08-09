// hook-release-freeze.mjs — PreToolUse(Bash): **릴리스 검증이 도는 중에 커밋을 얹는 것**을
// 막는다(헌법 §18-H).
//
// ── 왜 훅인가 ────────────────────────────────────────────────────────────────
// 이 규율은 파일이 아니라 **내가 치는 명령**에서 깨진다. 게이트는 커밋된 파일만 보므로
// 원리적으로 못 잡는다 — 강제는 훅이 한다(헌법 S-09 · `hook-verify-exit`과 같은 자리).
//
// ── 무엇을 막는가 ────────────────────────────────────────────────────────────
// `npm run release:arm` 이후 `git commit`·`push`·`merge`·`rebase` 따위. 조사·읽기는 자유다.
// 정당하게 커밋해야 하면 `npm run release:reopen -- "<이유>"`로 **이유를 적고** 다시 연다.
//
// 🔴 이건 커밋 금지가 아니라 **값을 보이게 만드는 장치**다. `cancel-in-progress` 때문에
// 새 커밋은 돌고 있던 검증을 버리고 처음부터 시작시킨다 — v2.07에서 그렇게 CI가 네 번 돌았고
// 3~4분짜리 검증이 41분이 됐다. 안 보이는 값은 계산되지 않는다.
//
// ── 계약 ─────────────────────────────────────────────────────────────────────
//  · 입력: stdin JSON `{tool_name, tool_input:{command}}`
//  · exit 0 = 통과 · exit 2 = 차단(stderr가 Claude에게 전달된다)
//  · **판정 불가는 통과시킨다** — 훅이 깨져서 모든 커밋이 막히면 그게 더 큰 사고다.

import { blockedBy, readLock, selfTest as judgeSelfTest, EMPTY } from './release-lock.mjs';

/**
 * 훅의 자체검사(§4). **판정의 양성·음성 주입은 `release-lock.mjs`가 갖고 있고** 여기서
 * 다시 세지 않는다 — 같은 사실을 두 곳에서 세면 갈라진다(§2 SSOT). 대신 이 파일만이 아는
 * 것을 못박는다: **훅이 실제로 부르는 경로**(stdin JSON → 명령 문자열 → 판정)가 이어져 있는가.
 */
export function selfTest() {
  judgeSelfTest();
  const armed = { ...EMPTY, armed: true, candidate: 'abc1234', armedAt: Date.now() };
  const parse = (raw) => blockedBy(JSON.parse(raw)?.tool_input?.command, armed, Date.now());
  if (!parse(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }))) {
    throw new Error('SELF-TEST 실패: 훅의 입력 경로가 끊겼다(stdin JSON에서 명령을 못 꺼낸다)');
  }
  if (parse(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } }))) {
    throw new Error('SELF-TEST 실패: 오탐 — 조사 명령을 막았다');
  }
}

selfTest();
if (process.argv.includes('--self-test')) {
  console.log('hook-release-freeze: 자체검사 통과 — 판정기의 양성·음성 주입 + 훅의 stdin 경로가 실제로 돈다.');
  process.exit(0);
}

const isMain = process.argv[1] && process.argv[1].endsWith('hook-release-freeze.mjs');
if (isMain) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;

  let hit = null;
  let state = null;
  try {
    state = readLock();
    hit = blockedBy((JSON.parse(raw) ?? {})?.tool_input?.command, state, Date.now());
  } catch {
    process.exit(0);
  }
  if (!hit) process.exit(0);

  console.error(
    [
      `🔴 릴리스 묶음이 얼려 있습니다 — 후보 ${hit.candidate} (헌법 §18-H).`,
      `   막힌 줄: ${hit.line}`,
      '',
      '   지금 커밋을 얹으면 커밋 하나가 늘어나는 게 아니라, **돌고 있는 검증이 취소되고**',
      '   처음부터 다시 돕니다(`concurrency: cancel-in-progress`). v2.07에서 그렇게',
      '   3~4분짜리 검증이 41분이 됐습니다.',
      '',
      '   둘 중 하나를 고르세요:',
      '     · 배포 확인까지 끝났다  →  npm run release:close',
      '     · 빨간 게이트를 고쳐야 한다(정당합니다)',
      '       →  npm run release:reopen -- "<왜 다시 여는지 10자 이상>"',
      '',
      '   문서·후속과제 같은 급하지 않은 변경은 **배포 확인 뒤**에 따로 올립니다.',
    ].join('\n'),
  );
  process.exit(2);
}
