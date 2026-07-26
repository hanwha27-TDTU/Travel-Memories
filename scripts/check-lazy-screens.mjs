// check-lazy-screens.mjs — 첫 로드 번들에 보조 화면이 딸려 오는 것을 막는 게이트(§7 3층).
//
// 규율(정본: src/ui/lazyScreens.ts 머리주석):
//   **핵심 화면(home·tripDetail)만 첫 로드 정적 그래프에 있어야 한다.**
//   개발자 정보·연구노트·가이드·진단·데이터 관리·지도 같은 보조 화면은 `ui/lazyScreens.ts`의
//   열기 함수(동적 import)를 거친다.
//
// 왜 게이트가 필요한가: 조항과 구조만으로는 안 지켜진다는 것이 이 저장소의 관측된 사실이다.
// 다음 사람이 `home.ts`에 `import { openGuide } from './guide'` 한 줄을 추가하는 순간
// 가이드·진단·CHANGELOG가 통째로 첫 로드에 돌아오고, **화면은 멀쩡히 동작하므로 아무도 모른다.**
// 실측(도입 시점): 이 한 겹으로 main 번들 gzip 173.5KB → 70.3KB.
//
// 왜 '직접 import 금지'가 아니라 '도달 가능성'을 보나: 간선 하나만 검사하면 우회가 쉽다
// (home → 새 파일 → aboutApp). main.ts에서 정적으로 **도달하는지**를 보면 경로가 몇 단계든 잡힌다.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 첫 로드에 있어도 되는 화면. 라우터가 경로에 따라 즉시 그리는 두 화면뿐이다. */
const CORE_SCREENS = ['home.ts', 'tripDetail.ts'];

/**
 * 정적(런타임에 남는) 상대 import 명세자만 뽑는다 — 순수 함수라 자체검사가 직접 부른다.
 * 제외: `import type ...`(빌드에서 지워짐) · 중괄호 안이 전부 `type X`인 import · `import()`(동적).
 */
export function staticRelativeImports(source) {
  const out = [];
  // `import ... from '...'` / `export ... from '...'`. 동적 import()는 from이 없어 안 걸린다.
  const re = /(^|\n)\s*(import|export)\b([\s\S]*?)\bfrom\s*['"](\.[^'"]*)['"]/g;
  for (const m of source.matchAll(re)) {
    const clause = m[3];
    const spec = m[4];
    if (/^\s+type\s/.test(clause)) continue; // import type { X } from '...'
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced) {
      const names = braced[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      // 중괄호 안이 전부 `type X`면 런타임에 아무것도 안 남는다.
      if (names.length > 0 && names.every((n) => /^type\s/.test(n))) continue;
    }
    out.push(spec);
  }
  return out;
}

/** fromFile 기준 상대 명세자를 실제 .ts 파일 경로로. 없으면 null. */
function resolveTs(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(cand) && cand.endsWith('.ts')) return cand;
  }
  return null;
}

/** entry에서 정적으로 도달하는 .ts 파일 집합(ROOT 상대 경로). */
export function reachableFrom(entry, readFile = (p) => readFileSync(p, 'utf8')) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    const rel = relative(ROOT, file);
    if (seen.has(rel)) continue;
    seen.add(rel);
    let src;
    try {
      src = readFile(file);
    } catch {
      continue; // 해석 못 한 파일은 조용히 건너뛴다(css 등)
    }
    for (const spec of staticRelativeImports(src)) {
      const next = resolveTs(file, spec);
      if (next) stack.push(next);
    }
  }
  return seen;
}

// ── 비공허 자체검사: 알려진 실패를 주입해 잡히는지 먼저 증명한다(§4) ──
(() => {
  const valueImport = staticRelativeImports(`import { openAboutApp } from './aboutApp';`);
  if (valueImport.length !== 1) throw new Error('SELF-TEST 실패: 값 import를 못 봤다(게이트 공허).');

  const typeImport = staticRelativeImports(`import type { MapPoint } from './mapView';`);
  if (typeImport.length !== 0) throw new Error('SELF-TEST 실패: `import type`을 위반으로 오탐한다.');

  const inlineType = staticRelativeImports(`import { type MapPoint } from './mapView';`);
  if (inlineType.length !== 0) throw new Error('SELF-TEST 실패: 인라인 type 전용 import를 오탐한다.');

  const mixed = staticRelativeImports(`import { openMapView, type MapPoint } from './mapView';`);
  if (mixed.length !== 1) throw new Error('SELF-TEST 실패: 값+타입 혼합 import를 못 봤다.');

  const dynamic = staticRelativeImports(`const m = await import('./screens/aboutApp');`);
  if (dynamic.length !== 0) throw new Error('SELF-TEST 실패: 동적 import를 정적으로 오탐한다.');
})();

const reachable = reachableFrom(join(ROOT, 'src/main.ts'));

const SCREEN_DIR = 'src/ui/screens';
const allScreens = readdirSync(join(ROOT, SCREEN_DIR)).filter((f) => f.endsWith('.ts'));

/** 첫 로드에 있으면 안 되는 파일: 보조 화면 + 진단 패널(무거운 판정 로직). */
function isLeak(rel) {
  if (rel.startsWith('src/ui/panels/')) return true;
  if (!rel.startsWith(`${SCREEN_DIR}/`)) return false;
  return !CORE_SCREENS.includes(rel.slice(SCREEN_DIR.length + 1));
}

const leaked = [...reachable].filter(isLeak).sort();

// 핵심 화면이 실제로 존재하는지도 본다 — 파일명이 바뀌면 위 필터가 조용히 전부 통과한다.
const missingCore = CORE_SCREENS.filter((f) => !allScreens.includes(f));
if (missingCore.length > 0) {
  console.error(`check-lazy-screens: 핵심 화면 파일이 없습니다: ${missingCore.join(', ')}`);
  console.error('  → 이름이 바뀌었다면 이 게이트의 CORE_SCREENS도 같은 커밋에서 갱신하세요.');
  process.exit(1);
}

if (leaked.length > 0) {
  console.error('check-lazy-screens: 보조 화면이 첫 로드 번들에 딸려 옵니다(정적 import 경로 존재).');
  for (const p of leaked) console.error(`  - ${p}`);
  console.error(`  → 핵심 화면(${CORE_SCREENS.join(', ')})은 보조 화면을 정적 import 하지 않습니다.`);
  console.error("  → src/ui/lazyScreens.ts 의 열기 함수를 쓰세요(없으면 같은 규칙으로 추가).");
  process.exit(1);
}

const lazyCount = allScreens.length - CORE_SCREENS.length;
console.log(
  `check-lazy-screens: OK — 첫 로드 화면 ${CORE_SCREENS.length}개(${CORE_SCREENS.join('·')}), ` +
    `지연 로드 ${lazyCount}개.`,
);
