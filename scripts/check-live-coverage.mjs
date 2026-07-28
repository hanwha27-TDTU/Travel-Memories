// check-live-coverage.mjs — **모든 사용자 화면은 「누가 눈으로 보는가」에 답해야 한다.**
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 (사용자 지적 2026-07-28)
// ─────────────────────────────────────────────────────────────────────────────
// *"니가 의심되는 부분에서 스크린샷 찍어서 확인하면 되는거 아냐?"*
//
// 맞다. Playwright·Chromium이 있는데 화면 확인을 **사용자에게 시키고** 있었다. §12를 앱에만
// 묻고 나 자신에게는 안 물은 것이다. 그리고 그 값은 이미 치렀다 — M-0046은 **자료구조가 옳고
// 화면 문장만 틀린** 결함이었고, 게이트 31종·유닛 686건이 전부 초록인 채로 배포됐다.
//
// 그래서 규칙을 조항으로만 두지 않는다(§7: **한 층만으로는 지켜지지 않는다는 것이 관측된
// 사실이다**). 조항은 CLAUDE.md §13, 구조는 라이브 스크립트의 `@live-covers` 선언,
// **기계 검사가 이 파일**이다: 새 화면을 만들면 게이트가 *"이 화면은 누가 눈으로 보나?"*를 묻는다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 무엇을 검사하나
// ─────────────────────────────────────────────────────────────────────────────
//  A) `src/ui/screens/*.ts`·`src/ui/panels/*.ts`의 모든 화면이 **어느 라이브 검사엔가 덮이거나**
//     `NO_LIVE_REQUIRED`에 **이유와 함께** 등록돼 있다. 이유 없는 제외는 결함이다(§7).
//  B) 라이브 스크립트가 선언한(`@live-covers`) 화면이 **실제로 존재**한다(선언이 유령을 가리키지 않게).
//  C) 제외 목록에 **없는 화면 이름**이 남아 있지 않다(파일을 지웠는데 이유만 남는 화석 방지).
//
// ─────────────────────────────────────────────────────────────────────────────
// 정직한 한계 — 이 게이트가 못 하는 것 (둘 다 실물로 확인했다)
// ─────────────────────────────────────────────────────────────────────────────
// ① 선언(`@live-covers`)이 **거짓일 수 있다.** 스크립트가 그 화면을 실제로 여는지까지는 이 정적
//    검사가 못 본다 — `check-skill-routing`이 받아들인 것과 같은 한계다.
//
// ② 🔴 **선언이 참이어도 그 검사가 이번 실행에서 돌았다는 뜻이 아니다.** 라이브 게이트는
//    **선택 게이트**라 전제(브라우저·최신 `dist`)가 없으면 SKIP한다(`gates-mechanization-dev`
//    §2-G). 이 게이트는 Required라 **늘 돈다** — 그래서 첫 판의 판정문은
//    *"화면 N개를 라이브 2종이 **덮음**"*이라고 말했고, 그 순간 라이브 2종은 **둘 다 SKIP**이었다.
//    Required 게이트의 초록이 안 잰 층을 잰 것처럼 말한 것이다(§8 「모르는 것은 확인 불가」 ·
//    §2-G 「SKIP을 PASS로 반올림하지 않는다」를 **커버리지 쪽에서** 다시 어긴 형태).
//    → 그래서 이 게이트는 **「덮였다」고 말하지 않고 「덮도록 선언돼 있다」고 말한다.**
//       실제로 쟀는지는 harness의 SKIP 보고가 말하고, 그건 이 게이트의 관할이 아니다.
//
// 그래서 이 게이트가 하는 일은 *"덮였다"의 보증*이 아니라 **"안 덮인 화면이 조용히 생기는
// 것의 차단"**이다. 실제로 열리는지는 라이브 스크립트 자신이 대상 0에서 공허하게 통과하지
// 않도록 막는다(`verify-diagnostics-live`가 목록 확보를 먼저 판정하는 이유 — 그 판에서 뚫렸다).

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIRS = [
  ['screens', join(ROOT, 'src/ui/screens')],
  ['panels', join(ROOT, 'src/ui/panels')],
];
const SCRIPTS = join(ROOT, 'scripts');

/**
 * 라이브 검사가 없어도 되는 화면 — **이유를 반드시 적는다**(비면 규율이 죽는다).
 *
 * 여기 한 줄을 적는 것은 *"이 화면은 사람이 눈으로 안 봐도 된다"*는 선언이다. 그러니 이유는
 * **왜 그 화면이 틀려도 사용자가 손해를 안 보는가**를 적어야 한다. "아직 못 했다"도 정당한
 * 사정이 될 수 있지만(§7 3항), 그건 **면허가 아니라 빚 증서**다 — M-0046이 그 값을 보여줬다.
 */
const NO_LIVE_REQUIRED = new Map([
  [
    'screens/r2Setup.ts',
    '저장소 자격증명 **설정 안내문**이라 사용자의 기억을 판정하지 않는다. 여기서 문장이 틀리면 ' +
      '설정이 안 될 뿐이고, 그 실패는 진단의 「사진 저장소 함수 판」·probe가 **판정으로** 말한다 ' +
      '(즉 이 화면의 오류는 다른 화면이 잡는다). 라이브로 열려면 R2 시크릿이 필요한데 ' +
      '샌드박스에 없다 — 넣으면 검사가 비밀을 들고 있어야 한다.',
  ],
  [
    'screens/researchNote.ts',
    '연구노트는 **읽기 전용 기록물**이다(해시체인 무결성은 `logIntegrity` 유닛이 잰다). ' +
      '판정도 행동 버튼도 없어 §10 ③(전달 결함)의 표면이 아니다 — 틀려도 사용자가 잘못된 ' +
      '행동을 하게 만들지 않는다.',
  ],
  [
    'screens/aboutApp.ts',
    '앱 소개·제작자 정보. 판정·행동이 없는 정적 문서 화면이라 위와 같은 이유.',
  ],
]);

/**
 * 화면 목록 — 손으로 세지 않는다. **디렉터리가 곧 등록부다.**
 *
 * `blueprint.ts`의 `SCREENS`를 쓰지 않는 이유: 그건 **손으로 선언한 목록**이라 화면을 만들고
 * 등록을 빠뜨리면 여기서도 함께 빠진다 — 두 누락이 서로를 가려 준다. 디렉터리는 거짓말을
 * 못 한다(§7 "손으로 세지 말고 등록부/디렉터리에서 뽑는다").
 *
 * 부작용 하나: `screens/`·`panels/`에 **화면이 아닌 파일**(타입 선언·헬퍼)을 두면 이 게이트가
 * 라이브 검사를 요구한다. 그건 오탐이 아니라 **질문**이다 — 그런 파일은 애초에 이 디렉터리
 * 밖에 있어야 하고, 그래도 둬야 한다면 `NO_LIVE_REQUIRED`에 이유를 적으면 된다.
 */
function allScreens() {
  const out = [];
  for (const [label, dir] of UI_DIRS) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.ts') && !f.endsWith('.d.ts')) out.push(`${label}/${f}`);
    }
  }
  return out.sort();
}

/**
 * 라이브 스크립트가 **자기가 여는 화면을 스스로 밝힌다.**
 * 선언을 별도 파일에 두지 않는 이유: 그 파일은 스크립트와 따로 낡는다(§1 SSOT).
 */
export function parseCovers(src) {
  const out = [];
  for (const m of src.matchAll(/@live-covers:\s*(.+)/g)) {
    for (const s of m[1].split(',')) {
      const t = s.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/** 검사 본체 — 순수 함수라 셀프테스트가 직접 돌린다(§4). */
export function checkCoverage(screens, coversByScript, excused) {
  const problems = [];
  const covered = new Map();
  for (const [script, list] of coversByScript) {
    for (const s of list) {
      if (!screens.includes(s)) {
        problems.push(`${script}: @live-covers가 없는 화면 '${s}'를 가리킴 — 선언이 유령을 덮고 있다`);
        continue;
      }
      covered.set(s, script);
    }
  }
  for (const s of screens) {
    if (covered.has(s)) continue;
    if (excused.has(s)) continue;
    problems.push(
      `${s}: 이 화면을 **눈으로 보는 라이브 검사가 없다** — 라이브 스크립트에 @live-covers로 ` +
        `추가하거나, NO_LIVE_REQUIRED에 **이유와 함께** 등록하세요(이유 없는 제외는 결함, §7).`,
    );
  }
  for (const s of excused.keys()) {
    if (!screens.includes(s)) problems.push(`NO_LIVE_REQUIRED에 없는 화면 '${s}'가 남아 있음 — 화석이 된 이유를 지우세요`);
    else if (covered.has(s)) problems.push(`${s}: 라이브로 덮였는데 NO_LIVE_REQUIRED에도 있음 — 예외를 지우세요`);
  }
  return problems;
}

// ── 셀프테스트: 알려진 실패가 RED로 잡히는지(게이트 비공허, §4) ──
{
  const S = ['screens/a.ts', 'screens/b.ts', 'panels/c.ts'];
  const cases = [
    { name: '전부 덮이면 통과', screens: S, covers: [['live.mjs', S]], excused: new Map(), clean: true },
    {
      name: '🔴 안 덮인 화면을 잡는다(이 게이트의 본체)',
      screens: S,
      covers: [['live.mjs', ['screens/a.ts', 'screens/b.ts']]],
      excused: new Map(),
      clean: false,
    },
    {
      name: '이유 있는 제외는 통과',
      screens: S,
      covers: [['live.mjs', ['screens/a.ts', 'screens/b.ts']]],
      excused: new Map([['panels/c.ts', '이유']]),
      clean: true,
    },
    {
      name: '🔴 선언이 없는 화면을 가리키면 잡는다(유령 커버리지)',
      screens: S,
      covers: [['live.mjs', [...S, 'screens/ghost.ts']]],
      excused: new Map(),
      clean: false,
    },
    {
      name: '🔴 화면이 사라졌는데 제외 이유만 남으면 잡는다(화석)',
      screens: S,
      covers: [['live.mjs', S]],
      excused: new Map([['screens/gone.ts', '이유']]),
      clean: false,
    },
    {
      name: '🔴 덮였는데 제외에도 있으면 잡는다(둘 중 하나는 거짓말)',
      screens: S,
      covers: [['live.mjs', S]],
      excused: new Map([['screens/a.ts', '이유']]),
      clean: false,
    },
  ];
  const broken = cases.filter((c) => (checkCoverage(c.screens, c.covers, c.excused).length === 0) !== c.clean);
  if (broken.length) {
    console.error(`check-live-coverage: 셀프테스트 실패 — 게이트가 공허함: ${broken.map((c) => c.name).join(', ')}`);
    process.exit(2);
  }
  // 선언 파서도 함께 — 빈 항목·공백이 유령을 만들지 않는지.
  const parsed = parseCovers('// @live-covers: screens/a.ts,  panels/b.ts ,\n// @live-covers: screens/c.ts');
  if (parsed.join('|') !== 'screens/a.ts|panels/b.ts|screens/c.ts') {
    console.error(`check-live-coverage: 셀프테스트 실패 — 선언 파서: ${JSON.stringify(parsed)}`);
    process.exit(2);
  }
}

// ── 실제 검사 ──
const screens = allScreens();
const coversByScript = readdirSync(SCRIPTS)
  .filter((f) => /^verify-.*-live\.mjs$/.test(f))
  .map((f) => [f, parseCovers(readFileSync(join(SCRIPTS, f), 'utf8'))]);

if (!coversByScript.length) {
  console.error('check-live-coverage: 라이브 스크립트를 하나도 못 찾았습니다 — 검사가 공허합니다.');
  process.exit(1);
}

const problems = checkCoverage(screens, coversByScript, NO_LIVE_REQUIRED);
if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('check-live-coverage: 눈으로 보는 층이 없는 화면이 있습니다(CLAUDE.md §13).');
  process.exit(1);
}
const coveredCount = screens.length - NO_LIVE_REQUIRED.size;
// **「덮음」이 아니라 「덮도록 선언됨」이다.** 위 정직한 한계 ② — 라이브 게이트는 SKIP될 수
// 있고 이 게이트는 그걸 모른다. 실제로 쟀는지는 harness의 SKIP 보고가 말한다.
console.log(
  `check-live-coverage: OK (셀프테스트 통과 · 화면 ${screens.length}개 중 ${coveredCount}개가 라이브 ${coversByScript.length}종에 **덮도록 선언됨** · 이유 있는 제외 ${NO_LIVE_REQUIRED.size}개)` +
    `\n  ↳ 이 게이트는 선언만 봅니다. 그 검사가 실제로 돌았는지는 harness의 라이브 게이트 판정(PASS/SKIP)이 말합니다.`,
);
