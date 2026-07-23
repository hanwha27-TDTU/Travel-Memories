# CHANGELOG · Bugeon Journey

[Keep a Changelog] 형식. 최신이 위. 이 파일은 손편집이 아니라 릴리스 시 갱신하며, 열거 가능한 사실(카운트 등)은 파생·게이트로 잠근다(LESSONS §7).

## [Unreleased] — Phase 0~1

### Phase 3e — 저장된 사진 재편집(비파괴) (2026-07-23)
- **재편집**: 전체보기 뷰어에 `✎ 편집` → 저장된 사진을 편집기(`openPhotoEditor`)로 다시 연다. 그동안 사진은 저장 후 삭제만 가능하고 재편집이 불가했음.
- **비파괴(§0)**: 편집은 **원본 Blob에서 파생**하고 원본·EXIF(촬영시각·GPS)는 절대 바꾸지 않는다. `reeditMediaLocalFirst`가 표시본·썸네일만 재생성(version+1·read-back). 미디어 로컬 전용(sync 후속).
- **이어서 편집(resume)**: `LocalMedia.editState`(직렬화 가능 순수값)에 회전·자르기·색보정·잡티 상태를 저장 → 다음 재편집 때 이전 편집을 그대로 이어서 조정. 최초 업로드도 편집 시 editState 저장. 백업에 자동 포함(비-Blob 필드).
- **라이브 검증(정적 dist 서버·Playwright, 콘솔 에러 0)**: 사진 저장→뷰어 `✎`→`↻ 회전`→`적용` → version 1→2, 치수 120×90→**90×120 스왑(회전 반영)**, **원본 크기 13262B 불변**, editState rotate90:1 저장. harness(6)·unit 73·build 그린.

### Phase 4 — 지도와 장소 (MapLibre·장소목록·GeoJSON) (2026-07-23)
- **지도 제공자 확정** ADR-0023(A-006): 기본 OSM 래스터(키 불필요·귀속표시), `VITE_MAP_STYLE_URL`로 교체 가능. CSP `img-src`·`connect-src`에 `tile.openstreetmap.org` 추가(index.html + `check-csp.mjs` REQUIRED·GOOD 셀프테스트 동시 갱신).
- **순수 로직** `domain/place/geojson.ts`: `momentCoord`(사진 EXIF GPS 첫 좌표, 없으면 null — 대략위치 안 지어냄)·`toFeatureCollection`([lng,lat] RFC 7946). 유닛 4케이스.
- **지도 모달** `ui/screens/mapView.ts`: 여행 히어로 `🗺 지도` → MapLibre(동적 import·코드분할 802KB 별도 청크) 마커+팝업. **팝업은 DOM 노드(textContent)로 안전**(문자열 보간 금지·map-experience-designer 규율). **사진이 주인공**(썸네일 우선).
- **오프라인 우선 대체**: 위치 순간을 항상 **장소 목록**으로도 제공. 타일 차단·WebGL 미지원 시 4.5s 강등으로 캔버스 숨기고 목록 전용. 위치 없으면 빈 상태 안내.
- **GeoJSON 내보내기**: 위치 순간을 `.geojson` FeatureCollection으로 다운로드(타일과 무관).
- **라이브 검증(Playwright/Chromium, 앱 콘솔 에러 0)**: 빈 상태 → GPS 시드 → 장소 목록("협재 노을") → 타일/WebGL 불가 강등(is-failed) → GeoJSON 내보내기(`[126.41,33.24]`·제목 유지). 게이트: harness(6)·unit 73·build 그린. 정직: 실 타일 렌더 지도는 WebGL+타일 도달 필요 → 사용자 실기기 몫(샌드박스 프록시가 외부 타일 차단).

### Phase 5a — 비용(Expense) 기록·통화별 합계 (2026-07-23)
- **비용 엔티티** `LocalExpense`(Dexie v4 `localExpenses`): 순간에 딸린 지출. `originalAmount>0`·ISO 4217 통화(H-04: 원금액 불변). 환율/기준통화 환산은 후속.
- **순수 로직** `domain/expense/format.ts`: `formatMoney`(통화별 소수자리·천단위)·`sumByCurrency`(통화 분리 합산, 환율 없이 안 섞음)·`formatTotals`. 유닛 9케이스(위조·NaN 방어 포함).
- **서비스** `services/expenses.ts`: create/update/softDelete + listByTrip/byMoment. 미디어와 동일 로컬 전용(sync 큐 op 없음, 서버 동기화 후속).
- **UI(tripDetail)**: 순간 생성 폼에 금액+통화(선택), 카드에 `💰` money chip, 인라인 편집에서 비용 생성/수정/삭제 조정, 여행 통계에 통화별 합계 stat.
- **cascade·백업 통합**: 순간·여행 삭제/복원/영구삭제가 비용도 함께 tombstone/복원/purge. 백업(export/import)에 expenses 포함(mergeDecision 병합).
- **라이브 검증(Playwright/Chromium, 콘솔 에러 0)**: 생성(칩 `₩12,000`·합계)→다통화(`₩12,000 · $15.00`, 분리)→편집(12,000→9,000)→백업 왕복(초기화 후 가져오기, 편집값 `₩9,000` 복원). 게이트: harness(6)·unit 69·build 그린.
- **정직**: 비용 서버 동기화·비용 cascade의 독립 라이브 테스트는 미디어 검증 패턴에 준함(별도 미실행). 실기기 픽셀 미검증.

### Phase 3d — 데이터 관리 허브(백업·복원·휴지통) (2026-07-23)
- **데이터 관리 허브**: 홈 헤더 `📦 데이터 관리` → 모달(백업·복원·휴지통·**가이드**). 기존 `📖 가이드` 버튼은 이 허브 안으로 이동. 가이드 모달 시각 시스템(.guide-*) 재사용.
- **백업(내보내기)** `services/backup.ts`: 여행·순간·사진(원본·표시본·썸네일 base64)을 tombstone 포함 단일 JSON으로 다운로드. 사진이 곧 기억(북극성)이라 사진 포함이 기본, 크기 경고 표기.
- **복원(가져오기)**: JSON을 **병합**(교체 아님) — `mergeDecision`(LWW+tombstone)·빈-데이터 가드 재사용으로 로컬을 절대 덮어쓰지 않음. 손 병합 로직 없음(SSOT 순수함수 재사용).
- **휴지통** `trips.ts`: `listDeletedTrips`·`restoreTripFromTrash`(여행+tombstone 자식 복원)·`purgeTripPermanently`(로컬 하드 삭제, 2단계 확인, 동기화 시 재출현 가능 정직 표기).
- **라이브 검증(Playwright/Chromium)**: (a) 생성→백업 내보내기(다운로드 캡처)→삭제→휴지통 복원(순간 유지)→DB 완전 초기화→파일 가져오기→**여행·순간 부활**. (b) **사진 포함 왕복**: 사진 첨부→백업(media 1·thumbB64 data:)→초기화→가져오기→**썸네일 naturalWidth 120 렌더**. 두 흐름 모두 콘솔 에러 0.
- 게이트: typecheck·harness(6)·unit 60·build 그린. **정직**: 영구삭제의 서버 전파는 동기화 실연동 후속.

### Phase 3c — 여행 삭제(대칭성) + 가이드 화면 (2026-07-23)
- **여행 삭제(하드 삭제 아님)**: 편집 패널에 위험 구역(🗑 여행 삭제 → 2단계 확인) 추가. `softDeleteTripLocalFirst`가 여행 + 소속 순간·사진을 같은 트랜잭션에서 cascade tombstone(고아 방지), 순간은 sync 큐 delete op, 미디어는 로컬 tombstone. `restoreTripLocalFirst`가 정확히 그 자식들만 복원(version+1 LWW 승리). 이로써 Trip 생명주기 대칭성 회복(생성·수정·보관·삭제).
- **공용 실행취소 토스트**: `src/ui/toast.ts`로 분리(document.body 부착 → 화면 전환에도 유지). 순간·사진·여행 삭제가 모두 재사용. tripDetail의 화면-로컬 토스트 제거(DRY).
- **가이드 화면**: 홈 헤더 `📖 가이드` → 2열 모달([연결·설정] / [개발·설계]). 카드 → 상세(‹ 뒤로). 콘텐츠는 **이 저장소의 실제 사실**로 구성(정직 §4): 설계개요도(Trip→Moment 흐름), 기계화검증 흐름도(실제 harness 6게이트), 개발 규율, 개발 에이전트(통합10+디자인16), 자기점검(정직 상태표), AI 개발 거버넌스(비타협 원칙·§0). 모든 자유 텍스트 textContent(innerHTML 금지·CSP 준수). 포커스 이동·Esc·배경탭 닫기.
- **라이브 검증(Playwright/Chromium)**: 900×1200에서 여행 생성→순간 저장→순간 편집("수정된 순간")→여행 삭제(홈·카드0·토스트)→실행취소(카드 복원)→**cascade 확인: 복원된 여행의 순간 1개·편집 텍스트 유지**, 가이드 2열/상세 렌더, 콘솔 에러 0. 지난 Phase 3b(순간·사진 편집·삭제)도 이 흐름에서 함께 라이브 확인됨.
- 게이트: typecheck·harness(6)·unit 60·build 그린. **미검증(정직)**: 실기기 픽셀·제스처; 가이드의 게이트·에이전트 목록은 손 스냅샷(레지스트리 파생 게이트는 후속).

### Phase 3b — 순간 편집·삭제 + 사진 개별 삭제 (실행취소) (2026-07-23)
- **순간 편집**: 카드에 ✎ → 한 줄·감정·장소·**메모**·**발생시각(datetime-local)** 수정. `updateMomentLocalFirst`(version+1·updatedAt·baseVersion·op update·read-back — 생성과 동일 규율). 그동안 데이터엔 있으나 편집 경로가 없던 `note`·`occurredAt`를 사용 가능하게 함.
- **순간 삭제(하드 삭제 아님)**: 🗑 → `deletedAt` tombstone(§0). 순간에 달린 활성 **사진도 같은 트랜잭션에서 함께 tombstone**(고아 사진이 통계를 속이지 않도록), undo가 정확히 그 사진들만 복원(`softDeleteMomentLocalFirst`→`deletedMediaIds`, `restoreMomentLocalFirst`).
- **사진 개별 삭제**: 썸네일 ✕ → `softDeleteMediaLocalFirst`(tombstone·원본 Blob 보존). 미디어는 로컬 전용(3a)이라 sync 큐 op를 만들지 않음(처리 주체 부재 → 대기열 영구 잔류/pendingSyncCount 오염 방지).
- **실행취소(§5 복구가능성)**: 삭제 후 5초 토스트로 되살림. 되살리기는 version+1·updatedAt=now라 다른 기기가 이미 삭제를 본 경우에도 **LWW로 복원이 승리**. 이중 탭 재진입 가드.
- 게이트: typecheck·harness(6 Required)·unit 60·build·secret 전부 그린. **미검증(정직)**: 실기기 탭→tombstone→undo 라이브 상호작용은 이 세션에서 미실행 — 사용자 기기 확인 권장.

### Phase 3a+++ — 사진 편집 배치 UX (이전/닫기·잘림 해소) (2026-07-23)
- **← 이전 / 배치 이동**: 여러 장 편집 시 사진 간 앞뒤 이동 + **각 사진 편집상태 기억**(재방문 시 슬라이더·크롭 복원). 마지막에 일괄 저장. `openPhotoEditor`가 `EditorResult{action,state,blob}` 반환·`EditorOpts{canGoBack,initialState}` 수용.
- **닫기(✕) 버튼**: 편집기 헤더 ✕(=원본 사용) + 전체보기 뷰어 ✕(+ ESC·배경탭). "닫기 버튼 없음" 해소.
- **썸네일 잘림 해소**: 타임라인 썸네일을 정사각 crop(object-fit:cover)에서 **자연 비율(높이 고정·너비 자동)**로 → 사진 전체가 안 잘리고 보임("앱에 맞게 최적화").
- 라이브 렌더: 3장 배치에서 ← 이전(2/3→1/3)·✕닫기(→2/3)·썸네일 183×108(가로 유지)·뷰어 ✕ 동작, 콘솔 에러 0.


### Phase 2 — 보관/완료 상태 실동작 (2026-07-23)
- **보관(archived)** 여행은 홈 목록에서 숨김 → **📦 보관함** 토글에서 따로 보기(개수 표시), 보관함에선 새 여행 폼 숨김.
- **↩ 복원**: 보관 카드에서 한 번에 완료 상태로 되돌림(홈 복귀). 완료(completed)는 홈에 그대로 유지.
- `listTrips`(보관 제외) + `listArchivedTrips` 분리. 보관 카드는 div(role=button)로 복원 버튼 중첩 허용, 키보드 접근성.
- 라이브 렌더: 보관 시 홈 2→1·보관함 1·복원 시 보관함 0, 콘솔 에러 0. **버그 수정**: `.trip-form[hidden]` 미적용(클래스 display 우선) → 명시 규칙(편집 패널과 동일 유형).


### Phase 3a++ — 자유 크롭 + 잡티 제거 (2026-07-23)
- **✂️ 자유 크롭**: 코너 핸들 드래그로 임의 영역 크롭. 크롭 모드에선 전체 이미지+오버레이 표시, 적용 시 bake에 반영. 정규화 좌표라 해상도 무관.
- **🩹 잡티 제거(스팟 힐링)**: 힐 모드에서 사진을 탭 → 주변 링 16샘플 역거리제곱 보간+가장자리 감쇠로 메꿈(`pixelops.healSpot`, 순수). 브러시 크기·되돌리기. 좌표는 기하 정규화 저장 → 미리보기/최종 동일 재적용.
- 회전·반전 시 기존 잡티·크롭 좌표 자동 변환(보존). 유닛 +9케이스(힐링 효과·반경 밖 불변·자유창 px 변환·좌표 회전/반전·isIdentity).
- 라이브 렌더(Playwright): 잡티 점 3개 사진에서 탭한 점만 소거 확인, 크롭 핸들 드래그(80%→61%), 적용→썸네일, 콘솔 에러 0.

### Phase 3a+ — 사진 편집기(비파괴, 핵심+확장) (2026-07-23)
- **비파괴 편집 모달**(`ui/photoEditor.ts`): 사진 첨부 시 자동 오픈. 미리보기=최종 저장과 **같은 bake 코드 경로**(WYSIWYG 단일 SSOT).
- 기하: 90° 회전·좌우 반전·수평 보정(±10°)·비율 크롭(원본/1:1/4:5/16:9)·줌(1–3×)·드래그 팬.
- 색: 밝기·대비·채도·색온도·노출 슬라이더. 확장: 선명도(언샤프)·비네팅·그레인.
- 프리셋 6종(원본·자연·필름·흑백·따뜻·차분 — 절제 원칙, 사진 원색 존중).
- 순수 모듈 분리: `media/pixelops.ts`(픽셀 연산)·`media/editor-core.ts`(EditState·크롭 기하·bake) → **유닛 12케이스**(색 연산·언샤프·그레인 결정성·크롭 창·회전 스왑·각도 커버).
- §0 유지: **원본 Blob 보존**, EXIF는 항상 원본에서, 무편집 적용 시 재인코딩 생략(손실 방지). 편집본은 압축본·썸네일의 파생 소스만.
- 라이브 렌더(Playwright): 첨부→편집기 오픈→필름 프리셋+회전+밝기→적용→썸네일 렌더, **콘솔 에러 0**.

### Phase 3a — 사진(로컬우선): EXIF 우선·원본 보존·압축본 (2026-07-23)
- **§0 규율 코드화**: 압축 **전에** EXIF(촬영시각·GPS) 추출(`media/exif.ts`, 외부 라이브러리 없이 최소 JPEG 파서), **원본 Blob은 그대로 보관**(`media/compress.ts`는 원본을 읽기만).
- **파생 생성**: WebP **표시본(≤1600)** + **썸네일(≤320)** 생성 후 로컬 저장(Dexie v3 `localMedia`, 원본+파생 Blob). `services/media.ts` 내구성 커밋+read-back.
- **UI**: 순간 기록 시 사진 첨부, 타임라인 카드 썸네일, 탭하면 전체보기 오버레이. 사진 통계.
- 검증: EXIF 파서 유닛(크래프트 바이트로 DateTimeOriginal→ISO), 라이브 렌더(Playwright, canvas 생성 JPEG 주입)로 썸네일·통계·뷰어·**콘솔 에러 0**. **버그 1건 발견·수정**: `.edit-panel` 클래스 display가 `[hidden]`을 이기던 문제 → `.edit-panel[hidden]{display:none}`.
- 범위: **사진 클라우드 업로드(압축본·썸네일, GPS 제거)는 3b(후속)**. 현재 사진은 이 기기 로컬.

### Phase 2 — 여행 날짜·상태·제목 편집 (2026-07-23)
- 상세 화면 **편집 패널**(제목·시작/종료일·상태): `updateTripLocalFirst`(내구성 커밋+version 증가+read-back+update 대기열), 저장 시 재렌더+동기화 트리거.
- 시작일 설정 시 타임라인 **Day 번호 자동 계산**, 상태 배지 반영.
- 라이브 렌더(Playwright): 편집→저장→히어로 갱신(완료·기간)·Day 번호 확인, 콘솔 에러 0.

### Phase 2 — 순간(Moment) 서버 동기화 (2026-07-23)
- **`journey.moments` 서버 테이블**(migration 0003): 복합 FK `(trip_id,user_id)→trips`(H-02 소유권 방어), 소유자 RLS + 초대제(`is_allowed()`), tombstone 전용, `updated_at` 트리거. 적용 완료.
- **동기화 코드 대칭 확장**(`sync.ts`): `MomentsRemote`·`pushPendingMoments`·`pullMoments`(멱등 upsert+read-back+LWW+빈클라우드 가드). `runSync`가 trips→moments 순으로 push. `mergeDecision` `SyncMeta`로 일반화. 상세 화면 진입/저장 시 동기화 트리거.
- 검증: `rls_attack_moments.sql` **MOMENTS_RLS_PASS**(격리·초대제·복합 FK 위조 차단) via MCP · rowmap 왕복 유닛 · 하네스·build 통과. 실 2기기 동기화는 실기기 검증 대기(정직한 완료).

### Phase 2 착수 — 여행 상세 + 타임라인 + 순간 기록 (로컬우선) (2026-07-23)
- **순간(Moment) 도메인** 추가: `LocalMoment`(Dexie v2 `localMoments`), `services/moments.ts`(내구성 로컬 커밋+read-back, 여행과 동일 규율), 순수 타임라인 로직 `domain/moment/timeline.ts`(날짜 그룹핑·Day 번호·tombstone 제외).
- **여행 상세 화면**(`ui/screens/tripDetail.ts`): 커버 히어로(순간·일 통계), **순간 기록 폼**(한 줄+감정 이모지+장소, 10초 캡처 지향), **날짜별 타임라인**(시각 노드·감정·장소 칩).
- **파라미터 라우팅**(`/trip/<id>` → `trip-detail`): `pathToRoute`/`pathToParam` 순수함수, 홈 여행 카드 클릭→상세, 뒤로가기.
- 검증: 하네스 6게이트·유닛(타임라인 5·라우터 파라미터)·build 통과. **라이브 렌더**(Playwright): 여행 생성→카드 클릭→상세 진입(`/trip/<uuid>`)→순간 2건 기록→타임라인/통계 렌더→뒤로가기까지 **콘솔 에러 0**.
- **범위 정직 표기**: 순간은 현재 **로컬우선(IndexedDB durable, 오프라인 OK)** — 여행(trip)처럼 서버 동기화(journey.moments migration+복합 FK RLS+동기화 파이프라인)는 후속. 순간은 아직 기기 간 동기화되지 않음.

### Phase 1 — 디자인 시스템 적용 (계절·테마·반응형) (2026-07-23)
- **디자인 토큰 SSOT**(`tokens.css`): 계절 강조색(봄·여름·가을·겨울) × 라이트/다크 뉴트럴 × 시맨틱 색 분리. `data-season`/`data-theme` 속성으로 스위칭, 강조 위 텍스트 흰색 고정.
- **테마 상태 모듈**(`ui/theme.ts`): 계절/테마 선택을 localStorage 캐시(표시 선호만; 기억 데이터는 IndexedDB). 미선택 시 계절은 이번 달 기준 자동, 테마는 OS 선호.
- **홈 화면 재디자인**(`home.ts`+`app.css`): 계절 세그먼트+다크 토글 컨트롤, 여행 커버 카드(계절 그라데이션·상태 배지), 몰입형 빈 상태, 반응형(모바일 풀블리드·데스크톱 그리드).
- **라이브 렌더 검증**(Playwright/Chromium): 모바일·데스크톱, 계절 전환(→겨울)·다크 토글·여행 3건 생성까지 **콘솔 에러 0**, 커버 카드 정상 렌더(스크린샷 확인).

### Phase 1 — 초대제 접근 잠금 + 첫 실배포 (2026-07-23)
- **첫 실배포**: PR #1 병합 → GitHub Pages 배포 성공. 대시보드 설정(journey 스키마 노출·Google OAuth 클라이언트·redirect URL) 완료 후 **2기기 Google 로그인·동기화 실동작 확인**(사용자 검증). RLS 격리 실증(다른 계정 로그인 시 타인 데이터 0건).
- **초대제 잠금(ADR-0021)**: migration `0002_journey_invite_only.sql` — `journey.allowed_users` + `journey.is_allowed()`(SECURITY DEFINER) + trips 정책에 허용조건 결합. 앱 게이트(`isAllowedUser()`)로 비허용자 자동 로그아웃 안내. 공격검사 `rls_invite_only_trips.sql` **INVITE_ONLY_PASS**, `rls_attack_trips.sql` 갱신 후 **RLS_ATTACK_PASS** 유지.
- 브랜드명 통일: 문서·주석·에이전트 정의의 제품명 Journey Archive → **Bugeon Journey**(기술 식별자·v0.2 원본 제외).

### Phase 1 — 동기화 push/pull 구현 (2026-07-22)
- 인증(`services/auth.ts`): Google OAuth(PKCE) 로그인·로그아웃·세션·상태구독.
- 동기화(`services/sync.ts`): 대기열 push(멱등 upsert + **정확한 read-back** + LWW 서버시각 반영) + pull 병합(**빈-클라우드 가드**, 교체 아님). 네트워크는 `TripsRemote` 포트 뒤로 격리.
- 순수 결정(`sync/merge.ts`): mergeDecision(LWW+tombstone 우선)·isEmptyCloudAnomaly·classifyError — 단위테스트 15케이스로 게이트 잠금.
- UI: Google 로그인/로그아웃/수동 동기화 버튼, 동기화 상태 표시. 저장·로그인·온라인 복귀 시 자동 동기화.
- 검증: 하네스 6게이트·26 유닛테스트·빌드 통과, 로컬 모드 렌더 회귀 에러 0. **실 Google 로그인→journey.trips push는 대시보드 설정(스키마 노출·OAuth)+실기기 로그인 필요 — 이 환경에서 미검증(정직한 완료).**

### Phase 1 thin slice — trips 로컬층 (2026-07-22)
- 여행 생성·목록 실동작: 내구성 로컬 커밋(Dexie entity+operation 원자 트랜잭션) + 정확한 read-back.
- 브라우저 왕복 검증: 생성→새로고침→IndexedDB 영속·대기열 정합·에러 0.
- **서버층 적용(ADR-0020)**: 공유 프로젝트 Travel&Accounting의 `journey` 스키마 분리 — `journey.trips` migration 적용, RLS 공격검사 6종 실행 **RLS_ATTACK_PASS**(위조 INSERT·타인 조회/수정/삭제·소유자 하드삭제·anon 차단), advisor journey 0건. 클라이언트 `db.schema=journey`.
- trip rowmap(toRow/fromRow) 경계 + 왕복 단위테스트.


### 적대적 검토 중간 항목 일괄 (2026-07-22, TASK-0004)
- **security**: 스캐너 범위를 git 추적 전체(+dist)로 확대, `sbp_`·Google API 키·PEM 개인키 패턴과 `.env` 추적 차단 추가. SECURITY.md 서술을 구현 실체와 일치시킴(엔트로피 탐지=후속).
- **test**: `tests/unit/`(router·registry) 신설 + 하네스 `unit-tests` 게이트 — 테스트 0개로 `npm test`가 RED이던 상태 해소.
- **refactor(gates)**: `check-domain-wiring` 기대 집합을 손편집 상수 → DATA_MODEL.md 헤딩 파생으로(SSOT). `check-base-consistency` 신설 — BASE(vite.config SSOT)↔manifest↔index.html 정합. 모든 게이트에 셀프테스트 내장.
- **build**: index.html base 링크를 `%BASE_URL%` 파생으로, ci.yml pull_request 중복 트리거 제거 + concurrency 취소.
- **feat(pwa)**: manifest 링크·apple-touch-icon을 index.html에 추가(기존엔 manifest 미연결로 설치 불가), icon.svg에서 PNG 192/512/maskable/180 파생 생성(`scripts/generate-icons.mjs`).

### 적대적 검토 후속 수정 (2026-07-22)
- **security**: `check-secret-leak` 첫-매치 우회(M-0004) 정정 — `matchAll` 전수 판정 + 알려진-실패 주입 셀프테스트 내장(매 실행 검증).
- **fix**: Dexie `deletedAt` 인덱스 제거(M-0005) — IndexedDB는 null 인덱스 키 불가, tombstone 계약과 양립하도록 스키마 v1 정정.
- **build**: `deploy-pages.yml`에 클라이언트 설정 주입(`vars.*`) 추가, Pages 활성화 절차·Variables 사용 근거를 `DEPLOYMENT.md`에 명문화.
- **security**: CSP를 스택 계약으로 확장(wss Realtime·worker-src blob: MapLibre·Storage img-src·object-src 'none') + `check-csp` 게이트(셀프테스트 내장) 하네스 편입.
- **chore**: `commit-msg` 훅 — `Revert`/`Reapply`/`Merge` 등 git 생성 제목 허용(롤백 전략과 충돌 해소), `[skip actions]`·`skip-checks:` 트레일러 차단 추가.

### Phase 0B 코드 골격 (2026-07-22)
- Vite + TypeScript(strict) 골격: 빌드·타입체크 통과, 홈(빈 상태) 1화면 렌더(에러 0).
- `base=/Travel-Memories/`, history 라우터(안전 폴백), PWA manifest(하위경로 scope).
- 단일 `harness`(typecheck·check-secret-leak·check-domain-wiring), `.githooks/commit-msg` 활성.
- CI(`ci.yml`) + GitHub Pages 배포 워크플로(`deploy-pages.yml`, 404 복제·시크릿 스캔).
- `DOMAIN_REGISTRY`(18 도메인), Dexie 스키마 스텁, Supabase publishable 클라이언트(PKCE) 스텁.

### v0.2 정밀 병합 (2026-07-22)
- 외부 v0.2 비판적 검증 채택(ADR-0013~0017): sync 원장(operation receipt·base_version·단조 커서·conflict table), deletion_jobs 상태머신, 복합 소유자 FK, 부분 고유 인덱스, EXIF 시각(local+offset+tz)·whitelist, 불변 Storage·TUS, publishable/secret 키 체계, pgTAP 2사용자 RLS 테스트, DB백업 Storage 미포함 명시.
- 유실범위 명확화("내구성 로컬 커밋 후 앱 원인 유실 0"), 디코딩 동시성 1, WebP magic-byte 검증.
- `ai_generations`→`ai_artifacts`, 인라인 AI 컬럼 제거(구현 전 검토).
- Gate 0A/Phase 0B 분리, agent-report JSON Schema, ACTIVE_TASKS 소유권, 독립검토 매핑.
- 신규: `docs/DEPLOYMENT.md`, `REPOSITORY_AUDIT.md`, `CONFLICT_REPORT.md`, `ACTIVE_TASKS.md`, `schemas/agent-report.schema.json`, `docs/reference/v0.2/`(원본 5종).

### 초기 스캐폴딩
### Added
- 프로젝트 기준 문서 세트(`docs/`, DEPLOYMENT 포함) + `CLAUDE.md` · `AGENTS.md`.
- 개발 에이전트 팀: 통합 10개 + 디자인 16개(`.claude/agents/`), 139개 논리 역할 등록부(`docs/AGENT_REGISTRY.md`).
- 선행 프로젝트 교훈 추출(`docs/LESSONS.md`).
- hook 후보 문서화(`.claude/settings.json`, `docs/SECURITY.md`).

### Changed
- 프로젝트를 "Bugeon Journey"로 재정의: 순수 HTML/JS → TypeScript+Vite+Supabase+Dexie+MapLibre+PWA.

### Removed
- 초기 순수 HTML/JS MVP(`index.html`, `css/`, `js/`) — git 히스토리 보존.
