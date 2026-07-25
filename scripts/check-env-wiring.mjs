// check-env-wiring.mjs — 코드가 읽는 VITE_* ↔ 배포 워크플로가 주입하는 VITE_* 대조 게이트
//
// 왜 필요한가(실제 사고): `VITE_MEDIA_STORE`를 코드에 넣고 GitHub Variables에도 넣었는데
// **워크플로에 배선하는 줄을 빠뜨렸다.** 이러면 빌드는 성공하고, 값은 조용히 빈 문자열이 되고,
// 기능은 "켰는데 안 켜진" 상태가 된다 — 오류 메시지가 어디에도 없다. 사람이 매번 기억할 일이
// 아니라 기계가 잠글 일이다(CLAUDE.md §6 결함군 승격).
//
// 검사: src/에서 `import.meta.env.VITE_X`로 읽는 이름 집합 == 워크플로 build 단계 env의 이름 집합.
//  - 코드에 있는데 워크플로에 없음 → 배포에서 조용히 빈 값(가장 위험) → FAIL
//  - 워크플로에 있는데 코드에 없음 → 죽은 설정(오타이거나 삭제 잔재) → FAIL
// 예외가 필요하면 EXCLUDE에 **이유와 함께** 적는다.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW = '.github/workflows/deploy-pages.yml';

/** 대조에서 제외할 이름. 반드시 근거를 남긴다(비면 규율이 산다). */
const EXCLUDE = new Set([
  // (현재 없음) 예: 런타임에만 쓰이고 빌드에 주입할 필요가 없는 이름
]);

/** src/ 아래 .ts 파일 전부. */
function tsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 텍스트에서 `import.meta.env.VITE_X` 이름을 모은다. */
export function envNamesInCode(text) {
  return new Set([...text.matchAll(/import\.meta\.env\.(VITE_[A-Z0-9_]+)/g)].map((m) => m[1]));
}

/** 워크플로 텍스트에서 build 단계 env에 배선된 `VITE_X: ${{ vars.VITE_X }}` 이름을 모은다. */
export function envNamesInWorkflow(text) {
  const out = new Set();
  for (const m of text.matchAll(/^\s+(VITE_[A-Z0-9_]+):\s*\$\{\{\s*vars\.(VITE_[A-Z0-9_]+)\s*\}\}/gm)) {
    // 좌변(빌드가 보는 이름)과 우변(Variables 이름)이 어긋나면 그 자체가 결함이다.
    if (m[1] !== m[2]) out.add(`__MISMATCH__${m[1]}!=${m[2]}`);
    else out.add(m[1]);
  }
  return out;
}

/** 두 집합을 비교해 문제 목록을 만든다(빈 배열 = 통과). */
export function compare(code, wf) {
  const problems = [];
  for (const n of wf) {
    if (n.startsWith('__MISMATCH__')) problems.push(`워크플로 배선 좌우 이름 불일치: ${n.slice(12)}`);
  }
  for (const n of code) {
    if (EXCLUDE.has(n)) continue;
    if (!wf.has(n)) problems.push(`${n}: 코드가 읽지만 워크플로가 주입하지 않음 → 배포에서 조용히 빈 값`);
  }
  for (const n of wf) {
    if (n.startsWith('__MISMATCH__') || EXCLUDE.has(n)) continue;
    if (!code.has(n)) problems.push(`${n}: 워크플로가 주입하지만 코드가 읽지 않음 → 죽은 설정(오타 의심)`);
  }
  return problems;
}

// ── 셀프테스트: 알려진 실패가 RED로 잡히는지(게이트 비공허, CLAUDE.md §4) ──
{
  const CODE = 'const a = import.meta.env.VITE_ONE; const b = import.meta.env.VITE_TWO;';
  const WF = '        VITE_ONE: ${{ vars.VITE_ONE }}\n        VITE_TWO: ${{ vars.VITE_TWO }}\n';
  const cases = [
    { name: '정상 통과', code: CODE, wf: WF, clean: true },
    { name: '워크플로 누락 검출', code: CODE, wf: '        VITE_ONE: ${{ vars.VITE_ONE }}\n', clean: false },
    { name: '죽은 설정 검출', code: 'import.meta.env.VITE_ONE', wf: WF, clean: false },
    {
      name: '좌우 이름 불일치 검출',
      code: CODE,
      wf: '        VITE_ONE: ${{ vars.VITE_ONE }}\n        VITE_TWO: ${{ vars.VITE_TOW }}\n',
      clean: false,
    },
    // BASE_URL 같은 vite 내장은 VITE_ 접두가 아니므로 애초에 대상이 아니다.
    { name: 'BASE_URL은 대상 아님', code: `${CODE} import.meta.env.BASE_URL`, wf: WF, clean: true },
  ];
  const broken = cases.filter(
    (c) => (compare(envNamesInCode(c.code), envNamesInWorkflow(c.wf)).length === 0) !== c.clean,
  );
  if (broken.length) {
    console.error(`check-env-wiring: 셀프테스트 실패 — 게이트가 공허함: ${broken.map((c) => c.name).join(', ')}`);
    process.exit(2);
  }
}

// ── 실제 검사 ──
const code = new Set();
for (const f of tsFiles('src')) for (const n of envNamesInCode(readFileSync(f, 'utf8'))) code.add(n);
const wf = envNamesInWorkflow(readFileSync(WORKFLOW, 'utf8'));

const problems = compare(code, wf);
if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('check-env-wiring: 코드 ↔ 배포 워크플로의 VITE_* 배선이 어긋남.');
  process.exit(1);
}
console.log(`check-env-wiring: OK (셀프테스트 통과 · VITE_* ${code.size}개 배선 일치)`);
