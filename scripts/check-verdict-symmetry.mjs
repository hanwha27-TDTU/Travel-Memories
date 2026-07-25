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

// ── 검사 F: 네 pull이 **전부** 원격 영구삭제를 적용하는가 ────────────────────
/**
 * 삭제 결함의 최빈 형태는 "형제 넷 중 하나만 조용히 빠짐"이다(M-0006·M-0007·M-0012).
 * 영구삭제 전파(ADR-0027)도 같은 함정을 갖는다 — pull 하나가 `purged_at`을 안 보면 그 도메인만
 * 다른 기기에 남는다. 도메인 목록을 손으로 적지 않고 **purge.ts의 등록부에서 뽑아** 대조한다.
 */
export function pullsApplyRemotePurge(syncSrc, purgeSrc) {
  const bad = [];
  const m = purgeSrc.match(/export const PURGE_DOMAINS = \[([^\]]+)\]/);
  if (!m) return ['purge.ts에서 PURGE_DOMAINS를 찾지 못함 — 등록부가 사라졌다'];
  const domains = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
  if (domains.length === 0) return ['PURGE_DOMAINS가 비어 있음'];
  for (const d of domains) {
    if (!new RegExp(`applyRemotePurge\\(\\s*'${d}'`).test(syncSrc)) {
      bad.push(`pull이 '${d}' 도메인의 원격 영구삭제를 적용하지 않음 — 그 종류만 다른 기기에 남는다`);
    }
  }
  // purged_at 검사가 purged.has() 보다 **앞**에 와야 한다(표식이 없는 기기가 여기서 처음 알게 되므로).
  const firstPurgedAt = syncSrc.indexOf('r.purged_at');
  const firstHas = syncSrc.indexOf('purged.has(r.id)');
  if (firstPurgedAt === -1) bad.push('pull에 purged_at 검사가 없음');
  else if (firstHas !== -1 && firstPurgedAt > firstHas) {
    bad.push('purged_at 검사가 purged.has() 뒤에 있음 — 표식이 없는 기기가 영구삭제를 못 배운다');
  }
  return bad;
}

/** toRow가 purged_at을 담으면 평범한 upsert가 다른 기기의 영구삭제를 null로 덮어쓴다. */
export function toRowNeverSendsPurgedAt(src) {
  const m = src.match(/export function to\w*Row\([\s\S]*?\n\}/);
  if (!m) return [];
  return /purged_at/.test(m[0])
    ? ['toRow()가 purged_at을 담음 — 평범한 upsert가 다른 기기의 영구삭제를 되살린다']
    : [];
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

// ── 셀프테스트: 알려진 실패가 RED로 잡히는지(게이트 비공허, CLAUDE.md §4) ──
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
      name: '네 pull이 모두 원격 영구삭제 적용',
      fn: () =>
        pullsApplyRemotePurge(
          `if (r.purged_at) applyRemotePurge('trip', x); purged.has(r.id);
           applyRemotePurge('moment', x); applyRemotePurge('media', x); applyRemotePurge('expense', x);`,
          `export const PURGE_DOMAINS = ['trip', 'moment', 'media', 'expense'] as const;`,
        ),
      clean: true,
    },
    {
      name: '한 도메인만 빠진 것을 검출(최빈 결함군)',
      fn: () =>
        pullsApplyRemotePurge(
          `if (r.purged_at) applyRemotePurge('trip', x); purged.has(r.id);
           applyRemotePurge('moment', x); applyRemotePurge('media', x);`,
          `export const PURGE_DOMAINS = ['trip', 'moment', 'media', 'expense'] as const;`,
        ),
      clean: false,
    },
    {
      name: '순서 역전 검출(표식 없는 기기가 영구삭제를 못 배움)',
      fn: () =>
        pullsApplyRemotePurge(
          `purged.has(r.id); if (r.purged_at) applyRemotePurge('trip', x);
           applyRemotePurge('moment', x); applyRemotePurge('media', x); applyRemotePurge('expense', x);`,
          `export const PURGE_DOMAINS = ['trip'] as const;`,
        ),
      clean: false,
    },
    { name: 'toRow가 purged_at을 안 담으면 정상', fn: () => toRowNeverSendsPurgedAt(`export function toRow(t, u) {\n  return { id: t.id, deleted_at: t.deletedAt };\n}`), clean: true },
    {
      name: 'toRow가 purged_at을 담으면 검출(영구삭제를 덮어쓰는 경로)',
      fn: () => toRowNeverSendsPurgedAt(`export function toRow(t, u) {\n  return { id: t.id, purged_at: null };\n}`),
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
  ];
  const broken = cases.filter((c) => (c.fn().length === 0) !== c.clean);
  if (broken.length) {
    console.error(`check-verdict-symmetry: 셀프테스트 실패 — 게이트가 공허함: ${broken.map((c) => c.name).join(', ')}`);
    process.exit(2);
  }
}

// ── 실제 검사 ───────────────────────────────────────────────────────────────
const problems = [];
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

for (const p of richTextRendererIntact(read(RICH_TEXT_RENDERER))) problems.push(`${RICH_TEXT_RENDERER}: ${p}`);
for (const p of metricsMissingExpected(read('src/ui/panels/diagnostics.ts'))) problems.push(`src/ui/panels/diagnostics.ts: ${p}`);
for (const p of toolRegistryComplete(read('src/ui/panels/diagnostics.ts'))) problems.push(`src/ui/panels/diagnostics.ts: ${p}`);
for (const p of legacyRows(read(NO_LEGACY_ROWS.file), NO_LEGACY_ROWS.banned)) problems.push(`${NO_LEGACY_ROWS.file}: ${p}`);

for (const p of overlayContract(read('src/ui/styles/app.css'))) problems.push(`src/ui/styles/app.css: ${p}`);

for (const p of pullsApplyRemotePurge(read('src/services/sync.ts'), read('src/services/purge.ts'))) {
  problems.push(`src/services/sync.ts: ${p}`);
}
for (const rel of ['src/domain/trip/rowmap.ts', 'src/domain/moment/rowmap.ts', 'src/domain/media/rowmap.ts', 'src/domain/expense/rowmap.ts']) {
  for (const p of toRowNeverSendsPurgedAt(read(rel))) problems.push(`${rel}: ${p}`);
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
  for (const p of markdownBypass(readFileSync(abs, 'utf8'))) problems.push(`${relative(ROOT, abs)}: ${p}`);
}

if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('check-verdict-symmetry: 진단 판정 계약 위반 — 도구 간 대칭이 깨졌다.');
  process.exit(1);
}
console.log(`check-verdict-symmetry: OK (셀프테스트 27건 통과 · 강조 렌더러 온전 · src ${scanned}개 파일 우회 0 · guide-card 화면 ${cardFiles}곳 계약 준수 · 지표 기대값·도구 필드 정상)`);
