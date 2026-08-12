// harness.mjs — 단일 검사 문(docs/TEST_PLAN.md). 게이트를 한 곳에서 실행.
// Phase 0B: typecheck + secret-leak + domain-registry 정합. 이후 Phase에서 게이트 추가.
//
// ── 선택(optional) 게이트의 계약 (2026-07-27 건강진단에서 신설) ──────────────────
//
// **`optional`은 "실패해도 된다"가 아니다. "전제가 없으면 재지 못한다"이다.**
//
//   · exit 2 = 전제 미충족(브라우저 없음·dist 없음·dist가 소스보다 낡음) → **SKIP**
//   · exit 1 = 검사가 실제로 돌았고 위반을 찾음                          → **FAIL**(Required와 동일)
//   · exit 0 = 통과
//
// 왜 이 구분이 필요했나: `verify-editor-live`(라이브 렌더)는 **이 앱에서 유일하게 도는
// 런타임 검출층**인데 harness에도 CI에도 없어서, 전역 playwright를 가진 사람이 기억해서
// 손으로 돌려야만 돌았다. 그런데 harness는 끝날 때 **"모든 Required 게이트 통과"**라고
// 말했다 — 런타임 층을 한 번도 재지 않고 하는 말이었다(§4 정직한 완료 위반). 그리고
// 직전 세션의 M-0037이 바로 그 검사에서 났다. **안 도는 검사가 최근 결함의 발생지였다.**
//
// 그래서 규칙 둘:
//   ① SKIP을 PASS로 반올림하지 않는다. 건너뛴 이유를 화면에 적고, 마지막 줄에서
//      "이번 실행은 그 층을 재지 않았다"고 말한다(§8 — 모르는 것은 '확인 불가').
//   ② CI에서는 전제를 **갖춰서** 돌린다(`.github/workflows/ci.yml`의 live-render job).
//      전제를 갖출 수 있는 곳에서까지 건너뛰면 ①은 그냥 변명이 된다.
import { execSync, spawnSync } from 'node:child_process';

// ── 통과한 게이트의 **단서**를 버리지 않는다 (2026-08-09 신설) ────────────────────
//
// 예전 판은 성공하면 `PASS`만 찍고 게이트가 한 말을 **통째로 버렸다**. 그래서 이런 일이
// 실제로 벌어지고 있었다:
//
//     check-production-artifacts: OK — 운영 소스맵 비활성 **(dist 미생성: 설정 확인)**
//
// 게이트는 정직했다 — "산출물이 없어 설정만 봤다"고 스스로 적었다. 그런데 화면에는 `PASS`만
// 나갔다. 자료구조는 옳고 **전달만 틀린** §10 ③형이고, 그 결과 **반쪽만 잰 검사가 온전히 잰
// 검사와 같은 얼굴**을 하고 있었다(§2-G — SKIP은 통과가 아니다의 조용한 사촌).
//
// 🔴 그렇다고 53줄을 다 찍지는 않는다 — **침묵이 정상**이다(§8). 남기는 것은 게이트가 스스로
// "이건 못 쟀다"고 말한 줄뿐이다. 남아 있는 것이 곧 확인할 거리다.
const CAVEAT_RE = /확인 불가|재지 않|안 쟀|못 쟀|검증하지 못|미생성|없어\s|정직한 한계|주의:/;

/**
 * 자기증명 안내문은 한계가 아니다 — **자기가 잘 돈다는 자랑**이다.
 * 「주입증명 … 미설치 1은 확인 불가로 갈림」처럼 낱말만 겹치는 줄을 한계로 읽으면
 * 목록이 소음이 되고, 소음이 된 목록은 사람이 안 읽는다(§11 ③ — 오탐은 틀린 게이트다).
 */
const SELF_PROOF_RE = /^(주입증명|자체검사|셀프테스트)/;

/** 게이트 출력에서 **한계를 말한 줄**만 고른다 — 순수 함수(자체검사가 부른다). */
export function caveatsOf(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  return text
    .split('\n')
    // 게이트가 이미 붙인 들여쓰기·화살표를 벗긴다. 안 벗기면 `↳ ↳`가 겹쳐 찍힌다.
    .map((l) => l.trim().replace(/^[↳·⚠️\s]+/, '').trim())
    .filter((l) => l && !SELF_PROOF_RE.test(l) && CAVEAT_RE.test(l));
}

// 자체검사(§4): 잡아야 할 것과 잡으면 안 되는 것을 주입해 본다. 이 함수가 공허하면
// 위 결함이 **고친 그 자리에서** 되살아난다.
{
  const must = [
    'check-production-artifacts: OK — 운영 소스맵 비활성 (dist 미생성: 설정 확인)',
    '  ↳ 정직한 한계: 등록까지만 보증합니다',
    '주의: Codex 전역 설치 경로가 없어 프로젝트 스냅샷만 검증했습니다.',
    '  ⚠️ 확인 불가: release-harness-governance 전역 설치본이 없습니다',
  ];
  const mustNot = [
    'check-csp: OK (셀프테스트 통과 · CSP 스택 계약 일치)',
    'check-sw: OK — 서비스워커 계약 일치',
    // 🔴 실제 오탐(2026-08-09): 자기증명 안내문이 「확인 불가」 낱말을 품어 한계로 잡혔다.
    '주입증명 17축: 정상 1 · 결함 15 모두 판별 · 미설치 1은 확인 불가로 갈림.',
    '',
  ];
  // 화살표를 벗겨 `↳ ↳`가 겹치지 않는지도 못박는다.
  if (caveatsOf('  ↳ 정직한 한계: 등록까지만')[0]?.startsWith('↳')) throw new Error('harness 자체검사 실패: 화살표를 안 벗겼다');
  for (const line of must) if (!caveatsOf(line).length) throw new Error(`harness 자체검사 실패: 한계 문장을 놓쳤다 — ${line}`);
  for (const line of mustNot) if (caveatsOf(line).length) throw new Error(`harness 자체검사 실패: 정상 문장을 한계로 읽었다 — ${line}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 빠른 차선 (`--fast` · `npm run gates`) — 2026-07-29, 실측 후 신설
// ─────────────────────────────────────────────────────────────────────────────
// 33개를 다 돌면 **91초**인데, 재보니 그중 28개(정적)는 다 합쳐 **1.8초**였다.
// 나머지가 89초를 먹는다: verify-editor-live 54s · check-timezone 15.5s ·
// verify-diagnostics-live 8s · unit-tests 7.5s.
//
// 그래서 편집 루프용 차선을 둔다 — `slow: true`를 뺀 나머지(정적 + typecheck ≈ 6초).
// typecheck는 뺄 수 없다: 타입이 깨지면 나머지 초록이 아무 뜻도 없다.
//
// 🔴 **이 차선의 유일한 계약**: 무엇을 **안 쟀는지** 반드시 말한다. 오늘(M-0047) 커버리지
// 게이트가 SKIP된 층을 「덮음」이라 말해 Required의 초록이 선택 게이트의 침묵을 덮었다.
// 같은 실수를 속도 개선으로 다시 저지르지 않는다 — 빠른 차선의 판정문은 **「통과」가 아니라
// 「일부만 쟀다」**이다(§2-G · §8).
const FAST = process.argv.includes('--fast');

const gates = [
  { name: 'typecheck', cmd: 'npm run -s typecheck' },
  { name: 'check-secret-leak', cmd: 'node scripts/check-secret-leak.mjs' },
  { name: 'check-hooks-wired', cmd: 'node scripts/check-hooks-wired.mjs' },
  { name: 'check-ci-policy', cmd: 'node scripts/check-ci-policy.mjs' },
  { name: 'check-workflow-pins', cmd: 'node scripts/check-workflow-pins.mjs' },
  { name: 'check-dependabot-policy', cmd: 'node scripts/check-dependabot-policy.mjs' },
  // 공통 스킬은 비공개 GitHub 정본의 승인 커밋에서만 갱신한다. 프로젝트에는 법을 복사하지 않고
  // 고정 스냅샷·해시·이 저장소 전용 릴리스 프로필만 둔다. CI가 전역 설치본까지 볼 수 있는
  // 환경에서는 설치 드리프트도 잡고, 일반 GitHub runner에서는 프로젝트 스냅샷·프로필을 판정한다.
  { name: 'check-shared-skill-contract', cmd: 'node scripts/check-shared-skill-contract.mjs' },
  // HRL-17 — 비싼 산출물 **앞**의 고정점. HRL-9(§18-E)가 산출물 뒤를 막는다면 이쪽은 앞을 맡는다.
  // 🔴 여기서 도는 것은 **원장 검사만**이다(싸다). 마감을 실제로 돌린 증거는 릴리스 때의
  // `--run`이고, 그게 실행 전후 트리 지문으로 「읽기 전용이다」라는 주장 자체를 검증한다.
  { name: 'check-input-closeout', cmd: 'node scripts/check-input-closeout.mjs' },
  // 게이트가 **개수가 아니라 뜻**을 단언하는지. 개수만 세는 검사는 「위반 0」과 「아무것도 안
  // 봤다」에 같은 종료코드를 준다 — 2026-08-09에 실제로 그 형태가 나왔다(check-gate-integrity).
  { name: 'check-gate-promise', cmd: 'node scripts/check-gate-promise.mjs' },
  // 게이트가 **자기가 사는 세계**를 가정하지 않는지. 로컬 하네스는 이 부류를 원리적으로
  // 못 잡는다(자기 세계에서 도니까) — 그래서 origin/main도 dist도 없는 **빈 세계 사본**을
  // 만들어 싼 게이트를 전부 한 번 돌린다. M-0135가 정확히 이 자리에서 CI만 빨갛게 만들었다.
  { name: 'check-env-assumption', cmd: 'node scripts/check-env-assumption.mjs' },
  // 라이브 게이트가 **시계로 자는 것**이 다시 늘지 않게. 실측(T-016): verify-editor-live의
  // 벽시계 128.6초 중 고정 대기가 137.3초/351회(겹쳐 돌아 합이 넘는다)였다 — 사실상 자는 검사였다.
  // 고정 대기는 오류도 경고도 안 내고 그냥 느려지므로 문서로는 안 지켜진다(M-0119가 그 형태).
  { name: 'check-live-sleep', cmd: 'node scripts/check-live-sleep.mjs' },
  // 거버넌스 문서가 **모집단 결번을 보이게** 서 있는지. 산문은 존재하는 것만 서술하므로
  // 빠진 칸을 볼 방법이 없다 — 형제를 나란히 세우면 빈칸이 모양으로 드러난다(TRE).
  { name: 'check-doc-tree', cmd: 'node scripts/check-doc-tree.mjs' },
  // 빌드 단계 기준선이 **판정에 쓸 수 있는 상태인가**(표본 3회 이상·임계가 판정식과 일치).
  // 지어낸 임계는 정상 빌드마다 오탐을 내고, 오탐이 반복되면 사람이 빨간불을 무시한다.
  { name: 'check-step-duration', cmd: 'node scripts/check-step-duration.mjs' },
  // 머지 뒤 결함을 발견했을 때 **고치기 전에** 수습 경로를 정한다. 세 갈래를 전부 낼 수
  // 있어야 판정기다 — 갈래 하나가 실제 파일에서 한 번도 안 나오면 죽은 갈래다.
  { name: 'check-recovery-path', cmd: 'node scripts/check-recovery-path.mjs' },
  // 독립 리뷰가 필요한 판인지 diff에서 결정적으로 판정한다(빈도 규칙은 사람 기억에 달린다).
  { name: 'check-review-tier', cmd: 'node scripts/check-review-tier.mjs' },
  { name: 'check-domain-wiring', cmd: 'node scripts/check-domain-wiring.mjs' },
  { name: 'check-csp', cmd: 'node scripts/check-csp.mjs' },
  { name: 'check-production-artifacts', cmd: 'node scripts/check-production-artifacts.mjs' },
  { name: 'check-base-consistency', cmd: 'node scripts/check-base-consistency.mjs' },
  { name: 'check-env-wiring', cmd: 'node scripts/check-env-wiring.mjs' },
  { name: 'check-domain-symmetry', cmd: 'node scripts/check-domain-symmetry.mjs' },
  { name: 'check-sync-parallelism', cmd: 'node scripts/check-sync-parallelism.mjs' },
  { name: 'check-verdict-symmetry', cmd: 'node scripts/check-verdict-symmetry.mjs' },
  { name: 'check-skill-routing', cmd: 'node scripts/check-skill-routing.mjs' },
  // 아래 둘은 형제다: 하나는 「이 코드는 누가 읽고 고치나(문서)」를, 다른 하나는
  // 「이 화면은 누가 눈으로 보나(라이브)」를 묻는다. 둘 다 *덮였음의 보증*이 아니라
  // **안 덮인 것이 조용히 생기는 것의 차단**이다(CLAUDE.md §13).
  { name: 'check-live-coverage', cmd: 'node scripts/check-live-coverage.mjs' },
  { name: 'check-self-eval', cmd: 'node scripts/check-self-eval.mjs' },
  { name: 'check-schema-parity', cmd: 'node scripts/check-schema-parity.mjs' },
  { name: 'check-migration-grants', cmd: 'node scripts/check-migration-grants.mjs' },
  { name: 'check-report-fields', cmd: 'node scripts/check-report-fields.mjs' },
  { name: 'check-no-synthetic-italic', cmd: 'node scripts/check-no-synthetic-italic.mjs' },
  { name: 'check-edge-fn-ops', cmd: 'node scripts/check-edge-fn-ops.mjs' },
  { name: 'check-sync-release-contract', cmd: 'node scripts/check-sync-release-contract.mjs' },
  { name: 'check-node-version', cmd: 'node scripts/check-node-version.mjs' },
  { name: 'check-backup-coverage', cmd: 'node scripts/check-backup-coverage.mjs' },
  { name: 'check-blueprint', cmd: 'node scripts/check-blueprint.mjs' },
  { name: 'check-registry-gen', cmd: 'node scripts/check-registry-gen.mjs' },
  // 가이드 화면이 헌법 조항(비타협 원칙·실행 규율·§0)을 **손으로 옮겨 적고** 있었다.
  // 헌법을 고쳐도 화면은 옛 문장을 보여줬고, 자료구조는 옳으니 유닛은 전부 초록이었다(§10 ③).
  { name: 'check-constitution-gen', cmd: 'node scripts/check-constitution-gen.mjs' },
  // 두 AI가 **다른 계약을 읽고 있지 않은지**. 2026-07-29에 실제로 네 군데가 갈라져 있었고,
  // 그중 「완료의 정의」는 서로를 포함하지 않았다 — Codex는 화면을 안 보고, Claude는 배포
  // 확인 없이 「완료」라 할 수 있었다(M-0046이 그 형태). 정본은 docs/CONSTITUTION.md 하나다.
  { name: 'check-adapter-parity', cmd: 'node scripts/check-adapter-parity.mjs' },
  // 위 게이트의 **앞단**: 애초에 등록되지 않아 비교 대상에도 못 들어오는 것을 막는다.
  // 새 `docs/*.md`가 지도에 없거나(실측 25개 중 4개가 그랬다), 새 AI 지시문이 어댑터로
  // 등록되지 않으면 그 도구만 다른 계약을 읽는다(CONSTITUTION 「지시·계약 문서를 바꿀 때」).
  { name: 'check-doc-governance', cmd: 'node scripts/check-doc-governance.mjs' },
  // 「모듈별 설계서」는 손으로 유지하지 않는다. 실행 코드의 파일·API·의존·I/O·해시에서
  // 재생성하고, 새 실행 파일이 미분류되거나 커밋본이 낡으면 RED다. 설계서가 정본처럼 보이는
  // 순간 코드와 갈라지므로, 이 게이트는 문서 내용보다 **파생 관계**를 지킨다.
  { name: 'check-module-design-docs', cmd: 'node scripts/check-module-design-docs.mjs' },
  // §11의 메타 게이트 — "게이트가 목적에 맞게 작동하는가? 대조군이 있는가?"(사용자 질문
  // 2026-08-05)를 기계로 되묻는다: check-*.mjs 전부가 harness에 배선됐는가 + 셀프테스트
  // (알려진 실패 주입) 흔적을 갖고 있는가. 새 게이트가 이 둘 없이 조용히 태어나는 것을 막는다.
  { name: 'check-gate-integrity', cmd: 'node scripts/check-gate-integrity.mjs' },
  // 「내가 못 보는 것」 등록부가 조용히 비지 않게(사용자 지시 2026-08-05: *"빼면 안 됨"*).
  // 이유 없는 미구현 · 없는 도구를 가리키는 coveredBy를 RED로 잡는다.
  { name: 'check-diag-blindspots', cmd: 'node scripts/check-diag-blindspots.mjs' },
  // 진단이 「서버가 한 번에 주는 행수」를 판정할 때 쓰는 **가정값**이 실제 페이지네이션 코드와
  // 갈라지지 않게. 갈라지면 진단이 틀린 기준으로 초록을 낸다(§7 SSOT).
  { name: 'check-page-size-parity', cmd: 'node scripts/check-page-size-parity.mjs' },
  { name: 'check-current-doc-facts', cmd: 'node scripts/check-current-doc-facts.mjs' },
  { name: 'check-platform-map', cmd: 'node scripts/check-platform-map.mjs' },
  { name: 'check-lazy-screens', cmd: 'node scripts/check-lazy-screens.mjs' },
  { name: 'check-font-subsets', cmd: 'node scripts/check-font-subsets.mjs' },
  { name: 'check-fn-size', cmd: 'node scripts/check-fn-size.mjs' },
  { name: 'check-sw', cmd: 'node scripts/check-sw.mjs' },
  { name: 'check-hand-counts', cmd: 'node scripts/check-hand-counts.mjs' },
  { name: 'check-doc-counts', cmd: 'node scripts/check-doc-counts.mjs' },
  { slow: true, name: 'check-timezone', cmd: 'node scripts/check-timezone.mjs' },
  { name: 'check-instant-normalization', cmd: 'node scripts/check-instant-normalization.mjs' },
  { name: 'check-exif-strip-on-share', cmd: 'node scripts/check-exif-strip-on-share.mjs' },
  { name: 'check-exif-order', cmd: 'node scripts/check-exif-order.mjs' },
  { name: 'check-bytes-upload-symmetry', cmd: 'node scripts/check-bytes-upload-symmetry.mjs' },
  // 「이 저장소가 이미 아는가」를 묻는 문. **비어 있으면 조용히 쓸모없어진다** — 층 하나가
  // 빠져도 검색은 성공한 것처럼 보인다. 그래서 자기점검을 게이트로 돌린다(M-0064).
  { name: 'check-known-index', cmd: 'node scripts/known.mjs --selftest' },
  // 「항상 최신 APK」 계약 — 워크플로(apk-latest 릴리스 --clobber) ↔ 앱 상수 ↔ 가이드 화면이
  // 같은 고정 주소를 말하는가. 하나가 조용히 갈라지면 다운로드 버튼이 낡은 앱·죽은 링크가 된다.
  { name: 'check-apk-release-link', cmd: 'node scripts/check-apk-release-link.mjs' },
  // 「접속하면 스스로 최신」 계약 — 빌드가 version.json을 심고, 앱이 시작·복귀 때 묻고,
  // SW가 그 신호를 만지지 않는가. 사슬이 끊기면 열려 있는 앱에 새 배포가 영영 안 닿는다(M-0070).
  { name: 'check-update-signal', cmd: 'node scripts/check-update-signal.mjs' },
  // 「여행 영구삭제가 자식을 trip_id로 지운다」가 스키마와 일치하는가 — tripScoped 플래그를
  // 각 도메인 rowmap의 trip_id 유무와 대조. 손으로 쓴 질의 컬럼이 없는 테이블을 치는 것을 막는다(C-1).
  { name: 'check-purge-scope', cmd: 'node scripts/check-purge-scope.mjs' },
  // 「진짜 좌표인가」 판정이 isRealCoord 한 곳에만 있는가 — 손으로 쓴 0,0 검사가 다시 생기면 RED(H-3).
  { name: 'check-real-coord', cmd: 'node scripts/check-real-coord.mjs' },
  { name: 'check-edge-cors', cmd: 'node scripts/check-edge-cors.mjs' },
  // 브랜드 색이 UI TS에 하드코딩되지 않는가 — 색 SSOT는 tokens.css(H-6).
  { name: 'check-ui-color-token', cmd: 'node scripts/check-ui-color-token.mjs' },
  { slow: true, name: 'unit-tests', cmd: 'npm run -s test' },
  // 런타임 층 — 실제 Chromium이 `dist`를 열어 **화면에 나가는 것**을 잰다.
  // 전제(playwright + 최신 dist)가 없으면 SKIP, 돌았는데 위반이면 FAIL(위 계약 참조).
  //
  // 둘로 나뉜 이유: 재는 대상이 다르다. 편집기는 **상호작용**(슬라이더·브러시·픽셀 read-back)을,
  // 진단은 **전달**(사용자에게 가는 문장·자리·버튼)을 잰다. 후자는 2026-07-28 M-0046 때
  // **아예 없던 층**이다 — 게이트 31종·유닛 686건이 전부 초록인 채로 거짓 안내가 배포됐고,
  // 30분 뒤 사용자 실기기 스크린샷이 잡았다(§10 ③).
  { slow: true, name: 'verify-editor-live', cmd: 'node scripts/verify-editor-live.mjs', optional: true },
  { slow: true, name: 'verify-diagnostics-live', cmd: 'node scripts/verify-diagnostics-live.mjs', optional: true },
  { slow: true, name: 'verify-authgate-live', cmd: 'node scripts/verify-authgate-live.mjs', optional: true },
];

/**
 * 전제 미충족을 뜻하는 종료코드. 라이브 게이트들이 이 값으로 자기 전제를 알린다.
 *
 * 🔴 **이 값은 `optional`일 때만 SKIP이다.** 아래 분기의 `g.optional &&`가 그 경계이고,
 * 그건 실수가 아니라 계약이다 — 정적 게이트 15종은 **셀프테스트가 공허할 때** 같은 `2`를
 * 낸다(저장소 관용구). Required이므로 지금은 올바르게 **FAIL**로 잡힌다.
 *
 * > 그러나 **게이트 하나를 `optional`로 바꾸는 순간, 그 게이트의 「나는 공허하다」는 비명이
 * > 조용한 SKIP이 된다.** 같은 숫자가 두 가지를 뜻하기 때문이다(2026-07-28 점검에서 확인).
 * > 그래서 규칙: **정적 게이트를 optional로 승격할 때는 그 게이트의 셀프테스트 실패 코드를
 * > 먼저 `1`로 바꾼다.** 전제 미충족과 공허함은 정반대의 사건이다.
 */
const EXIT_PRECONDITION = 2;

let failed = 0;
const skipped = [];
const notMeasured = [];
/** 통과했지만 **스스로 「일부는 못 쟀다」고 말한** 게이트. 마지막 판정문이 이것을 센다. */
const partial = [];
for (const g of gates) {
  if (FAST && g.slow) {
    notMeasured.push(g.name);
    continue;
  }
  process.stdout.write(`▶ ${g.name} ... `);
  // 🔴 **한 번만 돌린다.** 예전 판은 판정용과 출력용으로 두 번 돌릴 뻔했다 — 같은 검사를
  // 두 번 재는 것은 시간만 쓰는 게 아니라 두 실행이 갈릴 수 있어 근거가 약해진다.
  const run = spawnSync(g.cmd, { shell: true, encoding: 'utf8' });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (run.status === 0) {
    console.log('PASS');
    const said = caveatsOf(out);
    for (const line of said) console.log(`    ↳ ${line}`);
    if (said.length) partial.push(g.name);
    continue;
  }
  if (g.optional && run.status === EXIT_PRECONDITION) {
    // 전제가 없어 **재지 못했다**. 통과가 아니다 — 이유를 그대로 보여준다.
    console.log('SKIP');
    const why = out.trim().split('\n')[0] || '(이유를 알리지 않음)';
    console.log(`    ↳ ${why}`);
    skipped.push({ name: g.name, why });
    continue;
  }
  console.log('FAIL');
  if (out) process.stderr.write(out);
  failed++;
}

if (failed > 0) {
  console.error(`\nharness: ${failed} gate(s) FAILED`);
  process.exit(1);
}

// 마지막 줄이 이 실행의 **판정문**이다. 건너뛴 것이 있는데 "모두 통과"라고 쓰면 거짓말이 된다.
if (FAST) {
  // 「통과」라고 쓰지 않는다 — 이 실행은 무거운 층을 **아예 안 돌렸다.**
  console.log(`\nharness(빠른 차선): 재본 ${gates.length - notMeasured.length}개 통과 · **${notMeasured.length}개는 아예 안 쟀습니다**`);
  console.log(`  · 안 잰 것: ${notMeasured.join(', ')}`);
  console.log('  → 릴리스(머지·배포)할 때만 앱 build 뒤 전체를 재세요: npm run build && npm run harness');
} else if (skipped.length > 0) {
  console.log(`\nharness: Required 게이트 통과 · 선택 ${skipped.length}개 **건너뜀**`);
  for (const s of skipped) console.log(`  · ${s.name} — 재지 못했습니다: ${s.why}`);
  console.log('  → 이 실행은 위 층을 확인하지 않았습니다. 갖추고 돌리려면: npm run build && npm run live');
} else {
  console.log('\nharness: 모든 게이트 통과(선택 게이트 포함 — 건너뛴 것 없음)');
}

// 🔴 「통과」와 「온전히 쟀다」는 다른 말이다. 통과했더라도 게이트가 스스로 못 잰 것을 말했으면
// 판정문이 그 수를 세고 이름을 댄다 — 안 그러면 반쪽만 잰 검사가 온전히 잰 검사와 같은 얼굴이 된다.
if (partial.length) {
  console.log(`  · 통과했지만 **일부만 쟀다고 스스로 말한 게이트 ${partial.length}개**: ${partial.join(', ')}`);
  console.log('    → 위 ↳ 줄이 그 게이트가 재지 못한 것입니다. 초록이 곧 전수 검증은 아닙니다.');
}
