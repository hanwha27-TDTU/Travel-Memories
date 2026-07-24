# HANDOFF · Bugeon Journey

각 작업 종료 시 인계 기록. 최신이 위. 표면 전환(Claude↔Codex) 시 commit+push 후 GitHub에서 재pull하며, 미커밋 변경을 표면 간 이월하지 않는다. (AGENTS.md)

---

## 🔰 인계 요약 (다음 세션/AI 시작점)

> **새 AI(Claude 또는 Codex)는 여기부터 읽는다.** 저장소가 최종 정보원이며, 아래만으로 현재 단계와 다음 행동을 파악할 수 있어야 한다.

**현재 단계**: **실사용 가능한 개인 여행기록 PWA — v0.41 배포 라이브**(https://hanwha27-tdtu.github.io/Travel-Memories/, GitHub Pages, base=/Travel-Memories/). 아래 "현재 기능 지도"의 기능이 모두 구현·게이트·배포됨. 브랜치 `claude/travel-log-app-r2xd5f`, origin 동기화됨. 버전 SSOT는 `src/app/changelog.ts`(현재 v0.41), 연구노트(사람/AI/결정 해시체인)는 `src/app/researchLog.ts`(seq 1–27).

> **다기기 동기화 라이브**: Google OAuth(PKCE, 초대제 allowlist=hanwha27@gmail.com)·GitHub Variables·Exposed schemas(journey)가 실제 작동 중(2026-07-23 DB 실측: auth.users 2명 provider=google, 실 owner 계정 동기화 확인). Supabase 프로젝트 **Travel&Accounting**(`ihxiywffzmvrwmqvatzt`)의 journey 스키마 — 여행+회계 한 프로젝트 두 스키마, 메디컬은 별개 프로젝트(`rjhbfgbfhwdhtdzcdvtu`). 4엔티티(trips·moments·media·expenses) 동기화 코드 완성: push 멱등 upsert+read-back+LWW, pull 빈-클라우드 가드+version 기반 tombstone 우위(좀비 차단), 서버 `prevent_zombie_resurrection` 트리거·소유자 RLS·복합 FK(H-02). 마이그레이션 0001–0010 적용.
> **주의(정직·중요)**: 이 **샌드박스는 `*.supabase.co` 차단**이라 앱을 띄워 네트워크 동기화를 재현 검증할 수 없다 — 신규 동기화·Storage 업/다운·대용량 사진·실기기 터치(핀치·드래그)·PWA 설치는 **사용자 실기기 확인 몫**. 앱측 로직·서버 정책은 유닛/트랜잭션/라이브렌더로 검증됨(각 Phase 기록 참조).

### 현재 기능 지도 (v0.41 — 새 AI는 이 표로 기능 표면을 즉시 파악)

| 영역 | 상태 | 핵심 파일 |
|---|---|---|
| 여행·순간·장소·비용·사진 CRUD(로컬 우선, tombstone·실행취소·cascade) | ✅ | `services/{trips,moments,media,expenses}.ts`, `offline/db.ts`(Dexie) |
| 다기기 동기화(4엔티티, 좀비 차단) | ✅ 코드완성·실기기 몫 | `services/sync.ts`, `domain/*/rowmap.ts`, `supabase/migrations/*` |
| 사진 편집기(크롭·자유크롭·잡티·색·프리셋·회전·반전·**원근 펴기**·**수평 보정**·재편집) | ✅ | `ui/photoEditor.ts`, `media/{editor-core,pixelops}.ts` (스킬: photo-editor-dev) |
| 전체보기 뷰어(넘기기·회전·재편집·**확대/이동**·반응형) | ✅ | `ui/screens/tripDetail.ts` openViewer |
| 지도·GeoJSON(MapLibre·OSM 타일·장소검색 Nominatim) | ✅ | `ui/screens/mapView.ts`, `domain/place/geojson.ts`, `services/geocode.ts` |
| 백업/복원(단일 JSON + **여행별 폴더 ZIP**·**AES-GCM 암호화**·**신선도 표시**·병합복원) | ✅ | `services/{backup,backupCrypto,backupMeta,zip}.ts`, `ui/screens/dataManager.ts` |
| 비상 복구 체계(8게이트·복원 드릴·좀비 트리거·DR 감사관) | ✅ | `scripts/harness.mjs`, `docs/DISASTER_RECOVERY.md`, `.claude/agents/disaster-recovery-guardian.md` |
| 개발자정보·버전·연구노트(해시체인)·가이드 화면 | ✅ | `app/{changelog,researchLog,hashchain}.ts`, `ui/screens/guide.ts` |

**하네스 게이트(8, SSOT=`scripts/harness.mjs`)**: typecheck · check-secret-leak · check-domain-wiring · check-csp · check-base-consistency · check-schema-parity(클라 rowmap⊆서버 컬럼) · check-backup-coverage(전 테이블 export/import 커버) · unit-tests. 선택 라이브 게이트: `node scripts/verify-editor-live.mjs`(편집기·뷰어 37/37).

**Phase 3n(2026-07-24)**: 여행 목록에서 바로 삭제(v0.43). **동기(사용자)**: "여행 목록에 삭제 기능이 없네요, 추가하는게 어떨까요?" **실측**: 여행 삭제 서비스+안전장치(cascade tombstone·실행취소·휴지통)는 Phase 3c부터 존재하나 **상세→편집 패널 안에만** 노출돼 발견성 낮음. **구현**: `home.ts` `tripCard`를 `button`→`div(role=button)`로 전환(버튼 중첩 회피 — `archivedCard` 패턴 재사용)해 🗑 삭제 버튼 중첩(stopPropagation). `deleteTrip(t)`: `window.confirm`(순간·사진 함께 삭제·복구 가능 안내) → `softDeleteTripLocalFirst` → refresh → `showUndoToast(restoreTripLocalFirst)` → `trySync`. CSS `.trip-delete`(우상단 원형·danger hover). **검증**: `verify-editor-live`에 목록 삭제 테스트 추가 — 확인 수락 시 카드 제거(1→0)·실행취소 복원(0→1), **39/39 PASS**·콘솔 에러 0, harness 8게이트·build 그린. 하드삭제 없음(§0)·복구 가능(§5) 그대로. v0.43·연구노트 seq29.

**Phase 3m(2026-07-24)**: 가벼운 백업(원본 제외) 옵션(v0.42). **동기(사용자)**: 여행폴더 백업에 원본 뺀(Supabase 저장분=표시본만) 옵션 추가? 완전백업은 JSON 맞죠? → 선택: 체크박스 토글. **확인 답**: JSON=원본 포함 완전백업(현재 ZIP도 원본 포함), Supabase Storage=표시본만(원본·GPS 미동기화). **구현**: dataManager 백업 패널에 "원본 사진 포함" 체크박스(기본 켬) → ZIP 버튼이 `exportBackupZip(checked, p)`, 해제 시 파일명 접미 `_표시본만`. 메커니즘은 기존 `includeOriginals=false` 재사용(신규 코드 최소). 안내/주의문을 완전백업=JSON 중심으로 정정. **검증**: `backupRoundtrip` 가벼운백업 단언 강화(light<full 크기·`_원본` 엔트리 없음·표시본 폴백 복원), harness 8게이트·build 그린. 체크박스는 검증된 boolean 토글이라 자동층 충분(실기기 다운로드 UX는 사용자 확인). 데이터 안전 불변식 그대로(원본은 로컬·완전백업에만). v0.42·연구노트 seq28.

**Phase 3l(2026-07-24)**: 가로 화면(태블릿) 전체보기 잘림 수정(v0.41). **증상(사용자·실기기)**: 가로 태블릿에서 가로 사진 전체보기 시 위아래 잘려 전체를 못 봄(모바일 세로는 정상 — 사용자 확인). **근본형**: v0.40에서 뷰어를 `display:grid; place-items:center`로 바꾸며 `img{max-height:100%}`가 **auto-sized grid 트랙에 대해 해석되지 않아 높이 제약 실패** → 가로 화면(높이 기준)에서 폭만 맞고 세로 오버플로(세로 화면은 폭 기준이라 안 드러남). 추가로 `height:100dvh`가 `inset:0`과 과잉제약. **수정**: `.photo-viewer`를 **flex 중앙정렬**(definite-height 컨테이너에서 max-height:100% 신뢰) + `img{object-fit:contain}` 안전망 + `height:100dvh` 제거. **검증(현실로)**: `verify-editor-live`에 **가로 뷰포트(1600×1000) 측정 테스트** 추가 — 가로 사진(1600×1200) 렌더 rect가 뷰포트에 들어오는지. **비공허 확인**: 옛 grid로 되돌리면 1552×1164(높이 1164>1000 오버플로)로 FAIL 재현, 수정본은 1269×952 PASS. **verify-editor-live 37/37 PASS**·harness 8게이트·build 그린. 스킬 §4 결함 등록부에 등재(세로 뷰포트만 보면 이 부류 놓침 — 가로 뷰포트로도 검증). v0.41·**교훈: 반응형 회귀는 세로/가로 두 방향 모두 측정해야 잡힌다.**

**Phase 3k(2026-07-24)**: 전체보기 뷰어 확대/이동(반응형) + 백업 파일명 규칙(v0.40). **동기(사용자)**: ① 전체보기를 접속 기기에 맞게 최적화(반응형)? ② 백업 파일명을 "날짜_시간_제목_용도"로? → 선택: 둘 다. ① **뷰어 확대/이동**(`tripDetail.ts` openViewer): `scale/tx/ty` + `zoomAround`(화면점 고정 확대 — 휠·핀치·더블탭 공통) + `clampPan`(화면 밖 이탈 방지), 포인터 통합(1개=scale≤1 스와이프·scale>1 팬, 2개=핀치 `dist2`/`mid2`), `show()`에서 리셋, 방향키/`0` 키 리셋. **반응형 CSS**: `.photo-viewer` 폰 여백 최소·태블릿(≥900px) 24px·`height:100dvh`·safe-area 인셋·`.is-zoomed` 커서(grab). ② **백업 파일명 규칙**(`backup.ts`): `stampFromISO`(ISO→YYYYMMDD/HHMM)·`photoFileBase`(날짜_시간_제목__id8, `fsSafe` 추출) + `PURPOSE`(원본/표시본/썸네일) → serializeZip이 사진을 `20260717_0617_제목_원본__id8.jpg`로(제목=순간 제목→여행 제목→'사진'). 최상위 백업명 `bugeon-journey_YYYYMMDD_HHMM.{zip,json}`(dataManager). **핵심 안전**: 파일명은 trip.json 메타(`displayFile`/`thumbFile`/`originalFile`)에 기록되어 복원은 그 경로로 되읽으므로 파일명 자유 변경해도 복원 무결(같은 분·제목 충돌은 id8 접미로 방지). **검증**: 유닛 `backupNaming` 5(형식·FS금지문자·충돌방지)·`backupRoundtrip` 7(파일명 변경 후에도 메타 경로 복원 성공=안전 증명), **verify-editor-live 35/35 PASS**(뷰어 휠 확대 2.05x·`0`키 원복·기존 전 기능 무회귀·콘솔 에러 0), harness 8게이트·build 그린. v0.40·연구노트 seq26. **정직**: 실기기 핀치·더블탭 체감은 사용자 확인 권장.

**Phase 3j(2026-07-24)**: 원근 펴기(4점) + 수평 슬라이더 개선(v0.39). **동기(사용자)**: 키오스크 화면을 비스듬히 찍은 사진 제시하며 "기울기 보정 추가 가능?" → **실측**: 수평 슬라이더는 v0.24부터 존재(발견성 문제), 제시 사진의 진짜 문제는 **원근 왜곡**(사다리꼴) → 선택: 둘 다. ① **editor-core**: `EditState.quad`(TL·TR·BR·BL 0..1·순수 JSON·null=미적용) + `squareToQuadCoeffs`(Heckbert 사영) + `quadOutputDims`(마주보는 변 평균) + `rotateQuad90`/`flipQuadH`(freeCrop·heals 동일 규율) + bake **1.5단계 워프**. **좌표계 계약 확장(중요)**: 기하 공간 = quad 적용 후 크기 `gd` — 창·heal 재투영을 rd→gd로 치환(헌장 §1-4 명문화). ② **pixelops.warpPerspective**(역매핑+bilinear, 출력 크기만 루프·경계 클램프·순수). ③ **UI**: `📐 펴기` 칩(geoRow) → 4점 독립 핸들+SVG 사다리꼴 오버레이(`pe-quad-*`), 드래프트 방식(적용="반듯하게 펴기"가 undo 한 단계·`펴기 해제`), 회전/반전 시 quad 동반 변환·모드 자동 종료, heal/crop/펴기 모드 상호 배타, 수평 라벨 "수평(기울기)"·**±15°**. ④ **검증**: 유닛 `perspective` 10(호모그래피 모서리 정확·워프 항등/절반 추출·**비공허**(기울인 quad≠항등)·quad 회전 4회 원위치·isIdentity), **verify-editor-live 33/33 PASS**(펴기 모드 표시→핸들 드래그 polygon 갱신→적용 픽셀 실변화 113,125,197→137,111,185→undo 원복·콘솔 에러 0), harness 8게이트·build 그린. **정직**: 실기기 터치 핸들 드래그 체감·12MP 워프 속도는 사용자 확인 권장(미리보기는 FAST 420px 2단계라 즉답 구조).

**Phase 6d(2026-07-24)**: DR 감사관 실행 + 교정 3종(v0.38). **감사관(서브에이전트) 실행 판정 = HOLD**(게이트·드릴 직접 실행 확인): DR 구조 강함·과장 없음이나 최후 방어선(사용자 백업)이 설계상 사용자 주도라 실제 존재/신선도를 저장소로 검증 불가(소유자 확인 필요) + 평문 기본값이 실질 교정. 권고 3종 전부 반영: **#1** `services/backupMeta.ts`(localStorage 마지막 백업 시각·`backupFreshness`, 캐시성 메타·유닛 2) + 데이터 관리에 "마지막 백업: N일 전"·오래됨(≥14일)/없음 권고, 내보내기 성공 시 `recordBackupNow()`. **#2** 암호 없이 내보낼 때 `window.confirm`으로 "암호화 안 됨(사진·GPS·메모 평문)" 명시 확인(암호 있으면 생략) — 기본 평문 PII 노출 축소. **#3** `fake-indexeddb` dev 의존 + `tests/unit/restoreDrill.ts`(4): `importMergeRows`를 실 Dexie로 구워 빈db 저장·되읽기·**blob 바이트 왕복**·빈가드·LWW·tombstone 우위 검증 → 순수층뿐 아니라 db 접근층까지 증명. **검증**: harness **8게이트**·build 그린, 유닛 restoreDrill 4·backupMeta 2·backupRoundtrip 7·crypto 3·zip 5. **남은 HOLD 근거**(실제 백업 존재·신선도)는 정의상 앱 밖 사실 → 소유자 확인 몫, 앱은 관측화·경고·완전성까지 책임(정직한 경계 유지). v0.38·연구노트 seq24.

**Phase 6c(2026-07-24)**: 비상 복구 강화 — DR 감사관 + 실질 갭 3종 보완(v0.37). **동기(사용자)**: 외부 `disaster-recovery-guardian` 서브에이전트 적용 가능? → 8기준 대조 결과 지금은 HOLD(②③ 무장스케줄·신선도는 로컬퍼스트 개인앱이라 "백업 주인=사용자"로 설계상 자동화 안 함, 진짜 갭은 G1·G2·G3). 선택: 설치 + 갭 최대한 모두. ① **감사관 설치** — `.claude/agents/disaster-recovery-guardian.md`(verbatim·앱비종속·읽기전용, 28에이전트). ② **G1 복원 왕복 드릴** — `backup.ts`를 **db층**(exportCollectRows/importMergeRows)과 **순수 직렬화층**(serializeJson/deserializeJson·serializeZip/deserializeZip)으로 분리, **FileReader 제거**(arrayBuffer+btoa → Node/브라우저 공통·테스트 가능). `tests/unit/backupRoundtrip.ts`(7): JSON·ZIP export→import 파리티(전 행·사진 바이트·tombstone·고아·좌표·원본폴백) + 비공허(행 제거 시 실패). ③ **G2 백업 암호화** — `services/backupCrypto.ts`(WebCrypto AES-GCM-256 + PBKDF2 210k, `BGJENC1\n` MAGIC 봉투 자동감지, 의존성0). export에 선택적 passphrase(파일명 `.enc`), `importBackupAuto`가 봉투면 복호(needsPassphrase 흐름), dataManager 두 패널에 암호 입력 + 분실경고. **키 미저장**(사용자만 보유). 유닛 3(왕복·틀린암호 throw·salt/iv 무작위). ④ **G3 Storage 고아 스윕** — `MediaRemote.remove` + `pushPendingMedia`가 tombstone 서버반영 후 표시본 객체 정리(최선노력·유실0). 마이그 **0010**(`journey_media_delete_own` 소유자 폴더격리+초대제 DELETE 정책, DEL-CONTRACT 이행) 적용(project ihxiywffzmvrwmqvatzt). **검증**: harness **8게이트**·build 그린, 유닛 backupRoundtrip 7+zip 5+crypto 3; **표준 unzip -t "No errors"**(외부도구·CRC); Storage DELETE 정책 qual이 select/insert/update와 동일 소유자범위 + 격리술어(owner=true·other=false) BEGIN..ROLLBACK, 어드바이저 신규 0(기존 3건만)·프로덕션 무변경. **감사관 재판정 예상**: G1·G2·G3 해결로 #5·#6·#7 개선, ②③은 설계상 경계(DR문서 §4에 "백업 주인=사용자" 명시). v0.37·연구노트 seq23. **정직**: 실기기 Storage 실삭제·대용량 암호화 체감은 사용자 몫(로직·정책은 검증됨). 옛 고아 객체 일괄 스윕은 후속.

**Phase 6b(2026-07-24)**: 여행별 폴더 백업 ZIP(v0.36). **동기(사용자)**: "백업 시 여행별로 폴더로 구분?" → 선택: 여행별 폴더 ZIP + 원본 포함. **핵심 제약**: 브라우저는 일반 다운로드로 실제 OS 폴더 생성 불가(폴더쓰기 API=크롬 전용·iOS 불가) → 이식성 정답은 **ZIP 하위폴더**. ① **`src/services/zip.ts`(신규)** — 의존성 0 바닐라 store(무압축) ZIP 리더/라이터 + CRC32(다항식 0xEDB88320). 무압축 선택 이유: 백업 대부분이 이미 압축된 WebP라 재압축 이득 미미·구현 단순·검증 용이. UTF-8 파일명(범용비트11)로 한글 폴더 그대로. DOS date 1980-01-01 고정(재현성). ② **`backup.ts` 리팩터** — 공통 코어 `exportCollectRows()`(전 테이블 읽기)·`importMergeRows(rows)`(빈가드+mergeDecision 병합)를 추출해 **JSON·ZIP 두 형식이 같은 수집·병합 공유**(손 병합 금지·완전성 단일화). 신규 `exportBackupZip(includeOriginals)`(여행폴더=`제목__id8`/`trip.json`+`photos/<id>.webp|.thumb.webp|.orig.<ext>`, 고아행은 `_orphans/`로 유실방지, `manifest.json`)·`importBackupZip(buf)`·`importBackupAuto(buf)`(PK매직바이트로 ZIP/JSON 자동감지). ③ **dataManager UI** — 백업 패널에 🗂️ 여행별 폴더(ZIP)·💾 단일(JSON) 두 버튼, 복원은 .zip/.json 모두 accept+자동감지(arrayBuffer 경로). ④ **check-backup-coverage 게이트 역할기반 강화** — 함수명으로 export-role/import-role 분류 후 **각 역할에서 전 테이블 참조 강제**(형식이 늘어도 완전성 보증). 비공허: collector에서 `d.localMedia.toArray()` 제거 시 export-role RED 재확인. **검증**: 유닛 `zip` 5(CRC 벡터 0xCBF43926·왕복·한글폴더·50엔트리 오프셋·손상감지), **표준 `unzip -l`/`unzip -t` "No errors detected"**(외부도구 상호운용+CRC 무결성 — 사용자가 Finder/탐색기에서 여행별 폴더로 사진 바로 열람 가능 확인), harness **8게이트**·build 그린. **데이터 안전 불변식(병합·빈-데이터 가드·tombstone LWW) 그대로**. v0.36·연구노트 seq22. **정직**: 실기기 대용량 사진 ZIP 생성 체감은 사용자 확인 권장(로직은 장당 순차 arrayBuffer라 메모리 안전).

**Phase 6a(2026-07-24)**: 비상 복구 체계 — 백업 완전성 게이트 + 절차서(v0.35). **동기(사용자)**: "메디컬 앱처럼 비상 상황 대응 시스템이 우리 앱에도 있나? 바로 만들자. (압축 사진은 Supabase에 올라가나?)" → **실측 답**: 표시본은 Storage(journey-media)에 업로드·원본/GPS는 로컬 유지(절약 모드·§0). ① **`scripts/check-backup-coverage.mjs`(신규 8번째 게이트)** — `src/offline/db.ts`의 `\w+!: Table<` 선언을 진실원으로, 사용자 데이터 테이블(localTrips·localMoments·localMedia·localExpenses)이 `exportBackup`·`importBackup` **양쪽**에서 `.localX` 참조되는지 저장소만으로 대조. `EXCLUDE={syncQueue}`(파생 큐). 비공허 자체검사 내장 + **실파일 뮤테이션 검증**(backup.ts에서 localExpenses 참조 제거 시 export/import 양쪽 RED 확인). harness에 등록(**8게이트**). → 새 테이블 추가하고 백업 반영을 잊으면 빌드 즉시 RED = 시나리오 C·D의 최후 방어선 ③이 데이터를 빠뜨리지 않음을 기계적 보증. ② **`docs/DISASTER_RECOVERY.md`(신규)** — 3계층(①로컬 진실·②클라우드 교체가능 부품·③JSON 백업 최후방어선)·복구 우선순위 시나리오 A~D·기계적 보증(게이트)·정직한 갭(원본 클라우드 사본 없음=절약모드 계약·Storage 고아 스윕 미구현·TSA 미도입). **핵심 통찰**: 우리 복구 자세가 메디컬보다 튼튼한 지점 — 원본이 외부 호스트 의존 없음(약한 고리 부재)·백업이 사진 base64로 자족·②는 포트로 격리된 교체 가능 부품. **검증**: harness **8게이트**·build 그린. v0.35·연구노트 seq21. **유보(정직)**: TSA(외부 시각 증명)는 별도 논의. 원본 사진은 ①③에만 산다 → 사용자에 주기 백업 권고(자동 원격 백업은 비공개 기본·§3이라 범위 밖).

**Phase 5h(2026-07-23)**: 사진 다기기 동기화(v0.34) — **동기화 3엔티티 완성**. `domain/media/rowmap.ts`(MediaRow↔MediaMeta, blob·GPS·원본 미포함 — 표시본 메타만; `mediaStoragePath`={uid}/{id}.webp) + `services/media.ts` 5개 mutation(add/softDelete/restore/reedit/rotate)·moments cascade에 'media' 큐 op enqueue + `sync.ts` `mediaRemote`(메타 upsert/getById/listAll + Storage upload/download)·`pushPendingMedia`(활성=표시본 업로드+메타 upsert, tombstone=메타만)·`pullMedia`, runSync 순서 여행→순간→사진·비용. **안전 불변식**: pull은 로컬 blob 비파괴(다운로드 성공 시만 교체·tombstone은 deletedAt만·다운로드 실패 시 로컬 유지), push는 추가전용, 원본 미업로드(절약 모드·§0), GPS 미동기화(PRIVACY). 소비 기기엔 원본 없어 originalBlob=표시본 폴백·thumb는 다운로드본에서 재생성. **검증**: schema-parity(MediaRow 15↔journey.media), 유닛 `mediaRowmap` 4(경로·blob/GPS 미포함·메타 왕복·tombstone), 서버 메타 round-trip(전체 메타 upsert·read-back·좀비 차단 = MEDIA_META_ROUNDTRIP_OK·프로덕션 무변경). harness 7게이트·build 그린. **정직**: Storage blob 업/다운로드(네트워크)는 샌드박스(*.supabase.co 차단) 미검증 → 실기기 몫. 안전 불변식으로 기억 유실은 구조적 불가. **다기기 동기화 = 여행·순간·사진·비용 4엔티티 코드 완료**(실기기 왕복 확인만 남음).

**Phase 5g(2026-07-23)**: 비용 다기기 동기화(v0.33). `domain/expense/rowmap.ts`(ExpenseRow↔LocalExpense, category/note 포함) + `services/expenses.ts` 생성/수정/삭제에 'expense' 큐 op enqueue + **moments cascade 전파**(순간 softDelete→비용 tombstone·restore→비용 복원 시 각 비용에 큐 op·baseVersion·clientOperationId) + `sync.ts` `expensesRemote`·`pushPendingExpenses`·`pullExpenses`, runSync push 순서 여행→순간→비용(자식 복합 FK가 부모 서버 존재 요구). 서버 마이그 `0009`(expenses category/note 추가·무손실). **검증**: schema-parity 게이트가 0009 아티팩트 누락을 RED로 잡아 보강(게이트 실효 확인), expenseRowmap 유닛 4(왕복·tombstone·coi null), 서버 트랜잭션 round-trip(전체 행 upsert·read-back·tombstone·좀비 차단 = EXPENSE_SYNC_ROUNDTRIP_OK, 프로덕션 무변경 expenses 0·테스트유저 0). harness 7게이트·build 그린. **정직**: 네트워크 실사용(runSync over the wire)은 실기기 몫 — 단 trips/moments와 동일 포트/어댑터 플러밍이고 그건 이미 라이브라 신뢰도 높음. media(사진) 동기화만 남음(Storage 업로드·Signed URL·고아 스윕 — 다음 턴).

**Phase 5f(2026-07-23)**: 스키마 드리프트 방지 게이트(v0.32). `scripts/check-schema-parity.mjs` — 각 `src/domain/*/rowmap.ts`의 `interface XRow` 필드가 대응 journey 테이블(마이그레이션 SQL 파싱) 컬럼의 부분집합인지 저장소만으로 판정. `ROW_TO_TABLE`(TripRow→trips·MomentRow→moments·MediaRow→media·ExpenseRow→expenses) — 새 동기화 엔티티는 매핑 추가 강제. 비공허 자체검사 내장(가짜 컬럼 주입→검출), harness에 등록(7게이트). 이 게이트가 있었으면 place_lat/lng 좌표 드리프트가 즉시 RED. LESSONS §6에 드리프트 교훈(라이브 사실은 파생/실측). **다음(집중 턴 예정)**: 앱측 동기화 코드 — 비용(expense) 먼저(순간 delete cascade→비용 tombstone 큐 op 전파 포함, moments 대칭·유닛테스트), 그다음 사진(media, Storage 업로드/Signed URL·고아 스윕). rowmap 추가 시 이 게이트가 자동으로 서버 정합 보증.

**Phase 5e(2026-07-23)**: 다기기 서버 스키마 — 사진·비용·좌표(v0.31). 프로젝트 Travel&Accounting(`ihxiywffzmvrwmqvatzt`)에 마이그레이션 적용: `0005`(moments place_lat/place_lng) · `0006`(journey.media — 표시본 메타+storage_path, 복합 FK media_moment_fk, RLS 소유자+초대제, set_updated_at·zombie 트리거) · `0007`(journey-media Storage 버킷 비공개 + storage.objects 폴더격리 RLS `(storage.foldername(name))[1]=auth.uid()::text`, DELETE 정책 없음) · `0008`(journey.expenses — 원금액>0, 복합 FK, RLS, 트리거). 원본 blob은 서버 미저장(절약 모드) — 표시본만 버킷에. **검증**: `supabase/tests/rls_attack_media_expenses.sql`(BEGIN..ROLLBACK) — A 격리·B 조회/강탈/위조 차단(RLS+H-02)·media 좀비 방지 통과(MEDIA_EXPENSE_RLS_ZOMBIE_PASS). 어드바이저 신규 이슈 0(기존 3건: allowed_users 무정책·is_allowed SECURITY DEFINER·auth leaked-pw — 전부 기존). 프로덕션 무변경(trips 1·moments 1·media 0·expenses 0·테스트유저 0). **정정**: 여행 앱의 룸메이트는 메디컬이 아니라 **회계장부**(사용자 착오 정정) — 여행+회계=한 프로젝트 두 스키마, 메디컬은 별개 프로젝트. **남은 것(앱측·실기기 검증 필요)**: ① services/media·expenses·moments sync push/pull 코드(media는 표시본 Storage 업로드→storage_path 저장, Signed URL 다운로드) ② Google OAuth provider+redirect·Exposed schemas(journey)·GitHub Variables 실연동 → 두 기기 왕복 검증. (샌드박스는 *.supabase.co 차단이라 앱 런타임 미검증.)

**Phase 5d(2026-07-23)**: 서버측 좀비 방지 적용 + 프로젝트 실측(v0.30). **실측(Supabase MCP)**: Bugeon org에 프로젝트 2개 — Medical(`rjhbfgbfhwdhtdzcdvtu`, 메디컬 앱 전용·별개), Travel&Accounting(`ihxiywffzmvrwmqvatzt`, 여행=journey 스키마 / 회계=public 스키마, 한 집 두 방). 여행 앱은 이미 journey.trips·moments·allowed_users(RLS on, 데이터 1/1). **사용자 확정**: Travel&Accounting 유지(메디컬 별개 격리), 서버측 좀비 방지 즉시 적용. **적용**: `supabase/migrations/0004_journey_zombie_guard.sql` — `journey.prevent_zombie_resurrection()`(BEFORE UPDATE, search_path='')를 trips·moments에 부착, tombstone은 더 높은 version(진짜 복원)으로만 부활, 낮/동일 version 활성 upsert는 return OLD로 거부. **검증**: BEGIN..ROLLBACK 트랜잭션 테스트(`supabase/tests/zombie_guard.sql`)로 같은/낮은 version 거부·높은 version 복원 확인, 프로덕션 데이터 무변경(trips 1·moments 1·leftover 0), 어드바이저 함수 search_path WARN 해소. **journey 스키마 현황**: moments에 **place_lat/place_lng 없음**(클라 sync 시 컬럼 마이그레이션 필요), media·expenses 테이블 없음. **다음(다기기 완성)**: ① moments place_lat/lng 컬럼 ② journey.media 테이블+Storage 버킷+RLS+사진 표시본 업로드 ③ journey.expenses 테이블+RLS ④ Google OAuth·GitHub Variables 실연동(샌드박스 *.supabase.co 차단이라 앱 런타임 검증은 실기기 몫).

**Phase 5c(2026-07-23)**: 좀비데이터 원천 차단 + 공유 프로젝트 스키마 격리 계약(v0.29). ① `src/sync/merge.ts` `mergeDecision`을 **version 기반 tombstone 우위**로 전환: 삭제상태가 다른 전이(활성↔tombstone)는 version으로만 판정(벽시계 무시), 활성이 tombstone을 이기려면 version이 더 커야(진짜 복원), 동률은 삭제 승. 지연 pull·**오래된 백업 복원**이 삭제 데이터를 부활시키지 못하게 잠금(메디컬 앱 좀비 재발 방지). 적대적 유닛 6건 추가(`tests/unit/merge.test.ts`) — **비공허 확인**: 옛 시각-우선 로직 주입 시 부활 케이스 4건 RED. SYNC_PROTOCOL 불변식2에 ZOMBIE-GUARD 명문화. **후속**: 서버측도 tombstone을 낮은/동일 version 활성 upsert로 못 덮게 트리거/조건부 upsert(Supabase 연결 시). ② 공유 프로젝트 격리 계약(ADR-0020 확장) — "한 집 여러 방": 메디컬 앱과 같은 Supabase 프로젝트 공유하되 Postgres 스키마(journey/medical) + 앱별 Storage 버킷 + 소유자 RLS로 엄격 분리, 인증(auth.users)만 공유. `client.ts` 주석에 계약 기록. 검증: harness 6게이트·unit(merge 19)·build.

**Phase 5b(2026-07-23)**: 표시본 품질 상향 + 저장 용량 표시(v0.28). ① `media/compress.ts` DISPLAY_QUALITY 0.82→0.90(크기 1600px 유지), THUMB_QUALITY 0.72→0.80. 실측 근거: 12MP급 표시본 ~0.47MB→~0.66MB(+40%), 원본 별도 보관이라 전체 증가 ~10%대(측정 스크립트 scratchpad). ② `services/storage.ts`(신규) `computeStorageUsage()`: 사진=미디어 blob(원본+표시본+썸네일) 합, 텍스트=blob 제외 JSON 바이트, + `navigator.storage.estimate()`(가능 시). `formatBytes`. ③ 데이터 관리 상단 `.dm-usage` 요약 카드(사진/텍스트/합계 + 한도 대비 막대). estimate.usage는 프라이버시 반올림으로 부정확 → 막대·%는 **정확한 앱 데이터(사진+텍스트)/estimate.quota**로 계산(모순 방지). 검증: harness 6게이트·build·라이브(빈 상태 0B/65B, 1장 후 112KB/2KB/합계 113KB, 한도 975MB 0%·여유 충분, 콘솔 에러 0). v0.28·연구노트 seq14.

**Phase 3i(2026-07-23)**: 저장된 순간에 사진 추가(v0.27). 편집(✎) 시 `.moment-addphoto`(📷 사진 추가) 노출 — 그동안 순간 편집은 필드만, 사진은 개별 삭제(✕)만 가능했다. 생성 흐름의 배치 편집을 **`processPhotosIntoMoment(files, momentId, tripId, onProgress)` 모듈 함수로 추출**해 생성·추가가 단일 경로 공유(SSOT). 배치 장수 명시적 상한 없음(한 장씩 순차 열기·굽기·저장 → 메모리는 장당 한 장). 검증: harness 6게이트·build·라이브(생성 1장 → 편집 모드 사진추가 2장 배치 → 카드 3장, 콘솔 에러 0). v0.27 changelog·연구노트 seq13.

**Phase 3h(2026-07-23)**: 편집 미리보기 잘림 수정 + Ctrl+휠 줌(v0.26). ① **M-flex-clip**: `.pe-stage`(overflow:hidden)가 스크롤 flex 시트의 자식이라 자동 최소크기 0 → 내용이 96vh를 넘으면 min-height(220px)까지 압착되어 세로 사진 위쪽만 보임(사용자 실기기 재현) → `flex:0 0 auto`(수축 금지)로 해결, 헌장 §4에 결함 등록. ② Ctrl+휠 확대/축소(트랙패드 핀치 포함): stage wheel 리스너(passive:false·ctrlKey 필수·크롭 모드 제외), 연속 제스처 undo 규칙(pendingSnap→350ms 디바운스 commitPending+고해상 재굽기). 두 손가락 핀치는 v0.24 기존 기능. ③ `setPointerCapture` try/catch(합성/종료 포인터 안전). 검증: harness 6게이트 · **verify-editor-live 28/28 PASS**(신규: 무압착 566=566 · Ctrl+휠 1→1.8 · 핀치 1.8→3) · **비공허 확인**: 수축 허용을 주입하면 220vs566 RED로 잡힘 · 콘솔 에러 0. 실기기 핀치·Ctrl+휠 체감은 사용자 확인 권장.

**Phase 3g(2026-07-23)**: 편집기 실행취소·브러시 표시·뷰어 넘기기(v0.25) + **편집기 개발 헌장 스킬**. ① 전역 실행취소: 헤더 ↺, 이산 조작은 직전 `pushHistory`, 연속 제스처(슬라이더·팬·핀치·크롭 드래그)는 `pendingSnap`→`commitPending`(무변화 제스처는 커밋 안 함) — 잡티 전용 되돌리기를 통합 제거, aspect 칩 동기화를 `syncAspectChips` 단일 경로로. ② 잡티 브러시: 크기 조절·탭 시 실제 반경 원 표시(`pe-brush-dot`, pointer-events 없음). ③ 뷰어: `openViewer(list, index)`로 서명 변경 — ◀▶·방향키·좌우 스와이프(|dx|>48·세로 우세 무시)·순환·카운터(n/m), 회전 시 list[idx] 갱신. ④ **`.claude/skills/photo-editor-dev/SKILL.md`(사진 편집기 개발 프롬프트)**: 좌표계 계약·성능 규칙·과거 결함 등록부(§4)·검증 체크리스트 집대성 — 편집기 코드 수정 전 필독, 새 교훈은 §4에 행 추가. LESSONS.md §8은 스킬을 SSOT로 참조(중복 서술 금지). ⑤ 라이브 검증 스크립트를 `scripts/verify-editor-live.mjs`로 상비화(선택 게이트, 전역 playwright 폴백). 검증: harness 6게이트 · 유닛 90/90 · 라이브 25/25 PASS(undo 값·픽셀 원복, 이력 소진 비활성, 브러시 원, 뷰어 카운터·순환) · 콘솔 에러 0. 실기기 스와이프·더블탭은 사용자 확인 권장.

**Phase 3f(2026-07-23)**: 사진 편집기 전면 개선(v0.24). ① 성능: `bakeToCanvas`가 기하 중간 캔버스를 원본 전체 해상도로 만들던 것을 필요 배율로 프리스케일(12MP급에서 프레임당 수십 MB 할당 제거) + 드래그 중 저해상(FAST_MAX 420)→손 떼면 고해상(900) 2단계 미리보기 + 그레인 고정 시드(mulberry32, 미리보기 어른거림 제거·저장 재현성). ② UX: 미리보기 상단 sticky·액션바 하단 sticky(보면서 조절), 슬라이더 값 표시+라벨 더블탭 개별 초기화, 프리셋 aria-pressed 활성 표시(수동 조정 시 해제), 👁 원본 비교(홀드, 기하 유지·색/효과/잡티 제외), 두 손가락 핀치 줌(🔍 슬라이더 연동), 적용 중… 진행 표시, Esc 닫기+편집 존재 시 confirm 보호, 배치 추가 시 "⏭ 남은 N장 모두 원본"(action='skipAll' — 장당 편집기 강제 통과 제거). ③ 결함 수정: 자유 크롭 서/북 핸들을 경계 밖으로 끌면 반대 변이 늘어나던 클램프 결함 → `resizeFreeCrop` 순수함수로 추출(변 좌표 기준 클램프, 유닛 5) · 뷰어 사진 탭 시 닫힘 방지 + Esc 리스너 누수 수정. 검증: harness 6게이트 PASS · 유닛 90/90 · 라이브(Playwright/Chromium, dist 서빙) 17/17 PASS(값 표시·프리셋 해제·비교 홀드 픽셀 왕복·Esc confirm·배치 2장·뷰어) · 콘솔 에러 0. 실기기 터치(핀치·더블탭)는 사용자 확인 권장.

**Phase 4b(2026-07-23)**: 장소 검색(지오코딩). Nominatim(무료·키 불필요, 구글맵은 키·결제라 제외). `services/geocode.ts`(순수 URL·파서, 유닛 6). `LocalMoment.placeLat/placeLng`+rowmap. 생성·편집 폼 공통 `buildPlaceField`(🔍검색→결과 선택→좌표 저장, 결과는 textContent 안전). 지도 좌표 우선순위: 장소 좌표→사진 GPS. CSP에 nominatim.openstreetmap.org. **후속**: moment 서버 sync 시 place_lat/place_lng 컬럼 마이그레이션 필요. 라이브 검증: Playwright 자체 서빙+Nominatim 목킹으로 검색→선택→저장→지도표시(세션 후반 로컬서버 불안정 우회).

**Phase 3e(2026-07-23)**: 저장된 사진 재편집(비파괴). 뷰어 `✎ 편집` → `openPhotoEditor(원본Blob, {initialState})` → `reeditMediaLocalFirst`(원본·EXIF 불변, 표시본·썸네일 재생성, version+1). `LocalMedia.editState`(순수값)로 이어서 편집·백업 포함. 라이브 검증: 회전 재편집 시 치수 스왑·원본 크기 불변·editState 저장, 콘솔 에러 0. (참고: 이 세션 후반 vite preview 기동 불안정 → dist 정적 서버로 검증.)

**Phase 4(2026-07-23)**: 지도와 장소. ADR-0023(A-006 OSM 래스터 기본·교체가능, CSP에 tile.openstreetmap.org). `domain/place/geojson.ts`(순수, 유닛 4)·`ui/screens/mapView.ts`(여행 🗺 지도 → MapLibre 동적import·마커·DOM 팝업·장소목록 대체·GeoJSON 내보내기). tripDetail 히어로에 지도 버튼·refresh에서 locatedPoints 계산(사진 EXIF GPS). 라이브 검증: 빈상태·장소목록·강등폴백·GeoJSON, 앱 콘솔 에러 0. 실 타일 지도는 사용자 실기기 몫. 남은 Phase 5: 회고(Reflection)·대표사진.

**Phase 5a(2026-07-23)**: 비용(Expense) 기록. `LocalExpense`(Dexie v4)·`domain/expense/format.ts`(순수, 유닛 9)·`services/expenses.ts`(로컬 전용, 동기화 후속). tripDetail에 금액+통화 입력·money chip·통화별 합계·인라인 편집. 순간/여행 삭제·복원·영구삭제·백업에 비용 cascade 통합. 라이브 검증: 생성·다통화·편집·백업 왕복, 콘솔 에러 0. 남은 Phase 5: 회고(Reflection)·대표사진. Phase 4(지도)는 미착수. **PR #12 병합됨 → 이 브랜치는 main에서 새로 뜬 상태.**

**Phase 3d(2026-07-23)**: 데이터 관리 허브 — 홈 `📦 데이터 관리` → 백업·복원·휴지통·가이드(가이드 버튼을 이 안으로 이동). 백업/복원은 `src/services/backup.ts`(사진 base64 포함 JSON, 복원은 mergeDecision+빈-데이터 가드 병합, 손 병합 없음). 휴지통은 `trips.ts`(listDeletedTrips·restoreTripFromTrash·purgeTripPermanently). 라이브 검증: 백업→초기화→가져오기 왕복(사진 썸네일 렌더 포함) + 휴지통 복원, 콘솔 에러 0. 정직: 영구삭제 서버 전파는 동기화 실연동 후속.

**Phase 3c(2026-07-23)**: 여행 삭제(cascade tombstone + 실행취소) — Trip 생명주기 대칭성 회복. 공용 실행취소 토스트를 `src/ui/toast.ts`로 분리(body 부착·화면 전환 유지). **가이드 화면**(홈 `📖 가이드` → 2열 모달 [연결·설정]/[개발·설계], `src/ui/screens/guide.ts`) 추가 — 콘텐츠는 이 저장소 실제 사실(harness 6게이트·26 에이전트·비타협 원칙)로 구성, 손 스냅샷이라 레지스트리 파생 게이트는 후속. 라이브 검증(Playwright/Chromium): 생성→편집→삭제→실행취소→cascade 복원 전 과정 + 가이드 렌더, 콘솔 에러 0.

**Phase 3b(2026-07-23)**: 순간 편집·삭제 + 사진 개별 삭제 구현. 하드 삭제 없음(§0) — `deletedAt` tombstone + 5초 실행취소(§5). 순간 삭제 시 사진 cascade tombstone(undo가 함께 복원), 미디어는 로컬 전용이라 sync 큐 op 없음. 편집으로 그간 미사용이던 `note`·`occurredAt` 사용 가능. 서비스: `updateMomentLocalFirst`/`softDeleteMomentLocalFirst`/`restoreMomentLocalFirst`(moments.ts), `softDeleteMediaLocalFirst`/`restoreMediaLocalFirst`(media.ts). **연역적 발견(미구현·후속)**: Trip은 여전히 삭제(tombstone) 없이 보관만 존재 — 엔티티 생명주기 대칭성 결손. **미검증(정직)**: 실기기 라이브 상호작용 미실행.

**읽기 순서**:
1. `CLAUDE.md`(Claude) / `AGENTS.md`(Codex) — 어댑터·비타협 원칙·작업 루프
2. **이 HANDOFF 인계 요약 위쪽(현재 단계·기능 지도)** — 지금 어디까지 됐는지
3. `docs/PROJECT_SPEC.md`(최상위) → `docs/LESSONS.md`(교훈)
4. 도메인 계약: `DATA_MODEL` · `SYNC_PROTOCOL` · `SECURITY` · `MEDIA_PIPELINE` · `PRIVACY` · `DEPLOYMENT` · `ARCHITECTURE` · **`DISASTER_RECOVERY`(백업·복원·복구 우선순위)**
5. `docs/AGENT_REGISTRY.md` → `docs/DECISIONS.md` + `docs/ASSUMPTIONS.md`
6. `docs/ROADMAP.md`(Phase 계획) → `docs/ACTIVE_TASKS.md`
7. **작업 전 필수 스킬**(해당 영역 수정 시): 사진 편집기/뷰어 → `.claude/skills/photo-editor-dev/SKILL.md` **반드시 로드**. 데이터 안전(백업·동기화) 변경 → `.claude/agents/disaster-recovery-guardian`로 사전·사후 감사.
8. v0.2 원본 참조: `docs/reference/v0.2/`

**클론 후 검증**(그대로 실행):
```
npm ci
git config core.hooksPath .githooks   # commit-msg hook 활성
npm run harness                        # Required 게이트 전체 (목록은 scripts/harness.mjs — 손편집 나열 금지, M-0001)
npm run build                          # base=/Travel-Memories/ 정적 빌드
npm run dev                            # 홈 화면 확인 (선택)
```

**다음 작업 후보**(v0.40 이후 — 앞선 Phase 기록에서 "후속"으로 남긴 것들):
- **회고(Reflection) + 대표사진**: Phase 5의 원래 잔여. 여행/하루의 회고 텍스트·대표사진 지정(memory-centered-ux·photo-storytelling-designer 에이전트 영역).
- **Storage 옛 고아 스윕**: v0.37에서 tombstone 시점 스윕은 구현(0010 DELETE 정책). 그 이전에 삭제된 옛 표시본 객체의 1회성 일괄 정리는 미구현(유실 아님·잉여).
- **연구노트 TSA(외부 타임스탬프)**: 해시체인은 앱 내 무결성만 보장. 외부 시각 증명은 별도 논의(사용자 대기).
- **AI 산출물 테이블(ai_artifacts, Phase 7)**: 아직 미구현. 구현 시 사용자 필드와 절대 혼합 금지(비타협 원칙 #2).
- **실기기 검증 갭 해소**: 네트워크 동기화·Storage 업/다운·핀치/드래그·PWA 설치는 샌드박스 미검증 → 사용자 실기기 확인이 필요한 상시 항목.

**사용자 대기 열린 결정**: 연구노트 TSA 도입 여부 · (해소됨: Supabase 프로젝트=Travel&Accounting 확정 · Google OAuth 라이브 · 지도 타일=OSM 래스터 ADR-0023). ADR-0015 인라인 AI 컬럼 제거는 ai_artifacts 착수 시 재검토.

**협업 규칙**(AGENTS.md): 별도 클론 · `claude/*`·`codex/*` 브랜치 · `main` 직접 push 금지 · 뜨거운 파일 단일 PR 직렬화 · task는 `docs/ACTIVE_TASKS.md`에 등록 · agent 보고서는 `schemas/agent-report.schema.json` 검증(`artifacts/agent-reports/`) · **완료 = 배포 그린 확인**.

---

## HANDOFF-0004 · 적대적 검토 중간 항목 일괄 (TASK-0004)
- 작업 ID: TASK-0004 · 담당: Claude Code · 날짜: 2026-07-22 · 브랜치: `claude/travel-log-app-r2xd5f`
- 목표: HANDOFF-0003 "남은 위험" 중간 항목 6건 해소.
- 변경: ① 스캐너 범위=git 추적 전체(docs/ 제외·사유 명시)+dist, 패턴 추가(sbp_·Google API 키·PEM), `.env` 추적 차단, SECURITY.md 서술을 구현 실체로 정정(엔트로피=미구현·후속 명시) ② `tests/unit/`(router·registry 9케이스) 신설, `pathToRoute` base 주입 순수함수화, 하네스에 `unit-tests` 게이트 — `npm test` RED 해소 ③ `check-domain-wiring` 기대 집합을 손편집 상수에서 DATA_MODEL.md 헤딩 파생으로 교체(셀프테스트 4케이스) ④ base SSOT: index.html 링크 `%BASE_URL%` 파생 + manifest 중복은 `check-base-consistency` 게이트로 대조(셀프테스트 6케이스) ⑤ ci.yml pull_request 트리거 제거(중복 실행)+concurrency 취소 ⑥ PWA 아이콘 PNG 파생 생성(192/512/maskable/apple-touch, `scripts/generate-icons.mjs`, icon.svg=SSOT·산출물 커밋) + index.html manifest/apple-touch 링크(기존엔 manifest 링크 자체가 없어 PWA 설치 불가였음).
- 실행 검사(실제 결과): `npm run harness` 6게이트 전부 PASS · `npm test` 9/9 PASS · `npm run build` 성공, dist/index.html에 base 치환 확인 · PNG 4종 생성·픽셀 확인(512px 시각 확인). (자동층만 통과 표기 — 실기기 PWA 설치·iOS 홈화면 아이콘은 사용자 확인 권장.)
- 남은 위험(선택 항목): 고엔트로피 일반 토큰 탐지 미구현(문서에 후속 명시) · fork PR 받을 경우 ci.yml pull_request 재도입 필요(주석 명시) · maskable 아이콘 safe-zone은 자동 검증 없음(시각 확인만).
- 되돌리기: 이 커밋들 revert.

## HANDOFF-0003 · 적대적 검토 후속 수정 (TASK-0003)
- 작업 ID: TASK-0003 · 담당: Claude Code · 날짜: 2026-07-22 · 브랜치: `claude/travel-log-app-r2xd5f`
- 목표: 적대적 저장소 검토에서 확인된 결함 5건을 우선순위대로 수정.
- 변경: ① `scripts/check-secret-leak.mjs` — matchAll 전수 판정 + 셀프테스트 내장(M-0004, 우회 재현→수정→재현 차단 확인) ② `src/offline/db.ts` — `deletedAt` 인덱스 제거(M-0005) ③ `.github/workflows/deploy-pages.yml` — `vars.*` env 주입 + `docs/DEPLOYMENT.md` 활성화 절차 ④ `index.html` CSP 확장(wss·worker-src blob:·Storage img-src) + `scripts/check-csp.mjs` 게이트 신설·하네스 편입 ⑤ `.githooks/commit-msg` — Revert/Merge 허용 + `[skip actions]`·`skip-checks:` 차단.
- 실행 검사(실제 결과): 시크릿 스캐너 우회 픽스처 exit 1(RED) 확인 · 훅 픽스처 7케이스 전부 기대대로 · `npm run harness`(4게이트) PASS · `npm run build` 성공. (자동층만 통과 표기 — CSP의 실브라우저 동작·Pages 배포는 미검증: 지도/Realtime 미구현 + main 미병합.)
- 남은 위험(미수정, 검토에서 지적됨): 스캐너 커버리지가 SECURITY.md 주장보다 좁음(docs/scripts/.github 미스캔·엔트로피 미구현) · `npm test` 테스트 0개로 RED · base 경로가 vite.config/manifest 2곳 손편집 중복 · `check-domain-wiring` EXPECTED 손편집 사본 · CI 중복 실행(`push: '**'`+PR) · PWA 아이콘 SVG 단독(iOS) · 프로덕션 소스맵 공개.
- 운영 필요(사용자): Settings→Pages→Source="GitHub Actions" 설정 · Supabase 프로비저닝 후 Actions Variables 등록 · main 병합 후에만 배포 발동.
- 되돌리기: 이 커밋들 revert (훅이 이제 Revert 제목을 허용함).

## HANDOFF-0002 · Phase 0B 코드 골격
- 작업 ID: TASK-0002 · 담당: Claude Code · 날짜: 2026-07-22 · 브랜치: `claude/travel-log-app-r2xd5f`
- 목표: Vite+TS 골격이 빌드·타입체크·렌더되고 CI·배포·hook·레지스트리 게이트가 동작(기능 없음).
- 변경 파일: `package.json`·`tsconfig.json`·`vite.config.ts`·`.gitignore`·`.env.example`·`index.html`; `src/`(main·app/router·ui/screens/home·ui/styles/{tokens,app}.css·domain/registry·offline/db·services/supabase/client); `public/`(manifest·icons); `scripts/`(harness·check-secret-leak·check-domain-wiring); `.github/`(ci·deploy-pages·PR 템플릿); `.githooks/commit-msg`.
- DB/Storage 변경: 없음(Supabase 미프로비저닝).
- 보안/개인정보: 번들에 publishable 키만(시크릿 형태 스캔 통과). service_role/secret 부재.
- 실행 검사(실제 결과): `npm run typecheck` PASS · `npm run harness`(typecheck+secret-leak+domain-wiring) PASS · `npm run build` 성공(base 주입 확인) · Playwright 라이브 렌더 콘솔/페이지 에러 0. (자동층만 통과 표기 — 실기기·시각 미검증.)
- 남은 위험: SW 캐시·배선맵 생성기·경계 게이트 미구현; ADR-0015 인라인 AI 컬럼 제거 reviewer 확인 대기; CI/배포 워크플로는 GitHub에서만 실행됨(로컬 미검증).
- 다음 작업: Phase 0B 잔여(SW·게이트) 또는 Phase 1(인증·여행 CRUD·RLS). Supabase 프로젝트 생성 시 A-014 항목 확정.
- 되돌리기: 이 커밋 revert.

## HANDOFF-0001 · Phase 0 설계·에이전트 스캐폴딩
- 작업 ID: TASK-0000 · 담당 도구: Claude Code · 날짜: 2026-07-22
- 브랜치: `claude/travel-log-app-r2xd5f`
- 목표: 설계지시서 §28·§29에 따른 문서·에이전트·Phase 0 계획 스캐폴딩 (기능 구현 없음).
- 변경 파일:
  - 삭제: `index.html`, `css/styles.css`, `js/app.js`, `js/db.js` (기존 MVP — git 히스토리 보존).
  - 신규 문서: `CLAUDE.md`, `AGENTS.md`, `README.md`(개정), `docs/`(PROJECT_SPEC, ARCHITECTURE, DATA_MODEL, SECURITY, PRIVACY, SYNC_PROTOCOL, MEDIA_PIPELINE, DEPLOYMENT, LESSONS, AGENT_REGISTRY, TEST_PLAN, ROADMAP, DECISIONS, ASSUMPTIONS, HANDOFF, CHANGELOG).
  - 신규 에이전트: `.claude/agents/` 통합 10 + 디자인 16 = 26개.
  - `.claude/settings.json`(hook 후보 문서화), `.claude/agents/README.md`(등록부 인덱스).
- DB 변경: 없음. Storage 변경: 없음.
- 보안 영향: 소유자 범위 RLS·시크릿·EXIF PII 정책을 문서로 확정(코드 미구현). hook 후보 분류.
- 개인정보 영향: EXIF GPS 민감 PII 정책 잠정 기록(Phase 4 확정 예정).
- 실행 검사: 에이전트 frontmatter(name/model/tools) 기계 확인. 문서 인벤토리 카운트는 이번 검토에서 드리프트(123 역할·15종 표기, 유령 엔티티 `markers` 등)를 발견하여 정정함. 앱 코드 없음 → 자동 테스트 해당 없음(정직한 완료: 자동 검증층 미적용 단계, 문서 일관성은 육안+grep 검토 수준으로 오버클레임 아님).
- 실패 검사: 없음.
- 남은 위험: Phase 0 코드 골격(Vite 초기화) 미착수. 사용자 확인 대기 항목(사진 저장 모드·인증 방식·지도 제공자·Supabase 프로젝트).
- 다음 작업: Phase 0 코드 골격 — 변경 예정 파일 목록 제시 후 착수.
- 되돌리기: 이 커밋 revert 시 MVP는 git 히스토리에서 복구 가능.
