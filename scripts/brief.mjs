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
  // 프롬프트·인계 정본을 고치는 작업도 코드와 같은 착수 규율을 받는다(M-0096).
  // 개별 스킬 문서는 아래 skillsFor()가 자기 자신도 함께 라우팅한다.
  { match: /^\.claude\/skills\//, skill: 'gates-mechanization-dev' },
  { match: /^docs\/(CONSTITUTION|HANDOFF(?:_CODEX)?)\.md$/, skill: 'gates-mechanization-dev' },
  // 계약 스키마는 게이트가 읽는 **기계 계약**이다. 특히 release-profile.json은 릴리스 그래프·
  // 재생성 원장의 정본이라, 여기를 고치는 것은 게이트를 고치는 것과 같은 규율을 받는다.
  // (2026-08-09: 이 영역이 라우팅 표에 아예 없어 브리핑이 「읽을 문서 없음」을 냈다 — §9 2단계)
  { match: /^schemas\//, skill: 'gates-mechanization-dev' },
  // A portable diagnostic blueprint changes both diagnostic semantics and the
  // gates that prove those semantics. Route it to both contracts explicitly.
  { match: /^docs\/DIAGNOSTIC_TOOL_DESIGN_BLUEPRINT\.md$/, skill: 'diagnostics-dev' },
  { match: /^docs\/DIAGNOSTIC_TOOL_DESIGN_BLUEPRINT\.md$/, skill: 'gates-mechanization-dev' },
  // The service worker controls the deployed shell's offline behavior. It is
  // executable release infrastructure, not an ungoverned public asset.
  { match: /^public\/sw\.js$/, skill: 'gates-mechanization-dev' },
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
  // 셸(ADR-0036)의 웹 쪽 절반 — 위치가 살아 있는 원본을 받는 유일한 문이므로 사진저장 헌장이다.
  { match: /^src\/services\/nativePhotos/, skill: 'photo-storage-dev' },
  // Capacitor 전역 접근 SSOT — 사진 문(OriginalPhotos)과 로그인 복귀(App)가 함께 기대므로
  // 셸의 존재 이유인 사진저장 헌장을 따른다(ADR-0036·0037). **셸을 어떻게 짜는가**의
  // 규율(server.url 분리·브리지 감지 단일화)은 android-apk-dev가 정본이라 함께 걸린다.
  { match: /^src\/services\/capacitorShell/, skill: 'photo-storage-dev' },
  { match: /^src\/services\/capacitorShell/, skill: 'android-apk-dev' },
  { match: /^src\/services\/nativePhotos/, skill: 'android-apk-dev' },
  // APK 배포 사실 SSOT(고정 릴리스 주소·설치 안내) — 셸 배포 계약이므로 같은 헌장.
  // **「항상 최신 APK」 계약 자체**(고정 태그·--clobber·3자리 대조)의 정본은 android-apk-dev.
  { match: /^src\/app\/apk\.ts/, skill: 'photo-storage-dev' },
  { match: /^src\/app\/apk\.ts/, skill: 'android-apk-dev' },
  // 설치 가이드 문서(플레이북) — apk.ts SSOT에서 조립되는 셸 배포 산출물이라 같은 헌장.
  { match: /^src\/app\/playbook\.ts/, skill: 'android-apk-dev' },
  // Capacitor 셸 프로젝트 전체(웹 자산 미번들 계약·네이티브 플러그인) — 2026-08-01
  // 사용자 지시로 전용 헌장이 생겼다: "안드로이드 APK 생성에 관한 스킬문서도 별도 관리하자".
  { match: /^android-shell\//, skill: 'android-apk-dev' },
  { match: /^\.github\/workflows\/android-apk\.yml/, skill: 'android-apk-dev' },
  { match: /^scripts\/(check-apk-release-link|check-update-signal|gen-version-file)\.mjs/, skill: 'android-apk-dev' },
  // 훅은 「강제 수단」이라 게이트·프롬프트 거버넌스와 같은 규율을 받는다(S-09 · 헌법 §18).
  { match: /^scripts\/hook-[\w-]+\.mjs/, skill: 'gates-mechanization-dev' },
  // 「접속하면 스스로 최신」 배선 — 재설치 없이 웹만 갱신되는 계약이라 셸 헌장이 정본이다.
  // 예전엔 NO_SKILL_REQUIRED였다(계약이 check-update-signal에만 있다고 봤음) — 이제 전용
  // 헌장이 생겼으니 그쪽으로 옮긴다(§7 — 새로 생긴 헌장이 형제의 규율을 물려받는 방향).
  { match: /^src\/services\/appUpdate/, skill: 'android-apk-dev' },
  // 셸 자기갱신 배너(ADR-0040) — 새 APK 감지·shell-version 마커·함정 D/E가 전부 셸 헌장 소관.
  { match: /^src\/services\/shellUpdate/, skill: 'android-apk-dev' },
  { match: /^src\/domain\/media\//, skill: 'photo-storage-dev' },
  // 순간 안의 사진 순서 — 사진 자료의 규율(photo-storage)과 동기화 필드(sync-offline)가
  // 동시에 걸리는 이음매다. sortOrder는 서버로 가는 **사용자 기록**이다(마이그레이션 0029).
  { match: /^src\/domain\/media\/order/, skill: 'sync-offline-dev' },
  // 꾹 눌러 끌기 배선 — 화면 상호작용이라 UI 헌장이 정본이다.
  { match: /^src\/ui\/dragReorder/, skill: 'ui-responsive-dev' },
  { match: /^src\/ui\/panels\/(verdict|diagnostics)/, skill: 'diagnostics-dev' },
  { match: /^src\/services\/(diagnostics|envReport|storeState)/, skill: 'diagnostics-dev' },
  // 삭제 표식과 새 UUID의 대조는 판정과 동기화 스냅샷이 함께 성립해야 한다.
  { match: /^src\/services\/placeZombieAudit/, skill: 'diagnostics-dev' },
  { match: /^src\/services\/placeZombieAudit/, skill: 'sync-offline-dev' },
  // deviceId는 진단이 읽지만 **동기화 push 경로에 값을 찍는다** — 규율은 그쪽이 더 무겁다.
  { match: /^src\/app\/deviceId/, skill: 'sync-offline-dev' },
  { match: /^src\/app\/errorLog/, skill: 'diagnostics-dev' },
  { match: /^src\/domain\/integrity/, skill: 'diagnostics-dev' },
  // 자동 동기화 상태 → 사용자 문장. **판정 문장 자체가 결함일 수 있는** 부류라 진단 헌장이다
  // (§10 ③ · 7-D). 2026-07-27: 성공 72초 뒤인데 「판정 불가」로 총괄을 끌어내렸다.
  { match: /^src\/domain\/syncStatusVerdict/, skill: 'diagnostics-dev' },
  { match: /^src\/domain\/syncReleaseVerdict/, skill: 'diagnostics-dev' },
  { match: /^src\/domain\/syncReleaseVerdict/, skill: 'sync-runtime-dev' },
  { match: /^src\/services\/syncReleaseDiagnostics/, skill: 'diagnostics-dev' },
  { match: /^src\/services\/syncReleaseDiagnostics/, skill: 'sync-runtime-dev' },
  { match: /^src\/app\/syncReleaseContract\.gen\.ts$/, skill: 'gates-mechanization-dev' },
  // Domain-settled sync progress is part of the sync execution contract, not an elapsed-time estimate.
  { match: /^src\/domain\/syncProgress/, skill: 'sync-offline-dev' },
  { match: /^src\/domain\/(syncProgress|syncBadgeVerdict)/, skill: 'sync-runtime-dev' },
  // 큐 없는 tombstone의 서버 증거 판정 + 사용자 문장. 삭제/LWW 규율과 진단 전달 규율이
  // 동시에 걸리는 이음매라 두 헌장을 모두 읽는다(M-0095).
  { match: /^src\/domain\/syncTombstoneVerdict/, skill: 'diagnostics-dev' },
  { match: /^src\/domain\/syncTombstoneVerdict/, skill: 'sync-offline-dev' },
  { match: /^src\/domain\/placeZombieVerdict/, skill: 'diagnostics-dev' },
  { match: /^src\/domain\/placeZombieVerdict/, skill: 'sync-offline-dev' },
  // 휴지통 판정 + 그 관측 수집. `syncTombstoneVerdict`와 **같은 이음매**라 두 헌장을 모두 읽는다:
  // 판정 문장은 진단 규율(§8 · §10 ③), 「무엇을 휴지통으로 볼 것인가」는 삭제·tombstone 규율이다.
  { match: /^src\/domain\/trashVerdict/, skill: 'diagnostics-dev' },
  { match: /^src\/domain\/trashVerdict/, skill: 'sync-offline-dev' },
  { match: /^src\/services\/trashState/, skill: 'diagnostics-dev' },
  { match: /^src\/services\/trashState/, skill: 'sync-offline-dev' },
  // 진단 분류 축·사각지대 등록부 — 「무엇을 도구로 만들 것인가」의 정본이라 진단 헌장이다.
  { match: /^src\/domain\/diagGroups/, skill: 'diagnostics-dev' },
  { match: /^src\/domain\/diagnosticReport/, skill: 'diagnostics-dev' },
  // 🔴 왕복 시험은 **쓰기**다. 판정은 진단 규율이지만, 실제로 만들고 지우고 영구삭제하는
  // 경로라 삭제·tombstone·원장 규율이 그대로 걸린다 — 두 헌장을 모두 읽는다.
  { match: /^src\/domain\/roundTripVerdict/, skill: 'diagnostics-dev' },
  { match: /^src\/domain\/fileRealityVerdict/, skill: 'diagnostics-dev' },
  // 「저장소 보호」 거절 뒤 문장 — 판정 문장 결함군(§10 ③)이라 진단 헌장이 정본이다(T-005).
  { match: /^src\/domain\/persistAdvice/, skill: 'diagnostics-dev' },
  { match: /^src\/services\/fileReality/, skill: 'diagnostics-dev' },
  { match: /^src\/services\/roundTrip\.ts/, skill: 'diagnostics-dev' },
  { match: /^src\/services\/roundTrip\.ts/, skill: 'sync-offline-dev' },
  // 서버 계약 실측 — 판정은 진단 규율이고, 익명 클라이언트·RLS·페이지네이션을 만지므로
  // Supabase 보안 헌장도 함께 읽는다(잘못 만들면 **검사가 내 세션을 물고 가 공허해진다**).
  { match: /^src\/domain\/serverContractVerdict/, skill: 'diagnostics-dev' },
  { match: /^src\/services\/serverContract/, skill: 'diagnostics-dev' },
  { match: /^src\/services\/serverContract/, skill: 'supabase-security-dev' },
  // 세션·로그인 관측과 「기록을 볼 자격」 판정 — 인증 경계라 Supabase 보안 헌장이 함께 걸린다.
  // 🔴 authGate는 **홈 잠금과 딥링크 가드가 공유하는 단일 판정**이다(두 곳에 손으로 두면 우회로가 생긴다).
  { match: /^src\/domain\/authGate/, skill: 'supabase-security-dev' },
  { match: /^src\/domain\/sessionVerdict/, skill: 'diagnostics-dev' },
  { match: /^src\/domain\/deviceFleetVerdict/, skill: 'diagnostics-dev' },
  // 🔴 첫 화면 배지 — 사용자가 앱을 열 때 **가장 먼저 읽는 문장**이다. 여기가 거짓말하면
  // 나머지 진단은 열어 보지도 않는다(M-0101이 그 형태였다). 판정 규율은 진단 헌장,
  // 「서버와 같은가」의 대조는 동기화 헌장이 정본이라 둘 다 읽는다.
  { match: /^src\/domain\/syncBadgeVerdict/, skill: 'diagnostics-dev' },
  { match: /^src\/services\/syncParity/, skill: 'diagnostics-dev' },
  { match: /^src\/services\/syncParity/, skill: 'sync-offline-dev' },
  { match: /^src\/services\/(autoSync|syncPlan|syncParity)/, skill: 'sync-runtime-dev' },
  { match: /^src\/ui\/screens\/home/, skill: 'sync-runtime-dev' },
  // 위치관리대장 — 좌표 순서·역지오코딩은 장소 헌장 소관이다.
  { match: /^src\/domain\/place\/registry/, skill: 'map-place-dev' },
  { match: /^src\/ui\/screens\/placeRegistry/, skill: 'map-place-dev' },
  { match: /^src\/services\/sessionState/, skill: 'diagnostics-dev' },
  { match: /^src\/services\/sessionState/, skill: 'supabase-security-dev' },
  { match: /^src\/services\/(sync|syncPlan|canonicalSync|autoSync|purge|trips|moments|media|expenses|trash)\.ts/, skill: 'sync-offline-dev' },
  { match: /^src\/(sync|offline)\//, skill: 'sync-offline-dev' },
  { match: /^src\/domain\/\w+\/rowmap/, skill: 'sync-offline-dev' },
  // 홈 기간 트리(연도▸월) — 순수 로직이지만 존재 이유가 홈 화면 레이아웃·필터라 UI 헌장이다.
  { match: /^src\/domain\/trip\/timeTree/, skill: 'ui-responsive-dev' },
  // 홈 상태별 보기(칩·구획·접기) — 같은 이유로 UI 헌장이다. 여기 담긴 것이 「무엇을 첫 화면에
  // 보이고 무엇을 접는가」와 상태 라벨의 SSOT라, 화면 대칭 규율(§7)이 걸리는 자리다.
  { match: /^src\/domain\/trip\/homeSections/, skill: 'ui-responsive-dev' },
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
    match: /^(src\/services\/(sync|autoSync|purge|trash|storeState|placeZombieAudit|r2|media|backup)|src\/domain\/(syncTombstoneVerdict|placeZombieVerdict)|src\/ui\/panels\/(diagnostics|verdict)|src\/offline\/|supabase\/)/,
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
  ['src/app/constitution.gen.ts', '자동 생성 — docs/CONSTITUTION.md가 SSOT, check-constitution-gen이 강제'],
  // 목록이 아니라 **사람이 붙이는 말**만 있는 편집 메타. gates.ts의 형제이고, 목록과의
  // 어긋남은 check-registry-gen이 양방향으로 막는다(정독할 규율은 없고 설명만 채우면 된다).
  ['src/app/agents.ts', '에이전트 한 줄 설명 데이터 — 목록 정본은 .claude/agents/, check-registry-gen이 강제'],
]);

/** Windows의 `path.relative()`가 돌려주는 `\`를 라우팅 표의 `/` 표기로 맞춘다. */
export function routePath(path) {
  return path.replaceAll('\\', '/');
}

export function skillsFor(paths) {
  const out = new Map();
  const add = (skill, path) => {
    if (!out.has(skill)) out.set(skill, []);
    if (!out.get(skill).includes(path)) out.get(skill).push(path);
  };
  for (const rawPath of paths) {
    const p = routePath(rawPath);
    const ownSkill = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(p)?.[1];
    if (ownSkill) add(ownSkill, p);
    for (const r of SKILL_ROUTES) {
      if (r.match.test(p)) add(r.skill, p);
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
    .map((f) => routePath(join(dirname(path), f)))
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
const paths = (argv.length ? argv : changedPaths()).map((p) =>
  routePath(relative(ROOT, join(ROOT, p))),
);

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

// ⑦ 열린 과제(백로그) — docs/BACKLOG.md가 미완료 상태의 단일 정본이다. 여기서 매 착수마다
// 띄우는 것이 그 문서가 낡지 않게 하는 2층(구조)이다: 안 읽고는 일을 시작할 수 없다.
// 조항만 있던 ROADMAP은 실제로 스캐폴딩 시절에 멈춘 채 낡았다(HANDOFF-0057).
{
  const backlogFile = join(ROOT, 'docs/BACKLOG.md');
  if (existsSync(backlogFile)) {
    const text = readFileSync(backlogFile, 'utf8');
    const open = text.split('## 완료 아카이브')[0];
    const rows = open.split('\n').filter((l) => /^\|\s*T-\d/.test(l));
    console.log(`\n⑦ 열린 과제 ${rows.length}건 (정본 docs/BACKLOG.md — 상태 변경은 그 파일에서만):`);
    for (const r of rows) {
      const c = r.split('|').map((x) => x.trim());
      // | ID | 과제 | 상태 | ... — 셀 수가 모자라면 지어내지 않고 원문 줄을 그대로 보여준다.
      if (c.length >= 4) console.log(`  · ${c[1]} [${c[3]}] ${c[2]}`);
      else console.log(`  · ${r}`);
    }
    console.log('  → 끝낸 과제는 **같은 커밋에서** 완료 아카이브로 옮긴다(증거 필수).');
  } else {
    console.log('\n⑦ ⚠️ docs/BACKLOG.md가 없습니다 — 미완료 과제 정본이 사라졌습니다(그 자체가 결함).');
  }
}
// ⑨ 모순 검사(§17) — 사용자 실기기가 잡은 결함의 최빈형이 「두 문장이 서로 어긋남」이었다.
// 각 조각은 자기 자리에서 참이라 **유닛이 전부 통과한다** — 모순은 둘이 만나는 자리(대개 화면)
// 에서만 보인다. 그래서 착수마다 네 축을 묻는다(조항만으로는 안 지켜진다는 것이 관측된 사실이다).
console.log('\n⑨ 모순 검사(§17) — 코딩 전·중에 네 축을 대조한다:');
console.log('  · 판정문 ↔ 그 아래 값   — 「모른다」면서 숫자를 적고 있지 않은가? 「없다」인데 찾아는 봤나?');
console.log('  · 화면 ↔ 세계          — 「연결이 돌아오면」인데 연결은 멀쩡한가? 앱이 **아는 값**을 판정에 쓰고 있나?');
console.log('  · 기기 ↔ 기기 / 표면    — APK·설치된 PWA·브라우저 탭에서 **같은 문장이 다 참인가**?');
console.log('  · 문서 ↔ 코드          — 지시문이 시키는 절차가 훅·게이트에 실제로 막히지 않는가?');
console.log('  → 두 문장을 **한 값에서 파생**시키면 모순이 구조적으로 불가능해진다(그게 검사보다 낫다).');
console.log('  → 라이브로 잴 때: 그 검사가 **모순이 날 수 있는 표면에서 도는가?** 아니면 초록은 「안 봤다」이다.');

// ⑧ 미완성 작업(§16) — 조항만으로는 안 지켜진다는 것이 관측된 사실이라(§7 2층), 착수마다
// 세어서 보여준다. 이 저장소는 squash 머지라 브랜치를 origin/main에서 다시 세우는 것이
// 정례이고, 그 순간 안 물어본 미완성은 소리 없이 사라진다(M-0111).
{
  const count = (cmd) => {
    try {
      return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean).length;
    } catch {
      return null; // 얕은 클론 등 — 0으로 반올림하지 않는다(§8: 모르는 것은 '확인 불가')
    }
  };
  const dirty = count('git status --porcelain');
  const stashed = count('git stash list');
  const unmerged = count('git log --oneline origin/main..HEAD');
  const unknown = [dirty, stashed, unmerged].some((n) => n === null);
  const total = [dirty, stashed, unmerged].reduce((a, n) => a + (n ?? 0), 0);

  console.log('\n⑧ 미완성 작업(§16) — 세션 시작·종료마다 확인:');
  console.log(
    `  · 커밋 안 됨 ${dirty ?? '확인 불가'} · 숨김 ${stashed ?? '확인 불가'} · 머지 안 됨 ${unmerged ?? '확인 불가'}`,
  );
  if (unknown) console.log('  ⚠️ 일부를 못 셌습니다 — 0으로 읽지 마세요(§8). 직접 확인하세요.');
  if (total > 0) {
    console.log('  🔴 미완성이 있습니다. **보존(chore(wip): … 미완성 · 머지 금지) → 재고 → 사용자에게 묻는다.**');
    console.log('     "미완성 X가 있습니다. 이어서 마무리할까요?" — 안 물으면 그건 내가 만든 미완성이다(§16 ④).');
  } else if (!unknown) {
    console.log('  ✓ 없음 — 그래도 남이 두고 간 브랜치는 따로 본다: git branch -r → origin/main..origin/<브랜치>');
  }
}
console.log('');
}
