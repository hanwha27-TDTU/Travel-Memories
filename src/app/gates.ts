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
  'check-domain-wiring': '도메인↔화면 배선이 죽지 않았는지',
  'check-csp': 'CSP 위반(인라인·외부 리소스) 없는지',
  'check-base-consistency': 'base 경로·자산 참조 일관성',
  'check-env-wiring': '환경변수가 코드·워크플로·문서에서 같은 이름으로 쓰이는지',
  'check-domain-symmetry': '도메인 4종이 같은 생명주기 심볼을 갖는지(삭제만 있고 복원이 없는 형태 차단)',
  'check-verdict-symmetry': '진단 도구가 자기 렌더 코드를 갖지 않고 단일 렌더러를 거치는지',
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
  'check-node-version': '개발 환경과 배포 서버가 같은 Node 판을 쓰는지(어긋나면 여기선 되고 저기선 안 됩니다)',
  'check-backup-coverage': '모든 사용자 테이블이 백업 export/import에 다 있는지',
  'check-blueprint': '설계 개요도(배선맵) 선언 ↔ 실제 구조 일치',
  'check-registry-gen': '자동 집계 카운트·목록이 SSOT와 일치(손 스냅샷 드리프트 차단)',
  'check-constitution-gen': '화면이 보여주는 헌법 조항이 실제 헌법과 글자 단위로 일치',
  'check-adapter-parity':
    'Claude와 Codex가 **같은 계약**을 읽는지(두 지시문서가 갈라지면 두 AI가 다르게 판단한다)',
  'check-doc-governance':
    '새 규정·기준 문서와 새 AI 지시문이 **등록 없이 생기지 않는지**(등록 안 되면 비교 대상에도 못 들어온다)',
  'check-platform-map': '어느 데이터가 어느 서비스에 사는지의 지도가 실제 코드와 일치',
  'check-lazy-screens': '어쩌다 여는 화면이 첫 로드 번들에 딸려 오지 않는지',
  'check-font-subsets': '제목 폰트 조각 선언 ↔ 실제 파일·구간·선언순서 정합',
  'check-fn-size': '큰 함수가 더 커지지 않는지(래칫 — 결함이 숨을 면적을 줄인다)',
  'check-sw': '서비스워커가 서버 응답을 캐시에 가두지 않는지(교차 출처 무개입·GET 전용)',
  'check-hand-counts': '지시문서가 게이트 개수를 손으로 적지 않는지(반드시 낡는 숫자 차단)',
  'check-doc-counts': '문서에 표시한 live 카운트가 실제와 일치(마커 대조)',
  'check-timezone': '날짜를 UTC가 아닌 사용자 로컬로 계산(+ 다른 시간대에서도 유닛 통과)',
  'check-instant-normalization': '밖에서 온 시각을 앱의 표준 표기로 바꿔 저장(같은 순간을 두 표기로 적지 않게)',
  'check-exif-strip-on-share': '서버로 나가는 사진은 canvas 재인코딩본만 — 원본의 촬영위치(GPS)가 따라가지 않게',
  'check-exif-order': '촬영시각·위치(EXIF)를 **압축 전에, 원본에서** 읽는가 — 순서가 뒤집히면 그 정보는 영원히 사라진다(§0)',
  'check-bytes-upload-symmetry':
    '사진·소리가 **같은 판정**으로 바이트를 올리는가(형제 하나만 조용히 안 올라가는 것을 차단 — M-0059)',
  'check-known-index':
    '「이 증상을 이미 아는가」를 묻는 문(`npm run known`)이 **네 층을 다 뒤지는가** — 층이 비면 그 지식은 영영 안 보인다(M-0064)',
  'check-apk-release-link':
    '「항상 최신 APK」 계약 — CI 릴리스(apk-latest·--clobber) ↔ 앱 상수 ↔ 가이드 버튼이 같은 고정 주소를 말하는가',
  'check-update-signal':
    '「접속하면 스스로 최신」 계약 — 빌드가 version.json을 심고, 앱이 시작·복귀 때 묻고, SW가 신호를 안 만지는가(M-0070)',
  'check-purge-scope':
    '여행 영구삭제가 자식을 trip_id로 지우는 계약이 실제 스키마와 일치하는가 — tripScoped ↔ rowmap의 trip_id(C-1)',
  'check-real-coord':
    '「진짜 좌표인가」 판정(유한·범위·0,0 아님)이 isRealCoord 한 곳에만 있는가 — 손으로 쓴 좌표 0,0 검사를 차단(H-3)',
  'check-ui-color-token':
    '브랜드 색이 UI TS에 하드코딩되지 않는가 — 색 SSOT는 tokens.css, 예외는 color-token-ok 표시(H-6)',
  'unit-tests': '순수 로직 유닛(비공허 확인)',
  'verify-editor-live':
    '실제 브라우저가 앱을 열어 화면·편집기·서비스워커·폰트를 확인(정적 검사가 원리적으로 못 보는 층)',
  'verify-diagnostics-live':
    '실제 브라우저가 진단 도구를 하나씩 열어 **사용자에게 나가는 문장·자리·버튼**을 확인(자료구조가 옳아도 화면이 틀릴 수 있다 — M-0046)',
};

/** 게이트 카테고리. 없으면 'static'으로 본다. 목록은 registry.gen에서 오므로 개수는 파생. */
export const GATE_CATEGORY: Record<string, GateCategory> = {
  typecheck: 'static',
  'check-secret-leak': 'static',
  'check-hooks-wired': 'static',
  'check-ci-policy': 'static',
  'check-domain-wiring': 'generated',
  'check-csp': 'static',
  'check-base-consistency': 'generated',
  'check-env-wiring': 'generated',
  'check-domain-symmetry': 'static',
  'check-verdict-symmetry': 'static',
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
  'check-node-version': 'static',
  'check-backup-coverage': 'static',
  'check-blueprint': 'generated',
  'check-registry-gen': 'generated',
  'check-constitution-gen': 'generated',
  'check-adapter-parity': 'generated',
  'check-doc-governance': 'generated',
  'check-platform-map': 'generated',
  'check-lazy-screens': 'static',
  'check-font-subsets': 'generated',
  'check-fn-size': 'static',
  'check-sw': 'static',
  'check-hand-counts': 'generated',
  'check-doc-counts': 'generated',
  'check-timezone': 'static',
  'check-instant-normalization': 'static',
  'check-exif-strip-on-share': 'static',
  'check-exif-order': 'static',
  'check-bytes-upload-symmetry': 'static',
  'check-known-index': 'static',
  'check-apk-release-link': 'static',
  'check-update-signal': 'static',
  'check-purge-scope': 'static',
  'check-real-coord': 'static',
  'check-ui-color-token': 'static',
  'unit-tests': 'unit',
  'verify-editor-live': 'live',
  'verify-diagnostics-live': 'live',
};

export function categoryOf(gate: string): GateCategory {
  return GATE_CATEGORY[gate] ?? 'static';
}
