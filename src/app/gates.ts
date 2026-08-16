// app/gates.ts — 게이트 한 줄 설명·카테고리(편집 메타). 목록·개수는 registry.gen.ts에서 파생.
// guide.ts와 mechChecks.ts가 공유한다(설명을 두 곳에 손으로 쓰지 않게 — §7).

export type GateCategory = 'static' | 'generated' | 'unit' | 'live';

export const CATEGORY_LABEL: Record<GateCategory, string> = {
  static: '정적 검사 (저장소만 · 네트워크 없음)',
  generated: '자동 생성물 ↔ 현실 대조',
  unit: '유닛 (순수 로직)',
  live: '라이브 (실제 브라우저가 화면을 열어 확인)',
};

/**
 * 게이트 한 줄 설명 — **게이트마다 반드시 하나씩.**
 *
 * 설명 없는 게이트는 가이드 화면에 이름만 뜬다. 사용자에게 `check-edge-fn-ops`는 아무 뜻도
 * 아니므로, 그건 "무엇을 지키는지 말하지 않는 안전장치"다(§8 — 도구는 관측이 아니라 판정을
 * 한다). 실제로 이 표는 12개에서 멈춰 있었고 게이트가 22개로 늘 동안 10개가 이름만 떴다.
 * 그래서 이제 `check-registry-gen`이 누락을 RED로 잡는다 — 새 게이트를 추가하면 여기도 따라온다.
 */
export const GATE_DESC: Record<string, string> = {
  typecheck: 'TypeScript strict 타입 오류 0',
  'check-secret-leak': '시크릿(키·토큰) 형태가 코드에 새지 않았는지',
  'check-hooks-wired': '강제층(Claude Code hook)이 등록돼 있고 자체검사를 통과하는지',
  'check-ci-policy': 'CI 워크플로가 헌법 §15(실행 정책)에서 벗어나지 않았는지',
  'check-workflow-pins': 'GitHub Actions 공급망 참조가 검증한 commit SHA에 고정됐는지',
  'check-dependabot-policy': 'Dependabot이 비긴급 일반 버전 PR로 전체 릴리스 검사를 자동 실행하지 않는지',
  'check-shared-skill-contract':
    '전역 공통 스킬의 승인 커밋·프로젝트 스냅샷·릴리스 프로필·설치본이 서로 갈라지지 않는지',
  'check-input-closeout': '재생성 writer 전부가 읽기 전용 마감 check를 갖는지(비싼 산출물 앞의 고정점 · HRL-17)',
  'check-gate-promise': '게이트마다 **개수가 아닌 축**을 선언했는지(약속 원장 · 부채는 줄기만 한다)',
  'check-env-assumption': '게이트가 자기가 사는 세계를 가정하는지 — origin/main도 dist도 없는 **빈 세계 사본**에서 실제로 돌려 본다(M-0135)',
  'check-live-sleep': '라이브 게이트의 고정 대기(시계로 자기)가 기준선 위로 늘지 않는지 — 래칫은 한 방향(T-016 실측)',
  'check-doc-tree': '거버넌스 문서가 shape를 선언하고, 트리 문서는 축·근거·사각지대를 갖는지(모집단 결번을 보이게)',
  'check-step-duration': '빌드 단계 기준선이 실측 3회 이상에서 파생했고 임계가 판정식과 일치하는지(지어낸 임계 차단)',
  'check-recovery-path': '머지 뒤 결함의 수습 경로(되돌림·다음판·즉시배포)를 고칠 경로에서 판정할 수 있는지',
  'check-review-tier': '독립 리뷰 필요 여부를 diff에서 판정하는지(UI 표면·리뷰 신호·생성 블록 제외)',
  'check-domain-wiring': '도메인↔화면 배선이 죽지 않았는지',
  'check-csp': 'CSP 위반(인라인·외부 리소스) 없는지',
  'check-production-artifacts': '공개 운영 빌드에 원본 TS를 드러내는 소스맵이 없는지(설정 + 실제 dist)',
  'check-base-consistency': 'base 경로·자산 참조 일관성',
  'check-env-wiring': '환경변수가 코드·워크플로·문서에서 같은 이름으로 쓰이는지',
  'check-domain-symmetry': '도메인 4종이 같은 생명주기 심볼을 갖는지(삭제만 있고 복원이 없는 형태 차단)',
  'check-sync-parallelism':
    '동기화가 독립 도메인은 병렬로 실행하고, 직렬 경계는 구체적인 FK 사유를 가지며, 실패해도 같은 단계 작업을 전부 정산하는지',
  'check-verdict-symmetry': '진단 도구가 자기 렌더 코드를 갖지 않고 단일 렌더러를 거치는지',
  'check-reduced-motion-scope':
    '「움직임 줄이기」 미디어 블록 안에 움직임이 아닌 선언이 섞이지 않는지(배려가 정보를 뺏는 형태 차단)',
  'check-skill-routing': '모든 코드 영역이 착수 전 읽을 스킬 문서를 갖는지',
  // 「덮였다」가 아니라 「덮도록 **선언**됐다」까지만 말한다 — 라이브 게이트는 SKIP될 수 있고
  // 이 정적 게이트는 그걸 모른다(§8 모르는 것은 확인 불가).
  'check-live-coverage':
    '모든 화면이 **눈으로 보는 라이브 검사**에 등록돼 있는지(없으면 이유와 함께 제외 — 이유 없는 제외는 결함)',
  'check-self-eval': '자가평가 항목이 실제 게이트·코드와 어긋나지 않는지',
  'check-schema-parity': '클라 rowmap 필드 ⊆ 서버 마이그레이션 컬럼(드리프트 차단)',
  'check-migration-grants': '코드가 하는 연산을 서버 권한(GRANT·RLS)이 실제로 허락하는지',
  'check-report-fields': '보고용 구조체의 필드를 화면이 실제로 읽는지(계산만 하고 안 보여주는 형태 차단)',
  'check-no-synthetic-italic': '가짜 기울임(합성 이탤릭)으로 한글을 뭉개지 않는지',
  'check-edge-fn-ops': 'Edge Function이 처리하는 연산 목록이 클라이언트가 보내는 것과 일치하는지',
  'check-sync-release-contract':
    '동기화 릴리스 계약의 정본·앱 생성물·Edge 소스 식별자가 같은지(배포 누락을 운영 대조 전에 정적으로 차단)',
  'check-node-version': '개발 환경과 배포 서버가 같은 Node 판을 쓰는지(어긋나면 여기선 되고 저기선 안 됩니다)',
  'check-backup-coverage': '모든 사용자 테이블이 백업 export/import에 다 있는지',
  'check-blueprint': '설계 개요도(배선맵) 선언 ↔ 실제 구조 일치',
  'check-registry-gen': '자동 집계 카운트·목록이 SSOT와 일치(손 스냅샷 드리프트 차단)',
  'check-constitution-gen': '화면이 보여주는 헌법 조항이 실제 헌법과 글자 단위로 일치',
  'check-adapter-parity':
    'Claude와 Codex가 **같은 계약**을 읽는지(두 지시문서가 갈라지면 두 AI가 다르게 판단한다)',
  'check-doc-governance':
    '새 규정·기준 문서와 새 AI 지시문이 **등록 없이 생기지 않는지**(등록 안 되면 비교 대상에도 못 들어온다)',
  'check-doc-references':
    '문서가 가리키는 경로·npm 스크립트·게이트가 **실재하는지**(「막는다」고 적힌 규칙이 없으면 그 자리는 아무도 안 본다 — M-0051)',
  'check-module-design-docs':
    '모듈별 설계서가 실행 코드의 파일·API·의존·I/O·내용 해시에서 재생성됐는지(손편집 설계 드리프트 차단)',
  'check-gate-integrity':
    '모든 check-*.mjs가 harness에 배선되고 셀프테스트(대조군)를 갖는지 — 게이트도 검사받는다(§11, 사용자 질문 2026-08-05)',
  'check-diag-blindspots':
    '개발 환경이 못 보는 것의 등록부가 조용히 비지 않는지 — 이유 없는 미구현·없는 도구를 가리키는 항목 차단(사용자 지시 "빼면 안 됨")',
  'check-page-size-parity':
    '진단이 쓰는 페이지 크기 가정이 실제 페이지네이션 코드와 같은지(갈라지면 틀린 기준으로 판정한다)',
  'check-current-doc-facts': 'ROADMAP·DATA_MODEL·TEST_PLAN의 현재 상태가 migration·BACKLOG·릴리스 순서와 맞는지',
  'check-platform-map': '어느 데이터가 어느 서비스에 사는지의 지도가 실제 코드와 일치',
  'check-lazy-screens': '어쩌다 여는 화면이 첫 로드 번들에 딸려 오지 않는지',
  'check-font-subsets': '제목 폰트 조각 선언 ↔ 실제 파일·구간·선언순서 정합',
  'check-fn-size': '큰 함수가 더 커지지 않는지(래칫 — 결함이 숨을 면적을 줄인다)',
  'check-sw': '서비스워커가 서버 응답을 캐시에 가두지 않는지(교차 출처 무개입·GET 전용)',
  'check-hand-counts': '지시문서가 게이트 개수를 손으로 적지 않는지(반드시 낡는 숫자 차단)',
  'check-doc-counts': '문서에 표시한 live 카운트가 실제와 일치(마커 대조)',
  'check-version-ssot':
    '버전을 말하는 자리가 전부 한 정본에서 파생되는가 — 생성물·안드로이드 versionName·워크플로 주입·문서',
  'check-date-freshness':
    '적어 둔 날짜가 오늘과 어긋나지 않는가 — 미래 날짜 금지(항상) + 릴리스를 얼렸으면 최신 항목이 오늘 것인가',
  'check-screen-lifecycle':
    '라우터가 한 번에 한 화면만 살려 두는가 — 모든 화면이 screen.mount()를 거치고, 비동기 뒤에 그리기 전에 isCurrent()를 묻는가',
  'check-timezone': '날짜를 UTC가 아닌 사용자 로컬로 계산(+ 다른 시간대에서도 유닛 통과)',
  'check-instant-normalization': '밖에서 온 시각을 앱의 표준 표기로 바꿔 저장(같은 순간을 두 표기로 적지 않게)',
  'check-exif-strip-on-share': '서버로 나가는 사진은 canvas 재인코딩본만 — 원본의 촬영위치(GPS)가 따라가지 않게',
  'check-exif-order': '촬영시각·위치(EXIF)를 **압축 전에, 원본에서** 읽는가 — 순서가 뒤집히면 그 정보는 영원히 사라진다(§0)',
  'check-bytes-upload-symmetry':
    '사진·소리·영상이 **같은 판정**으로 바이트를 올리는가(형제 하나만 조용히 안 올라가는 것을 차단 — M-0059)',
  'check-known-index':
    '「이 증상을 이미 아는가」를 묻는 문(`npm run known`)이 **네 층을 다 뒤지는가** — 층이 비면 그 지식은 영영 안 보인다(M-0064)',
  'check-apk-release-link':
      '「항상 최신 설치파일」 계약 — Android·Windows 고정 릴리스(--clobber·read-back) ↔ 앱 상수 ↔ 통합 가이드 버튼이 같은 주소를 말하는가',
  'check-windows-shell':
    'Windows 앱이 원격 사이트가 아닌 로컬 번들을 싣고, 고정 HTTPS 오리진·main 최소 권한·NSIS 설치 계약을 지키는가',
  'check-update-signal':
    '「접속하면 스스로 최신」 계약 — 빌드가 version.json을 심고, 앱이 시작·복귀 때 묻고, SW가 신호를 안 만지는가(M-0070)',
  'check-purge-scope':
    '여행 영구삭제가 자식을 trip_id로 지우는 계약이 실제 스키마와 일치하는가 — tripScoped ↔ rowmap의 trip_id(C-1)',
  'check-real-coord':
    '「진짜 좌표인가」 판정(유한·범위·0,0 아님)이 isRealCoord 한 곳에만 있는가 — 손으로 쓴 좌표 0,0 검사를 차단(H-3)',
  'check-ui-color-token':
    '브랜드 색이 UI TS에 하드코딩되지 않는가 — 색 SSOT는 tokens.css, 예외는 color-token-ok 표시(H-6)',
  'check-edge-cors':
    '모든 Edge Function이 사전요청(OPTIONS)을 본문 읽기 전에 답하고 CORS 헤더를 붙이는가 — 브라우저가 못 부르는 함수를 차단(M-0148)',
  'check-gate-control':
    '게이트에 대조군(셀프테스트)이 있고 그것이 실제로 통과하는가 — §4를 처음으로 기계화한 래칫',
  'check-enforcement-parity':
    'Claude와 코덱스가 같은 강제를 받는가 — 공통 층(git 훅) 자동 배선과 Claude 전용 훅의 대체 명시',
  'check-tooling-registry': '필수 검사도구 원장 항목이 구조적으로 유효하고 일관되게 분류되는지',
  'unit-tests': '순수 로직 유닛(비공허 확인)',
  'verify-editor-live':
    '실제 브라우저가 앱을 열어 화면·편집기·서비스워커·폰트를 확인(정적 검사가 원리적으로 못 보는 층)',
  'verify-diagnostics-live':
    '실제 브라우저가 진단 도구를 하나씩 열어 **사용자에게 나가는 문장·자리·버튼**을 확인(자료구조가 옳아도 화면이 틀릴 수 있다 — M-0046)',
  'verify-authgate-live':
    '실제 브라우저가 **로그아웃 상태의 데이터 관리**를 열어 잠긴 카드·열린 카드를 확인(빌드 시 박히는 값이라 다른 라이브 픽스처는 이 갈래에 닿지 못한다 — ADR-0063)',
};

/**
 * 게이트 **약속 원장** — 「이 검사는 무엇을 *세지 않고* 단언하는가」.
 *
 * ── 왜 설명 말고 축이 또 필요한가 ────────────────────────────────────────────
 * `GATE_DESC`는 *무엇을 보는가*를 말한다. 그런데 개수만 세는 게이트는 어느 저장소에서나
 * **「위반 0」과 「아무것도 안 봤다」에 같은 종료코드**를 준다. 실제로 이 저장소에서
 * 2026-08-09에 그 형태가 나왔다 — `check-gate-integrity`가 *"52개 전부 보유"*라는 초록을
 * 내면서 모집단 밖의 게이트 셋(라이브 둘 포함)을 한 번도 보지 않았다.
 *
 * 그래서 게이트마다 **개수가 아닌 축**을 하나 적는다. 문체는 「N이 아니라 M」으로 고정한다 —
 * 거부하는 개수를 **이름 대게** 만들어야, 쓰는 사람이 자기 게이트가 무엇에 기대고 있는지
 * 한 번은 마주 본다. `check-gate-promise`가 형식을 강제한다.
 *
 * 🔴 **정직한 한계**: 기계는 축의 **내용이 참인지** 못 본다. 「아무거나가 아니라 무언가」라고
 * 적어도 통과한다. 아래 값은 2026-08-09에 게이트 전수를 실제로 돌려 **각자 출력한 판정문에서
 * 파생**했지, 상상해서 채우지 않았다. 그래도 이 원장은 사람이 정직할 때만 값을 낸다.
 */
export const GATE_AXIS: Record<string, string> = {
  typecheck: '오류 개수가 아니라, 전체 프로그램이 하나의 타입 계약을 만족하는지(부분 통과가 없다)',
  'check-secret-leak': '적발 건수가 아니라, 스캔 **범위**가 저장소 전체를 덮는지 — 범위 밖은 0건이 아니라 미검사다',
  'check-hooks-wired': '훅 개수가 아니라, 각 훅의 selfTest를 **실제로 실행해** 통과하는지(등록만으로는 공허)',
  'check-ci-policy': '워크플로 줄 수가 아니라, Ready PR이 build→harness 순서이고 deploy가 harness를 중복하지 않는지',
  'check-workflow-pins': '액션 개수가 아니라, 모든 공급망 참조가 태그가 아닌 **commit SHA**에 고정됐는지',
  'check-dependabot-policy': 'PR 개수가 아니라, 일반 version update가 꺼져 있고 security update만 열려 있는지',
  'check-shared-skill-contract':
    '스킬 개수가 아니라, 정본·스냅샷·설치본 해시가 **한 커밋으로 수렴**하는지 — 미설치는 결함이 아니라 확인 불가로 갈린다',
  'check-input-closeout': '원장 항목 수가 아니라, 디렉터리의 재생성 writer **전수**가 원장에 있고 각자 읽기 전용 check를 갖는지',
  'check-domain-wiring': '도메인 수가 아니라, 문서가 선언한 배선이 실제 코드에 살아 있는지',
  'check-csp': '지시자 수가 아니라, CSP 스택이 인라인·외부 리소스를 실제로 막는 한 계약인지',
  'check-production-artifacts':
    '설정 항목 수가 아니라, 운영 번들에 원본 소스맵이 없는지 — dist가 없으면 **설정만 본 것**이고 그 한계를 스스로 말한다',
  'check-base-consistency': '경로 개수가 아니라, BASE·manifest·index.html이 같은 배포 기준을 가리키는지',
  'check-env-wiring': '변수 개수가 아니라, 코드·워크플로·문서가 같은 이름을 쓰는지',
  'check-domain-symmetry':
    '함수 개수가 아니라, 로컬 쓰기 함수 **전부**가 op을 만들거나 등록된 예외인지 — 하나만 조용히 빠지는 형태를 잡는다',
  'check-sync-parallelism': '단계 수가 아니라, 직렬 간선마다 사유가 있고 실패가 **join-all**로 정산되는지',
  'check-verdict-symmetry': '도구 개수가 아니라, 모든 판정이 **단일 렌더러**를 지나는지 — 자기 렌더 코드를 갖는 선택지가 없다',
  'check-reduced-motion-scope':
    '블록 개수가 아니라, 그 안의 **모든 선언**이 움직임 속성이거나 **이유 있는** 예외인지 — `no-preference`에 든 것은 reduce 사용자에게 통째로 사라진다',
  'check-skill-routing': '규칙 수가 아니라, 모든 코드 영역이 읽을 문서를 갖거나 **이유 있는** 제외인지',
  'check-live-coverage':
    '화면 수가 아니라, 안 덮인 화면이 **조용히 생기지 않는지** — 덮였음의 보증이 아니라 누락의 차단이다',
  'check-self-eval': '항목 수가 아니라, 자기평가 가중치 합이 100이고 항목이 원장과 일치하는지',
  'check-schema-parity': '컬럼 수가 아니라, 앱 행 타입과 서버 테이블이 1:1로 대응하는지',
  'check-migration-grants': 'migration 수가 아니라, 모든 테이블이 RLS·grant 계약을 갖거나 근거 있는 제외인지',
  'check-report-fields': '필드 수가 아니라, **사용자에게 나가는** 보고 구조가 스키마와 1:1인지',
  'check-no-synthetic-italic': 'CSS 수가 아니라, 합성 이탤릭이 한글을 뭉개는 자리가 없는지',
  'check-edge-fn-ops': 'op 수가 아니라, Edge가 처리하는 연산과 클라이언트가 보내는 연산이 대칭이고 초대제 가드가 있는지',
  'check-sync-release-contract': '연산 수가 아니라, 정본·앱·Edge의 **논리 소스 해시**가 정확히 일치하는지(LF/CRLF 대조군 포함)',
  'check-node-version': '워크플로 수가 아니라, 개발과 배포가 같은 Node 판을 쓰는지',
  'check-backup-coverage': '테이블 수가 아니라, **모든** 사용자 테이블이 백업 왕복에 들어 있는지 — 빠진 테이블은 조용히 유실된다',
  'check-blueprint': '화면 수가 아니라, 설계도 선언이 실제 코드·테이블과 일치하는지',
  'check-registry-gen':
    '게이트 수가 아니라, 원장·생성물·편집 메타가 **양방향**으로 일치하는지 — 설명·분류 없는 게이트는 들어올 수 없다',
  'check-constitution-gen': '조문 수가 아니라, 화면이 헌법을 손으로 옮겨 적지 않고 **생성으로 파생**하는지',
  'check-adapter-parity': '문서 수가 아니라, 커밋본과 재생성본이 **글자 단위**로 같은지 — 두 AI가 다른 계약을 읽지 못한다',
  'check-doc-governance': '문서 수가 아니라, 등록되지 않은 문서·지시문이 조용히 생기지 않는지',
  'check-doc-references': '문서 수가 아니라, 문서가 가리키는 경로·npm·게이트가 **실재하는지**(내용이 참인지는 못 본다)',
  'check-module-design-docs':
    '문서 수가 아니라, 실행 파일 **전수**가 단일 모듈 소유를 갖고 커밋 설계서가 현재 코드에서 재생성한 결과와 같은지',
  'check-gate-integrity':
    '게이트 수가 아니라, **원장이 돌리는 게이트 전수**가 배선·대조군·실패 기대 케이스를 갖는지 — 모집단을 파일명이 아니라 원장에서 뽑는다',
  'check-diag-blindspots': '사각 수가 아니라, 알려진 사각이 도구로 덮이거나 **이유 있는** 대기인지',
  'check-page-size-parity': '값이 아니라, 앱과 서버가 같은 페이지 크기를 쓰는지',
  'check-current-doc-facts': '문서 수가 아니라, 현재 문서가 최신 migration·BACKLOG·릴리스 상태와 일치하는지',
  'check-platform-map': '행 수가 아니라, 플랫폼 표의 각 행이 **코드에서 실측된** 값인지',
  'check-lazy-screens': '화면 수가 아니라, 첫 로드에 들어가는 화면이 의도한 둘뿐인지',
  'check-font-subsets': '조각 수가 아니라, 참조·구간·swap·선언순서가 한 계약으로 맞는지',
  'check-fn-size': '함수 수가 아니라, 새 함수가 상한을 넘지 않고 기존 부채가 **늘지 않는지** — 래칫은 한 방향이다',
  'check-sw': '캐시 수가 아니라, 서비스워커가 교차 출처에 개입하지 않고 GET 전용인지',
  'check-hand-counts': '문서 수가 아니라, 지시문서에 **손편집 개수**가 남아 있지 않은지',
  'check-doc-counts': '마커 수가 아니라, 각 마커가 실제 카운트와 일치하는지',
  'check-date-freshness': '날짜 개수가 아니라, 오늘과의 차이가 시간대 허용치를 넘는지',
  'check-version-ssot': '버전 문자열 개수가 아니라, 각 자리가 정본에서 파생되는 배선인지',
  'check-screen-lifecycle': '화면 수가 아니라, 라우터의 화면 호출 **전부**가 세션을 거치고 비동기 갈래가 세대 확인을 갖는지',
  'check-timezone': '테스트 수가 아니라, 날짜가 UTC가 아닌 **사용자 로컬**로 계산되는지',
  'check-instant-normalization': '파일 수가 아니라, 서버 경계 **전부**가 시각을 정규화하는지',
  'check-exif-strip-on-share': '업로드 경로 수가 아니라, 공유 바이트가 canvas 파생본만이고 재인코딩 우회가 0인지',
  'check-exif-order': '호출 수가 아니라, EXIF를 압축·편집 **전에 원본에서** 읽고 기본 경로가 원본 보존인지',
  'check-bytes-upload-symmetry': '도메인 수가 아니라, 바이트 도메인 **전부**가 공용 업로드 문과 작업별 불변 키를 지나는지',
  'check-known-index': '색인 덩어리 수가 아니라, **네 층 전부**가 색인에 들어오는지',
  'check-apk-release-link': '참조 수가 아니라, 워크플로·상수·가이드가 같은 **고정 주소** 계약을 지키는지',
  'check-windows-shell': '파일 수가 아니라, 로컬 payload·영속 오리진·창 범위·권한 최소화가 **동시에** 유지되는지',
  'check-update-signal': '신호 수가 아니라, 빌드 신호·앱 확인·SW 무개입이 한 계약인지',
  'check-purge-scope': '도메인 수가 아니라, cascadeParents가 migration의 cascade 폐포·rowmap과 일치하는지',
  'check-real-coord': '파일 수가 아니라, 좌표 판정이 **isRealCoord 한 곳에만** 있는지',
  'check-ui-color-token': '파일 수가 아니라, 하드코딩 색이 0이고 전부 토큰을 지나는지',
  'check-edge-cors': '함수 수가 아니라, **형제 전부**가 사전요청에 답하고 순서가 맞는지 — 하나만 빠지면 그 함수는 못 불린다',
  'check-gate-control': '게이트 수가 아니라, **대조군을 가진 게이트가 줄지 않는지**와 그 대조군이 실제로 도는지 — 래칫은 한 방향이다',
  'check-enforcement-parity': '훅 수가 아니라, **공통 층이 자동 배선되고** 한쪽만 묶는 훅이 이유와 함께 등록됐는지',
  'check-tooling-registry': '도구 개수가 아니라 필수 도구와 선택 도구의 실행 판정이 원장 기대값과 일치하는지',
  'check-gate-promise': '게이트 수가 아니라, **모든 게이트가 개수 아닌 축을 선언**했고 부채가 늘지 않는지 — 래칫은 한 방향이다',
  'check-doc-tree':
    '문서 수가 아니라, 형제를 나란히 세워 **빈칸이 모양으로 드러나는지** — 미선언은 통과가 아니고, 이관 부채는 매번 이름째 출력된다',
  'check-step-duration':
    '단계 수가 아니라, 임계의 **출처가 실측인지** — 표본 3회 미만이거나 임계가 판정식과 갈라지면 그 기준선은 지어낸 것이다',
  'check-recovery-path':
    '파일 수가 아니라, **세 갈래가 전부 살아 있는지** — 실제 파일에서 한 번도 안 나오는 갈래는 선언만 있고 죽은 것이다',
  'check-review-tier':
    '변경 줄 수가 아니라, **리뷰 신호가 있는지** — 못 읽은 줄을 깨끗함으로 반올림하지 않고 안전한 쪽으로 기운다',
  'check-env-assumption':
    '선언 개수가 아니라, **없는 세계에서 게이트가 죽지 않는지** — 전제 미충족을 위반과 같은 종료코드로 내보내면 로컬만 초록이다',
  'check-live-sleep':
    '검사 초 수가 아니라, **시계로 자는 자리가 늘었는지** — 고정 대기는 오류도 경고도 안 내고 그냥 느려져서 문서로는 안 지켜진다',
  'unit-tests': '통과 개수가 아니라, 순수 로직 계약이 유지되는지',
  'verify-editor-live': '검사 수가 아니라, **실제 브라우저에서** 사용자 경로가 실제로 도는지',
  'verify-diagnostics-live': '도구 수가 아니라, **실제 DOM에** 판정 문장·자리·버튼이 나오는지',
  'verify-authgate-live': '검사 수가 아니라, 로그아웃에서 **파괴적 동작이 실제로 막히고 내보내기는 열리는지**',
};

/**
 * 게이트 **세계 원장** — 「이 검사는 자기가 사는 세계에서 무엇을 가정하는가」(헌법 §18-G).
 *
 * ── 왜 이게 필요했나 (M-0135) ────────────────────────────────────────────────
 * 로컬 하네스가 **전부 초록**인 커밋이 CI에서 죽었다. 범인은 `git diff origin/main...HEAD`
 * 한 줄이었다 — 로컬엔 `origin/main`이 있고, 얕은 체크아웃엔 없다. 🔴 **로컬 하네스는 이
 * 부류를 원리적으로 못 잡는다: 자기가 사는 세계에서 도니까.**
 *
 * 값은 **공백으로 나눈 세계 이름**이고, 빈 문자열은 *"작업트리 말고는 아무것도 가정하지
 * 않는다"*는 **선언**이다(빈칸과 「아직 안 봤다」는 다른 말이다 — 그래서 누락은 RED).
 * 어휘는 `scripts/check-env-assumption.mjs`의 `WORLDS`가 동결한다.
 *
 * 🔴 **정직한 한계**: 이 원장은 선언이고 산문이다. 그래서 `check-env-assumption`이 **빈 세계
 * 사본**(origin 없음 · dist 없음)을 실제로 만들어 싼 게이트를 전부 한 번 돌린다 —
 * 선언과 어긋나면 RED. 벗기지 못하는 넷(globalSkills·network·browser·runtimeEnv)은
 * **재지 않았습니다**로만 말한다.
 */
export const GATE_WORLD: Record<string, string> = {
  typecheck: '',
  'check-secret-leak': '',
  'check-hooks-wired': '',
  'check-ci-policy': '',
  'check-workflow-pins': '',
  'check-dependabot-policy': '',
  // 전역 설치본이 없는 runner에서는 프로젝트 스냅샷만 판정하고 설치 드리프트는 「확인 불가」.
  'check-shared-skill-contract': 'globalSkills',
  'check-input-closeout': '',
  'check-gate-promise': '',
  'check-doc-tree': '',
  'check-step-duration': '',
  'check-recovery-path': '',
  // 🔴 M-0135가 난 자리. 기준 가지가 없으면 커밋된 diff 창을 못 보고 「확인 불가」로 간다.
  'check-review-tier': 'baseRef',
  'check-domain-wiring': '',
  'check-csp': '',
  // build 전에는 설정만 본다(dist가 있으면 실제 산출물까지). 스스로 그렇게 적는다.
  'check-production-artifacts': 'dist',
  'check-base-consistency': '',
  'check-env-wiring': '',
  'check-domain-symmetry': '',
  'check-sync-parallelism': '',
  'check-verdict-symmetry': '',
  'check-reduced-motion-scope': '',
  'check-skill-routing': '',
  'check-live-coverage': '',
  'check-self-eval': '',
  'check-schema-parity': '',
  'check-migration-grants': '',
  'check-report-fields': '',
  'check-no-synthetic-italic': '',
  'check-edge-fn-ops': 'network',
  'check-sync-release-contract': '',
  'check-node-version': '',
  'check-backup-coverage': '',
  'check-blueprint': '',
  'check-registry-gen': '',
  'check-constitution-gen': '',
  'check-adapter-parity': '',
  'check-doc-governance': '',
  'check-doc-references': '',
  'check-module-design-docs': '',
  'check-gate-integrity': '',
  'check-diag-blindspots': '',
  'check-page-size-parity': '',
  'check-current-doc-facts': '',
  'check-platform-map': '',
  'check-lazy-screens': '',
  'check-font-subsets': '',
  'check-fn-size': '',
  'check-sw': '',
  'check-hand-counts': '',
  'check-doc-counts': '',
  // 유일하게 **시스템 시계**를 읽는 게이트다 — 작업트리 밖에서 값을 가져오는 자리.
  'check-date-freshness': 'runtimeEnv',
  'check-version-ssot': '',
  'check-screen-lifecycle': '',
  'check-timezone': '',
  'check-instant-normalization': '',
  'check-exif-strip-on-share': '',
  'check-exif-order': '',
  'check-bytes-upload-symmetry': '',
  'check-known-index': '',
  'check-apk-release-link': '',
  'check-windows-shell': '',
  'check-update-signal': '',
  'check-purge-scope': '',
  'check-real-coord': '',
  'check-ui-color-token': '',
  'check-edge-cors': '',
  'check-gate-control': '',
  'check-enforcement-parity': 'baseRef',
  'check-tooling-registry': 'runtimeEnv',
  'check-env-assumption': '',
  'check-live-sleep': '',
  'unit-tests': '',
  'verify-editor-live': 'browser dist',
  'verify-diagnostics-live': 'browser dist',
  'verify-authgate-live': 'browser',
};

/** 게이트 카테고리. 없으면 'static'으로 본다. 목록은 registry.gen에서 오므로 개수는 파생. */
export const GATE_CATEGORY: Record<string, GateCategory> = {
  typecheck: 'static',
  'check-secret-leak': 'static',
  'check-hooks-wired': 'static',
  'check-ci-policy': 'static',
  'check-workflow-pins': 'static',
  'check-dependabot-policy': 'static',
  'check-doc-references': 'static',
  'check-shared-skill-contract': 'generated',
  // 생성물을 대조하지 않고 **원장이 온전한가**를 본다(디렉터리 ↔ 원장). 그래서 static이다.
  'check-input-closeout': 'static',
  'check-gate-promise': 'static',
  'check-env-assumption': 'static',
  'check-live-sleep': 'static',
  'check-doc-tree': 'static',
  'check-step-duration': 'static',
  'check-recovery-path': 'static',
  'check-review-tier': 'static',
  'check-domain-wiring': 'generated',
  'check-csp': 'static',
  'check-production-artifacts': 'generated',
  'check-base-consistency': 'generated',
  'check-env-wiring': 'generated',
  'check-domain-symmetry': 'static',
  'check-sync-parallelism': 'static',
  'check-verdict-symmetry': 'static',
  'check-reduced-motion-scope': 'static',
  'check-skill-routing': 'generated',
  // 형제(`check-skill-routing`)와 같은 부류다: 손으로 쓴 **선언**을 디렉터리라는 **현실**에
  // 대조한다. 화면이 늘거나 사라지면 선언 쪽이 조용히 낡는 것을 잡는 자리.
  'check-live-coverage': 'generated',
  'check-self-eval': 'generated',
  'check-schema-parity': 'static',
  'check-migration-grants': 'static',
  'check-report-fields': 'static',
  'check-no-synthetic-italic': 'static',
  'check-edge-fn-ops': 'static',
  'check-sync-release-contract': 'generated',
  'check-node-version': 'static',
  'check-backup-coverage': 'static',
  'check-blueprint': 'generated',
  'check-registry-gen': 'generated',
  'check-constitution-gen': 'generated',
  'check-adapter-parity': 'generated',
  'check-doc-governance': 'generated',
  'check-module-design-docs': 'generated',
  'check-gate-integrity': 'generated',
  'check-diag-blindspots': 'generated',
  'check-page-size-parity': 'generated',
  'check-current-doc-facts': 'generated',
  'check-platform-map': 'generated',
  'check-lazy-screens': 'static',
  'check-font-subsets': 'generated',
  'check-fn-size': 'static',
  'check-sw': 'static',
  'check-hand-counts': 'generated',
  'check-doc-counts': 'generated',
  'check-date-freshness': 'static',
  'check-version-ssot': 'static',
  'check-screen-lifecycle': 'static',
  'check-timezone': 'static',
  'check-instant-normalization': 'static',
  'check-exif-strip-on-share': 'static',
  'check-exif-order': 'static',
  'check-bytes-upload-symmetry': 'static',
  'check-known-index': 'static',
  'check-apk-release-link': 'static',
  'check-windows-shell': 'static',
  'check-update-signal': 'static',
  'check-purge-scope': 'static',
  'check-real-coord': 'static',
  'check-ui-color-token': 'static',
  'check-edge-cors': 'static',
  'check-gate-control': 'static',
  'check-enforcement-parity': 'static',
  'check-tooling-registry': 'static',
  'unit-tests': 'unit',
  'verify-editor-live': 'live',
  'verify-diagnostics-live': 'live',
  'verify-authgate-live': 'live',
};

export function categoryOf(gate: string): GateCategory {
  return GATE_CATEGORY[gate] ?? 'static';
}
