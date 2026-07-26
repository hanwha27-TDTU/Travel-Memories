// check-verdict-symmetry.mjs — **진단 도구 판정 계약**의 수평 대칭을 정적으로 강제한다.
//
// 왜(실제 사고 2026-07-26, CLAUDE.md 「수평전개와 대칭성」):
// 진단 화면 여섯 개를 적대적으로 리뷰했더니 **같은 결함이 세 곳에서 동형 반복**되고 있었다 —
// 정상 항목을 이상 항목과 같은 무게로 전량 나열하는 형태. 그리고 셋 다 "각자 자기 렌더 코드를
// 가지고 있어서" 생긴 드리프트였다. 사용자가 실기기에서 먼저 봤다("너무 나열되어 있기도 하구요").
//
// 교훈은 M-0006과 **같은 형태**다: 규율을 문서에 적는 것과 구조가 그것을 강제하는 것은 다르다.
// LESSONS §3에 이미 "도메인 대칭성"이 적혀 있었는데도 cascade는 사진·비용만 조용히 빠졌다.
// 그래서 이번엔 세 층으로 간다 — 헌법 조항(CLAUDE.md) + 구조적 강제(공용 렌더러 하나) + 이 게이트.
//
// 검사 항목(전부 실제로 발생한 결함에서 역산했다):
//  A) 지표에 **기대값이 있다.** `actual`만 있고 `expected`가 없는 지표 = 기준 없는 숫자 = 옛 화면.
//  B) 화면 문자열에 **마크다운 리터럴이 없다.** textContent로 그리므로 `**`가 그대로 찍힌다
//     (저장소 경고 문구에서 실제로 노출됐다).
//  C) `.guide-card`를 만드는 코드는 **ic / mid 구조 계약**을 지킨다. 진단 허브만 이 계약을
//     어겨 힌트 텍스트가 16px 셰브론 트랙에 들어가 레이아웃이 깨졌다.
//  D) 진단 도구 등록부의 각 항목이 **필드를 빠짐없이** 갖는다(하나만 조용히 빠지는 게 최빈 결함군).
//  E) 판정 패널이 **옛 나열형 클래스**(r2-row/se-item)로 되돌아가지 않는다 — 공용 렌더러 우회 금지.
//
// 정직한 한계: 정적 검사는 "필드가 있다"까지만 본다. 기대값이 **말이 되는지**는 못 본다.
// 그건 tests/unit/verdict.test.ts가 실제 실행으로, 그리고 사람 리뷰가 본다. 두 층이 함께 있어야 한다.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 강조(`**…**`)를 안전하게 렌더하는 **유일한 경로**. 이게 있어야 문자열 쪽에 규칙을 걸 필요가 없다.
 *
 * ⚠️ 이 게이트 자신의 결함(M-0012): 처음엔 "이 6개 파일에서 `**` 금지"로 만들었다. 대상 파일을
 * **손으로 골랐기 때문에** dataManager·r2Setup·changelog가 통째로 빠졌고, 사용자 화면에 별표가
 * 그대로 찍혔다. CLAUDE.md §7이 "형제 목록을 손으로 세지 말고 등록부·디렉터리에서 뽑으라"고
 * 적힌 그대로의 위반이다. 지금은 규칙을 **렌더러 한 곳**에 두고, 그 렌더러가 살아 있는지와
 * 우회 경로가 없는지를 검사한다.
 */
const RICH_TEXT_RENDERER = 'src/ui/dom.ts';

/** 판정 렌더러를 우회하면 안 되는 파일과, 거기서 금지된 옛 나열형 클래스. */
const NO_LEGACY_ROWS = { file: 'src/ui/panels/diagnostics.ts', banned: ['r2-row', 'r2-table', 'se-item', 'se-findings'] };

// ── 검사 A: 지표에 기대값이 있는가 ──────────────────────────────────────────
/**
 * `actual:` 를 가진 객체 리터럴은 `expected:` 와 `level:` 도 가져야 한다.
 * 객체 경계는 중괄호 깊이로 잡는다(중첩 리터럴을 부모로 오인하지 않게).
 */
export function metricsMissingExpected(src) {
  const bad = [];
  for (const m of src.matchAll(/\bactual:/g)) {
    // 이 `actual:` 을 감싸는 가장 가까운 `{` 를 뒤로 훑어 찾는다.
    let depth = 0;
    let start = -1;
    for (let i = m.index; i >= 0; i--) {
      const c = src[i];
      if (c === '}') depth++;
      else if (c === '{') {
        if (depth === 0) {
          start = i;
          break;
        }
        depth--;
      }
    }
    if (start < 0) continue;
    let d = 0;
    let end = src.length;
    for (let j = start; j < src.length; j++) {
      if (src[j] === '{') d++;
      else if (src[j] === '}') {
        d--;
        if (d === 0) {
          end = j + 1;
          break;
        }
      }
    }
    const obj = src.slice(start, end);
    const missing = ['label:', 'expected:', 'level:'].filter((k) => !obj.includes(k));
    if (missing.length) bad.push(`지표 리터럴에 ${missing.join(', ')} 누락 — 기준 없는 숫자는 판정이 아니다 (…${obj.slice(0, 60).replace(/\s+/g, ' ')}…)`);
  }
  return bad;
}

// ── 검사 B: 강조 문자열이 안전한 렌더러를 **우회**하지 않는가 ──────────────
/**
 * 강조를 담은 문자열을 `.textContent =` 로 직접 넣으면 별표가 그대로 찍힌다(실제 결함).
 * 문자열을 금지하는 대신 **우회 경로**를 금지한다 — 강조는 el()/applyText()/setNote()가 처리한다.
 * 주석은 제외한다(주석의 강조는 화면에 안 나온다).
 */
export function markdownBypass(src) {
  const bad = [];
  const noComments = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  for (const m of noComments.matchAll(/\.textContent\s*=\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
    const body = m[2];
    if (/\*\*[^*]+\*\*/.test(body)) {
      bad.push(`강조 문자열을 textContent로 직접 대입(별표가 화면에 찍힘): "${body.slice(0, 60)}" → el()/applyText()를 쓸 것`);
    }
  }
  return bad;
}

/**
 * **빈 근거 표가 무엇이 없는지 말하는가.**
 *
 * 2026-07-27 사용자: *"사진파일 9개라고 적혀있는데 밑에 '없음' 이건 뭘 의미?"*
 * 접힌 제목은 **가진 것**(파일 9개·기록 9개)을 세고, 펼친 표는 **어긋난 것**을 담는다.
 * 그 한정을 아무도 말하지 않아서, 표가 비면 「없음」 한 단어만 남았다 — 사용자는 그게
 * *"사진이 없다"*인지 *"문제가 없다"*인지 알 수 없다. M-0028과 같은 형태(한정 생략).
 *
 * `table(rows, whenEmpty)`의 두 번째 인자는 **타입이 강제**한다(§7 2층). 그런데 타입은
 * *문자열이 있는가*만 보지 *의미가 있는가*는 못 본다 — `'없음'`을 그대로 넣으면 통과한다.
 * 이 게이트가 그 3층이다: **무엇이 없는지 말하지 않는 빈 문구**를 잡는다.
 */
export function emptyTextIsMeaningless(src) {
  const bad = [];
  // `table(` 호출을 찾아 **괄호를 세어** 그 호출의 끝을 정확히 집는다.
  // 정규식 하나로 `, '...' )`를 잡으면 무관한 호출까지 걸린다 — 오탐은 "빡빡한 게이트"가
  // 아니라 **틀린 게이트**이고, 사람이 무시하기 시작하면 그 게이트는 죽는다(§2-B ③).
  for (let i = src.indexOf('table('); i !== -1; i = src.indexOf('table(', i + 1)) {
    // `table(`이 다른 식별자의 꼬리(예: `renderTable(`)면 건너뛴다.
    if (i > 0 && /[\w$.]/.test(src[i - 1])) continue;
    let depth = 0;
    let end = -1;
    for (let j = i + 5; j < src.length; j++) {
      const c = src[j];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end === -1) continue;
    const call = src.slice(i, end); // 닫는 괄호 직전까지
    // 마지막 인자가 문자열 리터럴인가 — 아니면(변수·템플릿 조립 등) 판단하지 않는다.
    const m = /,\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1\s*,?\s*$/.exec(call);
    if (!m) continue;
    const body = m[2].trim();
    if (!body) {
      bad.push('빈 근거 표의 문구가 비어 있음 — 무엇이 없는지 적을 것');
    } else if (/^(없음|없습니다|-|—|N\/A|해당\s*없음|0개|0건)$/.test(body)) {
      bad.push(
        `빈 근거 표의 문구가 무의미함: "${body}" → **무엇이** 없는지 적을 것` +
          " (예: '짝이 안 맞는 것이 없어요 — 9개가 모두 1:1로 맞습니다')",
      );
    }
  }
  return bad;
}

/** 안전 렌더러가 살아 있는가 — 이게 사라지면 위 규칙 전체가 무너진다. */
export function richTextRendererIntact(src) {
  const bad = [];
  // 주석을 먼저 벗긴다 — dom.ts 머리주석의 "innerHTML 금지"를 사용으로 오탐했다(이 게이트의 오탐 1건).
  // 게이트의 오탐은 신뢰를 깎아 결국 게이트를 끄게 만든다 — 실패만큼 나쁘다.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  if (!/export function applyText\(/.test(code)) bad.push('dom.ts에 applyText()가 없음 — 강조 렌더 경로가 사라졌다');
  if (!/createElement\('strong'\)/.test(code)) bad.push('applyText가 <strong>을 만들지 않음 — 강조가 평문으로 떨어진다');
  if (/innerHTML/.test(code)) bad.push('dom.ts에 innerHTML 사용 — 강조 렌더는 textContent 조각으로만 해야 한다');
  if (!/if \(text !== undefined\) applyText\(node, text\)/.test(code)) bad.push('el()이 applyText를 쓰지 않음 — 대부분의 화면 문자열이 우회한다');
  return bad;
}

// ── 검사 C: guide-card 구조 계약 ────────────────────────────────────────────
export function guideCardContract(src) {
  if (!/'guide-card(?: |')/.test(src)) return [];
  // ⚠️ 부분문자열로 보면 안 된다(이 게이트 자신의 결함, 2026-07-26 주입시험에서 발견):
  // 실제 결함이었던 `guide-card-icon` 은 `guide-card-ic` 를 포함하므로 includes()로는 통과한다.
  // 게이트가 원래 결함을 그대로 통과시키면 게이트가 아니다. 클래스 토큰 경계로 본다.
  const hasClass = (c) => new RegExp(`['"\\s]${c}(?=['"\\s])`).test(src);
  const missing = ['guide-card-ic', 'guide-card-mid'].filter((c) => !hasClass(c));
  return missing.length
    ? [`.guide-card 를 만들면서 ${missing.join(', ')} 를 쓰지 않음 — CSS는 ic/mid/우측 3트랙을 전제한다(레이아웃이 깨진다)`]
    : [];
}

// ── 검사 D: 도구 등록부 필드 완전성 ─────────────────────────────────────────
const TOOL_FIELDS = ['id:', 'icon:', 'label:', 'hint:', 'lead:', 'probe:'];
export function toolRegistryComplete(src) {
  const bad = [];
  for (const m of src.matchAll(/\{\s*\n\s*id:\s*'([\w-]+)'/g)) {
    let d = 0;
    let end = src.length;
    for (let j = m.index; j < src.length; j++) {
      if (src[j] === '{') d++;
      else if (src[j] === '}') {
        d--;
        if (d === 0) {
          end = j + 1;
          break;
        }
      }
    }
    const obj = src.slice(m.index, end);
    const missing = TOOL_FIELDS.filter((f) => !obj.includes(f));
    if (missing.length) bad.push(`진단 도구 '${m[1]}' 에 ${missing.join(', ')} 누락 — 한 도구만 조용히 빠지는 게 최빈 결함군이다`);
  }
  return bad;
}

// ── 검사 E: 공용 렌더러 우회 ────────────────────────────────────────────────
export function legacyRows(src, banned) {
  return banned.filter((c) => src.includes(`'${c}`) || src.includes(` ${c}'`)).map((c) => `옛 나열형 클래스 '${c}' 사용 — 판정 렌더러(renderTool)를 우회하고 있다`);
}

// ── 검사 F: 영구삭제의 **순서 계약** (ADR-0030) ─────────────────────────────
/**
 * 영구삭제는 되돌릴 수 없는 유일한 경로다. 여기선 "무엇을 하는가"보다 **"어떤 순서로 하는가"**가
 * 안전을 결정하고, 순서는 코드를 훑어봐선 틀린 줄 모른다 — 그래서 게이트가 본다.
 *
 *  · 원장(`ledgerAdd`)을 **지우기 전에** 적어야 한다. 뒤집히면 그 틈에 밀린 편집을 가진 다른
 *    기기가 자기 사본을 다시 올려 좀비가 된다(ADR-0027이 하드 삭제를 기각했던 바로 그 이유).
 *  · 사진 경로(`familyMediaPaths`·`mediaPath`)와 자식 id(`familyIds`)는 **지우기 전에** 읽어야
 *    한다. 행이 사라지면 경로도 사라지고, 그러면 R2에 고아 파일이 영영 남는다.
 */
export function purgeOrderContract(syncSrc) {
  const bad = [];
  const body = syncSrc.match(/export async function pushPurges\([\s\S]*?\n\}/);
  if (!body) return ['sync.ts에서 pushPurges를 찾지 못함 — 영구삭제 경로가 사라졌다'];
  const src = body[0];
  const at = (needle) => src.indexOf(needle);
  const del = Math.min(
    ...['remote.hardDelete(', 'remote.hardDeleteFamily('].map(at).filter((i) => i !== -1),
    Infinity,
  );
  if (del === Infinity) return ['pushPurges가 서버 행을 지우지 않음 — 영구삭제가 표식만 남기던 옛 동작이다'];

  const ledger = at('remote.ledgerAdd(');
  if (ledger === -1) bad.push('pushPurges가 원장에 적지 않음 — 다른 기기가 영구삭제를 배울 길이 없다');
  else if (ledger > del) bad.push('원장 기록이 행 삭제 **뒤**에 있음 — 그 틈에 다른 기기가 사본을 다시 올린다');

  for (const q of ['remote.familyMediaPaths(', 'remote.mediaPath(', 'remote.familyIds(']) {
    const i = at(q);
    if (i === -1) bad.push(`pushPurges가 ${q}…)를 부르지 않음 — 지운 뒤엔 알 수 없는 정보다`);
    else if (i > del) bad.push(`${q}…) 가 행 삭제 **뒤**에 있음 — 행이 사라지면 그 값도 사라진다`);
  }

  // read-back — 성공 응답이 아니라 **되읽어** 확인한다(데이터 안전 불변식).
  for (const q of ['remote.stillThere(', 'remote.remainingInFamily(', 'remote.ledgerHas(']) {
    if (at(q) === -1) bad.push(`pushPurges에 read-back ${q}…)가 없음 — 200 응답을 완료로 믿는다`);
  }
  return bad;
}

/**
 * 다른 기기의 영구삭제는 **원장으로만** 배운다 — 서버 행이 없으므로 pull은 그 사실을 볼 수 없다.
 * `runSync`가 원장을 적용하지 않으면 지운 여행이 그 기기 휴지통에 영원히 남는다.
 */
export function runSyncAppliesLedger(syncSrc) {
  const body = syncSrc.match(/export async function runSync\([\s\S]*?\n\}/);
  if (!body) return ['sync.ts에서 runSync를 찾지 못함'];
  const bad = [];
  if (!/applyPurgedLedger\(/.test(body[0])) {
    bad.push('runSync가 applyPurgedLedger를 부르지 않음 — 다른 기기의 영구삭제를 영영 못 배운다');
  }
  if (!/ledgerAll\(/.test(body[0])) bad.push('runSync가 서버 원장을 읽지 않음');
  return bad;
}

/**
 * `purged_at` **컬럼**은 마이그레이션 0012에서 사라졌다(ADR-0030). 남아 있는 참조는 주석이
 * 아니라 **런타임 오류**다 — PostgREST가 없는 컬럼을 400으로 되돌린다. 실제로 이 전환에서
 * `storeState.ts`가 그 상태로 남을 뻔했다. 원장 테이블(`purged_ids`)의 자기 컬럼은 예외다.
 */
export function noDroppedPurgedAtColumn(files) {
  const bad = [];
  for (const [rel, src] of files) {
    for (const line of src.split('\n')) {
      if (!/purged_at/.test(line)) continue;
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue; // 주석은 역사 기록이라 남겨 둔다
      if (/purged_ids/.test(line)) continue; // 원장 자신의 컬럼
      bad.push(`${rel}: 사라진 컬럼 purged_at을 조회함 — 서버가 400으로 거절한다`);
    }
  }
  return bad;
}

/**
 * **목록 조회의 범위는 서버가 못박는다**(supabase-security-dev §2.8, 2026-07-26 신설).
 *
 * 단건 op(put/get/delete)는 키를 서버가 만들어 남의 폴더를 못 가리킨다. 그런데 목록은
 * **prefix 하나로 버킷 전체가 열린다** — R2엔 RLS가 없으므로 이 한 줄이 마지막 벽이다.
 * 그래서 요청 본문의 prefix/delimiter/bucket을 **무시가 아니라 아예 파싱하지 않는다**:
 * 파싱해 두면 다음 사람이 언젠가 쓰게 되고, 그 순간 벽이 사라진다.
 *
 * 목록 서명 URL을 브라우저로 내보내는 것도 막는다 — 그 URL 자체가 "이 접두사 아래 전부"다.
 */
export function listPrefixIsServerBuilt(fnSrc) {
  const bad = [];
  const body = fnSrc.match(/if \(op === 'list'\)[\s\S]*?\n  \}/);
  if (!body) return ['media-sign에 list op이 없음 — 진단이 서버 사진 목록을 물어볼 수 없다'];
  const src = body[0];

  if (!/const prefix = `\$\{userId\}\//.test(src)) {
    bad.push("list의 prefix가 `${userId}/`가 아님 — 남의 폴더가 열릴 수 있다");
  }
  // 주석을 걷어낸 뒤 본다(주석의 '하지 마라'를 위반으로 읽지 않게 — 실제로 겪은 오탐이다).
  const code = fnSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const f of ['prefix', 'delimiter', 'bucket']) {
    if (new RegExp(`body\\.${f}\\b`).test(code) || new RegExp(`\\b${f}\\?:\\s*unknown`).test(code)) {
      bad.push(`요청 본문에서 ${f}를 파싱함 — 목록 범위를 클라이언트가 정하게 된다`);
    }
  }
  // 목록 URL은 함수가 쓰고 버린다. 응답에 실어 보내면 접두사 전체 권한이 브라우저로 나간다.
  if (/return json\(\s*\{[^}]*\burl\b/.test(src)) {
    bad.push('list 응답에 서명 URL이 담김 — 접두사 전체 권한이 브라우저로 나간다');
  }
  // 잘렸으면 잘렸다고 말해야 한다. 안 그러면 그 위의 "고아 0건" 판정이 거짓말이 된다.
  if (!/truncated/.test(src)) bad.push('list가 truncated를 보고하지 않음 — 다 못 봤는데 "없다"로 읽힌다');
  return bad;
}

// ── 검사 H: 오버레이/모달 계약 ───────────────────────────────────────────────
/**
 * 실제 사고(2026-07-26, 사용자 실기기 가로 태블릿): 사진 편집 모달의 **상하가 잘리고 여백이
 * 없었다**. 세 오버레이가 같은 규칙을 각자 구현했고 셋이 서로 달랐다 — `.guide-overlay`만
 * 배웠고 `.pe-overlay`는 못 배웠다(§7의 교과서적 사례).
 *
 * 두 가지가 원인이다:
 *  ① `vh` — 모바일에서 `vh`는 주소창을 포함한 레이아웃 뷰포트라 **실제 보이는 높이보다 크다**.
 *  ② `place-items: center` + 넘침 — 위아래로 똑같이 삐져나가 **스크롤로도 닿지 못한다**.
 *
 * 라이브 렌더는 이걸 재현하지 못한다(헤드리스엔 주소창이 없어 vh == 실제 높이). 그래서
 * 기하가 아니라 **계약을 정적으로** 잠근다 — 이 게이트가 이 부류의 본 방어선이다.
 */
export function overlayContract(css) {
  const bad = [];
  const base = css.match(/\.overlay-base\s*\{([^}]*)\}/);
  if (!base) return ['.overlay-base 가 없음 — 오버레이 공용 계약이 사라졌다'];
  const body = base[1];
  if (!/overflow-y:\s*auto/.test(body)) bad.push('.overlay-base 에 overflow-y:auto 없음 — 넘친 내용에 닿을 수 없다');
  if (/place-items:\s*center/.test(body) || /align-items:\s*center/.test(body)) {
    bad.push('.overlay-base 가 세로 중앙정렬 — 넘치면 위아래로 삐져나가 스크롤로도 닿지 못한다');
  }
  if (!/env\(safe-area-inset/.test(body)) bad.push('.overlay-base 에 safe-area 여백 없음');

  const modal = css.match(/\.modal-base\s*\{([^}]*)\}/);
  if (!modal) bad.push('.modal-base 가 없음');
  else if (!/dvh/.test(modal[1])) bad.push('.modal-base 가 dvh를 쓰지 않음 — vh는 주소창을 포함해 실제보다 크다');

  // 개별 오버레이/모달이 계약을 되돌려 자기 규칙을 갖지 않는지.
  for (const m of css.matchAll(/\.([a-z-]*(?:overlay|modal|sheet))\s*\{([^}]*)\}/g)) {
    const [name, decl] = [m[1], m[2]];
    if (name === 'overlay-base' || name === 'modal-base') continue;
    if (/(?:max-)?height:[^;]*\b\d+vh/.test(decl)) {
      bad.push(`.${name} 가 높이에 vh 사용 — dvh를 쓰거나 .modal-base 에 맡길 것`);
    }
    if (/position:\s*fixed/.test(decl) && /place-items:\s*center/.test(decl)) {
      bad.push(`.${name} 가 자기 중앙정렬 규칙을 가짐 — .overlay-base 를 쓸 것(규칙을 두 번 쓰지 않는다)`);
    }
  }
  return bad;
}

// ── 검사 I: 시맨틱 틴트 위 원색 텍스트 금지 ─────────────────────────────────
/**
 * 실제 사고(2026-07-26): 시맨틱색 12~15% 틴트 배경 위에 **같은 색 원색 텍스트**를 쓰면
 * 라이트 테마에서 대비가 2.5~3.0:1로 무너진다(필요 4.5:1). 다크에서는 통과라 **다크에서만
 * 확인하면 안 보인다**(LESSONS §5 전형).
 *
 * v0.69에서 이 부류를 고쳤는데 **손으로 고른 규칙만 고쳤다.** 이번에 사용자 화면의 칩
 * (`📍 김포국제공항`·`💰 50,000 so'm`)이 그대로 남아 있는 것을 정독 중에 발견했다 —
 * M-0012와 정확히 같은 형태다. 그래서 규칙을 **기계가 전수 검사**하게 바꾼다.
 *
 * ⚠️ `border-left-color:`도 "color:"를 부분문자열로 포함한다 — 선언 경계를 봐야 오탐이 없다
 * (M-0011과 같은 함정).
 */
export function semanticTintContrast(css) {
  const bad = [];
  for (const m of css.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
    const [sel, decl] = [m[1].trim().split('\n').pop().trim(), m[2]];
    for (const hue of ['teal', 'sky', 'pink']) {
      const tinted = new RegExp(`background[^;]*--sem-${hue}\\)`).test(decl);
      const rawInk = new RegExp(`(?:^|[;{])\\s*color:\\s*var\\(--sem-${hue}\\)`).test(decl);
      if (tinted && rawInk) {
        bad.push(`${sel}: --sem-${hue} 틴트 위에 원색 텍스트 — 라이트에서 대비 미달. --sem-${hue}-ink 를 쓸 것`);
      }
    }
  }
  return bad;
}

// ── 검사 J: 상태를 바꾸는 화면은 동기화를 요청하는가 ────────────────────────
/**
 * 실제 사고(2026-07-26): `dataManager.ts`가 `runSync`를 **아예 import하지 않아** 휴지통 복원·
 * 영구삭제·백업 복원 뒤에 동기화가 일어나지 않았다. 영구삭제 전파(ADR-0027)를 만들어 놓고도
 * 그 op가 큐에 앉아만 있었다 — 사용자가 2기기 테스트를 했다면 실패했을 것이다.
 *
 * 근본형은 늘 같다: **로컬만 바꾸고 서버에 알리지 않음.** `check-domain-symmetry`가 서비스
 * 계층에서 이걸 잡는데(모든 *LocalFirst는 큐 op를 만든다), **화면 계층엔 같은 방어가 없었다.**
 * 큐에 op가 들어가도 아무도 push를 부르지 않으면 결과는 똑같다.
 *
 * 그래서 로컬 상태를 바꾸는 함수를 import하는 화면은 `requestSync`도 import해야 한다.
 */
const MUTATING_IMPORTS = /(LocalFirst|purgeTripPermanently|restoreTripFromTrash|importBackupAuto)/;

export function screensRequestSync(files) {
  const bad = [];
  for (const [name, src] of files) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const imports = [...code.matchAll(/import\s*\{([^}]*)\}\s*from/g)].map((m) => m[1]).join(',');
    if (!MUTATING_IMPORTS.test(imports)) continue;
    // ⚠️ 본문에 이름이 보이는 것으로는 부족하다(이 게이트 자신의 결함, 주입시험에서 발견):
    // import만 지워도 호출문이 남아 통과했다. **import 목록**에서 확인한다.
    const hasImport = /(^|[,\s])requestSync(Soon)?([,\s]|$)/.test(imports);
    const hasCall = /requestSync(Soon)?\s*\(/.test(code);
    if (!hasImport || !hasCall) {
      bad.push(`${name}: 로컬 상태를 바꾸면서 requestSync를 import·호출하지 않음 — 그 변경은 다른 기기에 영영 안 간다`);
    }
  }
  return bad;
}

/** 동기화 실행 규칙은 autoSync 한 곳에만 — 화면이 runSync를 직접 부르면 중복·오류삼킴이 재발한다. */
export function noDirectRunSync(files) {
  const bad = [];
  for (const [name, src] of files) {
    if (/from '[^']*services\/sync'/.test(src) && /\brunSync\b/.test(src)) {
      bad.push(`${name}: runSync를 직접 호출 — autoSync.requestSync를 쓸 것(단일 실행·상태 보고가 거기 있다)`);
    }
  }
  return bad;
}

// ── 셀프테스트: 알려진 실패가 RED로 잡히는지(게이트 비공허, CLAUDE.md §4) ──
/** 셀프테스트 통과 수 — **손으로 세지 않는다.** 아래 로그가 이 값을 읽는다. */
let selfTestCount = 0;
{
  const cases = [
    { name: '정상 지표 통과', fn: () => metricsMissingExpected(`const m = { label: 'a', actual: '1', expected: '0', level: 'ok' };`), clean: true },
    {
      name: '기대값 누락 검출(실제 결함 — 옛 진단 5줄)',
      fn: () => metricsMissingExpected(`const m = { label: 'a', actual: '1', level: 'ok' };`),
      clean: false,
    },
    {
      name: '중첩 리터럴을 부모로 오인하지 않는다',
      fn: () => metricsMissingExpected(`const v = { meta: { x: 1 }, label: 'a', actual: '1', expected: '0', level: 'ok' };`),
      clean: true,
    },
    { name: 'el()로 넘기는 강조 문자열은 정상', fn: () => markdownBypass(`el('p', 'x', '**이 기기**를 비웁니다');`), clean: true },
    {
      name: '빈 표 문구가 무엇이 없는지 말하면 정상',
      fn: () => emptyTextIsMeaningless(`return table(rows, '짝이 안 맞는 것이 없어요 — 9개가 모두 1:1로 맞습니다');`),
      clean: true,
    },
    {
      name: "빈 표 문구가 '없음' 한 단어면 검출(실제 결함 — 2026-07-27 사용자 지적)",
      fn: () => emptyTextIsMeaningless(`return table(rows, '없음');`),
      clean: false,
    },
    {
      name: '빈 문자열도 검출',
      fn: () => emptyTextIsMeaningless(`return table(rows, '');`),
      clean: false,
    },
    {
      name: 'textContent 직접 대입 검출(실제 결함 — 별표 노출)',
      fn: () => markdownBypass(`n.textContent = '브라우저가 **앱 데이터를 지울 수 있습니다.**';`),
      clean: false,
    },
    { name: '주석 안 강조는 결함이 아니다', fn: () => markdownBypass(`// 이것은 **강조**된 주석이다\nconst t = '평범한 문자열';`), clean: true },
    { name: '강조 없는 textContent 대입은 무관', fn: () => markdownBypass(`n.textContent = '평범한 값';`), clean: true },
    {
      name: '안전 렌더러 온전(주석의 innerHTML 언급은 오탐이 아니다)',
      fn: () => richTextRendererIntact(`// innerHTML 금지\nexport function applyText(n,t){ document.createElement('strong'); }\n if (text !== undefined) applyText(node, text);`),
      clean: true,
    },
    {
      name: '안전 렌더러 제거 검출(규칙 전체가 무너지는 경우)',
      fn: () => richTextRendererIntact(`export function el(){ node.textContent = text; }`),
      clean: false,
    },
    {
      name: 'innerHTML로 바뀌면 검출(XSS 경로)',
      fn: () => richTextRendererIntact(`export function applyText(n,t){ n.innerHTML = t; document.createElement('strong'); }\n if (text !== undefined) applyText(node, text);`),
      clean: false,
    },
    {
      name: 'guide-card 계약 통과',
      fn: () => guideCardContract(`el('button', 'guide-card'); el('span','guide-card-ic'); el('span','guide-card-mid');`),
      clean: true,
    },
    {
      name: 'guide-card 계약 위반 검출(실제 결함 — 진단 허브)',
      fn: () => guideCardContract(`el('button', 'guide-card'); el('span','guide-card-icon'); el('span','guide-card-label');`),
      clean: false,
    },
    { name: 'guide-card 를 안 쓰는 파일은 무관', fn: () => guideCardContract(`el('div', 'other');`), clean: true },
    {
      // 이 게이트 자신의 결함: 부분문자열 검사는 원래 결함(guide-card-icon)을 통과시켰다.
      name: '부분문자열 통과를 막는다(guide-card-icon ≠ guide-card-ic)',
      fn: () => guideCardContract(`el('button','guide-card'); el('span','guide-card-icon'); el('span','guide-card-mid');`),
      clean: false,
    },
    {
      name: '도구 등록부 완전',
      fn: () => toolRegistryComplete(`const T = [{\n  id: 'a', icon: 'x', label: 'L', hint: 'h', lead: 'l', probe: p,\n}];`),
      clean: true,
    },
    {
      name: '도구 필드 누락 검출(형제엔 있는데 하나만 빠짐)',
      fn: () => toolRegistryComplete(`const T = [{\n  id: 'a', icon: 'x', label: 'L', hint: 'h', probe: p,\n}];`),
      clean: false,
    },
    { name: '옛 나열형 클래스 없음', fn: () => legacyRows(`el('div', 'vd-metric')`, ['r2-row', 'se-item']), clean: true },
    { name: '옛 나열형 클래스 검출(렌더러 우회)', fn: () => legacyRows(`el('div', 'r2-row')`, ['r2-row', 'se-item']), clean: false },
    {
      name: '영구삭제 순서 계약 정상(원장·조회가 삭제보다 앞)',
      fn: () =>
        purgeOrderContract(
          `export async function pushPurges(remote, bytes) {
             await remote.familyIds(x); await remote.familyMediaPaths(x); await remote.mediaPath(x);
             await remote.ledgerAdd(ids); await remote.ledgerHas(x);
             await remote.hardDeleteFamily(x); await remote.hardDelete(d, x);
             await remote.stillThere(d, x); await remote.remainingInFamily(x);
}`,
        ),
      clean: true,
    },
    {
      name: '원장이 삭제 뒤에 있으면 검출(좀비가 돌아오는 창)',
      fn: () =>
        purgeOrderContract(
          `export async function pushPurges(remote, bytes) {
             await remote.familyIds(x); await remote.familyMediaPaths(x); await remote.mediaPath(x);
             await remote.hardDeleteFamily(x); await remote.hardDelete(d, x);
             await remote.ledgerAdd(ids); await remote.ledgerHas(x);
             await remote.stillThere(d, x); await remote.remainingInFamily(x);
}`,
        ),
      clean: false,
    },
    {
      name: '사진 경로 조회가 삭제 뒤에 있으면 검출(R2 고아 파일)',
      fn: () =>
        purgeOrderContract(
          `export async function pushPurges(remote, bytes) {
             await remote.familyIds(x); await remote.ledgerAdd(ids); await remote.ledgerHas(x);
             await remote.hardDeleteFamily(x); await remote.hardDelete(d, x);
             await remote.familyMediaPaths(x); await remote.mediaPath(x);
             await remote.stillThere(d, x); await remote.remainingInFamily(x);
}`,
        ),
      clean: false,
    },
    {
      name: 'read-back 누락 검출(200 응답을 완료로 믿음)',
      fn: () =>
        purgeOrderContract(
          `export async function pushPurges(remote, bytes) {
             await remote.familyIds(x); await remote.familyMediaPaths(x); await remote.mediaPath(x);
             await remote.ledgerAdd(ids); await remote.ledgerHas(x);
             await remote.hardDeleteFamily(x); await remote.hardDelete(d, x);
}`,
        ),
      clean: false,
    },
    {
      name: 'runSync가 원장을 적용하면 정상',
      fn: () => runSyncAppliesLedger(`export async function runSync(c, u) {\n  const l = await p.ledgerAll();\n  await applyPurgedLedger(l.ids);\n}`),
      clean: true,
    },
    {
      name: 'runSync가 원장을 안 읽으면 검출(다른 기기가 영영 못 배움)',
      fn: () => runSyncAppliesLedger(`export async function runSync(c, u) {\n  await pullTrips(r);\n}`),
      clean: false,
    },
    {
      name: '사라진 purged_at 컬럼 참조 없음',
      fn: () => noDroppedPurgedAtColumn([['a.ts', `.is('deleted_at', null)`]]),
      clean: true,
    },
    {
      name: '사라진 purged_at 컬럼 참조 검출(서버가 400으로 거절)',
      fn: () => noDroppedPurgedAtColumn([['a.ts', `.is('purged_at', null);`]]),
      clean: false,
    },
    {
      name: '원장 테이블 자신의 컬럼은 예외',
      fn: () => noDroppedPurgedAtColumn([['a.ts', `from('purged_ids').select('id, purged_at')`]]),
      clean: true,
    },
    {
      name: '목록 prefix가 서버 것이면 정상',
      fn: () => listPrefixIsServerBuilt(`if (op === 'list') {
    const prefix = \`\${userId}/\`;
    const truncated = false;
    return json({ ids, foreign, truncated, count: ids.length });
  }`),
      clean: true,
    },
    {
      name: '본문 prefix를 파싱하면 검출(버킷 전체가 열리는 실제 위험)',
      fn: () =>
        listPrefixIsServerBuilt(
          `const b = body.prefix;
if (op === 'list') {
    const prefix = b ?? \`\${userId}/\`;
    const truncated = false;
    return json({ ids, truncated });
  }`,
        ),
      clean: false,
    },
    {
      name: '목록 서명 URL을 응답에 담으면 검출',
      fn: () =>
        listPrefixIsServerBuilt(
          `if (op === 'list') {
    const prefix = \`\${userId}/\`;
    const truncated = false;
    return json({ url, ids, truncated });
  }`,
        ),
      clean: false,
    },
    {
      name: 'truncated 미보고 검출(다 못 봤는데 "없다"로 읽힘)',
      fn: () =>
        listPrefixIsServerBuilt(
          `if (op === 'list') {
    const prefix = \`\${userId}/\`;
    return json({ ids, count: ids.length });
  }`,
        ),
      clean: false,
    },
    {
      name: '오버레이 계약 정상',
      fn: () =>
        overlayContract(
          `.overlay-base { position: fixed; align-items: flex-start; overflow-y: auto; padding: max(12px, env(safe-area-inset-top,0)); }
           .modal-base { max-height: calc(100dvh - 24px); }`,
        ),
      clean: true,
    },
    {
      name: 'vh 사용 검출(실제 결함 — 상하 잘림)',
      fn: () =>
        overlayContract(
          `.overlay-base { position: fixed; align-items: flex-start; overflow-y: auto; padding: max(12px, env(safe-area-inset-top,0)); }
           .modal-base { max-height: calc(100dvh - 24px); }
           .pe-sheet { max-height: 96vh; }`,
        ),
      clean: false,
    },
    {
      name: '중앙정렬+넘침 검출(스크롤로도 못 닿는 형태)',
      fn: () =>
        overlayContract(
          `.overlay-base { position: fixed; place-items: center; overflow-y: auto; padding: max(12px, env(safe-area-inset-top,0)); }
           .modal-base { max-height: calc(100dvh - 24px); }`,
        ),
      clean: false,
    },
    {
      name: '오버레이 스크롤 누락 검출',
      fn: () =>
        overlayContract(
          `.overlay-base { position: fixed; align-items: flex-start; padding: max(12px, env(safe-area-inset-top,0)); }
           .modal-base { max-height: calc(100dvh - 24px); }`,
        ),
      clean: false,
    },
    { name: '-ink 변형을 쓰면 정상', fn: () => semanticTintContrast(`.a { background: color-mix(in srgb, var(--sem-teal) 12%, transparent); color: var(--sem-teal-ink); }`), clean: true },
    {
      name: '틴트 위 원색 텍스트 검출(실제 결함 — 화면의 칩)',
      fn: () => semanticTintContrast(`.chip.money { background: color-mix(in srgb, var(--sem-teal) 15%, transparent); color: var(--sem-teal); }`),
      clean: false,
    },
    {
      name: 'border-left-color를 color로 오인하지 않는다(오탐 방지)',
      fn: () => semanticTintContrast(`.a { border-left-color: var(--sem-teal); background: color-mix(in srgb, var(--sem-teal) 7%, var(--bg-2)); }`),
      clean: true,
    },
    { name: '틴트 없이 원색 텍스트만 쓰는 것은 무관', fn: () => semanticTintContrast(`.a { color: var(--sem-sky); }`), clean: true },
    {
      name: '변경 화면이 동기화를 요청하면 정상',
      fn: () => screensRequestSync([['a.ts', `import { purgeTripPermanently } from 'x';\nimport { requestSync } from 'y';\nrequestSync('z');`]]),
      clean: true,
    },
    {
      name: '동기화 누락 검출(실제 결함 — dataManager)',
      fn: () => screensRequestSync([['a.ts', `import { purgeTripPermanently, restoreTripFromTrash } from 'x';\npurgeTripPermanently(id);`]]),
      clean: false,
    },
    {
      // 이 게이트 자신의 결함: 본문 등장만 보면 import를 지워도 통과했다.
      name: 'import 없이 호출문만 남은 경우도 검출',
      fn: () => screensRequestSync([['a.ts', `import { purgeTripPermanently } from 'x';\nrequestSync('z');`]]),
      clean: false,
    },
    { name: '변경하지 않는 화면은 무관', fn: () => screensRequestSync([['a.ts', `import { listTrips } from 'x';`]]), clean: true },
    { name: 'runSync 직접 호출 검출', fn: () => noDirectRunSync([['a.ts', `import { runSync } from '../../services/sync';\nrunSync(c,u);`]]), clean: false },
    { name: 'autoSync 경유는 정상', fn: () => noDirectRunSync([['a.ts', `import { requestSync } from '../../services/autoSync';`]]), clean: true },
  ];
  const broken = cases.filter((c) => (c.fn().length === 0) !== c.clean);
  if (broken.length) {
    console.error(`check-verdict-symmetry: 셀프테스트 실패 — 게이트가 공허함: ${broken.map((c) => c.name).join(', ')}`);
    process.exit(2);
  }
  selfTestCount = cases.length;
}

// ── 실제 검사 ───────────────────────────────────────────────────────────────
const problems = [];
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

for (const p of richTextRendererIntact(read(RICH_TEXT_RENDERER))) problems.push(`${RICH_TEXT_RENDERER}: ${p}`);
for (const p of metricsMissingExpected(read('src/ui/panels/diagnostics.ts'))) problems.push(`src/ui/panels/diagnostics.ts: ${p}`);
for (const p of toolRegistryComplete(read('src/ui/panels/diagnostics.ts'))) problems.push(`src/ui/panels/diagnostics.ts: ${p}`);
for (const p of legacyRows(read(NO_LEGACY_ROWS.file), NO_LEGACY_ROWS.banned)) problems.push(`${NO_LEGACY_ROWS.file}: ${p}`);

for (const p of overlayContract(read('src/ui/styles/app.css'))) problems.push(`src/ui/styles/app.css: ${p}`);
for (const p of semanticTintContrast(read('src/ui/styles/app.css'))) problems.push(`src/ui/styles/app.css: ${p}`);

for (const p of purgeOrderContract(read('src/services/sync.ts'))) problems.push(`src/services/sync.ts: ${p}`);
{
  const rel = 'supabase/functions/media-sign/index.ts';
  for (const p of listPrefixIsServerBuilt(read(rel))) problems.push(`${rel}: ${p}`);
}
for (const p of runSyncAppliesLedger(read('src/services/sync.ts'))) problems.push(`src/services/sync.ts: ${p}`);
// 손으로 고른 목록이 아니라 **src 전체**에 건다 — 하나만 조용히 남는 게 이 저장소의 최빈 결함군이다.
{
  const all = walk(join(ROOT, 'src')).map((abs) => [relative(ROOT, abs), readFileSync(abs, 'utf8')]);
  for (const p of noDroppedPurgedAtColumn(all)) problems.push(p);
}

// 동기화 배선은 **모든 화면 파일**에 건다(손으로 고르지 않는다 — 그게 M-0012의 원인이었다).
{
  const screenFiles = walk(join(ROOT, 'src/ui')).map((abs) => [relative(ROOT, abs), readFileSync(abs, 'utf8')]);
  for (const p of screensRequestSync(screenFiles)) problems.push(p);
  // autoSync 자신과 진단 도구의 [지금 동기화]는 예외 — 전자는 규칙의 정의처이고,
  // 후자는 사용자가 **직접 누르는** 수동 경로라 자동 배선 대상이 아니다.
  const direct = screenFiles.filter(([n]) => !n.endsWith('panels/diagnostics.ts'));
  for (const p of noDirectRunSync(direct)) problems.push(p);
}

// guide-card 계약은 그것을 만드는 **모든** 화면에 건다(수평전개 — 한 곳만 고치고 끝내지 않는다).
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith('.ts')) out.push(p);
  }
  return out;
}
let cardFiles = 0;
for (const abs of walk(join(ROOT, 'src/ui'))) {
  const src = readFileSync(abs, 'utf8');
  if (/'guide-card(?: |')/.test(src)) cardFiles++;
  for (const p of guideCardContract(src)) problems.push(`${relative(ROOT, abs)}: ${p}`);
}

// 우회 경로 검사는 **src 전체**에 건다 — 손으로 고른 목록이 바로 M-0012의 원인이었다.
let scanned = 0;
for (const abs of walk(join(ROOT, 'src'))) {
  scanned++;
  const text = readFileSync(abs, 'utf8');
  for (const p of markdownBypass(text)) problems.push(`${relative(ROOT, abs)}: ${p}`);
  if (/\btable\(/.test(text)) {
    for (const p of emptyTextIsMeaningless(text)) problems.push(`${relative(ROOT, abs)}: ${p}`);
  }
}

if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('check-verdict-symmetry: 진단 판정 계약 위반 — 도구 간 대칭이 깨졌다.');
  process.exit(1);
}
console.log(`check-verdict-symmetry: OK (셀프테스트 ${selfTestCount}건 통과 · 강조 렌더러 온전 · src ${scanned}개 파일 우회 0 · guide-card 화면 ${cardFiles}곳 계약 준수 · 지표 기대값·도구 필드 정상)`);
