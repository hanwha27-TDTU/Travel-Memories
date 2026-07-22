# ARCHITECTURE · Journey Archive

설계지시서 §4·§5·§16·§17 + LESSONS §3.

## 배포 구조

기본 운영판은 **여러 파일 PWA**: `index.html`, `assets/`, `manifest.webmanifest`, `sw.js`. Service Worker·오프라인 캐시 안정성을 위해 단일 HTML만 고집하지 않는다. 별도 빌드로 **휴대용 단일 HTML판**(보조)을 생성한다.

배포 우선순위: ① 여러 파일 운영 PWA → ② GitHub Pages 정적 배포 → ③ 단일 HTML 보조 빌드.

> **GitHub Pages 정적 배포가 필수 목표**(ADR-0010). Vite `base=/Travel-Memories/`, Service Worker scope·라우터 하위경로 대응, 서버측 로직은 Supabase Edge Function, 번들엔 anon 키만. 상세·제약·파이프라인은 `docs/DEPLOYMENT.md`.

## 기술 구성

TypeScript(strict) · Vite · Vanilla TS 컴포넌트 · Supabase(Auth/PostgreSQL/Storage 비공개 버킷) · Dexie(IndexedDB) · MapLibre GL JS · GeoJSON · Web Worker+OffscreenCanvas(+Canvas 대체) · Service Worker+IndexedDB 대기열 · Vitest · Playwright · GitHub Pages · GitHub Actions · Git worktree+기능별 branch.

> 프레임워크는 MVP에서 추가하지 않는다. Vanilla 구조 유지 불가가 **실제 측정**된 경우에만 기술변경 제안서.

## 지도 어댑터 분리 (H-05 — MapLibre는 렌더러만)

MapLibre GL JS는 **벡터 타일을 렌더링하는 라이브러리**일 뿐이다. 타일·style·지오코딩 서비스는 별개이므로 MapLibre가 타일·검색·역지오코딩까지 제공한다고 오해하지 않는다(R18). 지도 책임을 교체 가능한 별도 어댑터로 분리한다.

| 어댑터 | 책임 |
|--------|------|
| `MapRenderer` | MapLibre GL JS — WebGL 렌더링만 |
| `MapStyleProvider` | 지도 style 문서 제공 |
| `TileProvider` | 벡터/래스터 타일 소스 |
| `Geocoder` | 장소명 → 좌표 검색 |
| `ReverseGeocoder` | 좌표 → 주소·장소 |
| `TimezoneResolver` | 좌표 → IANA 시간대 후보(C-10 시간 신뢰도 입력) |

geocoder·reverse geocoder·timezone·tile provider는 **미정**이므로 어댑터 인터페이스와 설정만 먼저 구현하고 실제 제공자는 이용약관·비용·개인정보 검토 후 선택한다(ASSUMPTIONS A-005). `services/maps`는 이 어댑터 경계를 노출하고 화면은 어댑터만 호출한다.

## 계층 경계 (§17)

```
UI (screens/components/dialogs)
  │  화면은 service/repository 계층만 호출 — Supabase SDK 직접 호출 금지
services (supabase/storage/sync/maps/ai)
  │  도메인 로직과 DOM 조작 분리, DB 행 형식과 화면 모델 분리
domain (trip/moment/place/media/expense/companion/reflection)
offline (db/schema/queue/conflict) · media (intake/exif/hash/compress/thumbnail/worker)
security (sanitize/validation/privacy) · export (json/csv/geojson)
```

- 데이터베이스 행 형식(snake_case)과 화면 모델(camelCase)을 분리하고 `toRow`/`fromRow` 경계에서만 변환.
- 모든 외부 입력은 검증 후 사용. 사용자 입력을 `innerHTML`로 직접 삽입 금지.
- 비동기 작업은 취소/시간초과 고려, 사진 처리는 `AbortSignal` 지원.
- 모든 업로드에 `client_operation_id`. 날짜는 서버 timestamptz 저장, 화면엔 여행 현지 시간대 표시.
- 파일 삭제와 DB 삭제를 하나의 성공으로 가정하지 않음.

## 배선맵 (전력망 모델 — LESSONS §3)

단말(소비자)에서 역방향으로 그린다. 단말: **타임라인·지도·사진 그리드·여행 통계·내보내기/백업·휴지통·동기화 상태·검색**. 각 단말을 소스로 역추적; 역추적 안 되는 단말 = 끊긴 배선. "데이터 저장은 0점 — 전류가 모든 단말까지 흘러야 한다." 맵은 SSOT(`TERMINALS`)에서 생성하고 "커밋본 == 생성본" 게이트로 강제. 검증 가능한 엣지만 그린다.

## 저장소 구조 (목표 — §16)

```
/  CLAUDE.md  AGENTS.md  README.md  package.json  vite.config.ts  tsconfig.json  index.html
public/ (manifest.webmanifest, icons/)
src/
  app/ (router, state, events)
  domain/ (trip, moment, place, media, expense, companion, reflection)
  ui/ (components, screens, dialogs, styles)
  services/ (supabase, storage, sync, maps, ai)
  offline/ (db, schema, queue, conflict)
  media/ (intake, exif, hash, compress, thumbnail, media.worker)
  security/ (sanitize, validation, privacy)
  export/ (json, csv, geojson)
  types/  utils/
supabase/ (migrations, policies, functions, seed)
tests/ (unit, integration, e2e, security, performance, fixtures)
docs/  .claude/ (agents, commands, settings.json)  .github/ (workflows, templates)  scripts/
```

Phase 0에서 위 골격을 세운다(빈 골격 + 최소 실행). 상세 계획 `docs/ROADMAP.md`.

## 코드 vs 데이터

장소/POI 카탈로그를 번들에 하드코딩하지 않는다. 실제 기록은 DB/Storage에만. seed 배열은 비어 있고 게이트로 강제(LESSONS §3).
