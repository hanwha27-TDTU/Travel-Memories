// check-gate-promise.mjs — 게이트마다 **개수가 아닌 축**을 선언했는가(약속 원장).
//
// ── 왜 필요한가 ──────────────────────────────────────────────────────────────
// 개수만 세는 게이트는 **「위반 0」과 「아무것도 안 봤다」에 같은 종료코드**를 준다.
// 이건 관념이 아니다 — 2026-08-09에 `check-gate-integrity`가 *"52개 전부 배선+대조군 보유"*
// 라는 초록을 내면서, 모집단 밖에 있던 게이트 셋(하필 **라이브 둘**)을 한 번도 보지 않았다.
// 숫자는 맞았고 뜻이 틀렸다.
//
// 그래서 `GATE_DESC`(무엇을 보는가) 옆에 `GATE_AXIS`(무엇을 **세지 않고** 단언하는가)를 둔다.
//
// ── 문체를 강제하는 이유 ─────────────────────────────────────────────────────
// 축은 「N이 아니라 M」 꼴이어야 한다. 거부하는 개수를 **이름 대게** 만들면, 쓰는 사람이
// 자기 게이트가 무엇에 기대고 있는지 한 번은 마주 본다. 자유 서술로 두면
// "여러 가지를 잘 검사함" 같은 문장이 들어오고 그 순간 원장이 소음이 된다.
//
// ── 래칫 ─────────────────────────────────────────────────────────────────────
// 축이 없는 기존 게이트는 **소급 부채**로 둘 수 있다. 단 부채는 아래 동결 목록의
// **부분집합**이어야 한다 — 이름을 새로 넣을 수 없으므로 부채는 줄기만 한다.
// 지금 이 저장소의 부채는 **0**이다(전수 선언 완료).
//
// 계약: exit 0 = 통과 · exit 1 = 위반. 판정은 종료코드로 한다(§18-A).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 🔴 **동결 부채 목록** — 축을 아직 못 적은 게이트. 여기 **이름을 새로 넣지 마라.**
 * 넣으면 이 게이트가 잡는다(래칫은 한 방향). 지금은 비어 있고, 비어 있는 것이 목표 상태다.
 */
const AXIS_DEBT_BASELINE = Object.freeze([]);

/** 축이 「무엇을 세지 않는가」를 실제로 말하는가. 이 문체가 이 원장의 유일한 이빨이다. */
const AXIS_FORM = /(이|가)\s*아니라/;
const AXIS_MIN = 20;

/** gates.ts의 Record 리터럴에서 키를 뽑는다(형제 게이트 check-registry-gen과 같은 규율). */
export function recordKeys(source, constName) {
  source = source.replace(/\r\n?/g, '\n');
  const start = source.search(new RegExp(`export const ${constName}(?![\\w$])`));
  if (start < 0) return [];
  const open = source.indexOf('{', start);
  const close = source.indexOf('\n};', open);
  return [...source.slice(open, close).matchAll(/^\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:/gm)].map((m) => m[1] ?? m[2]);
}

/** 키 → 값(문자열). 여러 줄에 걸친 값도 받는다. */
export function recordValues(source, constName) {
  source = source.replace(/\r\n?/g, '\n');
  const start = source.search(new RegExp(`export const ${constName}(?![\\w$])`));
  if (start < 0) return {};
  const open = source.indexOf('{', start);
  // 🔴 마지막 항목의 `,\n`은 `\n};`에 먹혀 body 밖으로 나간다. 닫는 꼬리를 붙여 주지 않으면
  // **맨 마지막 게이트만 조용히 안 읽힌다** — 실제로 첫 실행에서 `verify-diagnostics-live`가
  // 그렇게 빠졌다. 모집단이 하나 모자란 채로 도는 것이 이 저장소의 최빈 결함이다.
  const body = `${source.slice(open, source.indexOf('\n};', open))}\n}`;
  const out = {};
  // 🔴 `//`를 다음 항목의 시작으로 인정하지 않으면, **주석이 달린 항목의 값이 다음 항목까지
  // 통째로 삼켜진다**(2026-08-09에 `GATE_WORLD`에서 실제로 났다 — 값이 산문 한 문단이 됐다).
  // 조용히 틀린 게 아니라 요란하게 틀린 건 값을 **동결 어휘로 검증**하는 쪽이 있었기 때문이다.
  for (const m of body.matchAll(/^\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]*?),\n(?=\s*(?:'|\/\/|[A-Za-z_$]|\}))/gm)) {
    out[m[1] ?? m[2]] = (m[3] ?? '').replace(/^\s*'|'\s*$/g, '').replace(/'\s*\+\s*\n\s*'/g, '');
  }
  return out;
}

/** 순수 판정 — 자체검사가 가짜 입력으로 부른다. */
export function findProblems(gateNames, axes, debt) {
  const problems = [];
  for (const name of debt) {
    if (!AXIS_DEBT_BASELINE.includes(name)) {
      problems.push(`${name}: 동결 부채 목록에 없는 이름이 부채로 들어왔다 — 래칫은 한 방향이다(새 게이트는 축을 적고 태어난다)`);
    }
  }
  for (const name of gateNames) {
    const axis = (axes[name] ?? '').trim();
    if (!axis) {
      if (!debt.includes(name)) problems.push(`${name}: 개수가 아닌 **축** 선언이 없다 — GATE_AXIS에 한 줄 적으세요`);
      continue;
    }
    if (axis.length < AXIS_MIN) problems.push(`${name}: 축이 너무 짧아 무엇을 세지 않는지 알 수 없다 — "${axis}"`);
    else if (!AXIS_FORM.test(axis)) problems.push(`${name}: 축이 「N이 아니라 M」 꼴이 아니다 — 거부하는 개수를 이름 대세요. "${axis}"`);
  }
  for (const name of Object.keys(axes)) {
    if (!gateNames.includes(name)) problems.push(`${name}: GATE_AXIS에 있으나 원장(harness)에 없는 게이트다(지운 게이트?)`);
  }
  return problems;
}

// ── 자체검사: 알려진 실패를 주입해 RED를 본 뒤에만 신뢰한다(§4) ──
const SELF = { pos: 0, neg: 0 };

export function selfTest() {
  const names = ['check-a', 'check-b'];
  const good = { 'check-a': '건수가 아니라, 스캔 범위가 전부를 덮는지', 'check-b': '파일 수가 아니라, 계약이 한 곳에만 있는지' };
  if (findProblems(names, good, []).length) throw new Error('SELF-TEST 실패: 정상 원장을 걸렀다(오탐)');
  SELF.neg = 1;
  const crlf = "export const GATE_AXIS = {\r\n  'check-a': '건수가 아니라, 스캔 범위가 전부를 덮는지',\r\n};\r\n";
  if (recordKeys(crlf, 'GATE_AXIS').join() !== 'check-a' || !recordValues(crlf, 'GATE_AXIS')['check-a']) {
    throw new Error('SELF-TEST 실패: Windows CRLF 원장을 읽지 못했다');
  }
  SELF.neg += 1;

  const bad = [
    ['축 누락', names, { 'check-a': good['check-a'] }, [], '축** 선언이 없다'],
    ['개수만 세는 자유 서술', names, { ...good, 'check-b': '여러 가지를 꼼꼼하게 검사하고 있는지 확인한다' }, [], '꼴이 아니다'],
    ['너무 짧은 축', names, { ...good, 'check-b': '수가 아니라 뜻' }, [], '너무 짧아'],
    ['동결 목록에 없는 새 부채', names, { 'check-a': good['check-a'] }, ['check-b'], '래칫은 한 방향'],
    ['원장에 없는 유령 축', names, { ...good, 'check-ghost': '수가 아니라, 무언가를 단언하는지' }, [], '원장(harness)에 없는'],
  ];
  for (const [label, n, a, d, needle] of bad) {
    if (!findProblems(n, a, d).some((p) => p.includes(needle))) throw new Error(`SELF-TEST 실패: ${label}을(를) 놓쳤다`);
    SELF.pos += 1;
  }
}

selfTest();

const isMain = process.argv[1] && process.argv[1].endsWith('check-gate-promise.mjs');
if (isMain) {
  const harness = readFileSync(join(ROOT, 'scripts/harness.mjs'), 'utf8');
  const gateNames = [...harness.matchAll(/name:\s*'([^']+)',\s*cmd:/g)].map((m) => m[1]);
  const gatesTs = readFileSync(join(ROOT, 'src/app/gates.ts'), 'utf8');
  const axes = recordValues(gatesTs, 'GATE_AXIS');
  const declared = new Set(recordKeys(gatesTs, 'GATE_AXIS'));
  const debt = gateNames.filter((n) => !declared.has(n));

  const problems = findProblems(gateNames, axes, debt);
  if (problems.length) {
    console.error('🔴 약속 원장 위반 — 게이트는 개수가 아니라 뜻을 단언해야 합니다:');
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log(
    `check-gate-promise: OK (자체검사 양성 ${SELF.pos}·음성 ${SELF.neg} · 게이트 ${gateNames.length}개 전부 개수 아닌 축 선언 · 소급 부채 ${debt.length}/${AXIS_DEBT_BASELINE.length})`,
  );
  console.log('  ↳ 정직한 한계: 축의 **내용이 참인지**는 기계가 보지 못합니다 — 형식과 누락만 봅니다.');
}
