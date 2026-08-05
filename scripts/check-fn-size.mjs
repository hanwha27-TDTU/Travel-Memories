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
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 새로 만드는 최상위 함수의 상한. 이보다 길게 쓰려면 쪼개거나, 근거와 함께 LEGACY에 올린다. */
const LIMIT = 120;

/**
 * 이미 있던 큰 함수와 **현재** 길이. 값은 줄어들기만 한다(늘리려면 리뷰에서 근거를 대라).
 * 항목을 지우는 것은 자유 — LIMIT 아래로 내려왔다는 뜻이다.
 */
const LEGACY = {
  'src/ui/photoEditor.ts::openPhotoEditor': 763,
  'src/ui/screens/tripDetail.ts::renderTripDetail': 539,
  'src/ui/panels/diagnostics.ts::storeStateProbe': 222,
  'src/ui/photoViewer.ts::openPhotoViewer': 251,
  'src/ui/screens/home.ts::renderHome': 204,
  'src/ui/screens/designOverview.ts::openDesignOverview': 209,
  'src/ui/screens/dataManager.ts::trashPanel': 75,
  'src/ui/screens/aboutApp.ts::openAboutApp': 168,
  'src/ui/screens/mapView.ts::openMapView': 133,
  'src/ui/screens/tripDetail.ts::buildPlaceField': 110,
  'src/ui/panels/diagnostics.ts::syncProbe': 125,
  'src/domain/integrity.ts::checkIntegrity': 108,
  'src/ui/screens/r2Setup.ts::openR2Setup': 138,
  'src/ui/screens/researchNote.ts::openResearchNote': 126,
  'src/ui/screens/tripDetail.ts::buildMomentEditForm': 83,
  'src/ui/panels/verdict.ts::renderTool': 121,
};

/**
 * 최상위 함수의 (이름, 줄수)를 센다 — 순수 함수라 자체검사가 직접 부른다.
 * 세는 법: 열 0에서 시작하는 선언부터, 열 0의 닫는 중괄호까지. 이 저장소는 최상위 함수가
 * 항상 열 0에서 닫히므로 결정적이다(파서 없이도 흔들리지 않는다).
 *
 * 🔴 **두 형태를 모두 센다**(전수 감사 정리): 예전엔 `function foo()`만 셌고, `const foo = () => {}`
 * 화살표 함수는 **상한이 없는 것과 같았다**(자체검사조차 `notCounted`라 이름 붙여 그 구멍을
 * 인정하고 있었다). 큰 로직이 화살표 상수로 태어나면 래칫을 통째로 우회했다 — §7의 근본형
 * (형제 규율을 새 형태가 물려받지 않음). 이제 열 0의 `const NAME = (...) => {` 블록도 잰다.
 * 닫힘은 화살표면 `};`, 선언 함수면 `}` — 둘 다 열 0에서만 나온다(중첩 닫힘은 들여쓰기됨).
 */
export function topLevelFunctions(source, fileName = 'source.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];

  const add = (name, node) => {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const end = sourceFile.getLineAndCharacterOfPosition(node.end).line + 1;
    out.push({ name, lines: end - start + 1, line: start });
  };

  // SourceFile의 직접 자식만 센다. 본문 경계는 중괄호/들여쓰기가 아니라 TypeScript 파서가
  // 판정하므로 객체 반환 타입과 중첩 블록이 다음 최상위 함수를 삼킬 수 없다(M-0088).
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      add(statement.name.text, statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (
        ts.isIdentifier(declaration.name) &&
        initializer &&
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
        ts.isBlock(initializer.body)
      ) {
        add(declaration.name.text, statement);
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
    '): Promise<{ ok: boolean }> {',
    '  if (p) {',
    '    y();',
    '  }',
    '}',
    '',
    // 멀티라인 화살표도 센다 — 정규식 스캐너에서는 통째로 사라졌다.
    'export const c = (',
    '  p: number,',
    '): void => {',
    '  if (p) {',
    '    z();',
    '  }',
    '};',
  ].join('\n');
  const fns = topLevelFunctions(src);
  if (fns.length !== 3) throw new Error(`SELF-TEST 실패: 함수 3개를 못 셈(${fns.length}) — 화살표 상수를 놓쳤을 수 있음.`);
  const a = fns.find((f) => f.name === 'a');
  const b = fns.find((f) => f.name === 'b');
  const c = fns.find((f) => f.name === 'c');
  if (a.lines !== 3) throw new Error(`SELF-TEST 실패: a 길이 오산(${a.lines} ≠ 3).`);
  // 중첩 블록의 닫는 중괄호(들여쓰기됨)를 함수 끝으로 오인하면 여기서 잡힌다.
  if (b.lines !== 7) throw new Error(`SELF-TEST 실패: b 길이 오산(${b.lines} ≠ 7) — 중첩 블록을 끝으로 착각.`);
  if (!c) throw new Error('SELF-TEST 실패: 화살표 상수 c를 못 셈 — 화살표 커버리지 구멍.');
  if (c.lines !== 7) throw new Error(`SELF-TEST 실패: c 길이 오산(${c.lines} ≠ 7) — 멀티라인 화살표 선언 누락.`);
  // 회귀 주입: 옛 스캐너는 반환 타입의 `{`를 본문으로 오인해 다음 선언까지 삼켰다.
  const typed = topLevelFunctions(
    ['function typed(): { ok: boolean } {', '  return { ok: true };', '}', 'function next() {', '  work();', '}'].join('\n'),
  );
  if (typed.length !== 2 || typed[0].lines !== 3 || typed[1].lines !== 3) {
    throw new Error('SELF-TEST 실패: 객체 반환 타입이 다음 최상위 함수를 삼킴 — 알려진 오판을 RED로 잡지 못함.');
  }
  // 주입: 121줄 화살표 함수가 상한을 넘는지(래칫이 화살표에도 걸리는가) 확인.
  const bigArrow = ['const big = () => {', ...Array(120).fill('  work();'), '};'].join('\n');
  const bf = topLevelFunctions(bigArrow).find((f) => f.name === 'big');
  if (!bf || bf.lines !== 122 || bf.lines <= LIMIT) {
    throw new Error(`SELF-TEST 실패: 큰 화살표 길이 오산(${bf?.lines}) — 알려진 상한 위반 주입을 RED로 잡지 못함.`);
  }
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
  for (const fn of topLevelFunctions(readFileSync(abs, 'utf8'), rel)) {
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
