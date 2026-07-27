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

/**
 * 한 파일의 위반 목록. 반환형과 본문 두 가지를 본다(하나만 보면 우회로가 남는다).
 *
 * ⚠️ **컬럼 목록을 손으로 적지 않는다**(자기점검 2026-07-27에 이걸로 뚫렸다).
 * 처음엔 `created_at`·`updated_at`·`deleted_at` **셋만** 검사했다. 그래서 같은 커밋에서
 * `occurred_at`(순간의 발생 시각)과 `taken_at`(사진 촬영 시각)을 빠뜨렸는데 **게이트가
 * 초록이었다** — 게이트가 내 불완전한 목록을 그대로 베껴 갖고 있었기 때문이다.
 * 둘 다 서버에서 오고 둘 다 문자열로 정렬된다(`timeline.ts`의 `localeCompare`).
 *
 * 이제 **본문에 나타나는 모든 `r.*_at`을 코드에서 뽑아** 검사한다. 새 시각 컬럼이 생기면
 * 다음 형제가 자동으로 따라온다(§7의 세 번째 질문).
 */
export function violationsIn(source, rel) {
  const bad = [];
  const WRAPPED = /(?:isoInstant|isoInstantOrNull)\(\s*$/;
  for (const fn of fromRowFunctions(source)) {
    if (!/\bWithInstants</.test(fn.returnType)) {
      bad.push(`${rel}::${fn.name} — 반환형이 WithInstants<…>가 아님(브랜드가 안 걸려 날것이 통과한다)`);
    }
    // 본문이 읽는 시각 컬럼을 **전부** 모은다 — 위치마다 따로 본다(한 곳만 감싸고 넘어가지 못하게).
    for (const m of fn.body.matchAll(/r\.(\w+_at)\b/g)) {
      if (WRAPPED.test(fn.body.slice(0, m.index))) continue;
      bad.push(`${rel}::${fn.name} — r.${m[1]}이 isoInstant()/isoInstantOrNull()을 거치지 않음`);
    }
  }
  return bad;
}

/**
 * 백업 복원이 **실제로 정규화를 호출하는가.**
 *
 * ⚠️ 처음엔 파일에 `withCanonicalStamps`라는 글자가 있는지만 봤다. 그러면 **import 한 줄만
 * 남기고 호출 4개를 전부 지워도 초록**이다 — 자기점검에서 주입해 확인했다. 게이트를 만들었다는
 * 것과 그 자리가 지켜진다는 것은 다르다(§11).
 *
 * 이제 `incoming.<표>`를 **코드에서 뽑아** 각각이 정규화를 거치는지 본다(새 표도 자동으로 따라온다).
 */
export function backupViolations(src) {
  const tables = [...new Set([...src.matchAll(/incoming\.(\w+)/g)].map((m) => m[1]))];
  if (tables.length === 0) return ['src/services/backup.ts — 복원이 읽는 표를 찾지 못함(게이트가 공허해진다)'];
  return tables
    .filter((t) => !new RegExp(`incoming\\.${t}\\.map\\(withCanonicalStamps\\)`).test(src))
    .map((t) => `src/services/backup.ts — 복원한 ${t}가 withCanonicalStamps()를 거치지 않음`);
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

  // ④ **자기점검에서 실제로 뚫린 구멍**: 손으로 적은 3개 말고 다른 시각 컬럼.
  const extra = good.replace('createdAt: isoInstant(r.created_at),', "occurredAt: r.occurred_at ?? '',\n    createdAt: isoInstant(r.created_at),");
  if (violationsIn(extra, 'x.ts').length !== 1) throw new Error('SELF-TEST 실패: created/updated/deleted 밖의 시각 컬럼을 못 잡음.');
  const extraOk = good.replace('createdAt: isoInstant(r.created_at),', "occurredAt: isoInstant(r.occurred_at ?? ''),\n    createdAt: isoInstant(r.created_at),");
  if (violationsIn(extraOk, 'x.ts').length !== 0) throw new Error('SELF-TEST 실패: 감싼 컬럼을 위반으로 잡음(오탐).');

  // ⑤ **게이트가 공허했던 그 자리**: import만 남고 호출이 사라진 경우.
  const bkOk = "import { withCanonicalStamps } from '../domain/time';\nconst rows = { trips: incoming.trips.map(withCanonicalStamps) };";
  if (backupViolations(bkOk).length !== 0) throw new Error('SELF-TEST 실패: 정상 백업 코드를 위반으로 잡음(오탐).');
  const bkBad = "import { withCanonicalStamps } from '../domain/time';\nconst rows = { trips: incoming.trips };";
  if (backupViolations(bkBad).length !== 1) throw new Error('SELF-TEST 실패: 호출이 사라진 백업을 못 잡음(게이트 공허).');
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
violations.push(...backupViolations(readFileSync(join(ROOT, 'src', 'services', 'backup.ts'), 'utf8')));

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
