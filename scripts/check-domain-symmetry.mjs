// check-domain-symmetry.mjs — 도메인 생명주기 대칭 + 변경마다 동기화 op 생성 게이트
//
// 왜(실제 사고 2026-07-25, LESSONS §1·§3):
//  ① `expenses`에만 `restore*`가 없어 **비용만 실행취소가 불가능**했다. 형제 도메인엔 다 있었다.
//     "최빈 결함군은 형제 도메인엔 있는데 한 도메인만 조용히 빠짐"(§3)의 교과서적 사례.
//  ② `trips`의 cascade 삭제가 사진·비용을 tombstone하면서 **큐 op는 만들지 않아**, 여행을 지워도
//     서버 사진 행이 활성으로 남고 R2 객체까지 잔류했다. 로컬만 바꾸고 서버에 알리지 않은 것이다.
//
// 그래서 두 가지를 정적으로 강제한다:
//  A) `softDeleteX`가 있으면 `restoreX`도 있어야 한다(생명주기 대칭).
//  B) 로컬 상태를 바꾸는 함수는 **동기화 큐에 op를 넣거나**, 넣지 않는 이유를 등록해야 한다.
//     op가 없으면 그 변경은 이 기기에 갇히고, 다른 기기·서버는 영영 모른다.
//
// ⚠️ 이 게이트 자신의 세 번째 결함(2026-07-27): **이름이 `LocalFirst`로 끝나는 것만 봤다.**
// 그래서 `softDeleteAudio`/`restoreAudio`는 **검사 대상에 아예 들어오지 않았고**, 오디오는
// 형제들이 지키는 계약을 하나도 안 받은 채 태어났다(cascade·휴지통·영구삭제·용량·무결성
// 다섯 곳이 동시에 비었다 — M-0033과 같은 근본형). **접미사 규약에 기대는 검사는, 규약을
// 안 따르는 새 형제를 정확히 놓친다.**
//
// 그래서 B의 판정 기준을 **이름에서 행동으로** 옮겼다: *로컬 테이블에 쓰는 함수는 전부*
// 대상이다. 이름을 어떻게 짓든 피할 수 없고(§7 「기계가 물어보게」), 이름만 비슷한 순수
// 함수(`purgeOpType`은 문자열만 만든다)는 애초에 걸리지 않는다 — 오탐 없이 넓어진다.
// (실제로 동사 기준으로 먼저 넓혔더니 그 다섯 개를 오탐했다. 오탐은 틀린 게이트다 — §11 ③.)
//
// 정직한 한계: 정적 검사는 "op를 넣는 코드가 있다"까지만 본다. **자식 종류를 빠짐없이 넣는지**는
// 못 본다(그건 tests/unit/cascadeOps.test.ts가 실제 실행으로 잡는다). 두 층이 함께 있어야 한다.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICES = join(ROOT, 'src/services');

/**
 * op를 만들지 않아도 되는 함수 — **이유를 반드시 적는다**(비면 규율이 죽는다).
 *
 * 헌법 §7(2026-07-27): 대칭이 기본값이고, 비대칭은 **설계 단계에서 심사한 예외**만 허용한다.
 * 이 표가 그 심사 결과를 담는 자리다. 여기 한 줄을 적는 것은 "형제와 다르게 두겠다"는
 * 선언이므로, 이유는 *무엇이 다른가*가 아니라 **왜 그 차이가 사용자에게 손해가 아닌가**를
 * 적어야 한다.
 */
const NO_OP_REQUIRED = new Map([
  // 🔴 2026-07-27에 **오디오 3건(addAudioToMoment·softDeleteAudio·restoreAudio)을 지웠다.**
  //    "서버로 가지 않는다"는 사정이 사라졌기 때문이다(마이그레이션 0019 + sync.ts push/pull).
  //    예외를 지우는 것이 이 표의 정상 상태다 — 등록은 빚이지 면허가 아니다(§7 3항).
  [
    'ensureTable',
    '환율표는 사용자의 기억이 아니라 **기계 파생 캐시**다(외부 제공자에서 다시 받아올 수 있다). ' +
      '기기마다 따로 채워도 손해가 없고, 올리면 오히려 남의 기기 캐시를 덮어쓴다.',
  ],
  [
    'applyRemotePurge',
    '**서버가 알려준 영구삭제를 이 기기에 반영하는** 함수다. 여기서 op를 만들면 방금 받은 ' +
      '사실을 서버로 되돌려 보내는 메아리가 된다(무한 왕복). 의도를 만드는 쪽은 ' +
      'purgeTripPermanently·purgeChildPermanently이고, 이 함수는 그 결과를 받는 쪽이다.',
  ],
  [
    'pushPending',
    '큐를 **소비하는** 쪽이다(op를 만드는 게 아니라 서버로 보내고 지운다). 로컬 쓰기는 ' +
      '성공한 op 제거와 실패 표시(markFail)뿐 — 사용자 자료를 바꾸지 않는다.',
  ],
  ['pushPendingMoments', 'pushPending과 같은 이유 — 큐 소비자.'],
  ['pushPendingExpenses', 'pushPending과 같은 이유 — 큐 소비자.'],
  ['pushPendingMedia', 'pushPending과 같은 이유 — 큐 소비자.'],
  ['pushPendingAudio', 'pushPending과 같은 이유 — 큐 소비자.'],
  ['pushPendingPlaces', 'pushPending과 같은 이유 — 큐 소비자.'],
]);

/**
 * 함수 본문을 중괄호 균형으로 잘라낸다.
 *
 * ⚠️ 이 게이트 자신의 결함(2026-07-25): 처음에는 인자 목록 뒤 **첫 `{`**를 본문 시작으로 봤다.
 * 그런데 반환 타입이 `Promise<{ a: string[] }>`처럼 객체면 그 중괄호를 본문으로 착각해,
 * 멀쩡한 함수를 "op를 안 만든다"고 **오탐**했다(moments.ts). 꺾쇠 깊이를 세어 타입 안의
 * 중괄호를 건너뛴다. 게이트의 오탐은 신뢰를 깎아 결국 게이트를 끄게 만든다 — 실패만큼 나쁘다.
 */
export function bodyOf(src, afterParams) {
  let angle = 0;
  for (let i = afterParams; i < src.length; i++) {
    const c = src[i];
    if (c === '<') angle++;
    else if (c === '>') angle--;
    else if (c === '{' && angle <= 0) {
      let depth = 0;
      for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') {
          depth--;
          if (depth === 0) return src.slice(i, j + 1);
        }
      }
      return src.slice(i);
    }
  }
  return '';
}

/** 인자 목록 여는 괄호 위치 → 닫는 괄호 다음 위치. */
function afterParams(src, openParen) {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return openParen;
}

/**
 * **로컬 테이블에 쓰는가.** 이것이 "상태를 바꾸는 함수"의 정의다 — 이름이 아니라 행동.
 *
 * Dexie 쓰기 메서드를 테이블스러운 수신자(`d.localX`·`table`·`localTable`) 위에서 찾는다.
 * `new Set(...).delete(x)` 같은 자료구조 조작을 쓰기로 세지 않으려고 수신자를 제한한다.
 */
export function writesLocal(body) {
  return /\b(?:d\.local\w+|db\(\)\.local\w+|local\w+|localTable|table)\s*\.\s*(?:put|add|delete|update|bulkPut|bulkAdd|bulkDelete)\s*\(/.test(
    body,
  );
}

/** 이름으로 보는 생명주기 짝(A 검사 전용). */
export const LIFECYCLE_NAME = /^(softDelete|restore)\w*/;

/**
 * 파일에서 **로컬 테이블에 쓰는** export 함수를 찾아 {name, body} 목록을 만든다.
 * 생명주기 이름(softDelete·restore로 시작)은 쓰기가 없어도(위임형) 짝 검사를 위해 포함한다.
 */
export function mutationsIn(src) {
  const out = [];
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const body = bodyOf(src, afterParams(src, open));
    if (writesLocal(body) || LIFECYCLE_NAME.test(m[1])) out.push({ name: m[1], body });
  }
  return out;
}

/**
 * 큐에 op를 넣는 코드가 있는가(직접 add / ops 배열 / 헬퍼 위임 전부 인정).
 *
 * **위임도 인정한다**: 본문이 다른 변경 함수를 부르면 op 책임은 그쪽에 있다
 * (`restoreTripFromTrash` → `restoreTripLocalFirst`). 위임을 못 알아보면 게이트가
 * 멀쩡한 함수를 오탐하고, 오탐은 "빡빡한 게이트"가 아니라 **틀린 게이트**다(§11 ③).
 */
export function enqueuesOp(body) {
  if (/syncQueue\.(add|bulkAdd)/.test(body) || /\bops\b\s*[:=]/.test(body) || /childOp\(/.test(body)) return true;
  // 위임: 본문에서 다른 변경 함수를 부른다(op 책임이 그쪽에 있다).
  for (const c of body.matchAll(/\b(\w+)\s*\(/g)) {
    if (/^(softDelete|restore|create|update|add|purge)\w+|\w*LocalFirst$/.test(c[1])) return true;
  }
  return false;
}

/** 대칭·op 검사 → 문제 목록(빈 배열 = 통과). */
export function checkSources(files) {
  const problems = [];
  for (const [file, src] of files) {
    const muts = mutationsIn(src);
    const names = new Set(muts.map((m) => m.name));

    // A) softDelete ↔ restore 대칭 — 이 짝만은 이름으로 본다(짝의 정의가 이름이므로).
    for (const n of names) {
      if (!n.startsWith('softDelete')) continue;
      const twin = n.replace(/^softDelete/, 'restore');
      if (!names.has(twin)) {
        problems.push(`${file}: ${n}() 는 있는데 ${twin}() 가 없음 — 이 도메인만 되돌릴 수 없다(생명주기 대칭 위반)`);
      }
    }

    // B) 로컬 변경은 반드시 서버에 알린다
    for (const { name, body } of muts) {
      if (NO_OP_REQUIRED.has(name)) continue;
      if (!enqueuesOp(body)) {
        problems.push(`${file}: ${name}() 가 동기화 큐에 op를 넣지 않음 — 그 변경은 이 기기에 갇힌다`);
      }
    }
  }
  return problems;
}

// ── 셀프테스트: 알려진 실패가 RED로 잡히는지(게이트 비공허, CLAUDE.md §4) ──
{
  const OK = `
    export async function createXLocalFirst(a) { await d.syncQueue.add(op); }
    export async function softDeleteXLocalFirst(a) { await d.syncQueue.add(op); }
    export async function restoreXLocalFirst(a) { await d.syncQueue.add(op); }
  `;
  const cases = [
    { name: '정상 통과', src: OK, clean: true },
    {
      name: 'restore 누락 검출(실제 결함 F4)',
      src: OK.replace(/export async function restoreXLocalFirst[^\n]*\n/, ''),
      clean: false,
    },
    {
      name: 'op 미생성 검출(실제 결함 — cascade 누락형)',
      src: `export async function softDeleteXLocalFirst(a) { await d.localX.put(row); }
            export async function restoreXLocalFirst(a) { await d.syncQueue.add(op); }`,
      clean: false,
    },
    {
      name: '중첩 블록이 있어도 본문을 온전히 읽는다',
      src: `export async function createXLocalFirst(a) { if (x) { y(); } await d.transaction('rw', t, async () => { await d.syncQueue.add(op); }); }`,
      clean: true,
    },
    { name: 'ops 배열 형태도 인정', src: `export async function softDeleteXLocalFirst(a) { const ops = [o1]; }
            export async function restoreXLocalFirst(a) { const ops = [o2]; }`, clean: true },
    {
      // 이 게이트가 실제로 낸 오탐(moments.ts): 반환 타입의 중괄호를 본문으로 착각했다.
      name: '반환 타입 객체를 본문으로 오인하지 않는다',
      src: `export async function softDeleteXLocalFirst(\n  id: string,\n): Promise<{ mediaIds: string[] }> { await d.syncQueue.add(op); }
            export async function restoreXLocalFirst(id: string): Promise<{ a: number }> { await d.syncQueue.add(op); }`,
      clean: true,
    },

    // ── 2026-07-27에 **넓힌 능력**에 대한 주입. §11 ①: 등록부·대상을 넓히는 것은 새 게이트를
    //    만드는 것과 같다 — 넓힌 그 자리로 다시 주입해 RED를 확인하지 않으면 공허해진다.
    //    실제로 이 게이트는 `LocalFirst` 접미사가 없다는 이유만으로 오디오 전체를 놓쳤다.
    {
      name: '🔴 접미사 없는 이름이어도 로컬에 쓰면 잡는다(오디오를 놓쳤던 바로 그 구멍)',
      src: `export async function stashSomething(a) { await d.localAudio.put(row); }`,
      clean: false,
    },
    {
      name: '🔴 접미사 없는 softDelete의 짝 누락도 잡는다',
      src: `export async function softDeleteAudio(a) { await d.localAudio.put(row); }`,
      clean: false,
    },
    {
      name: '접미사 없어도 짝이 다 있고 op를 만들면 통과',
      src: `export async function softDeleteAudio(a) { await d.localAudio.put(r); await d.syncQueue.add(op); }
            export async function restoreAudio(a) { await d.localAudio.put(r); await d.syncQueue.add(op); }`,
      clean: true,
    },
    {
      // 반대 방향의 주입 — **오탐도 결함이다**(§11 ③). 동사 기준으로 넓혔을 때 이 부류를
      // 다섯 개나 오탐했고, 그래서 판정을 이름에서 행동으로 옮겼다.
      name: '🔴 이름만 변경처럼 생긴 순수 함수는 잡지 않는다(오탐 방지)',
      src: `export function purgeOpType(domain) { return \`purge:\${domain}\`; }
            export function updateLabel(x) { return x.trim(); }`,
      clean: true,
    },
    {
      name: '자료구조의 .delete()를 로컬 쓰기로 세지 않는다',
      src: `export function createIndex(rows) { const seen = new Set(); seen.delete('a'); return seen; }`,
      clean: true,
    },
  ];
  const broken = cases.filter((c) => (checkSources([['t.ts', c.src]]).length === 0) !== c.clean);
  if (broken.length) {
    console.error(`check-domain-symmetry: 셀프테스트 실패 — 게이트가 공허함: ${broken.map((c) => c.name).join(', ')}`);
    process.exit(2);
  }
}

// ── 실제 검사 ──
const files = readdirSync(SERVICES)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => [`services/${f}`, readFileSync(join(SERVICES, f), 'utf8')]);

const problems = checkSources(files);
if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('check-domain-symmetry: 도메인 대칭 또는 동기화 op 계약 위반.');
  process.exit(1);
}
const total = files.reduce((n, [, src]) => n + mutationsIn(src).length, 0);
console.log(`check-domain-symmetry: OK (셀프테스트 통과 · 로컬 쓰기 함수 ${total}개 전부 op 생성 또는 등록된 예외 + 대칭)`);
