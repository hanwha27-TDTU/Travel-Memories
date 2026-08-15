// check-doc-references.mjs — **문서가 가리키는 것이 실재하는가**(2026-08-15 · 사용자 지시 전수조사).
//
// ── 왜 (M-0051의 재발 차단) ──────────────────────────────────────────────────
// 2026-08-15 전수조사에서 `docs/SECURITY.md`가 *"`.claude/settings.json` 및 CI에 **구현**:"*
// 아래에 게이트 아홉 개를 나열했는데 **여섯은 저장소 어디에도 없었다** — 등록부에도,
// 스크립트에도 0건. 보안 계약이 「이 게이트가 막는다」고 적어 두면 다음 사람은 **그 자리를
// 안 본다.** M-0051이 정확히 그 값을 치렀다(「막는다」고 적힌 규칙이 구현되지 않은 채
// 반년치 코드를 통과).
//
// 같은 조사에서 `DEPLOYMENT.md`가 없는 빌드 스크립트를, `naming.ts` 주석이 없는 테스트 파일을
// 가리키고 있었다. 셋 다 **조용하다** — 코드가 깨지지 않으니 아무 신호가 없다. 그래서 기계가 본다.
//
// ── 이 게이트가 재는 것 ─────────────────────────────────────────────────────
//  A) 문서가 백틱으로 가리키는 **저장소 경로**가 실재하는가
//  B) 문서가 가리키는 **`npm run <이름>`**이 `package.json`에 있는가
//  C) 문서가 가리키는 **게이트 이름**이 등록부(`src/app/gates.ts`) 또는 하네스에 있는가
//
// ── 🔴 오탐을 걷어내는 것이 이 게이트의 절반이다(§11 ③) ──────────────────────
// 첫 판 조사에서 60건이 나왔는데 **실제 결함은 4종**이었다. 오탐이 많은 게이트는 사람이
// 무시하기 시작하고, 그 순간 죽는다. 그래서 아래를 **의도적으로 제외**한다:
//  · 확장자 생략(`tests/unit/foo` → 실제 `foo.test.ts`) — 산문에서 흔한 표기다
//  · 글롭(`*`)·생략표(`...`) — 애초에 한 파일을 가리키는 말이 아니다
//  · 빌드 산출물 경로(`dist/`·`src-tauri/target/`) — gitignore라 없는 게 정상이다
//  · **역사 문서**(`HANDOFF*.md`·`records/`·`reference/v0.2/`) — 그때는 있었다.
//    지우면 근거가 사라진다(ADR-0059). 🔴 **역사는 「지금 없다」가 결함이 아닌 유일한 자리다.**
//
// ── 정직한 한계 ─────────────────────────────────────────────────────────────
// 이 게이트는 **「가리키는 것이 있는가」**까지만 본다. **「적힌 내용이 참인가」는 못 본다** —
// 문서가 있는 파일을 가리키면서 그 파일이 하지 않는 일을 설명해도 조용하다. 그 층은 §9 2단계
// (정독 중 구멍 메우기)와 사람의 대조뿐이다.
//
// 🔴 **그리고 이름이 ASCII일 때만 본다**(주입으로 알았다 — §4). 아래 정규식은 `[a-z0-9-]`라
//    한글이 든 이름(`check-없는게이트`)은 **아예 안 읽는다.** 첫 주입이 한글이라 초록이 나왔고,
//    그건 「위반 없음」이 아니라 **「안 봤음」**이었다. 이 저장소의 게이트 이름·경로는 전부
//    ASCII라 실무에서는 닿지 않지만, **닿지 않는다는 것과 본다는 것은 다른 말이다.**
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSelfTest } from './gate-selftest-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 확장자를 생략해 적는 것은 산문의 관행이다 — 결함이 아니다. */
const SUFFIXES = ['', '.ts', '.tsx', '.mjs', '.js', '.md', '.json', '.toml', '.sql', '.css', '.test.ts', '.yml'];

/**
 * 역사 문서 — 「지금 없다」가 결함이 아닌 곳.
 * 🔴 이 목록은 **면제가 아니라 성격 선언**이다: 이 문서들은 *그때 무엇이 있었는가*를 적는다.
 */
const HISTORICAL = [
  /^docs\/HANDOFF/, /^docs\/records\//, /^docs\/reference\//, /^docs\/CHANGELOG\.md$/,
  // 🔴 이 게이트 자신 — 파일 전체가 **일부러 틀린 예**(자체검사 픽스처·설명용 반례)로 차 있다.
  //    자기를 스캔하면 대조군을 위반으로 신고한다. 「검사하는 것도 검사받는다」(§11)는 여기서
  //    `--selftest`가 맡는다: 스캔이 아니라 **주입**이 이 파일의 검사 방식이다.
  /^scripts\/check-doc-references\.mjs$/,
];

/**
 * 🔴 **일부러 없는 것을 가리키는 자리** — 「없다」가 그 문장의 **요점**인 곳.
 *
 * 두 부류뿐이다:
 *  · **과거 결함을 설명하는 산문** — *"첫 판은 `[a-z]+`였고 그래서 `tests/e2e`를 못 읽었다"*.
 *    실재하지 않는 것을 가리키는 게 **핵심**이다. 고치면 설명이 무너진다.
 *  · **이 게이트 자신의 자체검사 픽스처** — 없어야 RED가 나온다(§4). 만들면 대조군이 죽는다.
 *
 * 🔴 **경로로 등록한다(파일별이 아니라).** 그래야 `gen-module-design-docs`가 그 주석을 설계서로
 * 옮겨도 같은 판정이 따라간다 — 생성물은 원본의 그림자이므로 **원본에서 한 번 정하면 끝**이다.
 * 예전엔 이걸 몰라 **생성물 전체를 제외**했었고(T-046), 그 바람에 코드 주석의 화석을 잡아 주던
 * 통로가 닫혀 있었다. 지금은 열려 있다.
 *
 * ⚠️ **대가를 안다**: 여기 적힌 경로는 **어디에 적혀 있어도 통과한다.** 누가 SECURITY.md에
 * *"`tests/e2e`를 돌린다"*고 써도 안 잡힌다. 그래서 목록을 **짧게** 유지하고 이유를 적는다.
 */
const INTENTIONALLY_ABSENT = new Map([
  ['tests/e2e', '`check-current-doc-facts.mjs`가 **과거 결함**(좁은 문자 클래스가 이 이름을 못 읽었다)을 설명하는 산문. 실재하지 않는 것이 요점이다.'],
  ['tests/unit/foo', '이 게이트 자체검사의 픽스처 — 확장자 보정이 도는지 재려면 없어야 한다(§4).'],
  ['src/gone.ts', '이 게이트 자체검사의 픽스처 — 「계약 문서에서는 잡는다」를 재려면 없어야 한다(§4).'],
]);

/** 빌드가 만드는 것 — 저장소에 없는 것이 정상이다. */
const BUILD_OUTPUT = [/^dist\//, /^src-tauri\/(target|gen)\//, /^android-shell\/.*\/build\//, /^windows-dist\//];

const PATH_RE = /`((?:src|scripts|docs|schemas|supabase|tests|android-shell|src-tauri|\.claude|\.github|\.githooks)\/[A-Za-z0-9_./*-]+)`/g;
const NPM_RE = /`npm run ([a-z0-9:-]+)/g;
const GATE_RE = /`((?:check|verify)-[a-z0-9-]+)`/g;

/**
 * 🔴 **이름은 있으나 실물이 없는 것 — 「후보/목표」로 문서가 정직하게 밝힌 자리.**
 *
 * 왜 등록부인가: 문서가 *"게이트 후보"*라고 적어 두면 그건 정직한 상태이고 결함이 아니다.
 * 그런데 산문에서 「후보」라는 낱말을 찾아 판정하면 **표현이 조금만 달라도 뚫린다.**
 * 그래서 이름을 여기 **이유와 함께** 적게 한다 — 이 저장소가 이미 쓰는 형태다
 * (`NO_OP_REQUIRED`·`TOUCH_TARGET_EXCEPTIONS`). 🔴 **이유 없는 등록은 결함이다**(§7).
 *
 * 🔴 그리고 이 표 자체가 산출물이다: **「우리가 있다고 말만 하고 안 만든 것」의 전체 목록**이
 * 한 곳에 모인다. 예전엔 이 사실이 문서 넷에 흩어져 있어 아무도 세지 못했다.
 */
const PLANNED = new Map([
  ['check-supabase-sql-safe', 'SECURITY.md 후보. 파괴적 SQL은 지금도 PreToolUse 훅이 막지만 Claude만 묶는다(§18 강제 3층).'],
  ['check-rls-present', 'SECURITY.md 후보. 일부는 check-migration-grants가 이미 본다 — 만들 때 중복부터 확인.'],
  ['check-service-role-in-bundle', 'SECURITY.md 후보. check-secret-leak이 상당 부분 덮는다.'],
  ['check-no-hard-delete', 'SECURITY.md·SYNC_PROTOCOL.md 후보. 영구삭제(ADR-0030)는 의도된 예외라 갈래 설계가 먼저다.'],
  ['check-storage-immutable', 'SECURITY.md·MEDIA_PIPELINE.md 후보(H-11 upsert:false).'],
  ['check-exif-whitelist', 'SECURITY.md·PRIVACY.md·MEDIA_PIPELINE.md 후보. 🔴 전제가 이미 다르다 — exif_whitelist 컬럼은 없고 개별 컬럼만 서버로 가 목적이 더 보수적으로 달성돼 있다. 만들기 전에 무엇을 잴지부터 다시 정할 것.'],
  ['check-empty-cloud-guard', 'SYNC_PROTOCOL.md가 「활성 주장 아님」으로 밝힌 후보.'],
  ['check-no-delta-in-fullset-decision', 'SYNC_PROTOCOL.md가 「활성 주장 아님」으로 밝힌 후보.'],
  ['check-readback-before-success', 'SYNC_PROTOCOL.md가 「활성 주장 아님」으로 밝힌 후보.'],
]);

/** 같은 규율의 경로판 — 문서가 「목표」라고 밝힌 산출물. */
const PLANNED_PATHS = new Map([
  ['scripts/build-single-html.ts', 'DEPLOYMENT.md 「보조 빌드」의 목표 산출물. 2026-08-15 실측으로 없음을 문서에 명시했다.'],
]);

export function isHistorical(doc) { return HISTORICAL.some((re) => re.test(doc)); }
export function isBuildOutput(ref) { return BUILD_OUTPUT.some((re) => re.test(ref)); }
export function skippablePath(ref) { return ref.includes('*') || ref.includes('...') || isBuildOutput(ref); }

/** 순수 판정 — 파일 존재 여부는 `has`가 답한다(유닛에서 주입할 수 있게). */
export function violations(docs, has, npmScripts, gateNames, planned = { gates: PLANNED, paths: PLANNED_PATHS }) {
  const out = [];
  for (const { doc, text } of docs) {
    if (isHistorical(doc)) continue;
    for (const m of text.matchAll(PATH_RE)) {
      const ref = m[1];
      if (skippablePath(ref)) continue;
      if (SUFFIXES.some((s) => has(ref.replace(/\/$/, '') + s))) continue;
      if (planned.paths.has(ref) || INTENTIONALLY_ABSENT.has(ref)) continue;
      out.push({ doc, kind: '경로', ref });
    }
    for (const m of text.matchAll(NPM_RE)) {
      if (!npmScripts.has(m[1])) out.push({ doc, kind: 'npm', ref: `npm run ${m[1]}` });
    }
    for (const m of text.matchAll(GATE_RE)) {
      if (!gateNames.has(m[1]) && !planned.gates.has(m[1])) out.push({ doc, kind: '게이트', ref: m[1] });
    }
  }
  return out;
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'windows-dist'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p.slice(ROOT.length + 1));
  }
  return out;
}

function main() {
  const files = new Set(walk(ROOT));
  const has = (p) => files.has(p) || existsSync(join(ROOT, p));
  // 🔴 **문서만 보면 반쪽이다.** 이 조사가 잡은 결함 둘(`naming.ts`가 없는 테스트를,
  //    `time.ts`가 없는 게이트를 가리킴)은 **코드 주석**에 있었다. 그리고 코드 주석이 원본이므로
  //    여기서 잡으면 **고칠 자리를 정확히 가리킨다** — 생성된 설계서에서 잡는 것보다 낫다.
  const docs = [...files]
    .filter((f) => (
      (f.endsWith('.md') && (f.startsWith('docs/') || f.startsWith('.claude/') || f === 'CLAUDE.md' || f === 'AGENTS.md'))
      || ((f.startsWith('src/') || f.startsWith('scripts/')) && /\.(?:ts|mjs)$/.test(f))
    ))
    .map((f) => ({ doc: f, text: readFileSync(join(ROOT, f), 'utf8') }));

  const npmScripts = new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {}));
  const gatesSrc = readFileSync(join(ROOT, 'src/app/gates.ts'), 'utf8');
  const harness = readFileSync(join(ROOT, 'scripts/harness.mjs'), 'utf8');
  // 🔴 **출처가 셋이다.** 등록부·하네스만 보면 `verify-sync-release-live`처럼 **파일과 npm
  //    스크립트로만 존재하며 CI가 직접 부르는** 게이트를 「없다」고 잡는다(첫 판에서 실제로
  //    그렇게 오탐했다 — §11 ③). 「존재한다」의 정의를 실물에 맞춘다.
  const gateNames = new Set([
    ...[...gatesSrc.matchAll(/'((?:check|verify)-[a-z0-9-]+)'/g)].map((m) => m[1]),
    ...[...harness.matchAll(/'((?:check|verify)-[a-z0-9-]+)'/g)].map((m) => m[1]),
    ...readdirSync(join(ROOT, 'scripts'))
      .filter((f) => /^(?:check|verify)-.*\.mjs$/.test(f))
      .map((f) => f.replace(/\.mjs$/, '')),
  ]);

  // 🔴 모집단을 먼저 판정한다(§4). 문서 0개·게이트 0개면 아래 초록은 「없다」가 아니라 「안 봤다」다.
  if (docs.length < 20 || gateNames.size < 20) {
    console.error(`check-doc-references: 모집단이 이상합니다 — 문서 ${docs.length}개 · 게이트 ${gateNames.size}개. 검사를 신뢰할 수 없습니다.`);
    process.exit(1);
  }

  const bad = violations(docs, has, npmScripts, gateNames);
  if (bad.length) {
    console.error('check-doc-references: 문서가 **없는 것**을 가리킵니다(M-0051 — 「막는다」고 적힌 규칙이 없으면 그 자리는 안 봅니다).');
    for (const b of bad) console.error(`  - ${b.doc}: ${b.kind} \`${b.ref}\``);
    console.error('  → 실물로 만들거나, 「후보/목표」임을 문장에 적으세요(SYNC_PROTOCOL.md의 「활성 주장 아님」이 그 형식입니다).');
    process.exit(1);
  }
  console.log(`check-doc-references: 문서·소스 ${docs.length}개가 가리키는 경로·npm·게이트가 모두 실재합니다.`);
  console.log('    ↳ 정직한 한계: **가리키는 것이 있는가**까지만 봅니다 — 적힌 **내용이 참인지**는 못 봅니다.');
  console.log(`    ↳ 안 본 것: 역사 문서(HANDOFF·records·reference) · 「후보/목표」 ${PLANNED.size + PLANNED_PATHS.size}건 · 「일부러 없음」 ${INTENTIONALLY_ABSENT.size}건(이유는 코드에).`);
}

// 🔴 **자체검사 — 알려진 실패를 주입해 RED를 확인한다(§4).**
// 대조군은 「잡아야 할 것을 잡는가」와 「잡지 말아야 할 것을 안 잡는가」를 함께 둔다.
//    한쪽만 있으면 공허하다: 전부 통과시키는 게이트도, 전부 잡는 게이트도 자체검사를 통과한다.
//    아래에는 **알려진 실패를 주입한 케이스**와 **오탐 방지 케이스**가 섞여 있다.
const SELF_TESTS = [
  {
    name: '없는 게이트 이름을 잡는다',
    run: () => violations([{ doc: 'docs/X.md', text: '`check-missing-gate`' }], () => false, new Set(), new Set(['check-real-gate'])).length === 1,
  },
  {
    name: '있는 게이트는 통과시킨다',
    run: () => violations([{ doc: 'docs/X.md', text: '`check-real-gate`' }], () => false, new Set(), new Set(['check-real-gate'])).length === 0,
  },
  {
    name: '확장자를 생략해도 오탐하지 않는다',
    run: () => violations([{ doc: 'docs/X.md', text: '`tests/unit/foo`' }], (p) => p === 'tests/unit/foo.test.ts', new Set(), new Set()).length === 0,
  },
  {
    name: '🔴 역사 문서는 「지금 없다」로 잡지 않는다',
    run: () => violations([{ doc: 'docs/HANDOFF.md', text: '`src/no-such-file-here.ts`' }], () => false, new Set(), new Set()).length === 0,
  },
  {
    name: '🔴 그러나 계약 문서에서는 잡는다(역사 제외가 너무 넓지 않다)',
    run: () => violations([{ doc: 'docs/SECURITY.md', text: '`src/no-such-file-here.ts`' }], () => false, new Set(), new Set()).length === 1,
  },
  {
    name: '빌드 산출물·글롭은 오탐하지 않는다',
    run: () => violations([{ doc: 'docs/X.md', text: '`dist/a.js` `src/**/*.ts` `supabase/migrations/...`' }], () => false, new Set(), new Set()).length === 0,
  },
  {
    name: '없는 npm 스크립트를 잡는다',
    run: () => violations([{ doc: 'docs/X.md', text: '`npm run missing-script`' }], () => false, new Set(['gates']), new Set()).length === 1,
  },
];

if (process.argv.includes('--selftest')) {
  runSelfTest('check-doc-references', () => SELF_TESTS.filter((t) => !t.run()).map((t) => t.name));
} else {
  main();
}
