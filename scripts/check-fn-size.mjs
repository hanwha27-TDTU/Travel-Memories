// check-fn-size.mjs — 최상위 함수 길이 래칫 게이트(§7 3층).
//
// 왜: `renderTripDetail`이 **863줄짜리 함수 하나**였다. 그 안에서는 아무것도 유닛으로 검사할 수
// 없다 — 순수하게 검사 가능한 로직(시각 문자열·확대 수식·제스처 판정)이 DOM 클로저에 갇힌다.
// M-0022가 정확히 그 자리에서 났다: 유닛 15건이 전부 통과했는데 화면 문장은 틀렸다(§10 ③).
// 길이는 그 자체로 결함은 아니지만, **결함이 숨을 수 있는 면적**이고 그건 기계로 잴 수 있다.
//
// 왜 '래칫'인가: 지금 있는 큰 함수를 한 번에 쪼개는 것은 살아 있는 앱에 위험하다. 그래서
// 금지하지 않고 **되돌아가지 못하게** 한다 — 기록된 길이보다 길어지면 RED, 짧아져도 RED
// (기록을 줄여 커밋하라는 뜻). 예산은 한 방향으로만 움직인다.
//
// 이 게이트가 **못** 보는 것: 짧다고 좋은 코드는 아니다. 길이는 대리 지표일 뿐이고,
// 진짜 질문은 "여기서 순수 로직을 뽑아낼 수 있는가"다. 그건 사람이 판단한다.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 새로 만드는 최상위 함수의 상한. 이보다 길게 쓰려면 쪼개거나, 근거와 함께 LEGACY에 올린다. */
const LIMIT = 120;

/**
 * 이미 있던 큰 함수와 **현재** 길이. 값은 줄어들기만 한다(늘리려면 리뷰에서 근거를 대라).
 * 항목을 지우는 것은 자유 — LIMIT 아래로 내려왔다는 뜻이다.
 */
const LEGACY = {
  'src/ui/photoEditor.ts::openPhotoEditor': 763,
  'src/ui/screens/tripDetail.ts::renderTripDetail': 606,
  'src/ui/panels/diagnostics.ts::storeStateProbe': 327,
  'src/ui/photoViewer.ts::openPhotoViewer': 258,
  'src/ui/screens/home.ts::renderHome': 235,
  'src/ui/screens/designOverview.ts::openDesignOverview': 209,
  'src/ui/screens/dataManager.ts::trashPanel': 177,
  'src/ui/screens/aboutApp.ts::openAboutApp': 168,
  'src/ui/screens/mapView.ts::openMapView': 146,
  'src/ui/screens/tripDetail.ts::buildPlaceField': 146,
  'src/ui/panels/diagnostics.ts::syncProbe': 133,
  'src/domain/integrity.ts::checkIntegrity': 133,
  'src/ui/screens/r2Setup.ts::openR2Setup': 138,
  'src/ui/screens/researchNote.ts::openResearchNote': 126,
  'src/ui/screens/tripDetail.ts::buildMomentEditForm': 108,
  'src/ui/panels/verdict.ts::renderTool': 121,
};

/**
 * 최상위 함수의 (이름, 줄수)를 센다 — 순수 함수라 자체검사가 직접 부른다.
 * 세는 법: 열 0에서 시작하는 함수 선언부터, 열 0의 `}`까지. 이 저장소는 최상위 함수가
 * 항상 열 0에서 닫히므로 결정적이다(파서 없이도 흔들리지 않는다).
 */
export function topLevelFunctions(source) {
  const lines = source.split('\n');
  // 식별자에 `[A-Za-z_$]`만 허용하면 한글 이름 함수가 **조용히 안 세어진다**(주입시험에서 발견).
  // JS 식별자는 유니코드 문자를 허용하므로 \p{L}로 받는다 — 안 세어진 함수는 상한이 없는 것과 같다.
  const decl = /^(?:export\s+)?(?:async\s+)?function\s+([\p{L}_$][\p{L}\p{N}_$]*)\s*[(<]/u;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = decl.exec(lines[i]);
    if (!m) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === '}' || lines[j].startsWith('} ')) {
        out.push({ name: m[1], lines: j - i + 1, line: i + 1 });
        i = j;
        break;
      }
    }
  }
  return out;
}

// ── 비공허 자체검사(§4) ──
(() => {
  const src = [
    'function a(): void {',
    '  x();',
    '}',
    '',
    'export async function b(',
    '  p: number,',
    '): Promise<void> {',
    '  if (p) {',
    '    y();',
    '  }',
    '}',
    '',
    'const notCounted = () => {',
    '  z();',
    '};',
  ].join('\n');
  const fns = topLevelFunctions(src);
  if (fns.length !== 2) throw new Error(`SELF-TEST 실패: 함수 2개를 못 셈(${fns.length}).`);
  const a = fns.find((f) => f.name === 'a');
  const b = fns.find((f) => f.name === 'b');
  if (a.lines !== 3) throw new Error(`SELF-TEST 실패: a 길이 오산(${a.lines} ≠ 3).`);
  // 중첩 블록의 닫는 중괄호(들여쓰기됨)를 함수 끝으로 오인하면 여기서 잡힌다.
  if (b.lines !== 7) throw new Error(`SELF-TEST 실패: b 길이 오산(${b.lines} ≠ 7) — 중첩 블록을 끝으로 착각.`);
})();

/**
 * src 아래 모든 `.ts`를 모은다. **`fs.globSync`를 쓰지 않는다** — 그건 Node 22+ API인데 CI는 Node를
 * 따로 핀하므로, 로컬(22)에서는 통과하고 CI(20)에서는 **게이트가 실행조차 못 하고 죽었다**
 * (2026-07-26, 배포 2회 연속 실패). 돌지 못하는 게이트는 없는 게이트보다 나쁘다 —
 * harness가 FAIL을 내므로 그 뒤 모든 배포가 막힌다.
 *
 * 표준 `readdirSync`만 쓴다. 이 저장소의 게이트는 **가장 낮은 지원 Node에서 돌아야 한다.**
 */
function collectTs(dir) {
  const out = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...collectTs(rel));
    else if (e.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}
const files = collectTs('src').sort();
const problems = [];
const seen = new Set();

for (const rel of files) {
  const abs = join(ROOT, rel);
  const key = (name) => `${relative(ROOT, abs).split('\\').join('/')}::${name}`;
  for (const fn of topLevelFunctions(readFileSync(abs, 'utf8'))) {
    const k = key(fn.name);
    const budget = LEGACY[k];
    if (budget === undefined) {
      if (fn.lines > LIMIT) {
        problems.push(
          `${rel}:${fn.line} ${fn.name}() ${fn.lines}줄 > 상한 ${LIMIT}줄 — 쪼개세요.\n` +
            `      (정말 쪼갤 수 없다면 근거와 함께 LEGACY에 '${k}': ${fn.lines} 추가)`,
        );
      }
      continue;
    }
    seen.add(k);
    if (fn.lines > budget) {
      problems.push(
        `${rel}:${fn.line} ${fn.name}() ${fn.lines}줄 > 기록 ${budget}줄 — 큰 함수가 더 커졌습니다.\n` +
          `      래칫은 한 방향입니다. 늘린 만큼 다른 데로 덜어내세요.`,
      );
    } else if (fn.lines < budget) {
      problems.push(
        `${rel}:${fn.line} ${fn.name}() ${fn.lines}줄 < 기록 ${budget}줄 — 줄었습니다(좋습니다).\n` +
          `      → scripts/check-fn-size.mjs의 '${k}'를 ${fn.lines}로 낮춰 커밋하세요.`,
      );
    }
  }
}

// 사라진 기록은 남겨두지 않는다 — 없는 함수의 예산은 다음 사람을 속인다.
for (const k of Object.keys(LEGACY)) {
  if (!seen.has(k)) problems.push(`LEGACY에 '${k}'가 있으나 그런 최상위 함수가 없습니다(이름 변경·삭제?) — 항목을 지우세요.`);
}

if (problems.length > 0) {
  console.error('check-fn-size: 최상위 함수 길이 래칫 위반.');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const tracked = Object.keys(LEGACY).length;
console.log(`check-fn-size: OK — 새 함수 상한 ${LIMIT}줄, 래칫 추적 ${tracked}개(모두 기록과 일치).`);
