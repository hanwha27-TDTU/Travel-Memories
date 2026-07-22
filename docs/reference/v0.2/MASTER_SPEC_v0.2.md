# Journey Archive 통합 제품·설계 기준서 및 개발 실행지시서

문서 버전: 0.2  
개정 기준일: 2026-07-22  
상태: 비판적 검증 반영안  
작업명: Journey Archive  
주 개발도구: Claude Code  
협업 검토도구: OpenAI Codex  
백엔드: Supabase  
배포 대상: 모바일 우선 웹앱·PWA  
사용 목적: 개인 여행기록, 사진·장소·비용·감정·회고의 장기 보존  
대체 문서: 버전 0.1 전체

이 문서는 제품 의도, 비기능 요구사항, 아키텍처 경계, 보안 기준과 개발 절차를 정의한다. 저장소의 실제 상태는 추정하지 않는다. 첫 실행에서 반드시 읽기 중심의 저장소 조사를 먼저 수행한다.

---

## 0. 비판적 검증 결론

버전 0.1의 핵심 방향은 타당하다. 특히 Moment 중심 구조, 사용자 원문과 AI 결과의 분리, 원본 사진 불변, RLS 우선, 오프라인 대기열과 복구 가능성 우선 원칙은 유지한다.

다만 다음 항목은 그대로 구현하면 검증 불가능한 보장, 동기화 누락, 삭제 복구 실패 또는 개인정보 오노출을 만들 수 있으므로 수정한다.

| 중요도 | 버전 0.1의 문제 | 버전 0.2의 결정 |
|---|---|---|
| 차단 | 브라우저 저장소만으로 기록 유실 0건을 절대 보장 | “로컬 내구성 커밋 후 앱 원인 유실 0건”으로 범위를 한정하고 quota·축출·사용자 삭제 한계를 명시 |
| 차단 | 사진 500장을 모두 영구 대기열에 넣을 수 있다고 전제 | 저장공간 사전점검, 항목별 내구성 상태, 분할 수용과 명시적 거부를 도입 |
| 차단 | Background Sync를 주요 복구수단처럼 표현 | 앱 시작·포그라운드 큐·실제 서버 probe·수동 동기화를 기본으로 지정 |
| 차단 | 단일 HTML판을 PWA와 유사한 배포판으로 취급 | 제한된 휴대용 아카이브·보조판으로 분리하고 기능 동등성 금지 |
| 차단 | 메타데이터 JSON을 전체 백업처럼 오해할 수 있음 | 메타데이터 내보내기와 미디어 포함 전체 아카이브를 분리 |
| 차단 | `updated_at`과 행별 `version`만으로 다기기 동기화 | 멱등 operation 원장, 조건부 버전 갱신, 서버 change cursor와 충돌 기록을 도입 |
| 높음 | 일반 삭제 즉시 Storage 제거와 tombstone 복구가 충돌 | 휴지통과 영구 삭제를 분리하고 삭제 작업 상태머신을 도입 |
| 높음 | DB 행과 Storage 업로드의 실패 순서가 불명확 | pending DB 행 → 불변 경로 업로드 → 검증 → verified 전환으로 고정 |
| 높음 | EXIF 촬영시각을 곧바로 `timestamptz`로 확정 | 현지 원시시각, UTC 오프셋, 시간대 후보, 근거와 신뢰도를 별도 저장 |
| 높음 | MapLibre가 타일·검색·역지오코딩까지 제공한다고 오해할 여지 | 렌더러, style·tile provider, geocoder, reverse geocoder를 분리 |
| 높음 | 공통 열 원칙과 실제 테이블 정의가 불일치 | 공통 열, 소유권 복합 FK, CHECK와 부분 고유 인덱스를 명시 |
| 높음 | 모바일 사진 처리 동시성 기본 2 | 디코딩·변환 기본 1, 업로드 기본 2, 측정 후 상향 |
| 높음 | WebP 요청 결과를 WebP로 가정 | 결과 Blob MIME과 magic bytes를 검사하고 JPEG 또는 PNG로 대체 |
| 높음 | CLAUDE.md와 agent 지시를 강제수단으로 간주 | 문서는 맥락, hook은 사전 방어, CI·테스트는 최종 강제수단으로 구분 |
| 중간 | 123개 역할이 실제 123개 에이전트처럼 운영될 위험 | 123개는 책임 등록부로 유지하고 실제 실행 에이전트는 10개로 제한 |
| 중간 | MVP 음성입력·자연어검색·원본보관 범위가 혼재 | OS 받아쓰기·구조화 검색·앱용 파생본 저장만 MVP 기본으로 축소 |

---

## 0.1 규범 용어

| 용어 | 의미 |
|---|---|
| 필수 | 구현·검사·배포에서 위반할 수 없는 요구 |
| 권고 | 특별한 근거가 없으면 따라야 하는 요구 |
| 선택 | 사용자 승인 또는 별도 ADR 후 채택 가능한 요구 |
| 앱 원인 유실 | 성공으로 표시한 로컬 커밋이 앱 오류, 재시작, 네트워크 실패 또는 재시도 오류 때문에 사라지는 현상 |
| 외부 저장소 손실 | 사이트 데이터 삭제, 브라우저 축출, OS 저장장치 오류, 기기 분실처럼 앱이 통제할 수 없는 손실 |

---

## 0.2 정보원과 충돌 처리

| 순위 | 정보원 | 적용 범위 |
|---|---|---|
| 1 | 사용자 승인된 현재 기준서와 ADR | 제품 의도, 범위, 개인정보 기본값 |
| 2 | 최신 공식 표준·공식 서비스 문서 | 보안, API, 브라우저와 배포 제약 |
| 3 | 저장소의 적용된 migration·테스트·코드 | 현재 구현 사실 |
| 4 | `docs/DECISIONS.md`, `docs/HANDOFF.md` | 승인된 설계 이유와 인계 |
| 5 | `CLAUDE.md`, `AGENTS.md`, agent 프롬프트 | 도구별 작업 맥락 |
| 6 | 개별 대화 기억 | 임시 참고만 허용 |

충돌은 조용히 덮어쓰지 않는다.

```text
- 충돌한 요구와 파일을 식별한다.
- 현재 동작과 목표 동작을 각각 기록한다.
- 보안·데이터 보존·마이그레이션 영향을 평가한다.
- 가장 복구 가능한 기본안을 제안한다.
- 결정 전에는 파괴적 변경을 수행하지 않는다.
- 승인된 결론은 docs/DECISIONS.md에 남긴다.
```

---

## 0.3 Claude Code에 대한 최상위 지시

당신은 이 프로젝트의 수석 설계자이자 개발 오케스트레이터다.

첫 작업은 구현이 아니라 저장소 조사다. Git 상태, 디렉터리, 패키지, 빌드, 테스트, 환경변수 예시, Supabase migration, 정책, 배포와 문서를 조사하고 이 문서와의 충돌을 보고한다.

각 단계는 다음 순서로 수행한다.

```text
- 조사
- 설계
- 변경 예정 파일과 위험 제시
- 최소 범위 구현
- 자동검사
- 적대적 검토
- 문서와 인계 갱신
- 승인 가능한 결과 보고
```

불명확한 사항이 있어도 임의로 범위를 키우지 않는다. 가장 보수적이고 복구 가능한 기본값을 선택하고 `docs/ASSUMPTIONS.md`에 근거, 영향과 해제 조건을 기록한다.

다음 원칙은 절대 위반하지 않는다.

```text
- 사용자 원본 자료를 임의로 삭제하거나 덮어쓰지 않는다.
- 사용자 원문과 AI 결과를 동일한 필드에 저장하지 않는다.
- Supabase secret key 또는 legacy service_role key를 프론트엔드에 포함하지 않는다.
- RLS를 켰다는 사실만으로 안전하다고 간주하지 않고 실제 두 사용자·비로그인 공격검사를 통과시킨다.
- 원본 사진은 MVP 기본값으로 Supabase에 저장하지 않는다.
- 사진 재인코딩 전에 필요한 촬영시각, 위치, 방향과 원본 규격을 읽는다.
- 성공으로 표시한 로컬 기록은 네트워크 실패나 앱 재시작 때문에 유실되면 안 된다.
- 저장공간이 부족한 사진을 저장 완료로 표시하지 않는다.
- 전체 코드베이스를 이유 없이 재작성하지 않는다.
- 활성 task가 소유한 파일을 다른 agent가 동시에 수정하지 않는다.
- 자동검사를 통과하지 않은 변경을 완료로 표시하지 않는다.
- 사용자 승인 없이 공개 공유, 소셜 기능, 추적 분석 또는 외부 AI 전송을 추가하지 않는다.
- 적용된 migration 파일을 수정하지 않고 새 migration으로 변경한다.
- Storage 객체 교체에 upsert를 기본 사용하지 않는다.
- 로그와 오류보고에 토큰, Signed URL, 원문 GPS, 개인 메모 또는 사진 바이트를 남기지 않는다.
```

`CLAUDE.md`와 `AGENTS.md`는 짧고 안정적인 맥락만 제공한다. 반드시 차단해야 하는 동작은 deterministic command hook, 스크립트와 CI로 검증한다. LLM 기반 hook은 보조수단이며 최종 통제수단이 아니다.

---

## 1. 제품 비전

Journey Archive는 긴 여행기를 요구하는 일기 앱이 아니라 사진, 장소, 시간, 비용, 동행인, 감정과 회고를 연결하여 장기간 검색·복원 가능한 개인 여행기록 데이터베이스다.

핵심 제품 문장은 다음과 같다.

> 사진, 장소, 비용과 짧은 감정을 자동으로 연결하여 여행 당시의 기억과 그 여행이 나에게 남긴 의미를 다시 찾아주는 개인 여행기록 앱

가장 작은 의미 단위는 `Moment`다. 아래 화살표는 소유 계층이 아니라 주 탐색 관계를 뜻한다.

```text
Trip
→ TripDay
→ Moment
→ MediaAsset
→ Place
→ Expense
→ Companion
→ Reflection
```

여행 전체를 하나의 긴 글로만 저장하지 않는다. 식사, 관광지, 이동, 사건, 대화와 감정을 독립 순간으로 저장하고 여행·날짜·장소 단위로 재구성한다.

---

## 2. 제품 목표와 검증 가능한 기준

| 목표 | 수용 기준 |
|---|---|
| 여행 중 순간기록 | 사진 선택 시간을 제외하고 대표 흐름을 10초 이내 완료 |
| 로컬 저장 반응 | 저장 누름 후 메타데이터 로컬 커밋 p95 500ms 이하를 기준 기기에서 측정 |
| 여행 후 회고 | 기본 질문을 10분 이내 완료 |
| 과거 여행 검색 | 여행목록 시작점에서 3회 이내 조작으로 대표 결과 접근 |
| 오프라인 기록 | 로컬 내구성 커밋 후 앱 원인 유실 0건 |
| 대량 선택 | 사진 500장 선택 입력에서 강제종료 없이 제한된 동시성으로 대기열 관리 |
| 저장공간 부족 | 미수용 항목을 저장 완료로 표시하지 않고 수용·대기·거부 수를 구분 |
| 업로드 장애 | 성공 항목은 재업로드하지 않고 실패 operation·파일만 멱등 재시도 |
| 개인정보 | 모든 여행, 미디어, 좌표, 비용과 회고의 기본값 비공개 |
| 데이터 이동성 | 메타데이터 JSON·비용 CSV·위치 GeoJSON과 미디어 포함 전체 아카이브를 구분 제공 |

브라우저 저장소에는 quota와 축출 정책이 있고 사용자가 사이트 데이터를 지우면 IndexedDB와 OPFS도 삭제될 수 있다. `navigator.storage.persist()` 요청도 브라우저가 거부할 수 있다. 따라서 “어떤 상황에서도 유실 0건”이라는 문구를 사용하지 않는다.

```text
- 로컬 트랜잭션 성공 전에 저장 완료를 표시하지 않는다.
- 미디어는 내구성 있는 로컬 복사 또는 파생본 생성 전까지 비내구성 상태로 표시한다.
- 저장공간 예상치와 사용량을 표시한다.
- 가능한 환경에서 persistent storage를 요청하고 결과를 과장 없이 표시한다.
- 사이트 데이터 삭제, 브라우저 축출, 기기 분실 위험을 안내한다.
- 장기 보존은 서버 동기화 또는 사용자 전체 아카이브로 이중화한다.
```

성능 수치는 Phase 0에서 기준 기기와 네트워크 프로필을 확정한 뒤 `docs/PERFORMANCE_BUDGET.md`에 고정한다. 측정 조건이 없는 “빠름”은 완료 기준으로 인정하지 않는다.

---

## 3. 핵심 설계 원칙

### 3.1 최소 입력

```text
사진 선택 또는 기록 시작
→ 자동 메타데이터 후보 확인
→ 한 줄 기록
→ 선택적으로 감정·비용·중요기억
→ 메타데이터 로컬 커밋
→ 사진 내구성 처리와 동기화
```

음성입력은 MVP에서 운영체제 키보드 받아쓰기 또는 사용자가 명시적으로 첨부한 오디오 메모만 기본으로 본다. 브라우저 음성인식 서비스를 필수 기능으로 약속하지 않는다.

### 3.2 사용자 원본 불변

휴대전화 원본 파일은 읽기 전용으로 취급한다. 앱은 별도 파생본과 썸네일을 생성한다. 원본 클라우드 보관은 MVP 기본범위가 아니며 별도 기능 플래그, 비용 안내, 대용량 재개 업로드와 복원검사를 통과한 뒤 활성화한다.

### 3.3 오프라인 우선

메타데이터 저장은 서버보다 로컬 저장소가 먼저다.

```text
사용자 입력
→ Dexie 트랜잭션으로 로컬 엔터티와 operation 기록
→ 로컬 커밋 확인
→ 기록 저장 완료 표시
→ 동기화 큐
→ 실제 서버 가용성 확인
→ 멱등 동기화
```

미디어는 별도 상태를 갖는다.

```text
파일 선택
→ selected_non_durable
→ OPFS 또는 IndexedDB에 내구성 스테이징
→ staged
→ 앱용 파생본 생성·검증
→ derived_ready
→ 업로드 가능
```

### 3.4 기본 비공개와 최소 전송

외부 지도, 지오코딩, 오류보고, 분석, OCR과 AI 전송은 기능별로 구분한다. 지도 타일 제공자는 IP와 지도 화면 범위를 볼 수 있고 역지오코더는 좌표를 받을 수 있으므로 개인정보 고지와 제공자 교체 인터페이스를 둔다.

### 3.5 복구 가능성 우선

위험한 작업에는 사전 목록, operation ID, 재시도, 결과검증, 부분 실패 상태, 복구경로와 인계기록이 필요하다. DB와 Storage 사이에 분산 트랜잭션이 있다고 가정하지 않는다.

---

## 4. 개발 범위

### 4.1 MVP

| 영역 | MVP 기능 |
|---|---|
| 계정 | 개인용 로그인, 세션 복구, 로그아웃, 공개 회원가입 기본 비활성 |
| 여행 | 생성, 수정, 완료, 보관, 휴지통, 복원, 영구 삭제 요청 |
| 순간 | 빠른 기록, 사용자 메모, 감정 1~5, 중요기억 |
| 사진 | 여러 장 선택, 메타데이터 추출, 방향 정규화, 앱용 파생본, 썸네일, 업로드 |
| 타임라인 | 현지 날짜·시간순 표시, 구간 렌더링 |
| 장소 | 좌표와 장소 후보, 수동 수정, 중복 후보와 병합 |
| 지도 | MapLibre 렌더링, 제공자 추상화, 지도 없는 장소목록 |
| 검색 | 날짜·장소·태그·사용자 문장 기반 구조화 검색 |
| 비용 | 원통화 금액, 분류, 순간·장소 연결, 통화별 합계 |
| 회고 | 구조화된 여행 종료 회고 |
| 오프라인 | 로컬 커밋, 미디어 스테이징, 동기화 큐, 충돌 처리, 재실행 복구 |
| 백업 | 메타데이터 내보내기·복원, Phase 6에서 미디어 포함 전체 아카이브 |
| 보안 | RLS, 비공개 Storage, CSP, 입력검증, 비밀검사, 두 사용자 공격검사 |
| 운영 | 오류코드, 저장공간, 큐 상태, 고아 자원 감사 |

### 4.2 후속 범위

| 영역 | 기능 |
|---|---|
| 동행인 고도화 | 연락처를 읽지 않는 별칭 중심 관리 |
| 통계 | 국가, 도시, 방문 횟수, 사진, 비용 |
| 의미 검색 | 임베딩 또는 로컬 검색 기반 자연어 검색 |
| OCR | 영수증과 간판 문자 추출 |
| 비용 추출 | 금액·통화·상호 후보 |
| AI | 하루·여행 요약, 태그, 사진 설명 |
| 로컬 LLM | Ollama 또는 동등 로컬 모델 |
| 제한 공유 | 만료 링크, 위치·EXIF 제거, 별도 위협모델 |
| 원본 보관 | 별도 private bucket, TUS 재개 업로드, 비용·복원 검증 |
| 영상 | 압축, 대표 화면, 재생과 대용량 재개 업로드 |
| 백업 암호화 | 검토된 포맷과 키 유도 규칙을 갖춘 전체 아카이브 암호화 |

### 4.3 명시적 제외

```text
- 공개 소셜 피드
- 팔로우, 좋아요, 댓글
- 여행상품 예약
- 항공권·숙박 결제
- 지속적인 GPS 추적
- 사용자 몰래 위치 수집
- MVP에서 원본 사진 전체 기본 클라우드 백업
- 자동 공개 여행기
- 경쟁형 점수와 과도한 배지
- 사용자 확인 없는 AI 기록 수정
- 기본 활성화된 제3자 행동분석
- 다기기 실시간 공동편집
```

---

## 5. 배포 구조와 실행환경

### 5.1 운영판

운영판은 여러 파일로 구성된 HTTPS PWA다.

```text
index.html
assets/
manifest.webmanifest
service worker
```

PWA 설치에는 HTTPS 또는 로컬 개발 환경이 필요하다. `file://`로 연 단일 파일은 설치형 PWA와 동등하지 않다.

| 운영 호스트 요구 | 기준 |
|---|---|
| 전송 | HTTPS |
| 보안 헤더 | CSP, HSTS, Referrer-Policy, Permissions-Policy, X-Content-Type-Options 설정 가능 |
| 정적 자원 | 해시 기반 장기 캐시와 새 버전 무효화 |
| 라우팅 | 정적 호스트에서도 재접속 가능한 경로 |
| 배포 | 원자적 배포 또는 즉시 rollback |
| 로그 | URL query, Signed URL과 위치가 로그에 남지 않도록 통제 |

GitHub Pages는 정적 보조 배포 또는 검증 환경으로 사용할 수 있다. 운영 호스트는 보안 헤더, 롤백과 로그 정책을 기준으로 별도 ADR에서 결정한다.

MVP 라우터는 정적 호스팅 호환성과 오프라인 재접속을 위해 hash route를 기본 후보로 한다. 다른 방식을 선택하면 404 fallback과 PWA navigation fallback 검사를 추가한다.

### 5.2 단일 HTML 보조판

| 기능 | 운영 PWA | 단일 HTML 보조판 |
|---|---:|---:|
| 설치형 PWA | 지원 | 보장하지 않음 |
| Service Worker | 지원 | `file://`에서 보장하지 않음 |
| Background Sync | 선택적 보조 | 미지원 |
| 대용량 오프라인 큐 | 지원 | 제한 |
| 지도 | 지원 | 외부 자원과 CORS에 따라 제한 |
| Supabase 로그인 | 지원 | 기본 비활성 또는 제한 |
| 로컬 아카이브 열람 | 지원 | 핵심 목적 |
| JSON·CSV·GeoJSON 확인 | 지원 | 지원 |
| 전체 기능 회귀동등성 | 필수 | 요구하지 않음 |

단일 HTML판은 별도 산출물과 별도 테스트 세트를 가진다. 운영 PWA의 완료조건을 단일 HTML판에 억지로 맞추지 않는다.

### 5.3 브라우저 지원

Phase 0에서 `docs/BROWSER_SUPPORT.md`를 만든다. 최소 검증군은 현재와 직전 주요 버전의 Android Chrome, iOS Safari, 데스크톱 Chrome·Edge·Firefox·Safari다. 기능은 UA 문자열이 아니라 capability detection으로 선택한다.

```text
- OffscreenCanvas 미지원 시 메인 스레드 Canvas 대체
- OPFS 미지원 시 IndexedDB Blob 대체
- Background Sync 미지원 시 포그라운드 큐
- WebP 인코딩 미지원 시 MIME 검증 후 JPEG 또는 PNG
- HEIC 디코딩 미지원 시 지연 모듈 또는 명시적 실패
```

---

## 6. 권장 기술 구성

| 영역 | 선택 |
|---|---|
| 언어 | TypeScript strict |
| UI | Vanilla TypeScript 컴포넌트 |
| 빌드 | Vite |
| 서버 | Supabase |
| 인증 | Supabase Auth |
| 데이터베이스 | Supabase PostgreSQL |
| 파일 | Supabase Storage private bucket |
| 로컬 메타데이터 | Dexie 기반 IndexedDB |
| 로컬 미디어 | OPFS 우선, IndexedDB Blob 대체 |
| 지도 렌더링 | MapLibre GL JS |
| 지도 데이터 | 교체 가능한 style·tile provider |
| 장소검색 | 교체 가능한 geocoder·reverse geocoder |
| 위치 교환 | GeoJSON |
| 사진 처리 | Web Worker＋OffscreenCanvas, Canvas 대체 |
| 단위검사 | Vitest 또는 동등 도구 |
| 브라우저검사 | Playwright 또는 동등 도구 |
| DB·RLS 검사 | Supabase local stack＋pgTAP＋두 사용자 API 검사 |
| 정적 배포 | 보안 헤더와 rollback 가능한 호스팅 |
| CI | GitHub Actions |
| 협업 | task별 branch＋Git worktree |

MapLibre는 벡터 타일을 브라우저에서 렌더링하는 TypeScript/WebGL 라이브러리다. 타일, style과 지오코딩 서비스는 별도다.

Vite의 `VITE_` 접두 환경변수는 클라이언트 번들에 노출된다. 따라서 Supabase URL과 publishable key처럼 공개 가능한 값 외의 비밀값에 이 접두사를 사용하지 않는다.

프레임워크 추가는 실제 측정으로 Vanilla 구조가 유지 불가능하다고 확인되고 ADR, 마이그레이션 비용, 번들 영향과 회귀계획이 승인된 경우에만 허용한다.

---

## 7. 애플리케이션 계층과 의존성

```text
UI
→ Application Use Cases
→ Domain
→ Repository Interfaces
→ Local Adapter / Supabase Adapter / Map Adapter
```

| 계층 | 책임 |
|---|---|
| UI | DOM, 접근성, 사용자 상태 표현 |
| Application | 여행 생성, 순간 저장, 동기화 요청, 삭제 요청 같은 유스케이스 |
| Domain | 불변조건, 상태전이, 충돌정책, 비용 규칙 |
| Repository | 저장소 독립 인터페이스 |
| Local Adapter | Dexie, OPFS, Cache Storage |
| Remote Adapter | Supabase Auth, Database, Storage, Edge Function |
| Worker | EXIF, 해시, 디코딩, 변환, 썸네일 |
| Security Boundary | 입력검증, URL 허용목록, 로그 정제, 개인정보 정책 |

UI에서 Supabase SDK, Dexie 또는 OPFS를 직접 호출하지 않는다. DB Row, Local Row, Domain Model과 ViewModel을 분리한다.

서버는 동기화된 데이터의 정본이고 로컬 DB는 오프라인 작업과 화면의 즉시 정본이다. 양쪽 중 하나를 단순 캐시로 취급하지 않는다.

---

## 8. 화면 정보구조

### 8.1 최상위 화면

| 화면 | 목적 |
|---|---|
| 여행목록 | 예정·진행·완료·보관·휴지통 |
| 여행상세 | 여행 개요와 주요 상태 |
| 타임라인 | 날짜와 시간순 순간 |
| 지도 | 장소 분포와 기록 순서 |
| 빠른 기록 | 최소입력 |
| 검색 | 날짜·장소·태그·문장 검색 |
| 동기화 센터 | 로컬·업로드·충돌·실패 상태 |
| 설정·백업 | 개인정보, 저장공간, 내보내기, 로컬 정리 |

여행상세 탭은 다음과 같다.

```text
개요 | 타임라인 | 지도 | 사진 | 비용 | 회고
```

### 8.2 빠른 기록

| 항목 | 처리 | 기본 노출 |
|---|---|---|
| 사진 | 촬영 또는 선택 | 노출 |
| 한 줄 기록 | 문자, OS 받아쓰기 또는 오디오 메모 | 노출 |
| 장소 | EXIF·현재 위치·검색 후보, 수정 가능 | 축약 |
| 감정 | 1~5 | 선택 |
| 비용 | 원통화 금액, 통화, 분류 | 선택 |
| 중요기억 | 켜기·끄기 | 선택 |
| 촬영시각 | 원시값과 추정 신뢰도 | 숨김 |
| GPS | EXIF 또는 명시적 현재 위치 | 숨김 |
| 태그 | 수동, AI 추천은 후속 | 숨김 |
| 저장상태 | 메타데이터와 미디어를 분리 표시 | 항상 |

```text
기록 저장됨
사진 로컬 보관 중 2/5
사진 업로드 대기 3
동기화 충돌 1
저장공간 부족으로 미수용 2
```

### 8.3 회고

| 필드 | 질문 |
|---|---|
| best_moment | 가장 좋았던 순간은 무엇인가 |
| unexpected | 예상과 가장 달랐던 것은 무엇인가 |
| meaningful_person | 기억에 남는 사람이나 대화는 무엇인가 |
| learning | 새로 배운 점은 무엇인가 |
| revisit | 다시 가고 싶은 장소와 이유는 무엇인가 |
| next_improvement | 다음 여행에서는 무엇을 바꿀 것인가 |
| one_sentence | 이번 여행을 한 문장으로 표현하면 무엇인가 |

---
## 9. 핵심 사용자 흐름

### 9.1 여행 생성

```text
여행 만들기
→ 제목·기간 입력
→ 선택적으로 대표 국가·도시·예산
→ Dexie에 여행과 insert operation을 같은 트랜잭션으로 기록
→ 로컬 커밋 확인
→ 여행상세 진입
→ 서버 가능 시 멱등 동기화
```

### 9.2 순간과 사진 기록

```text
사진 선택 또는 기록 시작
→ 파일 수·원본 크기·예상 로컬 용량 검사
→ 순간 메타데이터 로컬 저장
→ 각 사진을 selected_non_durable로 등록
→ EXIF와 원본 규격 읽기
→ OPFS 또는 IndexedDB에 내구성 스테이징
→ staged 표시
→ 제한된 동시성으로 디코딩·방향정규화·압축·썸네일
→ 파생본 MIME·크기·해시 검증
→ derived_ready
→ pending DB 행 동기화
→ 불변 Storage 경로 업로드
→ 원격 존재·크기 확인
→ media_assets를 verified로 전환
→ 로컬 임시 원본은 보존정책에 따라 정리
```

앱이 닫히기 전까지 브라우저가 들고 있는 원본 `File` 참조만 있는 항목은 내구성 저장이 아니다. 이 상태를 저장 완료로 표시하지 않는다.

### 9.3 여행 종료

```text
여행 완료 요청
→ 미동기화·충돌·누락 항목 표시
→ 대표사진 선택
→ 회고 질문
→ 메타데이터 백업 권장
→ 완료 상태 로컬 커밋
→ 서버 동기화
```

AI 요약은 MVP 완료 후 별도 동의로 생성한다.

### 9.4 삭제

```text
휴지통으로 이동
→ deleted_at 기록
→ 동기화
→ 복원 가능 상태 유지
→ 사용자가 별도로 영구 삭제 확인
→ deletion_job 생성
→ Storage 삭제
→ 결과 확인
→ 관계 데이터 정리
→ 최종 완료
```

---

## 10. 데이터 모델 공통규칙

### 10.1 공통 열

`profiles`와 운영 원장처럼 성격이 다른 테이블을 제외한 모든 사용자 소유 가변 테이블은 다음 공통 열을 원칙으로 한다.

| 필드 | 형식 | 규칙 |
|---|---|---|
| id | uuid | 오프라인 생성을 위해 클라이언트 생성 허용 |
| user_id | uuid | `auth.users.id`, not null |
| created_at | timestamptz | 서버 기본값, 클라이언트 임의 변경 금지 |
| updated_at | timestamptz | 서버 트리거 관리 |
| version | bigint | 1부터 시작, 서버에서 증가 |
| deleted_at | timestamptz | tombstone, nullable |
| updated_by_device_id | uuid | 동기화 메타데이터, 인증수단 아님 |
| last_operation_id | uuid | 마지막 성공 클라이언트 operation |

자식 테이블은 단순 `trip_id` FK만 두지 않는다. 가능한 경우 `(trip_id, user_id)`가 부모 `(id, user_id)`를 참조하는 복합 외래키를 사용하여 다른 사용자의 부모 ID를 연결할 수 없게 한다.

### 10.2 서버 관리 열

```text
- 클라이언트는 created_at, updated_at, version을 신뢰원으로 제공하지 않는다.
- UPDATE 트리거는 user_id 변경을 차단하고 updated_at과 version을 설정한다.
- INSERT의 user_id는 RLS WITH CHECK로 auth.uid()와 일치해야 한다.
- 서버 변경은 sync_changes에 동일 트랜잭션으로 기록한다.
```

### 10.3 삭제와 고유성

soft delete가 있는 고유조건은 일반 고유제약이 아니라 부분 고유 인덱스를 사용한다.

```sql
create unique index trip_days_unique_active
on trip_days (trip_id, local_date)
where deleted_at is null;
```

---

## 11. 주요 서버 테이블

### 11.1 profiles

| 필드 | 형식 | 설명 |
|---|---|---|
| id | uuid | `auth.users.id`와 동일 |
| display_name | text | 표시 이름 |
| locale | text | BCP 47 언어 태그 |
| timezone | text | IANA 시간대 |
| settings | jsonb | 버전된 사용자 설정 |
| account_state | text | active, deletion_requested |
| created_at | timestamptz | 생성 |
| updated_at | timestamptz | 수정 |
| version | bigint | 수정 버전 |

### 11.2 user_devices

| 필드 | 형식 | 설명 |
|---|---|---|
| id | uuid | 앱이 생성한 장치 식별자 |
| user_id | uuid | 소유자 |
| label | text | 사용자 지정 장치명 |
| app_instance_id | uuid | 재설치 구분 |
| last_seen_at | timestamptz | 마지막 서버 접촉 |
| revoked_at | timestamptz | 장치 폐기 |
| created_at | timestamptz | 생성 |

장치 ID는 동기화 표식이며 보안 인증요소나 실제 하드웨어 지문으로 사용하지 않는다.

### 11.3 trips

| 필드 | 형식 | 설명 |
|---|---|---|
| id | uuid | 여행 ID |
| user_id | uuid | 소유자 |
| title | text | 여행명 |
| start_date | date | 시작일 |
| end_date | date | 종료일 |
| status | text | planned, active, completed, archived |
| country_codes | text[] | ISO 3166-1 alpha-2 후보 |
| cities | text[] | 표시용 도시 |
| user_summary | text | 사용자 작성 요약 |
| cover_media_id | uuid | nullable, 대표 미디어 |
| budget_amount | numeric(18,4) | 예산 |
| budget_currency | text | ISO 4217 |
| 공통 열 |  |  |

`start_date <= end_date`를 검사한다. `cover_media_id` FK는 media 테이블 생성 뒤 별도 migration으로 추가하고 `ON DELETE SET NULL`을 사용한다. 동일 사용자·동일 여행 미디어인지 서버에서 검증한다.

### 11.4 trip_days

| 필드 | 형식 | 설명 |
|---|---|---|
| id | uuid | 날짜 기록 |
| user_id | uuid | 소유자 |
| trip_id | uuid | 여행 |
| local_date | date | 현지 날짜 |
| representative_timezone | text | 해당 날짜 대표 IANA 시간대, nullable |
| title | text | 하루 제목 |
| user_summary | text | 사용자 원문 |
| 공통 열 |  |  |

AI 요약은 이 테이블에 직접 쓰지 않고 `ai_artifacts`에 저장한다. `(trip_id, local_date) WHERE deleted_at IS NULL`은 고유하다.

### 11.5 moments

| 필드 | 형식 | 설명 |
|---|---|---|
| id | uuid | 순간 |
| user_id | uuid | 소유자 |
| trip_id | uuid | 여행 |
| trip_day_id | uuid | 현지 날짜, nullable |
| place_id | uuid | 대표 장소, nullable |
| occurred_local | timestamp without time zone | 사용자에게 보이는 현지 원시시각 |
| occurred_at | timestamptz | 신뢰 가능한 UTC 환산이 있을 때만 |
| utc_offset_minutes | smallint | 알려진 오프셋 |
| timezone | text | IANA 시간대 후보 |
| time_source | text | manual, exif, file, current_location, inferred |
| time_confidence | text | exact, offset_known, timezone_inferred, local_only |
| title | text | 순간 제목 |
| user_note | text | 사용자 원문 |
| emotion_score | smallint | 1~5 |
| is_highlight | boolean | 대표 기억 |
| source | text | manual, photo_import, location |
| 공통 열 |  |  |

`occurred_at`이 null이어도 `occurred_local`로 기록을 보존할 수 있다. 타임라인 정렬은 확정 UTC와 현지 원시시각을 구분하여 수행한다.

### 11.6 places

| 필드 | 형식 | 설명 |
|---|---|---|
| id | uuid | 장소 |
| user_id | uuid | 소유자 |
| name | text | 사용자 확인 장소명 |
| category | text | 식당, 관광지, 숙소 등 |
| latitude | double precision | nullable, -90~90 |
| longitude | double precision | nullable, -180~180 |
| coordinate_precision | text | exact, approximate, city_only |
| address | text | 주소 |
| city | text | 도시 |
| country_code | text | ISO 코드 |
| external_place_id | text | 제공자별 외부 ID |
| provider | text | geocoder 제공자 |
| source | text | exif, current_location, manual, geocoder |
| confidence | numeric(4,3) | 0~1 |
| merged_into_place_id | uuid | 병합 대상, nullable |
| 공통 열 |  |  |

장소 병합은 원본 행을 즉시 삭제하지 않고 `merged_into_place_id`와 감사기록으로 되돌릴 수 있게 한다.

### 11.7 media_assets

| 필드 | 형식 | 설명 |
|---|---|---|
| id | uuid | 미디어 |
| user_id | uuid | 소유자 |
| trip_id | uuid | 여행 |
| moment_id | uuid | 순간, nullable |
| media_type | text | MVP는 image |
| server_state | text | pending, uploaded, verified, deletion_pending, failed |
| storage_bucket | text | 앱용 버킷 |
| storage_path | text | 앱용 파일 |
| thumbnail_path | text | 썸네일 |
| original_storage_bucket | text | 후속 기능 |
| original_storage_path | text | 후속 기능 |
| original_filename | text | 표시용 원본명 |
| original_mime_type | text | 원본 MIME 후보 |
| original_size | bigint | 원본 크기 |
| original_width | integer | 원본 폭 |
| original_height | integer | 원본 높이 |
| stored_mime_type | text | 실제 검증된 저장 MIME |
| stored_size | bigint | 저장 크기 |
| width | integer | 저장 폭 |
| height | integer | 저장 높이 |
| thumbnail_size | bigint | 썸네일 크기 |
| captured_local | timestamp without time zone | EXIF 원시시각 |
| captured_at | timestamptz | 확정 또는 신뢰 가능한 UTC |
| utc_offset_minutes | smallint | EXIF 또는 사용자 확인 |
| timezone | text | IANA 후보 |
| time_source | text | exif_offset, exif_local, gps_inferred, manual |
| time_confidence | text | exact, offset_known, timezone_inferred, local_only |
| latitude | double precision | EXIF 위도 |
| longitude | double precision | EXIF 경도 |
| orientation_original | smallint | 원본 EXIF 방향 |
| content_hash | text | 원본 전체 콘텐츠 해시 |
| hash_algorithm | text | 예: sha256-v1 |
| derived_hash | text | 파생본 해시 |
| fingerprint | text | 1차 중복 후보 |
| exif_whitelist | jsonb | 허용된 EXIF만 |
| is_original_retained | boolean | 기본 false |
| 공통 열 |  |  |

서버 상태와 클라이언트의 `compressing`, `uploading` 같은 세부 작업상태를 혼합하지 않는다.

### 11.8 expenses

| 필드 | 형식 | 설명 |
|---|---|---|
| id | uuid | 비용 |
| user_id | uuid | 소유자 |
| trip_id | uuid | 여행 |
| moment_id | uuid | 순간, nullable |
| place_id | uuid | 장소, nullable |
| transaction_type | text | expense, refund |
| original_amount | numeric(18,4) | 양수 원금액 |
| original_currency | text | ISO 4217 |
| exchange_rate | numeric(20,10) | nullable |
| base_amount | numeric(18,4) | nullable |
| base_currency | text | nullable |
| rate_date | date | nullable |
| rate_source | text | nullable |
| category | text | 분류 코드 |
| payment_method | text | 결제수단 |
| incurred_local | timestamp without time zone | 현지시각 |
| incurred_at | timestamptz | 확정 UTC, nullable |
| note | text | 사용자 메모 |
| receipt_media_id | uuid | 영수증 사진, nullable |
| 공통 열 |  |  |

원금액은 환율 값으로 덮어쓰지 않는다. 환율이 없어도 저장한다.

### 11.9 companions와 trip_companions

| 테이블 | 핵심 필드 | 규칙 |
|---|---|---|
| companions | id, user_id, name, relationship, note, 공통 열 | 연락처 접근 없이 사용자 입력 별칭 |
| trip_companions | id, user_id, trip_id, companion_id, 공통 열 | 활성 trip_id＋companion_id 고유 |

### 11.10 reflections

| 필드 | 형식 | 설명 |
|---|---|---|
| id | uuid | 회고 |
| user_id | uuid | 소유자 |
| trip_id | uuid | 여행 |
| best_moment | text | 최고의 순간 |
| unexpected | text | 예상 밖의 경험 |
| meaningful_person | text | 사람과 대화 |
| learning | text | 배운 점 |
| revisit | text | 재방문 |
| next_improvement | text | 다음 여행 개선 |
| one_sentence | text | 한 문장 |
| 공통 열 |  |  |

활성 회고는 여행당 하나다. AI 초안은 별도 `ai_artifacts`에 둔다.

### 11.11 tags와 moment_tags

| 테이블 | 핵심 필드 | 규칙 |
|---|---|---|
| tags | id, user_id, name, normalized_name, 공통 열 | 활성 normalized_name 사용자별 고유 |
| moment_tags | id, user_id, moment_id, tag_id, 공통 열 | 활성 조합 고유 |

### 11.12 client_operations

| 필드 | 형식 | 설명 |
|---|---|---|
| operation_id | uuid | 클라이언트 작업 ID |
| user_id | uuid | 사용자 |
| device_id | uuid | 장치 |
| entity_type | text | 대상 |
| entity_id | uuid | 대상 ID |
| operation_type | text | insert, update, delete, finalize_upload |
| base_version | bigint | 클라이언트가 읽은 버전 |
| payload_hash | text | 민감 원문 대신 검증 해시 |
| status | text | processing, applied, conflict, rejected |
| result_version | bigint | 성공 버전 |
| error_code | text | 안정적 오류 코드 |
| created_at | timestamptz | 서버 수신 |
| processed_at | timestamptz | 처리 완료 |

`(user_id, operation_id)`은 고유하다. 재전송 시 기존 결과를 반환한다.

### 11.13 sync_changes

| 필드 | 형식 | 설명 |
|---|---|---|
| sequence | bigint identity | pull cursor에 쓰는 단조 증가 값 |
| user_id | uuid | 소유자 |
| entity_type | text | 대상 |
| entity_id | uuid | 대상 |
| operation_type | text | upsert, delete |
| entity_version | bigint | 결과 버전 |
| operation_id | uuid | 원인 operation |
| changed_at | timestamptz | 서버시각 |

클라이언트는 테이블별 `updated_at` 추측 대신 `sequence > last_cursor`로 페이지를 받는다. tombstone이 필요한 삭제는 원본 행 또는 변경 피드에서 확인 가능해야 한다. MVP에서는 변경 로그를 자동 정리하지 않는다.

### 11.14 sync_conflicts

| 필드 | 형식 | 설명 |
|---|---|---|
| id | uuid | 충돌 |
| user_id | uuid | 소유자 |
| entity_type | text | 대상 |
| entity_id | uuid | 대상 |
| local_operation_id | uuid | 로컬 operation |
| base_version | bigint | 기준 버전 |
| server_version | bigint | 현재 서버 버전 |
| local_candidate | jsonb | 필요한 필드만 |
| server_snapshot | jsonb | 필요한 필드만 |
| status | text | open, resolved_local, resolved_server, merged |
| resolved_at | timestamptz | 해결 |
| created_at | timestamptz | 생성 |

충돌 스냅샷은 해당 사용자만 접근할 수 있으며 로그로 출력하지 않는다.

### 11.15 deletion_jobs

| 필드 | 형식 | 설명 |
|---|---|---|
| id | uuid | 삭제 작업 |
| user_id | uuid | 소유자 |
| entity_type | text | trip, media, account |
| entity_id | uuid | 대상 |
| state | text | requested, enumerating, deleting_storage, verifying, finalizing_db, completed, failed, cancelled |
| storage_manifest | jsonb | 삭제할 버킷·경로와 결과 |
| attempts | integer | 재시도 |
| next_retry_at | timestamptz | 다음 시도 |
| error_code | text | 오류코드 |
| requested_at | timestamptz | 요청 |
| completed_at | timestamptz | 완료 |

### 11.16 ai_artifacts

Phase 7에서만 생성한다.

| 필드 | 형식 | 설명 |
|---|---|---|
| id | uuid | AI 결과 |
| user_id | uuid | 소유자 |
| artifact_type | text | daily_summary, trip_summary, tags, caption, ocr |
| target_type | text | 대상 종류 |
| target_id | uuid | 대상 |
| output_json | jsonb | AI 출력 |
| provider | text | 제공자 |
| model | text | 모델 |
| prompt_version | text | 프롬프트 |
| source_record_ids | uuid[] | 근거 기록 |
| source_snapshot_hash | text | 입력 스냅샷 |
| generated_at | timestamptz | 생성 |
| user_confirmed | boolean | 확인 |
| user_edited | boolean | 수정 |
| deleted_at | timestamptz | 삭제 |

---

## 12. 데이터 제약과 인덱스

필수 제약은 애플리케이션 검증만으로 대체하지 않는다.

| 대상 | 필수 제약 |
|---|---|
| trips | 날짜 순서, status 허용값 |
| moments | emotion_score 1~5, 오프셋 범위, 시간 신뢰도 |
| places | 위도·경도·confidence 범위 |
| media_assets | 양수 크기·규격, 상태 허용값, verified 시 storage_path 필수 |
| expenses | original_amount > 0, 통화 코드 형식, 환율 > 0 |
| 공통 | version >= 1 |
| 관계 | 동일 user_id 복합 FK |
| soft delete | 활성 행 기준 부분 고유 인덱스 |

```text
- 각 사용자 소유 테이블의 user_id
- trips의 user_id, status, start_date
- moments의 trip_id, occurred_at, occurred_local, deleted_at
- media_assets의 trip_id, moment_id, server_state, content_hash
- expenses의 trip_id, incurred_at, original_currency
- sync_changes의 user_id, sequence
- client_operations의 user_id, operation_id
- deletion_jobs의 state, next_retry_at
```

---

## 13. 시간과 시간대 정책

사진 EXIF의 원시 촬영시각에는 UTC 오프셋이 없을 수 있다. 위치만으로 시간대를 추론할 수 있지만 카메라 시계가 현지시각으로 설정되었다는 보장은 없다. 추정값을 확정 사실로 바꾸지 않는다.

```text
- 원시 현지시각을 먼저 보존한다.
- OffsetTimeOriginal 또는 명시적 오프셋이 있으면 captured_at을 계산한다.
- GPS와 장소로 시간대를 추정한 경우 timezone_inferred로 표시한다.
- 파일 수정시각은 촬영시각보다 낮은 우선순위를 갖는다.
- 사용자가 수정하면 manual로 표시하고 원시 EXIF 값은 whitelist에 남긴다.
- 날짜별 그룹은 해당 순간의 현지 날짜를 사용한다.
- UTC 값이 없는 항목도 검색·정렬에서 사라지지 않게 한다.
```

GeoJSON 좌표 순서는 `[longitude, latitude]`다.

```json
{
  "type": "Feature",
  "geometry": {
    "type": "Point",
    "coordinates": [126.5312, 33.4996]
  },
  "properties": {
    "place_id": "uuid",
    "name": "장소명",
    "visited_local": "2026-07-22T14:35:21",
    "timezone": "Asia/Seoul",
    "time_confidence": "offset_known"
  }
}
```

---
## 14. 로컬 저장소

### 14.1 역할 분리

| 저장소 | 저장 내용 |
|---|---|
| Dexie·IndexedDB | 엔터티, 큐, operation 원장, 충돌, 초안, 썸네일 메타데이터 |
| OPFS | 대용량 원본 스테이징, 앱용 파생 Blob, 임시 처리 파일 |
| IndexedDB Blob 대체 | OPFS 미지원 환경의 제한된 미디어 저장 |
| Cache Storage | 버전된 앱 셸과 공개 정적 자원 |
| 메모리 | 짧은 Signed URL, 디코딩 Bitmap, 현재 화면 데이터 |

OPFS도 브라우저 저장 quota를 사용하며 사이트 데이터 삭제 시 제거된다.

### 14.2 Dexie 테이블

```text
app_meta
local_profiles
local_trips
local_trip_days
local_moments
local_places
local_media
local_expenses
local_companions
local_trip_companions
local_reflections
local_tags
local_moment_tags
record_sync_queue
media_jobs
failed_operations
local_conflicts
drafts
cached_thumbnail_index
storage_ledger
sync_cursors
```

모든 로컬 사용자 자료는 `user_id` 또는 사용자별 DB namespace로 분리한다. 로그아웃 후 다른 계정이 이전 사용자 자료를 볼 수 없어야 한다.

### 14.3 로컬 원자성

Dexie 트랜잭션 안에서 임의의 네트워크 요청이나 장시간 외부 비동기 작업을 기다리지 않는다. IndexedDB transaction은 사용되지 않는 event-loop tick에서 자동 커밋될 수 있다.

메타데이터 저장은 하나의 Dexie 트랜잭션으로 엔터티, 로컬 operation과 queue 항목을 함께 쓴다.

OPFS와 IndexedDB 사이에는 원자적 분산 트랜잭션이 없으므로 미디어는 2단계 로컬 커밋을 사용한다.

```text
OPFS pending 경로에 쓰기·닫기
→ Dexie에 blob_ref와 media_job 기록
→ durable 상태 전환
→ 실패 시 pending orphan audit가 정리
```

### 14.4 저장공간 관리

```text
- 앱 시작과 대량 선택 전에 navigator.storage.estimate()를 확인한다.
- 사용 시작 후 적절한 시점에 navigator.storage.persist()를 요청한다.
- 승인 여부를 사용자에게 과장 없이 표시한다.
- 예상 파생본과 임시 원본 공간에 안전 여유를 더한다.
- 부족하면 분할 선택, 동기화 완료 임시파일 정리 또는 미디어 제외 저장을 제안한다.
- 사용자 확인 없이 서버 파일을 정리하지 않는다.
```

---

## 15. 로컬 상태머신

### 15.1 기록 동기화

```text
local_committed
→ queued
→ processing
→ applied
→ synced
```

```text
retryable_failed
permanent_failed
conflict
cancelled
tombstoned
```

### 15.2 미디어 처리

```text
selected_non_durable
→ staging
→ staged
→ metadata_extracted
→ decoding
→ transforming
→ derived_ready
→ remote_row_pending
→ uploading
→ remote_uploaded
→ verifying
→ synced
```

```text
quota_blocked
decode_failed
unsupported
retryable_failed
permanent_failed
cancelled
conflict
```

`selected_non_durable`는 저장 완료가 아니다. `staged`부터 앱 재시작 복구 대상이다.

---

## 16. 동기화 프로토콜

### 16.1 서버 쓰기

모든 앱 쓰기는 `operation_id`, `entity_id`, `base_version`을 가진다.

```text
클라이언트 operation 생성
→ 로컬 커밋
→ 서버 apply_client_operation 호출
→ 이미 처리된 operation이면 저장된 결과 반환
→ 현재 version과 base_version 비교
→ 일치하면 같은 DB transaction에서 행 갱신, version 증가, client_operations와 sync_changes 기록
→ 불일치하면 conflict 반환
```

`updated_at`만으로 덮어쓰기 순서를 결정하지 않는다.

RPC 또는 서버 함수가 `SECURITY DEFINER`를 필요로 하면 non-exposed private schema, 고정 `search_path`, 명시적 `auth.uid()` 검증, 최소 권한과 별도 보안검사를 적용한다. 가능하면 RLS가 작동하는 security invoker 경로를 우선한다.

### 16.2 서버 pull

```text
마지막 sync cursor 읽기
→ sync_changes에서 sequence 이후 페이지 조회
→ 각 변경 엔터티 fetch 또는 tombstone 적용
→ 로컬 transaction 커밋
→ 성공한 마지막 sequence를 cursor로 저장
```

커서가 서버 보존범위보다 오래되면 전체 재동기화를 수행한다. MVP에서는 변경 피드를 임의로 정리하지 않는다.

### 16.3 연결 감지

`navigator.onLine`은 UI 힌트로만 사용한다. LAN 연결만 있어도 true일 수 있으므로 서버 접근을 보장하지 않는다.

실제 동기화 전에는 짧은 timeout을 가진 Supabase probe를 수행한다. 저장 버튼은 온라인 여부 때문에 비활성화하지 않는다.

### 16.4 Background Sync

Background Sync는 제한된 브라우저에서만 제공되므로 선택적 보조수단이다.

```text
앱 실행
→ 포그라운드 큐 검사
→ 실제 서버 연결 성공
→ online 이벤트 후 검사
→ 사용자 수동 동기화
→ 지원 환경에서 Background Sync
```

### 16.5 재시도

| 시도 | 기준 대기 |
|---:|---:|
| 1 | 5초 |
| 2 | 15초 |
| 3 | 60초 |
| 4 | 5분 |
| 5 이상 | 최대 15분 cap, 사용자 주의 표시 |

각 대기에는 jitter를 적용하고 서버의 `Retry-After`를 우선한다.

| 오류 | 처리 |
|---|---|
| 네트워크, 408, 429, 5xx | 재시도 |
| 401 | 세션 갱신 1회 후 재시도 |
| 403 | 권한 오류, 자동 반복 금지 |
| 409 | 충돌 흐름 |
| 413 | 영구 실패 또는 재압축 |
| 400, 검증 실패 | 영구 실패, 사용자 수정 |
| 취소 | 재시도 금지 |

### 16.6 충돌

| 데이터 | 정책 |
|---|---|
| 사진 바이트 | 불변 객체, 동일 해시 재사용 제안 |
| 사용자 메모 | 양쪽 값을 보존한 병합 화면 |
| 비용 | version 비교 후 필드별 사용자 선택 |
| 감정·중요기억 | 마지막 명시적 사용자 선택을 제안하되 자동 확정하지 않음 |
| 장소 | 이름과 좌표를 분리 비교 |
| 삭제 | tombstone 우선, 복원은 새 명시적 operation |
| AI 결과 | 재생성 가능, 사용자 원문보다 우선하지 않음 |

---

## 17. 사진 처리 설계

### 17.1 MVP 저장정책

| 산출물 | Supabase | 로컬 |
|---|---:|---:|
| 앱용 파생 이미지 | 저장 | 동기화 완료와 보존정책까지 |
| 썸네일 | 저장 | 제한 캐시 |
| 원본 | 기본 저장 안 함 | 처리에 필요한 기간만 |
| EXIF 원문 전체 | 저장 안 함 | 저장 안 함 |
| 허용된 EXIF 필드 | DB | DB |

후속 저장 모드는 다음과 같이 정의하되 MVP에서는 기능 플래그를 끈다.

| 모드 | 앱용 | 썸네일 | 원본 |
|---|---:|---:|---:|
| 절약 | 저장 | 저장 | 저장 안 함 |
| 균형 | 저장 | 저장 | 선택 항목만 |
| 원본보관 | 저장 | 저장 | 전체 |

원본보관 활성화에는 별도 private bucket, TUS 재개 업로드, 비용 한도, 전체 백업·복원 검사가 필요하다.

### 17.2 기본 파생 기준

| 항목 | 기본값 |
|---|---|
| 긴 변 | 최대 2560px |
| 우선 형식 | WebP |
| 품질 | 0.82 |
| 목표 크기 | 참고 0.5~1.5MB, 보장값 아님 |
| 썸네일 긴 변 | 640px |
| 썸네일 품질 | 0.70 |
| 디코딩·변환 동시성 | 모바일 기본 1 |
| 업로드 동시성 | 모바일 기본 2 |
| 작은 사진 | 확대 금지 |

품질과 크기는 이미지 내용에 따라 달라지므로 목표 범위만으로 성공·실패를 판정하지 않는다.

### 17.3 입력검사

```text
- 빈 파일 차단
- 파일명 확장자만 신뢰하지 않음
- MIME 후보와 magic bytes 확인
- 실제 디코딩 가능 여부 확인
- SVG를 사진 입력으로 허용하지 않음
- 원본 파일크기, 픽셀 수와 한 변 길이 상한 확인
- 압축폭탄·비정상 규격·손상 이미지 차단
- 로컬 저장 예상량과 여유 확인
- AbortSignal 지원
```

입력 상한은 Phase 0 성능시험으로 확정한다. 50MB 이상 파일 테스트는 “반드시 성공”이 아니라 안전한 처리 또는 명시적 거부를 검증한다.

### 17.4 처리 순서

```text
파일 선택
→ 기본 검증
→ 저장공간 사전점검
→ EXIF·원본 규격 읽기
→ 원시시각·GPS·방향 whitelist
→ 1차 fingerprint
→ 중복 후보
→ 내구성 스테이징
→ worker 디코딩
→ 방향 정규화
→ 크기 축소
→ WebP 인코딩 요청
→ 결과 Blob MIME·magic bytes 검사
→ 불일치 시 JPEG 또는 투명도 보존 PNG
→ 썸네일 생성과 동일 검증
→ 전체 콘텐츠 해시
→ 파생본·메타데이터 로컬 저장
→ 업로드 큐
```

### 17.5 방향 정책

`createImageBitmap()`은 기본적으로 EXIF 방향을 적용할 수 있으므로 수동 회전을 중복 적용하지 않는다.

구현은 한 전략을 선택하고 fixture로 검증한다.

```text
전략 A
createImageBitmap(..., imageOrientation: "none")
→ EXIF orientation을 앱이 한 번만 적용

전략 B
브라우저의 from-image를 사용
→ 앱 수동 회전 금지
```

브라우저 capability test 결과에 따라 전략을 선택하고 `orientation_strategy`를 진단 메타데이터에 기록한다.

### 17.6 형식 대체

Canvas 인코더는 요청 형식을 지원하지 않으면 PNG를 반환할 수 있으므로 `blob.type`과 바이트 서명을 확인한다.

```text
WebP 성공
→ image/webp 저장

WebP 미지원, 불투명 이미지
→ image/jpeg 품질 0.82

WebP 미지원, 알파 필요
→ image/png

HEIC 직접 디코딩 불가
→ 검토된 지연 로딩 변환 모듈
→ 라이선스·WASM 크기·메모리 검사
→ 실패 시 원본을 변경하지 않고 미첨부 상태 안내
```

### 17.7 EXIF

압축 전에 다음만 추출한다.

```text
- captured_local
- OffsetTimeOriginal 또는 동등 오프셋
- latitude
- longitude
- orientation
- original_width
- original_height
- camera_make
- camera_model
- original_filename
```

MakerNote, 얼굴영역, 기기 일련번호와 불필요한 전체 EXIF는 기본 저장하지 않는다. 공유용 파생 파일에는 GPS와 불필요한 EXIF를 넣지 않는다.

### 17.8 중복검사

```text
1차 후보
파일크기＋원시 촬영시각＋폭＋높이

2차 확정
원본 전체 콘텐츠의 강한 해시와 hash_algorithm/version
```

부분 해시나 빠른 fingerprint만으로 완전 중복을 확정하지 않는다. 동일 해시여도 기존 자산을 다른 Moment에 연결하는 것은 허용한다.

### 17.9 메모리

```text
- 한 번에 하나의 큰 이미지만 디코딩·변환
- ImageBitmap.close()
- URL.revokeObjectURL()
- Canvas 폭과 높이를 최소화
- context와 Blob 참조 해제
- worker 메시지에서 불필요한 복사 방지
- 완료된 임시 원본은 서버 검증과 보존 유예 후 정리
- 처리 사이에 UI 제어권 반환
```

500장 시험은 큐 크기, 수용 항목 수, 저장공간 거부, 재시작 복구와 메모리 상한을 함께 검증한다.

---

## 18. Supabase Storage

### 18.1 버킷

| 버킷 | 단계 | 허용 내용 |
|---|---|---|
| travel-media-private | MVP | 앱용 이미지와 썸네일 |
| travel-originals-private | 후속 | 사용자가 명시적으로 보관한 원본 |
| travel-av-private | 후속 | 영상과 오디오 |

모든 버킷은 private다. 버킷별 MIME과 크기 제한을 설정한다.

### 18.2 경로

```text
travel-media-private/
  {user_id}/
    {trip_id}/
      photos/
        {media_id}.{verified_extension}
      thumbnails/
        {media_id}.{verified_extension}
```

후속 원본은 별도 버킷을 사용한다.

```text
travel-originals-private/
  {user_id}/
    {trip_id}/
      originals/
        {media_id}.{verified_extension}
```

경로에 사용자 이름, 원본 파일명, 장소명, 날짜 또는 메모를 넣지 않는다.

### 18.3 불변 객체

```text
- 업로드는 upsert: false
- 동일 path가 이미 있으면 멱등 검증 후 재사용 또는 오류
- 내용 교체는 새 media_id와 새 path
- 앱은 일반 UPDATE·MOVE 권한을 요구하지 않음
- 삭제는 별도 영구 삭제 작업에서만 수행
```

작은 앱용 파생본은 standard upload를 사용한다. 6MB를 넘거나 네트워크 안정성이 중요한 원본·영상은 TUS resumable upload를 사용한다.

### 18.4 업로드 순서

```text
media_assets pending 행 생성
→ 고유 불변 경로 확정
→ Storage upload
→ 업로드 응답과 객체 메타데이터 확인
→ 필요한 경우 인증된 짧은 접근검사
→ media_assets uploaded
→ DB와 객체 크기·MIME 일치 확인
→ verified
```

파일 업로드만 성공하고 DB 완료가 실패하면 pending 행과 동일 operation으로 재개한다. DB pending 생성이 실패하면 업로드하지 않는다.

### 18.5 Storage RLS

각 정책은 `TO authenticated`, `bucket_id`와 첫 경로 구간을 확인한다.

```text
SELECT
bucket_id = 지정 버킷
AND 첫 경로 구간 = auth.uid()::text

INSERT
bucket_id = 지정 버킷
AND 첫 경로 구간 = auth.uid()::text
AND 허용된 경로 구조

DELETE
영구 삭제 유스케이스 또는 서버 작업만
AND 소유 경로
```

클라이언트 UPDATE 정책은 기본 생성하지 않는다.

### 18.6 Signed URL

```text
- 화면에 필요한 항목에만 짧게 발급
- 기본 만료는 수분 단위
- 메모리에만 보관
- 로그·DB·영구 캐시에 저장하지 않음
- 만료 후 재발급
- 개별 URL의 즉시 취소에 의존하지 않음
```

---

## 19. 인증과 데이터베이스 보안

### 19.1 계정 기본값

이 앱은 개인용이므로 공개 회원가입을 기본 비활성화한다. 초기 운영은 초대 또는 관리자 생성 계정으로 제한한다. 공개 가입을 켜려면 abuse, 이메일 확인, rate limit, 계정 삭제와 개인정보 고지를 별도 검토한다.

프론트엔드에 허용되는 값은 다음뿐이다.

```text
- Supabase URL
- Supabase publishable key
- legacy 호환이 필요한 경우 anon key
- 공개 지도 style 또는 공개 식별자
```

금지 값은 다음과 같다.

```text
- Supabase secret key
- legacy service_role key
- 데이터베이스 비밀번호
- 관리자 JWT
- 비공개 지도·AI·지오코딩 API 키
```

### 19.2 공통 RLS

정책은 operation별로 분리하고 `TO authenticated`를 명시한다.

```sql
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id)
```

| operation | 정책 |
|---|---|
| SELECT | `USING` 소유권 |
| INSERT | `WITH CHECK` 소유권 |
| UPDATE | `USING` 기존 소유권＋`WITH CHECK` 새 소유권 |
| DELETE | 앱 직접 hard delete 금지, 필요한 테이블만 제한 |
| 관계형 테이블 | user_id와 복합 FK로 부모 소유권까지 보장 |

### 19.3 RLS 완료조건

RLS SQL 파일을 읽는 정적 검사만으로 통과 처리하지 않는다.

```text
- Supabase local stack 초기화
- migration을 빈 DB에 적용
- 모든 노출 사용자 테이블 RLS 활성 확인
- pgTAP으로 정책·제약·함수 검사
- 익명 클라이언트
- 사용자 A
- 사용자 B
- 위조 user_id
- 다른 사용자의 부모 ID
- Storage 경로 조작
- UPDATE 후 user_id 변경
- soft-deleted 행
- view와 RPC 권한
- Security Advisor와 Performance Advisor 검토
```

view를 만들면 Postgres 버전과 `security_invoker` 설정을 확인하여 RLS 우회를 막는다.

### 19.4 보안 헤더와 프론트엔드

| 항목 | 기준 |
|---|---|
| CSP | `script-src 'self'`, inline script 금지, 필요한 connect·worker·img 출처만 허용 |
| framing | `frame-ancestors 'none'` |
| object | `object-src 'none'` |
| base | `base-uri 'none'` |
| referrer | 좌표·경로가 외부로 전달되지 않도록 엄격 설정 |
| permissions | geolocation·camera는 self와 사용자 동작에만 |
| MIME | `X-Content-Type-Options: nosniff` |
| 외부 스크립트 | 런타임 CDN 로딩 금지, 빌드에 고정 |
| DOM | 사용자 입력을 `innerHTML`에 직접 삽입 금지 |

### 19.5 로컬 계정 경계

```text
- 로컬 행과 OPFS 경로를 user_id로 분리
- 앱 시작 시 현재 세션 사용자와 로컬 namespace 일치 확인
- 로그아웃 즉시 이전 사용자 화면과 메모리 캐시 잠금
- 로컬 미동기화 자료가 있으면 삭제 전 명시적 경고
- 로그아웃＋로컬 데이터 유지와 로그아웃＋이 장치에서 삭제를 구분
- 다른 계정 로그인 후 이전 자료 표시 금지
```

MVP는 종단간 암호화를 약속하지 않는다. 잠금 해제된 기기나 동일 origin XSS에 대한 로컬 데이터 보호 한계를 `docs/PRIVACY.md`에 명시한다.

### 19.6 로그

```text
사용자 메시지
사진 업로드에 실패했습니다. 연결을 확인한 뒤 다시 시도하세요.

개발자 진단
MEDIA_UPLOAD_NETWORK_TIMEOUT
operation_id
단계
재시도 횟수
민감하지 않은 크기 범주
```

토큰, 세션, Signed URL, 원문 파일명, GPS, 사용자 메모, 동행인 이름과 사진 바이트는 기록하지 않는다.

---
## 20. 삭제와 계정 종료

### 20.1 휴지통

MVP에서 일반 삭제는 `deleted_at`을 설정하는 휴지통 이동이다. Storage 객체는 즉시 제거하지 않는다. 사용자가 복원 operation을 만들 수 있다.

### 20.2 영구 삭제

사용자의 별도 확인 후 `deletion_jobs`를 생성한다.

```text
삭제 대상 DB 행과 Storage 경로 열거
→ manifest 고정
→ Storage 삭제
→ 항목별 결과 기록
→ 남은 객체 재검사
→ 관계 행 hard delete 또는 최종 tombstone
→ sync_changes 기록
→ 완료
```

일부 Storage 삭제가 실패하면 DB 식별정보를 먼저 완전히 제거하지 않는다. 삭제 재시도는 동일 deletion job으로 수행한다.

### 20.3 계정 삭제

```text
계정 삭제 요청
→ 미동기화 로컬 자료 경고
→ 전체 export 선택 제공
→ 모든 여행과 Storage manifest 생성
→ Storage 삭제·검증
→ DB 사용자 자료 정리
→ auth 계정 삭제를 마지막에 수행
```

---

## 21. 지도와 위치

MapLibre는 지도 렌더러다. style·tile provider, geocoder와 reverse geocoder는 별도 adapter다.

```text
MapRenderer
MapStyleProvider
TileProvider
Geocoder
ReverseGeocoder
TimezoneResolver
```

| 개인정보 원칙 | 기준 |
|---|---|
| 위치 요청 | 기록 동작 시에만 |
| 지속 추적 | 금지 |
| EXIF 위치 | 수정·삭제 가능 |
| 외부 역지오코딩 | 좌표 전송 전 고지와 설정 |
| 대략적 위치 | exact를 approximate 또는 city_only로 낮출 수 있음 |
| 공유 | 기본 위치 제외 |
| 지도 없음 | 장소목록과 수동 입력 가능 |
| 이동 흐름 | 기록된 순간 순서를 연결한 시각화이며 실제 GPS 경로로 표시하지 않음 |

지도 제공자 키가 비밀이면 프론트엔드에 넣지 않는다. 필요한 요청은 Edge Function 또는 노출 가능한 제한 토큰 구조를 사용한다. 제공자 이용약관, attribution, rate limit과 개인정보 전송을 `docs/MAP_PROVIDERS.md`에 기록한다.

---

## 22. 비용

비용 분류 코드는 다음과 같다.

```text
lodging
transport
meal
cafe
attraction
shopping
communication
insurance
medical
other
```

화면 번역은 코드와 분리한다.

```text
original_amount와 original_currency 저장
→ 환율이 있으면 exchange_rate, rate_date, rate_source 저장
→ base_amount 계산
→ 원금액은 불변
```

환율이 없는 비용도 저장하고 합계는 통화별로 표시한다. 환불은 음수 금액 대신 `transaction_type=refund`로 표현한다.

---

## 23. 백업, 내보내기와 복원

### 23.1 내보내기 종류

| 종류 | 내용 | 미디어 바이트 |
|---|---|---:|
| 메타데이터 JSON | 전체 관계, 버전, schema 정보 | 없음 |
| 비용 CSV | 비용 원통화와 환산값 | 없음 |
| 위치 GeoJSON | 선택한 위치와 시간 신뢰도 | 없음 |
| 전체 아카이브 | manifest＋records＋파생 미디어＋checksum | 포함 |
| 원본 포함 아카이브 | 사용자가 원본보관을 켠 경우 | 선택 |

“JSON 백업”을 사진까지 포함한 완전 백업이라고 부르지 않는다. Supabase의 DB 백업은 Storage 객체 바이트를 포함하지 않는다.

### 23.2 전체 아카이브

```text
manifest.json
records/
  trips.ndjson
  moments.ndjson
  places.ndjson
  expenses.ndjson
  ...
media/
  photos/
  thumbnails/
checksums.json
```

manifest에는 다음을 포함한다.

```text
- archive_format_version
- app_version
- schema_version
- exported_at
- 사용자 locale와 timezone
- 포함 범위
- record count
- media count와 bytes
- checksum algorithm
- 누락 항목
```

대형 아카이브는 메모리에 전체 ZIP을 만들지 않고 스트리밍 또는 분할 볼륨을 사용한다. 브라우저가 스트리밍 파일 저장을 지원하지 않으면 안전한 크기 한도와 분할 다운로드를 제공한다.

### 23.3 복원

```text
파일 구조와 manifest 검사
→ checksum 검사
→ 지원 schema version 확인
→ dry run
→ 중복 ID와 hash 보고
→ 로컬 staging
→ 사용자 확인
→ 멱등 import operations
→ 서버 동기화
→ record·media count와 참조 무결성 검증
```

복원은 기존 자료를 자동 덮어쓰지 않는다. 손상된 백업은 부분 적용 전에 중단하거나 격리된 staging으로 이동한다.

### 23.4 암호화

전체 아카이브에는 GPS, 비용과 동행인 자료가 들어갈 수 있으므로 민감정보 경고를 표시한다. 암호화 백업은 별도 포맷 ADR과 암호학 검토가 완료되기 전까지 자체 암호 알고리즘을 만들지 않는다.

---

## 24. AI 원칙

AI는 기록 생성자가 아니라 정리 보조자다.

허용 범위는 다음과 같다.

```text
- 하루 요약 초안
- 여행 요약 초안
- 사진 설명 초안
- 태그 후보
- 회고 질문 후보
- OCR
- 비용 분류 후보
- 의미 검색
```

금지 범위는 다음과 같다.

```text
- 실제 기록에 없는 사건 추가
- 사용자 원문 덮어쓰기
- 추정 장소를 확정 사실로 표시
- 확인되지 않은 사람 이름 생성
- 비용 임의 수정
- AI 결과를 사용자 작성글처럼 표시
- 사용자 동의 없는 외부 전송
```

AI 실행 전에는 제공자, 전송할 기록 범위, 보존정책과 비용을 표시한다. AI 결과는 `ai_artifacts`에 저장하고 원본 ID와 입력 snapshot hash를 남긴다.

AI 관련 agent와 코드는 Phase 7 전에는 활성화하지 않는다.

---

## 25. 저장소 구조

```text
/
├─ CLAUDE.md
├─ AGENTS.md
├─ README.md
├─ package.json
├─ package-lock.json 또는 선택한 package manager lock
├─ vite.config.ts
├─ tsconfig.json
├─ index.html
├─ public/
│  ├─ manifest.webmanifest
│  └─ icons/
├─ src/
│  ├─ main.ts
│  ├─ app/
│  │  ├─ router.ts
│  │  ├─ state.ts
│  │  └─ events.ts
│  ├─ application/
│  │  ├─ trips/
│  │  ├─ moments/
│  │  ├─ media/
│  │  ├─ sync/
│  │  └─ backup/
│  ├─ domain/
│  │  ├─ trip/
│  │  ├─ moment/
│  │  ├─ place/
│  │  ├─ media/
│  │  ├─ expense/
│  │  ├─ companion/
│  │  └─ reflection/
│  ├─ repositories/
│  ├─ ui/
│  │  ├─ components/
│  │  ├─ screens/
│  │  ├─ dialogs/
│  │  └─ styles/
│  ├─ services/
│  │  ├─ supabase/
│  │  │  └─ generated/database.types.ts
│  │  ├─ storage/
│  │  ├─ maps/
│  │  └─ ai/
│  ├─ offline/
│  │  ├─ db.ts
│  │  ├─ schema.ts
│  │  ├─ opfs.ts
│  │  ├─ queue.ts
│  │  ├─ quota.ts
│  │  └─ conflict.ts
│  ├─ sync/
│  │  ├─ operations.ts
│  │  ├─ pull.ts
│  │  ├─ retry.ts
│  │  └─ connectivity.ts
│  ├─ media/
│  │  ├─ intake.ts
│  │  ├─ exif.ts
│  │  ├─ hash.ts
│  │  ├─ orientation.ts
│  │  ├─ compress.ts
│  │  ├─ thumbnail.ts
│  │  ├─ verify.ts
│  │  └─ media.worker.ts
│  ├─ security/
│  │  ├─ sanitize.ts
│  │  ├─ validation.ts
│  │  ├─ privacy.ts
│  │  └─ logging.ts
│  ├─ export/
│  │  ├─ json.ts
│  │  ├─ csv.ts
│  │  ├─ geojson.ts
│  │  └─ archive.ts
│  ├─ types/
│  └─ utils/
├─ supabase/
│  ├─ migrations/
│  ├─ functions/
│  ├─ seed/
│  └─ tests/
│     ├─ database/
│     └─ rls/
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  ├─ e2e/
│  ├─ security/
│  ├─ performance/
│  └─ fixtures/
├─ docs/
│  ├─ PROJECT_SPEC.md
│  ├─ ARCHITECTURE.md
│  ├─ DATA_MODEL.md
│  ├─ SECURITY.md
│  ├─ PRIVACY.md
│  ├─ THREAT_MODEL.md
│  ├─ SYNC_PROTOCOL.md
│  ├─ MEDIA_PIPELINE.md
│  ├─ BACKUP_FORMAT.md
│  ├─ BROWSER_SUPPORT.md
│  ├─ PERFORMANCE_BUDGET.md
│  ├─ MAP_PROVIDERS.md
│  ├─ AGENT_REGISTRY.md
│  ├─ ACTIVE_TASKS.md
│  ├─ DECISIONS.md
│  ├─ ASSUMPTIONS.md
│  ├─ ROADMAP.md
│  ├─ TEST_PLAN.md
│  ├─ CHANGELOG.md
│  ├─ REPOSITORY_AUDIT.md
│  ├─ CONFLICT_REPORT.md
│  └─ HANDOFF.md
├─ artifacts/
│  └─ agent-reports/
├─ schemas/
│  └─ agent-report.schema.json
├─ .claude/
│  ├─ agents/
│  ├─ commands/
│  ├─ hooks/
│  └─ settings.json
├─ .github/
│  ├─ workflows/
│  ├─ ISSUE_TEMPLATE/
│  └─ pull_request_template.md
└─ scripts/
   ├─ build-single-html.ts
   ├─ validate-rls.ts
   ├─ check-secrets.ts
   ├─ check-client-bundle-secrets.ts
   ├─ validate-agent-reports.ts
   ├─ orphan-audit.ts
   └─ generate-agent-registry.ts
```

기존 저장소 구조와 다르면 무조건 이동시키지 않는다. 먼저 차이와 마이그레이션 비용을 보고한다.

---

## 26. 코드 작성 규칙

```text
- 모든 새 TypeScript는 strict 모드
- any는 예외 근거, 범위와 제거계획 기록
- UI에서 Supabase SDK, Dexie, OPFS 직접 호출 금지
- 화면은 application service 또는 repository interface만 호출
- 도메인 로직과 DOM 조작 분리
- DB Row, Local Row, Domain Model, ViewModel 분리
- Supabase generated TypeScript types를 CI에서 갱신·검증
- 모든 외부 입력은 runtime schema 검증
- 사용자 입력을 innerHTML에 직접 삽입 금지
- 비동기 작업은 AbortSignal과 timeout 고려
- 사진 처리와 해시는 worker 우선
- 모든 서버 쓰기는 operation_id 사용
- Storage 객체는 불변, upsert false
- 날짜는 원시 현지시각과 확정 UTC를 구분
- 파일 삭제와 DB 삭제를 하나의 원자적 성공으로 가정하지 않음
- 로그에 토큰, Signed URL, GPS 원문, 메모 원문 금지
- 오류는 안정적 error code와 사용자 문구 분리
- 적용된 migration 수정 금지
- 런타임 CDN script 금지
- Dexie transaction 안에서 네트워크 또는 장시간 외부 await 금지
- service worker는 private Signed URL 응답을 일반 캐시하지 않음
- Vite build와 별도로 tsc --noEmit을 CI에서 실행
- lockfile 없이 dependency 변경 금지
```

---

## 27. 에이전트 운영 구조

### 27.1 책임 등록부와 실제 실행자의 구분

123개 역할은 누락 방지를 위한 책임 등록부다. 실제 `.claude/agents/`에는 우선 10개 통합 agent만 둔다. 역할별 책임은 `docs/AGENT_REGISTRY.md`에서 통합 agent에 매핑한다.

### 27.2 처음 생성할 10개

| 통합 agent | 핵심 책임 |
|---|---|
| orchestrator | 저장소 조사, 작업분해, 의존성, 범위, 결정·인계 통합 |
| product-ux | 제품목표, 사용자 흐름, 정보구조, 접근성, i18n |
| frontend | UI 계층, 상태, 라우팅, PWA 셸, 브라우저 호환 |
| travel-domain | 여행·순간·장소·비용·회고·검색·내보내기 도메인 |
| media-pipeline | intake, EXIF, 방향, 해시, 압축, 썸네일, 메모리 |
| supabase | DB, migration, Auth, RLS, Storage, Edge Function, 비용 |
| offline-sync | Dexie, OPFS, 큐, 연결, retry, conflict, cursor |
| security-privacy | 위협모델, 비밀, XSS, upload, RLS 침투, 삭제, 개인정보 |
| qa | 단위·통합·E2E·모바일·장애·대량·저메모리·수용검사 |
| reviewer-release | 코드·아키텍처·의존성·빌드·배포·문서·rollback |

AI 역할은 Phase 7에서 `travel-domain`이 제품 의미를, `security-privacy`가 전송·환각을, `supabase` 또는 `frontend`가 실행 adapter를 맡는다. 필요하면 그때 별도 AI 통합 agent 추가 ADR을 작성한다.

### 27.3 agent 출력 계약

각 결과는 채팅 요약뿐 아니라 다음 위치의 JSON 파일로 남긴다.

```text
artifacts/agent-reports/{TASK_ID}-{agent}.json
```

```json
{
  "schema_version": "1.0",
  "agent": "agent-name",
  "task_id": "TASK-0001",
  "status": "completed|partial|blocked|failed",
  "objective": "작업 목적",
  "base_commit": "git sha",
  "branch": "branch name",
  "worktree": "path",
  "assumptions": [],
  "files_read": [],
  "files_changed": [],
  "database_changes": [],
  "storage_changes": [],
  "security_impact": [],
  "privacy_impact": [],
  "implementation_summary": [],
  "tests_added": [],
  "commands_run": [],
  "test_results": [],
  "known_risks": [],
  "rollback_plan": [],
  "unresolved_items": [],
  "recommended_next_agents": []
}
```

`schemas/agent-report.schema.json`과 CI로 검증한다.

### 27.4 작업 소유권

`docs/ACTIVE_TASKS.md`에 task, branch, worktree, 담당 agent, 수정 예상 경로와 상태를 기록한다.

```text
- 한 agent는 한 task_id만 처리
- 다른 활성 task가 소유한 파일 수정 금지
- 요구범위 밖 리팩터링 금지
- DB 변경은 supabase와 security-privacy 검토
- RLS 변경은 security-privacy의 침투검사
- 사진 처리 변경은 media-pipeline과 qa 저메모리검사
- 삭제 변경은 security-privacy와 supabase 검토
- 배포 전 qa 수용검사와 reviewer-release 승인
```

### 27.5 hooks와 CI

| hook | 목적 |
|---|---|
| block-destructive-shell | `rm -rf`, `git clean -fd`, `reset --hard`, force push 등 차단 |
| enforce-task-ownership | ACTIVE_TASKS와 수정 경로 비교 |
| block-client-secrets | 프론트 파일과 dist에 secret/service_role 패턴 차단 |
| protect-applied-migrations | 이미 적용된 migration 수정 차단 |
| post-edit-quality | 변경 TypeScript에 format, lint, typecheck |
| stop-gate | 테스트·보고서·handoff 누락 시 완료 차단 |

운영 강제 hook은 deterministic command hook을 우선한다. CI는 hook을 신뢰하지 않고 같은 규칙을 다시 검사한다.

---

## 28. Claude Code와 Codex 협업

| 역할 | Claude Code | Codex |
|---|---|---|
| 저장소 조사 | 주 담당 | 독립 검토 |
| 구조 설계 | 주 담당 | 적대적 검토 |
| 다파일 기능 | 주 담당 | 좁은 보완 |
| SQL | 초안·적용 | 정합성·경계 검토 |
| RLS | 초안·테스트 | 공격관점 재검토 |
| 사진 | 구현 | 성능·메모리 검토 |
| 오류 | 전체 흐름·재현 | 작은 범위 수정 |
| 테스트 | 기본 세트 | 누락·적대 시나리오 |
| 배포 | 주 담당 | pre-release 검토 |
| 문서 | 주 담당 | 코드와 불일치 검사 |

공통 기준 파일은 다음과 같다.

```text
CLAUDE.md
AGENTS.md
docs/PROJECT_SPEC.md
docs/ARCHITECTURE.md
docs/DATA_MODEL.md
docs/SECURITY.md
docs/PRIVACY.md
docs/SYNC_PROTOCOL.md
docs/MEDIA_PIPELINE.md
docs/DECISIONS.md
docs/HANDOFF.md
docs/ROADMAP.md
docs/ACTIVE_TASKS.md
```

`CLAUDE.md`와 `AGENTS.md`에 전체 기준서를 복제하지 않는다. 두 파일은 읽을 문서 경로, 필수 명령, 절대 금지와 완료 gate만 요약한다.

각 task는 별도 branch와 worktree를 사용한다. worktree가 충돌을 제거해 주는 것은 아니므로 동일 migration, 핵심 media pipeline, sync state machine, 공통 type 또는 동일 RLS policy의 병렬 수정은 금지한다.

---

## 29. Git과 변경관리

### 29.1 branch

```text
feature/TASK-번호-기능명
fix/TASK-번호-오류명
security/TASK-번호-보안항목
test/TASK-번호-검사항목
refactor/TASK-번호-대상
docs/TASK-번호-문서
```

### 29.2 commit

```text
feat: 새로운 기능
fix: 오류 수정
security: 보안 강화
refactor: 동작 변경 없는 구조개선
test: 검사 추가
docs: 문서 변경
build: 빌드 변경
chore: 관리작업
```

```text
feat(media): add durable local staging queue
security(rls): enforce composite owner foreign keys
test(sync): cover idempotent replay after offline restart
```

### 29.3 PR 필수항목

```text
- 작업 목적
- 변경 범위
- 변경 파일
- 화면 변화
- DB와 migration 변화
- Storage 변화
- 개인정보 영향
- 보안 영향
- 호환성과 데이터 migration
- 실행한 검사
- 검사 결과
- 되돌리기 방법
- 미해결 위험
```

### 29.4 완료 정의

```text
설계 확인
→ 구현
→ format·lint·typecheck
→ 단위검사
→ 통합검사
→ DB·RLS 검사
→ 적대검사
→ 회귀검사
→ 문서·handoff
→ 수용검사
→ reviewer-release 승인
```

---

## 30. 필수 검사

### 30.1 사진

```text
- JPEG, PNG, WebP
- HEIC 지원과 미지원 경로
- EXIF 없음
- GPS 없음
- UTC offset 없음
- orientation 1~8 fixture
- 50MB 이상 파일
- 과도한 픽셀 수
- 손상 파일
- 확장자와 MIME 불일치
- SVG 위장
- 동일 사진 두 번
- 사진 100장
- 사진 500장
- 저장공간 충분·부족
- 압축 중 화면 이동
- 압축 중 앱 종료
- 업로드 중 연결 단절
- WebP 요청이 PNG로 반환되는 대체경로
- 앱 재시작 후 staged 항목 복구
```

### 30.2 동기화

```text
- 오프라인 여행 생성
- 오프라인 순간 수정
- 재접속 후 pull과 push
- 같은 operation 재전송
- 응답 유실 후 재전송
- 두 기기의 같은 메모 수정
- 한 기기 삭제, 다른 기기 수정
- 일부 사진만 성공
- pending DB 성공 후 upload 실패
- upload 성공 후 finalize 실패
- 오래된 sync cursor
- 세션 만료
- 429와 Retry-After
- 앱 중복 실행
```

### 30.3 보안

```text
- 비로그인 DB 조회
- 사용자 B가 사용자 A 행 조회
- 다른 user_id INSERT
- 사용자 A trip_id와 사용자 B child 연결
- UPDATE로 user_id 변경
- 다른 사용자 Storage 경로
- bucket_id 조작
- path traversal 형태
- 악성 HTML 메모
- script 장소명
- javascript URL
- 가짜 이미지
- 압축폭탄 후보
- 만료 Signed URL
- dist의 secret 패턴
- 로그의 토큰·좌표·Signed URL
- 삭제 계정의 파일 접근
```

### 30.4 데이터 보존

```text
- 메타데이터 JSON 내보내기
- 일부 여행 내보내기
- GeoJSON
- 비용 CSV
- 전체 아카이브
- 미디어 누락 manifest
- checksum 실패
- 새 기기 복원
- 구버전 backup migration
- 중복 복원
- 중단 후 복원 재개
- 복원 dry run
- Storage와 DB 고아 검사
```

### 30.5 PWA와 배포

```text
- 새 설치
- 오프라인 첫 재실행
- 오래된 service worker 업데이트
- 로컬 DB migration 중 대기열 보존
- 정적 route 직접 진입
- CSP 위반 검사
- 캐시된 이전 bundle rollback
- 단일 HTML 제한기능 표시
```

---

## 31. 성능·저장용량·접근성

### 31.1 성능

| 항목 | 기준 |
|---|---|
| 초기 화면 | Phase 0 기준 기기와 네트워크에서 p75 목표 확정 |
| 로컬 메타데이터 저장 | p95 500ms 목표 |
| 사진 처리 | UI 장시간 정지 없음, worker 우선 |
| 디코딩 동시성 | 모바일 기본 1 |
| 업로드 동시성 | 모바일 기본 2 |
| 타임라인 | 구간 렌더링 또는 가상화 |
| 지도 | marker clustering |
| 요청 | 중복 fetch와 반복 Signed URL 발급 차단 |
| 측정 | Performance Profiler가 전후 수치 기록 |

### 31.2 저장용량 화면

```text
- Supabase 앱용 파일 수와 용량
- 썸네일 용량
- 선택적 원본 용량
- 로컬 staged 용량
- 로컬 derived 용량
- 동기화 대기 용량
- 실패 항목 용량
- 브라우저 estimate와 persistent storage 승인 여부
```

자동 정리는 로컬 검증 완료 임시파일과 만료된 메모리 캐시에 한정한다. 서버 사진은 사용자 확인 없이 삭제하지 않는다.

### 31.3 접근성

```text
- 휴대전화 세로 우선
- 주요 터치영역 44×44 CSS px 목표
- 상태를 색상만으로 표현하지 않음
- 진행률과 오류에 문자 제공
- 키보드 탐색
- 모달 초점 이동·복귀
- 사진 대체설명
- 충분한 명암
- 지도 없는 장소목록
- prefers-reduced-motion 고려
- WCAG 2.2 AA를 설계 목표로 문서화
```

---

## 32. 개발 단계

| 단계 | 범위 | 완료 gate |
|---|---|---|
| Gate 0A | 읽기 중심 저장소 감사와 문서 계획 | REPOSITORY_AUDIT, CONFLICT_REPORT, 예정 파일, 위험 |
| Phase 0B | Vite·TypeScript 기반, 문서, CI, agent, hook | build·typecheck·기본검사 |
| Phase 1 | 인증, 여행, 로컬 DB | 두 사용자 RLS, 오프라인 여행 |
| Phase 2 | 순간, 타임라인, sync cursor | 재시작·충돌·멱등 |
| Phase 3 | 사진 pipeline | EXIF, 방향, 파생본, staged 복구, 대량·저메모리 |
| Phase 4 | 장소와 지도 | 제공자 추상화, 수동 대체, GeoJSON |
| Phase 5 | 비용과 회고 | 원통화, 회고, 완료 |
| Phase 6 | 백업과 안정화 | 전체 archive, 복원, 고아 감사, 보안 |
| Phase 7 | AI 확장 | 별도 branch, 동의, provenance, 환각검사 |

### 32.1 Gate 0A에서 허용되는 변경

```text
- docs 문서 초안
- CLAUDE.md
- AGENTS.md
- docs/AGENT_REGISTRY.md
- .claude/agents의 10개 통합 agent
- agent report schema
```

Gate 0A에서 금지되는 변경은 다음과 같다.

```text
- 제품 기능 구현
- package dependency 설치·교체
- DB migration 적용
- Storage bucket 생성
- 기존 src 대규모 이동
- hook의 차단 모드 활성화
- 배포
```

저장소가 완전히 비어 있더라도 먼저 비어 있다는 사실과 Phase 0B 예정 파일을 보고한다.

---

## 33. Claude Code가 처음 수행할 작업

```text
- git status와 현재 branch 확인
- 저장소 루트와 추적 파일 조사
- package manager, build, TypeScript, test, PWA 상태 확인
- Supabase migration, policy, config와 seed 조사
- 환경변수 이름만 확인하고 실제 secret 값 출력 금지
- 현재 데이터 모델과 공개 API 요약
- 버전 0.2와의 충돌·누락·기존 우수 구현 식별
- docs/REPOSITORY_AUDIT.md 작성
- docs/CONFLICT_REPORT.md 작성
- docs/PROJECT_SPEC.md, ARCHITECTURE.md, DATA_MODEL.md, SECURITY.md, PRIVACY.md, MEDIA_PIPELINE.md, SYNC_PROTOCOL.md 초안
- docs/ASSUMPTIONS.md와 DECISIONS.md seed 작성
- docs/AGENT_REGISTRY.md에 123개 책임 등록
- .claude/agents에 10개 통합 agent 정의
- 반복 강제 규칙을 hook 후보와 CI 규칙으로 분류
- Phase 0B 작업과 변경 예정 파일 제시
- 제품 코드는 아직 구현하지 않음
```

최종 보고서는 다음 순서다.

```text
- 현재 저장소 요약
- 이 기준서와의 충돌
- 생성·수정한 파일
- 실행한 검사와 결과
- 보안·개인정보 영향
- 미해결 가정
- Phase 0B 예정 파일
- 위험과 rollback
- 다음 승인 지점
```

---

## 34. 최종 성공 기준

```text
- 여행 중 기록 흐름이 대표 사용 시나리오에서 10초 이내다.
- 로컬 내구성 커밋 후 앱 재시작과 네트워크 장애로 기록이 사라지지 않는다.
- 브라우저 저장한계는 감추지 않고 수용 상태를 정확히 표시한다.
- 원본 사진은 사용자 기기에서 변경되지 않는다.
- MVP 서버에는 기본적으로 앱용 파생본과 썸네일만 저장한다.
- 사진 수백 장은 제한된 메모리와 저장공간 사전점검으로 관리한다.
- 실패한 operation과 파일만 재시도한다.
- 장소, 사진과 시간은 근거·신뢰도와 함께 연결된다.
- 사용자는 과거 여행을 빠르게 찾고 회고를 남길 수 있다.
- 다른 사용자는 DB와 Storage 자료에 접근할 수 없다.
- 메타데이터 export와 미디어 포함 전체 archive의 차이를 명확히 제공한다.
- 복원은 dry run, checksum, version migration과 무결성 검사를 통과한다.
- Claude Code와 Codex는 저장소 문서, task와 worktree를 공유한다.
- 모든 변경은 검사, agent report와 handoff를 남긴다.
- 저장소 자체가 최종 정보원이며 특정 AI 대화에 종속되지 않는다.
- 외부 서비스와 브라우저가 제공하지 않는 보장을 문구로 약속하지 않는다.
```

---

## 부록 A. 공식 검증 근거

| ID | 공식 문서 | 핵심 확인 |
|---|---|---|
| R1 | MDN Storage quotas and eviction criteria | origin 저장소에는 quota와 eviction이 있음 |
| R2 | MDN StorageManager.persist() | persistent storage 요청은 거부될 수 있음 |
| R3 | MDN Origin private file system | OPFS도 quota 대상이며 사이트 데이터 삭제 시 제거 |
| R4 | MDN Background Synchronization API | 제한적 지원, secure context 필요 |
| R5 | MDN Navigator.onLine | 실제 인터넷·서버 접근을 보장하지 않음 |
| R6 | MDN Making PWAs installable | 설치에는 HTTPS 또는 localhost 필요 |
| R7 | MDN createImageBitmap | EXIF orientation 처리 옵션과 기본 동작 |
| R8 | MDN HTMLCanvasElement.toBlob·OffscreenCanvas.convertToBlob | 요청 형식 미지원 시 PNG 반환 가능 |
| R9 | Supabase Row Level Security | RLS, `TO authenticated`, USING, WITH CHECK와 인덱스 |
| R10 | Supabase Testing Overview | pgTAP으로 구조·RLS·무결성 검사 |
| R11 | Supabase Storage Access Control | `storage.objects`, bucket와 folder 경로 정책 |
| R12 | Supabase private buckets and Signed URLs | private 접근과 제한시간 URL |
| R13 | Supabase Standard Uploads | 6MB 이하 standard upload 권장 |
| R14 | Supabase Resumable Uploads | 대용량·불안정 네트워크 TUS |
| R15 | Supabase Database Backups | DB backup에 Storage 객체 바이트 미포함 |
| R16 | Supabase API keys | publishable은 client, secret/service_role은 server |
| R17 | Vite Env Variables | `VITE_` 변수는 client bundle에 노출 |
| R18 | MapLibre GL JS Introduction and Plugins | 벡터 타일 렌더러이며 geocoder는 별도 plugin·service |
| R19 | Claude Code memory and hooks | CLAUDE.md는 context, hook은 lifecycle enforcement |
| R20 | Claude Code custom subagents | 별도 context·tools·permissions와 `.claude/agents/` |
| R21 | OpenAI Codex AGENTS.md, subagents and worktrees | 저장소 지침, 병렬 역할, 독립 checkout 지원 |
| R22 | Dexie transaction documentation | IndexedDB transaction auto-commit 주의 |

검증 기준일은 2026-07-22다. 외부 API 또는 도구 버전이 바뀌면 각 Phase 시작 전에 공식 문서를 다시 확인한다.

---

## 부록 B. 초기 가정

| ID | 가정 | 영향 | 해제 조건 |
|---|---|---|---|
| A-001 | 초기 운영은 개인 1인 계정 | 공개 signup과 abuse 방어를 MVP에서 제외 | 다사용자 배포 승인 |
| A-002 | MVP는 종단간 암호화를 제공하지 않음 | Supabase와 잠금 해제 기기 경계가 위협모델에 남음 | 별도 암호화 ADR |
| A-003 | 원본 cloud 보관은 MVP 비활성 | Storage 비용과 대용량 upload 단순화 | Phase 6 복원검사 완료 |
| A-004 | hash routing이 기본 후보 | 정적 호스팅과 오프라인 route 단순화 | 호스트가 fallback을 보장 |
| A-005 | 지도·geocoder 제공자는 미정 | adapter와 설정만 먼저 구현 | 이용약관·비용·개인정보 검토 |
| A-006 | 영구 삭제는 자동 실행하지 않음 | Storage 비용은 남지만 복구성 우선 | 사용자 설정형 보존정책 승인 |
| A-007 | 사진 디코딩 동시성은 1 | 처리시간보다 모바일 안정성 우선 | 측정으로 상향 승인 |
| A-008 | 500장 시험은 전량 영구수용이 아니라 무강제종료와 정확한 상태표시를 의미 | quota 부족 시 분할 수용 | 충분한 저장 또는 네이티브 파일 핸들 확보 |
