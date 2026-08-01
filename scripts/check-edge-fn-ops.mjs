#!/usr/bin/env node
// check-edge-fn-ops.mjs — Edge Function이 **자기 능력을 정직하게 밝히는가.**
//
// 왜 생겼나(2026-07-26 사후분석 근본형 B — "판정 문장이 한정을 생략한다"의 서버 판):
//   클라이언트가 새 응답 필드를 기대하는데 서버에 **옛 함수가 배포돼 있으면** 앱은 그걸 알
//   방법이 없다. 그래서 `typeof d.outside === 'number' ? d.outside : 0` 같은 방어 코드를 쓰게
//   되는데, 그 순간 **"0개"와 "모른다"가 구분되지 않는다.** 실제로 그날 그 코드를 썼다.
//
//   해법은 함수가 `capabilities`로 **판(version)과 지원 op 목록**을 스스로 밝히는 것이다.
//   그러면 화면이 「앱이 기대하는 기능이 서버에 없어요」라고 정직하게 말할 수 있다(원칙 #4).
//
//   그런데 그 선언은 **손으로 유지되는 목록**이다 — 손편집 중복은 그 자체가 결함이다(§SSOT).
//   op을 구현하고 목록에 안 넣거나, 목록에만 넣고 구현을 안 하면 선언이 거짓말이 된다.
//   이 게이트가 그 두 방향을 **모두** 잡는다.
//
// 왜 유닛이 아니라 게이트인가: 소스 파일을 읽어야 하는데 `node:fs`는 유닛 TS 설정 밖이다.
//   같은 이유로 예전에도 소스 구조 검사를 게이트 층으로 옮겼다 — 검사는 제 집에 있어야 한다.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FN_PATH = 'supabase/functions/media-sign/index.ts';

/**
 * 핸들러가 실제로 분기하는 op 이름.
 *
 * `body.op === 'string'`(typeof 비교)까지 세면 거짓 경보가 난다 — 실제로 처음 짰을 때 그렇게
 * 걸렸다. **앞에 점이나 글자가 없는 `op`**만 센다.
 */
export function handledOps(src) {
  return new Set([...src.matchAll(/(?<![.\w])op === '(\w+)'/g)].map((m) => m[1]));
}

/** `export const FN_OPS = [...] as const;` 에서 선언된 op 이름. 못 찾으면 null. */
export function declaredOps(src) {
  const m = src.match(/export const FN_OPS = \[([\s\S]*?)\]/);
  if (!m) return null;
  return new Set([...(m[1] ?? '').matchAll(/'(\w+)'/g)].map((x) => x[1]));
}

export function audit(src) {
  const problems = [];
  const declared = declaredOps(src);
  if (declared === null) {
    problems.push('FN_OPS 선언을 찾지 못했습니다 — 함수가 자기 능력을 밝히지 않으면 클라이언트는 추측할 수밖에 없습니다.');
    return problems;
  }
  if (declared.size === 0) {
    problems.push('FN_OPS가 비어 있습니다 — 선언이 비면 검사가 공허해집니다.');
    return problems;
  }
  const handled = handledOps(src);
  if (handled.size === 0) {
    problems.push("핸들러에서 op 분기를 찾지 못했습니다 — 검사가 무엇도 대조하지 못합니다.");
    return problems;
  }
  for (const o of handled) {
    if (!declared.has(o)) {
      problems.push(`op '${o}' 를 구현했는데 FN_OPS에 선언하지 않았습니다 — 클라이언트가 없는 기능으로 취급합니다.`);
    }
  }
  for (const o of declared) {
    if (!handled.has(o)) {
      problems.push(`op '${o}' 를 FN_OPS에 선언했는데 구현이 없습니다 — 선언이 빈 약속이 됩니다.`);
    }
  }
  if (!/export const FN_VERSION = \d+;/.test(src)) {
    problems.push('FN_VERSION 선언이 없습니다 — 서버 판을 못 밝히면 "옛 함수가 배포됨"을 구분할 수 없습니다.');
  }
  return problems;
}

/**
 * 🔐 초대제 형태검사 — Edge Function이 **인증만 하고 초대제를 빠뜨리지 않았는가.**
 *
 * 왜 생겼나(H-1 · 전수감사 2026-08-01): journey 테이블은 RLS로 `auth.uid() = user_id AND
 * journey.is_allowed()`를 이중으로 건다(0002). 그런데 R2 서명·지오코딩은 **DB를 거치지
 * 않으므로** 그 두 번째 방어(초대제)가 통째로 빠졌다 — 허용목록 밖 로그인 계정도 서명 URL을
 * 받고 지도 API를 돌릴 수 있었다. 정확히 §7의 근본형("새 경로는 형제가 지키는 계약을
 * 물려받지 않는다")이고, 이번엔 그 경로가 **DB 밖**이라 RLS가 못 따라왔다.
 *
 * 다음 Edge Function이 이 규율을 자동으로 물려받게 **형태로** 강제한다:
 *   ① `isInvited` 헬퍼가 있고 ② 그것이 journey.is_allowed() RPC에 되묻고
 *   ③ 인증 뒤에 `if (!(await isInvited(req))) return … 403` 가드가 있다.
 * 산문(주석)은 코드가 바뀔 때 같이 안 바뀐다 — 그래서 형태로 잡는다(M-0060).
 */
export function inviteAudit(src) {
  const problems = [];
  const hasHelper = /async function isInvited\s*\(/.test(src);
  const callsRpc = /rest\/v1\/rpc\/is_allowed/.test(src);
  const hasGuard = /if\s*\(\s*!\s*\(\s*await\s+isInvited\s*\(\s*req\s*\)\s*\)\s*\)\s*return[^;\n]*403/.test(src);
  if (!hasHelper) {
    problems.push('isInvited 헬퍼가 없습니다 — 인증은 sub 위조만 막고 초대제는 못 겁니다(§7). RLS가 테이블에 거는 journey.is_allowed()를 이 경로에도 걸어야 합니다.');
  }
  if (!callsRpc) {
    problems.push('isInvited가 journey.is_allowed() RPC(rest/v1/rpc/is_allowed)를 호출하지 않습니다 — 허용목록 SSOT에 되묻지 않으면 손편집 중복이 됩니다.');
  }
  if (!hasGuard) {
    problems.push('인증 뒤 초대제 가드가 없습니다 — `if (!(await isInvited(req))) return … 403` 형태가 필요합니다. 허용목록 밖 계정이 이 함수를 쓸 수 있습니다.');
  }
  return problems;
}

// ── 비공허 자체검사 ─────────────────────────────────────────────────────────
let selfTestCount = 0;
{
  const ok = `export const FN_VERSION = 4;
export const FN_OPS = ['probe', 'list'] as const;
const op = typeof body.op === 'string' ? body.op : '';
if (op === 'probe') { }
if (op === 'list') { }`;
  const cases = [
    { name: '선언과 구현이 맞으면 정상', src: ok, clean: true },
    {
      name: "구현했는데 선언 안 함(실제로 낼 실수)",
      src: ok.replace("'probe', 'list'", "'probe'"),
      clean: false,
    },
    {
      name: '선언했는데 구현 안 함(빈 약속)',
      src: ok.replace("'probe', 'list'", "'probe', 'list', 'ghost'"),
      clean: false,
    },
    {
      name: "typeof 비교(`body.op === 'string'`)를 op으로 세지 않는다(거짓 경보 방지)",
      src: ok,
      clean: true,
    },
    { name: 'FN_OPS가 없으면 검출', src: ok.replace(/export const FN_OPS[\s\S]*?as const;/, ''), clean: false },
    { name: 'FN_OPS가 비면 검출(공허해짐)', src: ok.replace("'probe', 'list'", ''), clean: false },
    { name: 'FN_VERSION이 없으면 검출', src: ok.replace('export const FN_VERSION = 4;', ''), clean: false },
    {
      name: '핸들러 분기가 하나도 없으면 검출(대조 불가)',
      src: `export const FN_VERSION = 4;\nexport const FN_OPS = ['probe'] as const;`,
      clean: false,
    },
  ];
  const broken = cases.filter((c) => (audit(c.src).length === 0) !== c.clean);
  if (broken.length) {
    console.error(`check-edge-fn-ops: 셀프테스트 실패 — 게이트가 공허함: ${broken.map((c) => c.name).join(', ')}`);
    process.exit(2);
  }
  selfTestCount = cases.length;
}

// ── 초대제 형태검사 자체검사 (§4 — 알려진 실패를 주입해 RED 확인) ────────────
let inviteSelfTestCount = 0;
{
  const okInvite = `async function isInvited(req: Request): Promise<boolean> {
  const r = await fetch(\`\${base}/rest/v1/rpc/is_allowed\`, { method: 'POST', body: '{}' });
  if (!r.ok) return false;
  return (await r.json()) === true;
}
const userId = await verifiedUserId(req);
if (!userId) return json({ error: 'unauthorized' }, 401);
if (!(await isInvited(req))) return json({ error: 'forbidden' }, 403);`;
  const cases = [
    { name: '헬퍼·RPC·가드 다 있으면 정상', src: okInvite, clean: true },
    { name: 'isInvited 헬퍼가 없으면 검출', src: okInvite.replace('async function isInvited', 'async function unused'), clean: false },
    { name: 'RPC 호출이 없으면 검출(허용목록에 안 되물음)', src: okInvite.replace('/rest/v1/rpc/is_allowed', '/auth/v1/user'), clean: false },
    { name: '인증만 하고 초대제 가드가 없으면 검출(H-1의 형태)', src: okInvite.replace(/if \(!\(await isInvited\(req\)\)\) return json\({ error: 'forbidden' }, 403\);/, ''), clean: false },
    { name: '가드가 403이 아니면 검출(거부하지 않음)', src: okInvite.replace('}, 403);', '}, 200);'), clean: false },
  ];
  const broken = cases.filter((c) => (inviteAudit(c.src).length === 0) !== c.clean);
  if (broken.length) {
    console.error(`check-edge-fn-ops: 초대제 셀프테스트 실패 — 게이트가 공허함: ${broken.map((c) => c.name).join(', ')}`);
    process.exit(2);
  }
  inviteSelfTestCount = cases.length;
}

/**
 * 🔴 대상은 **손으로 세지 않고 디렉터리에서 뽑는다**(§7 — 형제 목록을 손으로 세지 마라).
 *
 * 2026-07-30까지 이 게이트는 `media-sign` **한 개를 상수로** 갖고 있었다. 그래서 두 번째
 * 함수(`geocode`)를 만드는 순간, 새 형제는 형제들이 지키는 계약을 **하나도 안 받은 채**
 * 태어날 수 있었다 — `check-domain-symmetry`가 접미사 규약에 기대다 오디오를 통째로
 * 놓쳤던 것과 **정확히 같은 근본형**이다(그 주석이 이 파일 위쪽에 이미 적혀 있었다).
 *
 * 이제 `supabase/functions` 아래 모든 `<함수>/index.ts`를 훑는다. 다음 함수는
 * **아무것도 안 해도** 이 검사에 들어온다.
 * (글로브를 주석에 그대로 적지 않는다 — 별표+슬래시가 블록 주석을 거기서 닫아버린다.)
 */
function edgeFunctionPaths() {
  const dir = join(ROOT, 'supabase/functions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'index.ts')))
    .map((e) => `supabase/functions/${e.name}/index.ts`)
    .sort();
}

const targets = edgeFunctionPaths();
if (targets.length === 0) {
  // 대상 0에서 조용히 통과하면 그건 통과가 아니라 **안 잰 것**이다(§4).
  console.error('check-edge-fn-ops: 검사할 Edge Function을 찾지 못했습니다 — 경로가 바뀌었으면 이 게이트도 함께 고치세요.');
  process.exit(1);
}
// 옛 상수가 가리키던 함수는 **여전히 목록에 있어야 한다**(디렉터리 스캔이 조용히 좁아지지 않게).
if (!targets.includes(FN_PATH)) {
  console.error(`check-edge-fn-ops: ${FN_PATH} 가 스캔 결과에 없습니다 — 스캔이 좁아졌거나 함수가 사라졌습니다.`);
  process.exit(1);
}

let failed = false;
let opTotal = 0;
for (const rel of targets) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const problems = [...audit(src), ...inviteAudit(src)];
  if (problems.length) {
    failed = true;
    for (const p of problems) console.error(`  ✗ ${rel}: ${p}`);
  } else {
    opTotal += declaredOps(src)?.size ?? 0;
  }
}
if (failed) {
  console.error('check-edge-fn-ops: 함수의 능력 선언과 구현이 어긋나거나 초대제 가드가 빠졌습니다.');
  process.exit(1);
}
console.log(
  `check-edge-fn-ops: OK (셀프테스트 ${selfTestCount}+${inviteSelfTestCount}건 · 함수 ${targets.length}개 · 선언·구현 op ${opTotal}종 대칭 · 초대제 가드 확인)`,
);
