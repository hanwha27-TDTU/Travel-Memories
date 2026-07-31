// brief.mjs — **착수 브리핑.** 코딩을 시작하기 전에 이걸 먼저 돌린다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 (사용자 제안 2026-07-26)
// ─────────────────────────────────────────────────────────────────────────────
// "적어놓고 어기는 이유는 읽지 않기 때문이죠. 그래서 아예 모든 코딩 시작 전 스킬문서부터
//  정독하고, 정독 과정에서 오류나 모순이 있으면 그것부터 정리하고 시작하면 되지 않을까요?"
//
// 맞다. 그런데 **절반만 맞다** — 그리고 그 차이가 이 스크립트의 모양을 정한다.
//
//  · 맞는 절반: 오늘 오버레이 잘림 사고(가로 태블릿) 때 `ui-responsive-dev/SKILL.md`는
//    **있었고 나는 app.css를 고치기 전에 읽지 않았다.**
//  · 빠진 절반: 읽었어도 못 막았다. 그 문서 어디에도 `vh`/`dvh`·오버레이 스크롤 얘기가
//    **없었다.** 문서에 구멍이 있었다.
//  · 더 중요한 반례: M-0012에서 나는 CLAUDE.md §7("형제 목록을 손으로 세지 말고
//    등록부/디렉터리에서 뽑는다")을 **직접 쓰고 같은 커밋에서 어겼다.** 읽음은 그때 최대치였다.
//    실패한 것은 읽기가 아니라 **적용**이었다 — 산문에 동의하고 넘어갔지, 그 절차가 요구하는
//    *산출물*(형제 목록)을 실제로 만들지 않았다.
//
// 그래서 이 스크립트는 두 가지를 **강제로 산출물로 만든다**:
//   ① 이 변경에 필수인 스킬 문서 목록 (읽을 것을 고르는 일을 기억에 맡기지 않는다)
//   ② 형제 목록 — 디렉터리에서 **기계가 뽑는다** (§7이 요구하는 바로 그 산출물)
// 그리고 ③ 이 영역에서 과거에 낸 실수를 같이 띄운다 — 같은 자리에서 두 번 넘어지지 않게.
//
// 사용:
//   node scripts/brief.mjs                  # 지금 작업 트리의 변경 파일 기준
//   node scripts/brief.mjs src/ui/dom.ts …  # 앞으로 고칠 파일을 직접 지정

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 경로 → 필수 스킬 문서. **이 표가 SSOT다** — 어느 문서를 읽을지 기억에 맡기지 않는다.
 * `check-skill-routing` 게이트가 "src의 모든 영역이 표에 걸리는가"를 검사한다.
 */
export const SKILL_ROUTES = [
  { match: /^src\/ui\/(styles|theme|toast|dom)/, skill: 'ui-responsive-dev' },
  { match: /^src\/ui\/screens\//, skill: 'ui-responsive-dev' },
  // 보조 화면 지연 로드의 단일 관문. 화면을 다루는 파일이므로 UI 헌장을 읽되,
  // 이 파일을 바꾼다는 건 "무엇이 첫 로드에 들어가는가"를 바꾼다는 뜻이다(check-lazy-screens).
  { match: /^src\/ui\/lazyScreens/, skill: 'ui-responsive-dev' },
  // 바깥 지도 칩 줄(구글·네이버·카카오·얀덱스). **UI 부품이지만 규율은 장소 헌장**이다 —
  // 여기 담긴 것이 좌표·장소명이 기기 밖으로 나가는 유일한 경로의 동의 절차이기 때문이다
  // (`externalMapConsent`와 같은 판단).
  { match: /^src\/ui\/externalMapRow/, skill: 'map-place-dev' },
  // 「어느 선택기로 고르는가」. 🔴 **이 파일이 사진 경로에서 가장 비싼 자리다**(M-0064) —
  // 안드로이드 사진 선택기가 GPS를 지우고 넘긴다는 사실이 **여기 주석에 적혀 있었는데도**
  // 나흘을 다른 데서 찾았다. 그래서 **사진저장 헌장을 먼저** 띄운다(§0-B가 그 사실이다).
  // 장소 헌장도 함께 — 좌표가 사용자 기억에 찍히는 규율은 그쪽이다.
  { match: /^src\/ui\/pickOriginal/, skill: 'photo-storage-dev' },
  { match: /^src\/ui\/pickOriginal/, skill: 'map-place-dev' },
  // 「지금 내 위치」를 읽는 브라우저 문. **services/이지만 규율은 장소 헌장**이다 —
  // 여기서 나오는 좌표는 사용자의 기억이 찍힐 자리이고, 정확도 판정·실패 문장·
  // 「자동으로 넣지 않는다」는 결정이 전부 domain/place/here.ts와 한 몸이다.
  { match: /^src\/services\/here/, skill: 'map-place-dev' },
  { match: /^src\/ui\/(photoEditor|photoViewer|editor)/, skill: 'photo-editor-dev' },
  // 🔴 **사진 바이트가 지나는 자리는 전용 헌장을 함께 읽는다**(사용자 지시 2026-08-01:
  // *"사진저장관련 스킬문서 별도로 만들어서 특별관리하자"*). 이 경로는 네 헌장에 걸쳐
  // 흩어져 있어 **전체를 보는 사람이 없었고**, 이틀 동안 결함 넷이 여기서 났다
  // (M-0057·M-0058·M-0059·M-0060 — 넷 다 조각이 아니라 **이음매**가 틀렸다).
  { match: /^src\/media\//, skill: 'photo-storage-dev' },
  { match: /^src\/media\//, skill: 'photo-editor-dev' },
  { match: /^src\/services\/(media|r2)\.ts/, skill: 'photo-storage-dev' },
  { match: /^src\/domain\/media\//, skill: 'photo-storage-dev' },
  { match: /^src\/ui\/panels\/(verdict|diagnostics)/, skill: 'diagnostics-dev' },
  { match: /^src\/services\/(diagnostics|envReport|storeState)/, skill: 'diagnostics-dev' },
  // deviceId는 진단이 읽지만 **동기화 push 경로에 값을 찍는다** — 규율은 그쪽이 더 무겁다.
  { match: /^src\/app\/deviceId/, skill: 'sync-offline-dev' },
  { match: /^src\/app\/errorLog/, skill: 'diagnostics-dev' },
  { match: /^src\/domain\/integrity/, skill: 'diagnostics-dev' },
  // 자동 동기화 상태 → 사용자 문장. **판정 문장 자체가 결함일 수 있는** 부류라 진단 헌장이다
  // (§10 ③ · 7-D). 2026-07-27: 성공 72초 뒤인데 「판정 불가」로 총괄을 끌어내렸다.
  { match: /^src\/domain\/syncStatusVerdict/, skill: 'diagnostics-dev' },
  { match: /^src\/services\/(sync|autoSync|purge|trips|moments|media|expenses|trash)\.ts/, skill: 'sync-offline-dev' },
  { match: /^src\/(sync|offline)\//, skill: 'sync-offline-dev' },
  { match: /^src\/domain\/\w+\/rowmap/, skill: 'sync-offline-dev' },
  // 2026-07-27 M-0034로 옮겼다. 예전엔 "순수 날짜 함수"라며 문서 불필요로 분류돼 있었는데,
  // 그 사이 이 파일이 **시각 표기의 SSOT**(`isoInstant`·`Instant` 브랜드)를 갖게 됐다 —
  // 서버·백업 경계가 전부 여기를 통과하므로 규율은 동기화 헌장에 있다. 분류가 낡으면
  // 착수 브리핑이 "읽을 것 없음"이라고 **거짓으로** 말한다.
  { match: /^src\/domain\/time/, skill: 'sync-offline-dev' },
  // 「집 시간대」 하나만 든 파일. 표시 설정(localStorage)이지만 그 값이 **기억 시각의 환산
  // 기준**이라 규율은 `domain/time`과 같은 곳이다 — 두 「로컬」을 섞지 않는다는 그 규율이다.
  { match: /^src\/services\/homeZone/, skill: 'sync-offline-dev' },
  // 「처음 한 번만 확인」의 저장·판정. UI처럼 보이지만 담긴 것은 **개인정보 경계**라
  // 규율은 장소 헌장이다(`externalMapConsent`와 같은 판단 — 좌표가 언제 밖으로 나가는가).
  { match: /^src\/services\/consent/, skill: 'map-place-dev' },
  { match: /^src\/domain\/place\/photoHint/, skill: 'map-place-dev' },
  // 이름 규칙(R2 객체 키 + ZIP 폴더·파일명). 여기 한 글자가 바뀌면 **Edge Function의 파서**와
  // 어긋나 멀쩡한 사진이 「설명할 수 없는 파일」로 뜬다 — 그 계약은 동기화 헌장에 있다.
  { match: /^src\/domain\/media\/naming/, skill: 'sync-offline-dev' },
  // 저장 공간 사전점검 — 인테이크(media 서비스)가 부르고, 계약은 MEDIA_PIPELINE에 있다.
  { match: /^src\/domain\/media\/quota/, skill: 'photo-editor-dev' },
  // 오디오 노트 — 새 미디어 종류다. 저장·삭제·복원·백업 규율은 동기화 헌장이 정본이고,
  // 녹음/재생 UI 규율(자동재생 금지·동시 1개·정리 한 곳)은 그 파일 머리주석에 있다.
  { match: /^src\/(domain\/audio|services\/audio|ui\/audioNote)/, skill: 'sync-offline-dev' },
  { match: /^src\/services\/(backup|zip)/, skill: 'backup-restore-dev' },
  { match: /^src\/services\/(fx|expenses)/, skill: 'expense-fx-dev' },
  { match: /^src\/domain\/expense\//, skill: 'expense-fx-dev' },
  { match: /^src\/(services\/geocode|domain\/place)/, skill: 'map-place-dev' },
  // 장소 라이브러리(2026-07-30 · 마이그레이션 0022). **두 헌장이 다 걸린다**: 무엇을 장소로
  // 볼지·좌표의 출처 규율은 장소 헌장이고, 저장·큐 op·tombstone·백업 규율은 동기화 헌장이다.
  // 한쪽만 읽으면 반쪽이 된다 — 실제로 오디오가 그렇게 다섯 곳을 비운 채 태어났다(M-0033).
  { match: /^src\/services\/places\.ts/, skill: 'map-place-dev' },
  { match: /^src\/services\/places\.ts/, skill: 'sync-offline-dev' },
  // 바깥 지도(구글)로 나가는 동의 상태. 위치가 **기기 밖으로 나가는** 유일한 경로라 규율은
  // 장소 헌장에 있다(PRIVACY「개인자료 기본 비공개」의 예외를 사용자 확인으로 다루는 자리).
  { match: /^src\/services\/externalMapConsent/, skill: 'map-place-dev' },
  { match: /^src\/ui\/screens\/mapView/, skill: 'map-place-dev' },
  { match: /^src\/services\/(supabase|auth|r2)/, skill: 'supabase-security-dev' },
  { match: /^supabase\//, skill: 'supabase-security-dev' },
  { match: /^scripts\//, skill: 'gates-mechanization-dev' },
  // 배포 경로. 2026-07-27에 `ci.yml`을 고치는데 브리핑이 **읽을 문서를 하나도 안 줬다** —
  // 이 표에 없었고 게이트는 `src/`만 훑고 있었다. 그런데 여기는 틀리면 **전부가 막히는**
  // 자리다(M-0031: 게이트가 CI에서만 죽어 배포가 2회 연속 실패). 게이트 헌장의 §2-D(CI Node)
  // ·§2-G(선택 게이트가 어디서 도는가)·§2-H(배포 그린 확인)가 정확히 이 파일들의 규율이다.
  // 배포 계약 자체의 정본은 `docs/DEPLOYMENT.md`이고 헌장이 그리로 보낸다.
  { match: /^\.github\/workflows\//, skill: 'gates-mechanization-dev' },
  { match: /^src\/app\/(registry|blueprint|gates|hashchain)/, skill: 'gates-mechanization-dev' },
  { match: /^src\/app\/router/, skill: 'ui-responsive-dev' },
  { match: /^src\/domain\/moment\//, skill: 'sync-offline-dev' },
  { match: /^src\/services\/storage/, skill: 'diagnostics-dev' },
];

/**
 * **필독 사후분석** — 특정 영역을 건드리기 전에 반드시 읽어야 하는 사고 기록.
 *
 * 왜 스킬 문서와 따로 두나(2026-07-26): 스킬 문서는 *"이렇게 하라"*를 말하고, 사후분석은
 * *"이렇게 하다 이렇게 됐다"*를 말한다. 둘은 다른 종류의 지식이고, 후자가 없으면 앞의 규칙이
 * **왜** 있는지 몰라 상황이 조금만 달라져도 어긴다. 실제로 그날 §7·§10을 **직접 쓰고도**
 * 같은 부류에 다시 빠졌다 — 규율을 쓰는 것과 적용하는 것은 다른 행동이다.
 *
 * 라우팅으로 강제하는 이유: 문서만 만들어 두면 **안 읽는다.** 읽을 자리를 표가 정해야 한다.
 */
export const POSTMORTEMS = [
  {
    match: /^(src\/services\/(sync|autoSync|purge|trash|storeState|r2|media|backup)|src\/ui\/panels\/(diagnostics|verdict)|src\/offline\/|supabase\/)/,
    doc: 'docs/records/2026-07-26-STORAGE-DELETE-POSTMORTEM.md',
    // ⚠️ **개수를 여기 손으로 적지 않는다.** 처음엔 '결함 10건'이라고 박아 뒀는데 사고가 12건이
    // 될 때까지 아무도 못 고쳤다 — 브리핑이 "이 영역에서 뭐가 났는지"를 알려주는 자리에서
    // **틀린 숫자를 알려주고 있었다**(M-0001의 그 드리프트). 이제 문서 표에서 뽑는다.
    why: (n) => `저장·동기화·삭제·복원·진단에서 하루에 결함 ${n}건 — 정적 게이트가 잡은 것은 0건이었다`,
    /** 사후분석 §1 표의 「발견된 결함 | **N건** 」에서 실측. 못 읽으면 숫자 없이 말한다(반올림 금지). */
    count: (text) => /발견된 결함 \|\s*\*\*(\d+)건\*\*/.exec(text)?.[1] ?? null,
  },
];

/** 스킬 문서가 필요 없는 영역 — **이유를 반드시 적는다**(이유 없는 제외는 결함, §7). */
export const NO_SKILL_REQUIRED = new Map([
  ['src/main.ts', '진입점 배선만 — 규율은 각 모듈 문서가 갖는다'],
  ['src/domain/registry.ts', '데이터 선언만 — 파생물은 gen-registry가 만든다'],
  ['src/app/changelog.ts', '사용자 대면 이력 데이터. 규율은 파일 머리주석에 있다'],
  ['src/app/researchLog.ts', '연구 기록 데이터 — 코드 규율 없음'],
  ['src/app/selfEval.ts', '자기평가 데이터 — check-self-eval이 직접 강제한다'],
  // *.gen.ts는 **손으로 고치는 파일이 아니다.** 읽을 문서는 그 생성기 쪽에 있고,
  // 드리프트는 짝 게이트가 막는다(정독 대상은 생성기이지 산출물이 아니다).
  ['src/app/registry.gen.ts', '자동 생성 — gen-registry.mjs가 SSOT, check-registry-gen이 강제'],
  ['src/app/platformMap.gen.ts', '자동 생성 — gen-platform-map.mjs가 코드에서 실측, check-platform-map이 강제'],
]);

export function skillsFor(paths) {
  const out = new Map();
  for (const p of paths) {
    for (const r of SKILL_ROUTES) {
      if (r.match.test(p)) {
        if (!out.has(r.skill)) out.set(r.skill, []);
        out.get(r.skill).push(p);
      }
    }
  }
  return out;
}

/** §7이 요구하는 산출물 — 형제 목록을 **디렉터리에서 뽑는다**(손으로 세지 않는다). */
export function siblingsOf(path) {
  const dir = join(ROOT, dirname(path));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(ts|mjs|css|sql)$/.test(f))
    .map((f) => join(dirname(path), f))
    .filter((f) => f !== path);
}

function changedPaths() {
  try {
    const out = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
    return out
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
      .filter((p) => !p.endsWith('/'));
  } catch {
    return [];
  }
}

/** 이 영역에서 과거에 낸 실수 — 같은 자리에서 두 번 넘어지지 않게. */
function pastMistakes(paths) {
  const file = join(ROOT, 'docs/records/coding-mistakes.md');
  if (!existsSync(file)) return [];
  const src = readFileSync(file, 'utf8');
  const bases = paths.map((p) => p.split('/').pop().replace(/\.\w+$/, ''));
  const out = [];
  for (const block of src.split(/\n## /).slice(1)) {
    const title = block.split('\n')[0];
    if (bases.some((b) => b.length > 3 && block.includes(b))) out.push(title);
  }
  return out;
}

// ── 실행 ────────────────────────────────────────────────────────────────────
// ⚠️ 이 파일은 라우팅 표(SKILL_ROUTES)의 SSOT라 `check-skill-routing`이 import한다.
// 가드가 없으면 게이트를 돌릴 때마다 브리핑 전문이 출력돼 게이트 결과가 묻힌다(실제로 그랬다).
const isMain = process.argv[1] && process.argv[1].endsWith('brief.mjs');
if (!isMain) {
  // 표만 제공하고 조용히 끝낸다.
} else {
const argv = process.argv.slice(2);
const paths = (argv.length ? argv : changedPaths()).map((p) => relative(ROOT, join(ROOT, p)));

if (!paths.length) {
  console.log('변경 파일이 없습니다. 고칠 파일을 인자로 주세요: node scripts/brief.mjs src/ui/dom.ts');
  process.exit(0);
}

console.log('\n═══ 착수 브리핑 ═══\n');
console.log(`대상 파일 ${paths.length}개:`);
for (const p of paths) console.log(`  · ${p}`);

// 🔴 **0단계 — 고칠 파일을 정하기 전에 물어야 하는 것**(2026-08-01 · M-0064).
// 이 브리핑은 *"이 **파일**을 고치려면 뭘 읽나"*에 답한다. 그런데 조사는 파일이 아니라
// **증상**에서 시작하고, 나흘을 잃은 결함의 답은 내가 **코드 주석에 적어 둔 것**이었다.
// 파일을 정하는 순간 이미 가설을 고른 것이므로, 그 전에 한 번 물어야 한다.
console.log('\n⓪ 🔴 **파일을 정하기 전에**: 이 증상을 이 저장소가 이미 아는가?');
console.log('     npm run known <증상 낱말...>      예) npm run known 사진 위치 선택기');
console.log('     원장·ADR·헌장 + **🔴 코드 주석**을 뒤진다. 답이 이미 적혀 있는데도 못 찾아');
console.log('     나흘을 쓴 적이 있다(M-0064) — 그때 빠진 층이 바로 코드 주석이었다.');

const skills = skillsFor(paths);
console.log('\n① 먼저 정독할 스킬 문서 (기억이 아니라 라우팅 표에서 뽑음):');
if (!skills.size) {
  const unrouted = paths.filter((p) => !NO_SKILL_REQUIRED.has(p));
  if (unrouted.length) {
    console.log('  ⚠️ 해당 문서를 찾지 못했습니다. 라우팅 표(SKILL_ROUTES)에 빠진 영역일 수 있어요 —');
    console.log('     그 자체가 결함이니 표를 먼저 고치세요.');
  } else {
    console.log('  (문서 불필요 영역 — NO_SKILL_REQUIRED에 이유가 적혀 있습니다)');
  }
} else {
  for (const [skill, hits] of skills) {
    const f = `.claude/skills/${skill}/SKILL.md`;
    const lines = existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f), 'utf8').split('\n').length : 0;
    console.log(`  📖 ${f}  (${lines}줄)  ← ${hits.join(', ')}`);
  }
  console.log('\n  정독 중 **문서와 코드가 어긋나거나 규칙이 빠져 있으면 그것부터 고친다.**');
  console.log('  (오늘의 사고: ui-responsive-dev에 vh/dvh·오버레이 스크롤 규칙이 아예 없었다 —');
  console.log('   읽었어도 못 막았을 구멍이었고, 그 구멍을 메우는 게 이 단계의 진짜 일이다.)');
}

const pms = POSTMORTEMS.filter((pm) => paths.some((p) => pm.match.test(p)));
if (pms.length) {
  console.log('\n①-B 🔴 **필독 사후분석** — 이 영역에서 실제로 일어난 사고의 전말:');
  for (const pm of pms) {
    const text = existsSync(join(ROOT, pm.doc)) ? readFileSync(join(ROOT, pm.doc), 'utf8') : '';
    const lines = text ? text.split('\n').length : 0;
    const n = pm.count(text);
    console.log(`  📕 ${pm.doc}  (${lines}줄)`);
    // 개수를 못 읽었으면 **숫자를 지어내지 않는다** — 문장만 남긴다.
    console.log(`     ${n ? pm.why(n) : '저장·동기화·삭제·복원·진단에서 하루에 여러 건 — 정적 게이트가 잡은 것은 0건이었다'}`);
  }
  console.log('  스킬 문서가 "이렇게 하라"면 이건 "이렇게 하다 이렇게 됐다"이다. 둘 다 읽어야 한다.');
}

console.log('\n② 형제 목록 (§7 — 손으로 세지 않고 디렉터리에서 뽑음):');
for (const p of paths) {
  const sib = siblingsOf(p);
  if (!sib.length) continue;
  console.log(`  ${p}`);
  console.log(`    형제 ${sib.length}: ${sib.map((s) => s.split('/').pop()).join(', ')}`);
}
console.log('\n  → 이 변경이 형제 전부에 걸려야 하는가? 아니라면 **제외 이유를 코드에 남긴다.**');
console.log('  → 다음 형제가 자동으로 따라오는가? 아니라면 구조(2층)가 빠진 것이다.');

const mistakes = pastMistakes(paths);
if (mistakes.length) {
  console.log('\n③ 이 영역에서 과거에 낸 실수:');
  for (const m of mistakes.slice(0, 6)) console.log(`  ⚠️ ${m}`);
}

console.log('\n④ 세계를 본다 — 상태 의존 작업이면 **실서버 스냅샷을 한 번 뜬다**(§9 4단계):');
console.log('  · 지금 데이터에 **옛 방식으로 만들어진 것**이 있는가? 있으면 누가 데려오는가?');
console.log('  · 규칙 문서는 "무엇이어야 하는가"를 말하지 "지금 무엇인가"를 말하지 않는다.');
console.log('  · 실측 M-0019: 저장소가 둘인 걸 모르고 만들어 멀쩡한 사진 11장을 문제로 단정할 뻔했다.');

console.log('\n⑤ 이 변경은 게이트가 잡을 수 있는 부류인가(§10):');
console.log('  · 계약(권한·형제 대칭) → 정적 게이트로 잠근다');
console.log('  · 상태 의존(과거 데이터) → **진단 지표**로 만든다. 정적 게이트는 못 잡는다');
console.log('  · 전달(사용자 문장) → 순수 함수로 뽑아 유닛 + **실기기 확인**');

console.log('\n⑥ 착수 전 자문(CLAUDE.md §0 5W1H · §7 · §8):');
console.log('  · 왜   — 북극성("기억과 의미를 다시 찾아준다")을 더 잘 이루는가?');
console.log('  · 어디서 — 이 사실의 SSOT는 어디인가? 손편집 중복을 만들고 있지 않은가?');
console.log('  · 어떻게 — 검증 경로는? 알려진 실패를 주입해 RED를 확인할 수 있는가?');
console.log('');
}
