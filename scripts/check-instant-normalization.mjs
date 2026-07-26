// check-instant-normalization.mjs — 시각 **표기** 정규화 게이트(결함군 M-0034, 2026-07-27).
//
// 왜: 사용자 기기의 진단이 사진 9건을 「만든 시각이 고친 시각보다 늦음」으로 띄웠는데
// 데이터는 멀쩡했다. 같은 순간을 두 표기로 저장했을 뿐이었다:
//
//   로컬(JS `toISOString()`)  2026-07-26T17:29:48.340Z      ← ms 3자리 고정 · `Z`
//   서버(PostgREST/JSON)      2026-07-26T17:29:48.34+00:00  ← ms 끝 0 생략 · `+00:00`
//
// 이 앱은 시각을 **문자열로 비교**한다(`mergeDecision`의 LWW). `'0'`(0x30) > `'+'`(0x2B)이라
// 같은 순간이 다르게 읽혔고, 동률일 때만 도는 version 판정이 통째로 건너뛰어졌다.
//
// ── 이 게이트가 **타입이 못 잡는 것**만 본다 ────────────────────────────
// `WithInstants<T>` 브랜드 타입이 이미 `createdAt: r.created_at`을 컴파일 오류로 만든다(2층).
// 그런데 타입은 **새 rowmap이 아예 그 반환형을 안 쓰는 경우**를 못 잡는다 — 다음 사람이
// `fromPlaceRow(r): LocalPlace`라고 쓰면 날것을 넣어도 멀쩡히 컴파일된다. 그 구멍이 이 게이트다.
// (§7 세 질문 중 *"다음 형제가 자동으로 따라오는가"* — 답이 '아니오'면 층이 빈 것이다.)
//
// 사용: node scripts/check-instant-normalization.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOMAIN = join(ROOT, 'src', 'domain');

/**
 * 서버 행 → 로컬 행 변환 함수를 찾아 (이름, 반환형, 본문)을 뽑는다.
 * `from…Row(r: XRow): T {` 형태만 본다 — snake_case 행을 받는 것이 곧 "서버 경계"의 정의다.
 */
export function fromRowFunctions(source) {
  const out = [];
  const re = /export\s+function\s+(from\w*Row)\s*\(([^)]*)\)\s*:\s*([^{]+)\{/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const start = m.index + m[0].length;
    // 본문 끝: 열 0의 `}` — 이 저장소의 최상위 함수는 항상 거기서 닫힌다(check-fn-size와 같은 전제).
    const rest = source.slice(start);
    const end = rest.search(/\n\}/);
    out.push({ name: m[1], returnType: m[3].trim(), body: rest.slice(0, end < 0 ? rest.length : end) });
  }
  return out;
}

/** 한 파일의 위반 목록. 반환형과 본문 두 가지를 본다(하나만 보면 우회로가 남는다). */
export function violationsIn(source, rel) {
  const bad = [];
  for (const fn of fromRowFunctions(source)) {
    if (!/\bWithInstants</.test(fn.returnType)) {
      bad.push(`${rel}::${fn.name} — 반환형이 WithInstants<…>가 아님(브랜드가 안 걸려 날것이 통과한다)`);
    }
    for (const [col, helper] of [
      ['created_at', 'isoInstant'],
      ['updated_at', 'isoInstant'],
      ['deleted_at', 'isoInstantOrNull'],
    ]) {
      if (!fn.body.includes(`r.${col}`)) continue; // 그 컬럼을 안 쓰는 변환이면 해당 없음
      if (!new RegExp(`${helper}\\(\\s*r\\.${col}`).test(fn.body)) {
        bad.push(`${rel}::${fn.name} — r.${col}이 ${helper}()를 거치지 않음`);
      }
    }
  }
  return bad;
}

// ── 자체검사: 알려진 실패를 주입해 RED를 확인한 뒤에만 이 게이트를 믿는다(§4·§11) ──
(() => {
  const good = `
export function fromRow(r: TripRow): WithInstants<LocalTrip> {
  return {
    createdAt: isoInstant(r.created_at),
    updatedAt: isoInstant(r.updated_at),
    deletedAt: isoInstantOrNull(r.deleted_at),
  };
}
`;
  if (violationsIn(good, 'x.ts').length !== 0) throw new Error('SELF-TEST 실패: 정상 코드를 위반으로 잡음(오탐).');

  // ① 실제로 났던 그 코드 — 날것 대입.
  const raw = good.replace('isoInstant(r.created_at)', 'r.created_at');
  if (violationsIn(raw, 'x.ts').length !== 1) throw new Error('SELF-TEST 실패: 날것 대입을 못 잡음(게이트 공허).');

  // ② 타입이 못 잡는 구멍 — 반환형을 안 쓴 **새 형제**. 이게 이 게이트의 존재 이유다.
  const noBrand = good.replace('WithInstants<LocalTrip>', 'LocalTrip').replace('isoInstant(r.created_at)', 'r.created_at');
  if (violationsIn(noBrand, 'x.ts').length !== 2) throw new Error('SELF-TEST 실패: 브랜드 없는 새 rowmap을 못 잡음.');

  // ③ 그 컬럼이 아예 없는 변환은 해당 없음(오탐 금지 — 오탐은 틀린 게이트다, §11 ③).
  const partial = 'export function fromXRow(r: XRow): WithInstants<X> {\n  return { id: r.id };\n}\n';
  if (violationsIn(partial, 'x.ts').length !== 0) throw new Error('SELF-TEST 실패: 없는 컬럼을 위반으로 잡음(오탐).');
})();

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const files = walk(DOMAIN).filter((f) => f.endsWith('rowmap.ts'));
const violations = [];
let fnCount = 0;
for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const src = readFileSync(file, 'utf8');
  fnCount += fromRowFunctions(src).length;
  violations.push(...violationsIn(src, rel));
}

// 백업 복원은 타입이 안 걸리는 **두 번째 유입구**다(파일에서 온 행 — 옛 백업에 옛 표기가 있다).
// 서버 경계만 막고 여기를 두면 같은 결함이 다른 문으로 다시 들어온다(§7 수평전개).
const backup = readFileSync(join(ROOT, 'src', 'services', 'backup.ts'), 'utf8');
if (!/withCanonicalStamps/.test(backup)) {
  violations.push('src/services/backup.ts — 복원한 행이 withCanonicalStamps()를 거치지 않음');
}

// LWW가 다시 **문자열 대소**로 돌아가지 않게 못 박는다. 이게 M-0034가 사용자에게 닿은 경로다.
const merge = readFileSync(join(ROOT, 'src', 'sync', 'merge.ts'), 'utf8');
if (/\bserver\.updatedAt\s*[<>]\s*local\.updatedAt/.test(merge) || !/compareInstants/.test(merge)) {
  violations.push('src/sync/merge.ts — LWW가 시각을 문자열 대소로 비교함(compareInstants를 쓰세요)');
}

if (violations.length > 0) {
  console.error(
    'check-instant-normalization: 밖에서 온 시각이 정규 표기를 거치지 않습니다(M-0034).\n' +
      violations.map((v) => '  - ' + v).join('\n') +
      '\n  → src/domain/time.ts의 isoInstant()/isoInstantOrNull()/withCanonicalStamps()를 쓰고,' +
      '\n     서버 경계 함수의 반환형은 WithInstants<…>로 두세요(누락이 컴파일 오류가 되게).',
  );
  process.exit(1);
}

console.log(
  `check-instant-normalization: OK — 서버 경계 ${files.length}파일 ${fnCount}함수 전부 정규화 · 백업 복원 · LWW 순간비교.`,
);
