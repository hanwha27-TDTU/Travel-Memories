// check-domain-symmetry.mjs — 도메인 생명주기 대칭 + 변경마다 동기화 op 생성 게이트
//
// 왜(실제 사고 2026-07-25, LESSONS §1·§3):
//  ① `expenses`에만 `restore*`가 없어 **비용만 실행취소가 불가능**했다. 형제 도메인엔 다 있었다.
//     "최빈 결함군은 형제 도메인엔 있는데 한 도메인만 조용히 빠짐"(§3)의 교과서적 사례.
//  ② `trips`의 cascade 삭제가 사진·비용을 tombstone하면서 **큐 op는 만들지 않아**, 여행을 지워도
//     서버 사진 행이 활성으로 남고 R2 객체까지 잔류했다. 로컬만 바꾸고 서버에 알리지 않은 것이다.
//
// 그래서 두 가지를 정적으로 강제한다:
//  A) `softDeleteXLocalFirst`가 있으면 `restoreXLocalFirst`도 있어야 한다(생명주기 대칭).
//  B) 로컬 상태를 바꾸는 함수(`*LocalFirst`)는 **동기화 큐에 op를 넣어야 한다**.
//     op가 없으면 그 변경은 이 기기에 갇히고, 다른 기기·서버는 영영 모른다.
//
// 정직한 한계: 정적 검사는 "op를 넣는 코드가 있다"까지만 본다. **자식 종류를 빠짐없이 넣는지**는
// 못 본다(그건 tests/unit/cascadeOps.test.ts가 실제 실행으로 잡는다). 두 층이 함께 있어야 한다.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICES = join(ROOT, 'src/services');

/** op를 만들지 않아도 되는 함수 — **이유를 반드시 적는다**(비면 규율이 죽는다). */
const NO_OP_REQUIRED = new Map([
  // (현재 없음) 예: 순수 로컬 캐시만 만지는 *LocalFirst 함수가 생기면 여기에 이유와 함께 등록
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

/** 파일에서 `export … function <name>LocalFirst` 를 찾아 {name, body} 목록을 만든다. */
export function mutationsIn(src) {
  const out = [];
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(\w*LocalFirst)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    out.push({ name: m[1], body: bodyOf(src, afterParams(src, open)) });
  }
  return out;
}

/** 큐에 op를 넣는 코드가 있는가(직접 add / ops 배열 / 헬퍼 위임 전부 인정). */
export function enqueuesOp(body) {
  return /syncQueue\.(add|bulkAdd)/.test(body) || /\bops\b\s*[:=]/.test(body) || /childOp\(/.test(body);
}

/** 대칭·op 검사 → 문제 목록(빈 배열 = 통과). */
export function checkSources(files) {
  const problems = [];
  for (const [file, src] of files) {
    const muts = mutationsIn(src);
    const names = new Set(muts.map((m) => m.name));

    // A) softDelete ↔ restore 대칭
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
console.log(`check-domain-symmetry: OK (셀프테스트 통과 · *LocalFirst ${total}개 전부 op 생성 + 대칭)`);
