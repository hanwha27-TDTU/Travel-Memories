// check-screen-lifecycle.mjs — 라우터가 **한 번에 한 화면만** 살려 두는가(§7 3층).
//
// 🔴 왜 생겼나(2026-08-13 · M-0158): 라우터가 「지금 어느 화면인가」를 아무 데도 안 적어서
//    두 결함이 한 뿌리에서 났다 — ①인증 확인을 기다리는 사이 뒤로 가면 **늦게 끝난 확인이
//    떠난 화면을 다시 그렸고** ②떠난 화면의 구독이 **살아남아** 떼어낸 DOM을 참조했다.
//    게이트 71종·유닛이 전부 초록이었다. 규율이 `main.ts`에 살았고 **진입점은 유닛이 못 부른다.**
//
//    판단은 `src/app/screenSession.ts`로 옮겨 유닛을 붙였다(1·2층). 그런데 그것만으로는
//    **다음 화면이 라우터에 붙을 때 그 규율을 탄다는 보장이 없다** — 새 `case`가 세션을 안 거쳐도
//    타입은 통과한다(그냥 `renderX(...)`를 부르면 반환값을 버릴 뿐 오류가 아니다).
//    이 게이트가 정확히 그 구멍을 막는다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 무엇을 재나 — 네 가지 (전부 라우터 콜백 **안에서만**)
// ─────────────────────────────────────────────────────────────────────────────
//  ① **모집단을 먼저 확보한다.** 라우터 콜백을 못 찾거나 화면 호출이 0개면 판정하지 않고
//     `exit 2`로 나간다. 0에서 공허하게 통과하는 검사는 「없다」가 아니라 **「안 봤다」**이다
//     (§13 5항 — `verify-diagnostics-live` 첫 판이 허브를 못 열고도 PASS를 찍었다).
//  ② **모든 화면 호출은 `screen.mount(...)`를 거친다.** 맨몸으로 `renderX(...)`를 부르면
//     그 화면의 정리 함수를 아무도 들고 있지 않다 = M-0158 ②의 재발.
//  ③ **비동기 뒤에 그리면 `isCurrent()`를 먼저 묻는다.** `.then(...)` 콜백 안에서 화면을
//     그리는데 세대 확인이 없으면 M-0158 ①의 재발.
//  ④ **정의된 라우트가 전부 case로 다뤄지고, `default`에 exhaustive 가드가 있는가**
//     (2026-08-14 · T-031 · M-0161). 라우트는 `src/app/router.ts`의 `ROUTE_SEGMENTS`에서
//     **파생**한다 — 손으로 세지 않는다.
//
//     🔴 왜 2층(타입)이 있는데도 이 검사가 필요한가: `default:`를 `case 'home'`과 다시
//     합치거나 `const x: never = route` 한 줄을 지우면 **컴파일러가 조용해진다.** 예전 코드가
//     정확히 그 모양이었고, 화면 없는 라우트 셋이 홈으로 떨어지면서 주소창만 그 라우트를
//     가리켰다. 타입은 규율을 **세우고**, 이 게이트는 그것이 **되돌아가는 것**을 막는다.
//
// 🔴 **정직한 한계**: 이 게이트는 **라우터**만 본다. 화면 안에서 스스로 거는 구독·타이머가
//    정리되는지는 보지 못한다 — 그건 그 화면의 유닛과 실기기 몫이다(§10). 그리고 `isCurrent()`가
//    **올바른 자리**에 있는지(그리기 직전인지)도 못 본다. 존재만 본다.
//    ④도 「case가 있다」까지다 — 그 case가 **옳은 화면**을 그리는지는 못 본다(그건 라이브 몫).
//
// 종료코드: 0 통과 · 1 위반 · 2 전제 미충족(자체검사 실패 포함).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { runSelfTest } from './gate-selftest-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = 'src/main.ts';
const ROUTER = 'src/app/router.ts';

/**
 * 라우트 모집단을 `router.ts`의 `ROUTE_SEGMENTS` 객체 리터럴에서 뽑는다.
 * 🔴 정규식이 아니라 AST로 읽는다 — 주석에 적힌 옛 라우트 이름(`'map'`·`'settings'`)이
 *    이 파일에 그대로 남아 있어, 문자열 검색이면 **주석을 모집단으로 셀** 뻔했다.
 */
export function routeNames(source, fileName = 'router.ts') {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let names = null;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'ROUTE_SEGMENTS' &&
      node.initializer
    ) {
      // `as const`를 벗긴다.
      let init = node.initializer;
      while (ts.isAsExpression(init) || ts.isTypeAssertionExpression?.(init)) init = init.expression;
      if (ts.isObjectLiteralExpression(init)) {
        names = init.properties
          .filter((p) => ts.isPropertyAssignment(p))
          .map((p) => (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null))
          .filter((n) => n !== null);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/** 화면을 그리는 호출로 보는 이름 규칙. 이 저장소의 관행(`renderHome`·`renderTripDetail`)이다. */
const SCREEN_CALL = /^render[A-Z]/;

/**
 * 라우터 콜백 안의 화면 호출을 전부 찾아 **어떻게 불렸는지** 분류한다.
 *
 * 반환: `{ found:boolean, calls:[…], switches:[…] }`
 * - `found` — 라우터 콜백 자체를 찾았는가(못 찾으면 판정 불가)
 * - `mounted` — `screen.mount(...)`의 인자로 들어갔는가
 * - `inAsync` — `.then(...)` 콜백 안에서 그리는가
 * - `guarded` — 그 `.then(...)` 콜백 안에 `isCurrent()`가 있는가
 * - `switches` — `switch (route)` 하나당 `{ cases, hasDefault, neverGuard, line }`
 */
export function analyzeRouter(source, fileName = 'main.ts') {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls = [];
  const switches = [];
  let found = false;

  /** `createRouter(<콜백>)`의 콜백 본문을 찾는다 — 라우터 배선의 유일한 자리다. */
  const routerBodies = [];
  const findRouter = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'createRouter' &&
      node.arguments.length > 0
    ) {
      const cb = node.arguments[0];
      if (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) {
        found = true;
        routerBodies.push(cb.body);
      }
    }
    ts.forEachChild(node, findRouter);
  };
  findRouter(sf);

  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const textOf = (node) => source.slice(node.getStart(sf), node.end);

  for (const body of routerBodies) {
    const walk = (node, thenCb) => {
      // `.then(<콜백>)` 안으로 들어가는지 추적한다 — 비동기 뒤 그리기의 표지.
      let nextThen = thenCb;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'then' &&
        node.arguments.length > 0
      ) {
        const cb = node.arguments[0];
        if (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) nextThen = cb;
      }

      // ④ 라우트 분기 — `switch (route)`의 case 라벨과 exhaustive 가드를 모은다.
      if (ts.isSwitchStatement(node) && ts.isIdentifier(node.expression) && node.expression.text === 'route') {
        const cases = [];
        let hasDefault = false;
        let neverGuard = false;
        for (const clause of node.caseBlock.clauses) {
          if (ts.isCaseClause(clause)) {
            if (ts.isStringLiteralLike(clause.expression)) cases.push(clause.expression.text);
          } else {
            hasDefault = true;
            // `const unhandled: never = route;` — 빠진 case를 컴파일러가 물어보게 만드는 한 줄.
            if (/:\s*never\b/.test(textOf(clause))) neverGuard = true;
          }
        }
        switches.push({ cases, hasDefault, neverGuard, line: lineOf(node) });
      }

      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && SCREEN_CALL.test(node.expression.text)) {
        const parent = node.parent;
        const mounted =
          !!parent &&
          ts.isCallExpression(parent) &&
          ts.isPropertyAccessExpression(parent.expression) &&
          parent.expression.name.text === 'mount';
        calls.push({
          name: node.expression.text,
          mounted,
          inAsync: !!thenCb,
          guarded: thenCb ? /\bisCurrent\s*\(/.test(textOf(thenCb)) : true,
          line: lineOf(node),
        });
      }
      ts.forEachChild(node, (c) => walk(c, nextThen));
    };
    walk(body, null);
  }

  return { found, calls, switches };
}

/**
 * 분석 결과 → 사람이 읽는 위반 목록. 순수 함수라 자체검사가 직접 먹인다.
 *
 * `routes`는 **`router.ts`에서 파생한 라우트 전부**다. 기본값을 두지 않는다 — 기본값은
 * 옛 전제를 못박고, 그 순간 이 검사는 「지금의 라우트」가 아니라 「내가 아는 라우트」를 잰다(§11 ②).
 */
export function violations({ found, calls, switches }, routes, file = ENTRY) {
  if (!found) return { fatal: `${file}에서 createRouter(...) 콜백을 찾지 못했습니다 — 배선이 바뀌었으면 이 게이트를 먼저 고치세요.` };
  if (calls.length === 0) return { fatal: `${file}의 라우터 콜백에서 화면 호출(render*)을 하나도 못 찾았습니다 — 모집단 0은 통과가 아닙니다.` };
  if (!Array.isArray(routes) || routes.length === 0) {
    return { fatal: `${ROUTER}에서 라우트 목록(ROUTE_SEGMENTS)을 읽지 못했습니다 — 모집단 0으로는 라우트 커버리지를 판정할 수 없습니다.` };
  }
  if (switches.length === 0) {
    return { fatal: `${file}의 라우터 콜백에서 switch (route)를 찾지 못했습니다 — 분기 방식이 바뀌었으면 이 게이트를 먼저 고치세요.` };
  }

  const out = [];
  for (const c of calls) {
    if (!c.mounted) {
      out.push(`${file}:${c.line} ${c.name}()이 screen.mount(...)를 거치지 않습니다 — 정리 함수를 아무도 들고 있지 않습니다(M-0158 ②).`);
    }
    if (c.inAsync && !c.guarded) {
      out.push(`${file}:${c.line} ${c.name}()이 비동기(.then) 뒤에 그리는데 isCurrent() 확인이 없습니다 — 늦게 끝난 것이 새 화면을 덮습니다(M-0158 ①).`);
    }
  }
  for (const s of switches) {
    const missing = routes.filter((r) => !s.cases.includes(r));
    if (missing.length) {
      out.push(
        `${file}:${s.line} 라우트 ${missing.map((m) => `'${m}'`).join('·')}이(가) case로 다뤄지지 않습니다 — ` +
          `정의만 된 라우트는 default로 떨어지면서 주소창만 그 라우트를 가리킵니다(T-031 · M-0161).`,
      );
    }
    if (s.hasDefault && !s.neverGuard) {
      out.push(
        `${file}:${s.line} default에 exhaustive 가드(\`const x: never = route\`)가 없습니다 — ` +
          `다음 라우트가 case 없이 조용히 default로 떨어집니다(§7 2층이 없으면 이 결함은 컴파일러에게 안 보입니다).`,
      );
    }
  }
  return { fatal: null, list: out };
}

runSelfTest('check-screen-lifecycle', () => {
  const fails = [];
  const ROUTES = ['home', 'trip-detail'];
  const wrap = (bodyLines) => `const router = createRouter((route, param) => {\n  const screen = screens.begin();\n${bodyLines}\n});`;
  /**
   * ②③ 케이스용 껍데기 — 라우트 분기는 **정상**으로 두고 `trip-detail` 자리에서만 결함을 만든다.
   * 그래야 잡힌 위반이 ②③ 때문인지 ④ 때문인지 섞이지 않는다.
   */
  const inSwitch = (detailBody) => wrap(`  switch (route) {
    case 'trip-detail':
${detailBody}
      break;
    case 'home':
      screen.mount(renderHome(root));
      break;
    default: {
      const unhandled: never = route;
      void unhandled;
      screen.mount(renderHome(root));
      break;
    }
  }`);

  // 정상: 동기 화면은 mount로, 비동기 화면은 isCurrent 뒤에 mount로. 라우트도 전부 case에 있다.
  const good = inSwitch(`      void guard().then((ok) => {
        if (!screen.isCurrent()) return;
        if (ok) screen.mount(renderTripDetail(root, param));
      });`);
  const g = violations(analyzeRouter(good), ROUTES);
  if (g.fatal || g.list.length) fails.push(`정상 배선을 위반으로 셌다: ${g.fatal ?? g.list.join(' / ')}`);
  if (analyzeRouter(good).calls.length !== 3) fails.push('정상 배선에서 화면 호출 3개를 못 셌다');

  // 결함 ①: mount를 안 거친다.
  const bare = violations(analyzeRouter(inSwitch('      renderTripDetail(root, param);')), ROUTES);
  if (!bare.list?.some((v) => v.includes('screen.mount'))) fails.push('맨몸 화면 호출을 못 잡았다');

  // 결함 ②: 비동기 뒤에 세대 확인 없이 그린다(M-0158 고치기 전의 실제 코드 모양).
  const race = violations(analyzeRouter(inSwitch(`      void guard().then((ok) => {
        if (ok) screen.mount(renderTripDetail(root, param));
      });`)), ROUTES);
  if (!race.list?.some((v) => v.includes('isCurrent'))) fails.push('세대 확인 없는 비동기 그리기를 못 잡았다');

  // 결함 ③: 모집단이 0이면 통과시키지 않는다 — 화면 호출·라우터·라우트 목록 셋 다.
  if (!violations(analyzeRouter(wrap('  /* 아무것도 안 그린다 */')), ROUTES).fatal) fails.push('모집단 0을 통과시켰다');
  if (!violations(analyzeRouter('const x = 1;'), ROUTES).fatal) fails.push('라우터가 없는데 통과시켰다');
  if (!violations(analyzeRouter(good), []).fatal) fails.push('라우트 목록이 비었는데 통과시켰다');

  // 결함 ④-a: 정의된 라우트가 case에 없다 — T-031이 실제로 그 모양이었다(정의만 되고 화면은 홈).
  const dead = violations(analyzeRouter(good), [...ROUTES, 'map']);
  if (!dead.list?.some((v) => v.includes("'map'"))) fails.push('case가 없는 라우트를 못 잡았다');

  // 결함 ④-b: default에 exhaustive 가드가 없다 — **고치기 전의 실제 main.ts 모양**이다.
  const legacy = violations(analyzeRouter(wrap(`  switch (route) {
    case 'trip-detail':
      screen.mount(renderTripDetail(root, param));
      break;
    case 'home':
    default:
      screen.mount(renderHome(root));
      break;
  }`)), ROUTES);
  if (!legacy.list?.some((v) => v.includes('never'))) fails.push('exhaustive 가드 없는 default를 못 잡았다');

  // 결함 ④-c: 라우트 분기 자체가 사라지면 판정하지 않는다(통과도 실패도 아니다).
  if (!violations(analyzeRouter(wrap('  screen.mount(renderHome(root));')), ROUTES).fatal) {
    fails.push('switch (route)가 없는데 통과시켰다');
  }

  // 오탐 방지: `screen.mount` 안이면 이름이 무엇이든 통과해야 한다(다음 화면이 자동으로 따라오게).
  const future = violations(analyzeRouter(inSwitch('      screen.mount(renderBrandNewScreen(root));')), ROUTES);
  if (future.fatal || future.list.length) fails.push('새 화면 이름을 오탐했다');

  // 모집단 추출: 객체 리터럴은 읽고, **주석에 남은 옛 라우트 이름은 세지 않는다**(AST로 읽는 이유).
  const routerSrc = `// 예전엔 'map'·'settings'가 있었다\nexport const ROUTE_SEGMENTS = { home: '', 'trip-detail': 'trip' } as const;`;
  const got = routeNames(routerSrc);
  if (JSON.stringify(got) !== JSON.stringify(ROUTES)) fails.push(`라우트 추출이 틀렸다: ${JSON.stringify(got)}`);
  if (routeNames('const other = { a: 1 };') !== null) fails.push('ROUTE_SEGMENTS가 없는데 목록을 만들어 냈다');

  return fails;
});

const src = readFileSync(join(ROOT, ENTRY), 'utf8');
const routes = routeNames(readFileSync(join(ROOT, ROUTER), 'utf8'), ROUTER);
const analysis = analyzeRouter(src, ENTRY);
const result = violations(analysis, routes, ENTRY);

if (result.fatal) {
  console.error(`check-screen-lifecycle: 판정 불가 — ${result.fatal}`);
  process.exit(2);
}
if (result.list.length) {
  console.error('check-screen-lifecycle: 라우터가 화면 생명주기·라우트 커버리지를 지키지 않습니다.');
  for (const v of result.list) console.error(`  - ${v}`);
  console.error('  → 규율은 src/app/screenSession.ts 한 곳에 있습니다. 새 화면도 그것을 거치게 하세요(§7).');
  process.exit(1);
}

const { calls } = analysis;
const asyncN = calls.filter((c) => c.inAsync).length;
console.log(
  `check-screen-lifecycle: OK — 라우터 화면 호출 ${calls.length}개 전부 screen.mount()를 거칩니다(비동기 ${asyncN}개는 isCurrent() 확인 뒤).`,
);
console.log(
  `    ↳ 라우트 ${routes.length}개(${routes.join('·')}) 전부 case로 다뤄지고 default에 exhaustive 가드가 있습니다.`,
);
console.log(
  '    ↳ 정직한 한계: **라우터**만 봅니다 — 화면이 스스로 건 구독·타이머의 정리와 isCurrent()가 올바른 자리인지는 못 봅니다(그건 유닛·실기기 몫).',
);
console.log(
  '    ↳ 그리고 case가 **있다**까지만 봅니다 — 그 case가 옳은 화면을 그리는지는 라이브 검사 몫입니다.',
);
