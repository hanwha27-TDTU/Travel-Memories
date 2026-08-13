---
shape: tree
shape_reason: 공통 코어에서 웹·Android·Windows가 갈라지는 소유권과 단계별 완료 경계를 한눈에 보여야 한다.
---

# Bugeon Journey · Tauri 2 Windows 개념 스키마

> 상태: Phase 2 인증 어댑터 구현. 이 문서는 다른 앱의 착수서를 복사한 것이 아니라 Bugeon Journey 실행 코드와 데이터 계약에 맞춘 Windows 정본이다.

## 1. 목적과 경계

> 축: 실행 표면별 소유권
> 근거: 손목록

Windows판은 새 제품이 아니다. 같은 여행 기록 코어를 Windows 10/11에서 설치형으로 실행하는 세 번째 표면이다.

```text
Vite · TypeScript 공통 코어
├─ Web       → dist/          → GitHub Pages
├─ Android   → 원격 Pages     → Capacitor WebView + 필요한 네이티브 문
└─ Windows   → windows-dist/  → Tauri 2 + WebView2 + 필요한 네이티브 문
```

공통 코어가 소유하는 것:

- Trip → TripDay → Moment → Media / Video / Place / Expense / Companion / Reflection
- Dexie 로컬 커밋과 operation queue
- Supabase LWW·OCC·canonical version·tombstone 동기화
- R2 파생 미디어, 백업·복원, 지도 공급자 판정
- 화면·문장·검증 로직

Windows 셸이 소유하는 것:

- 창과 WebView2 수명주기
- 안정된 로컬 오리진과 최소 capability
- 시스템 브라우저 OAuth 복귀, 외부 링크, 단일 인스턴스
- 필요가 증명된 파일 선택·저장, 설치·업데이트

## 2. 고정 불변식

> 축: 설치 뒤 바꾸면 데이터·권한 경계가 달라지는 값
> 근거: 손목록

| 축 | 결정 | 이유 |
|---|---|---|
| 운영 프런트엔드 | 번들된 `windows-dist/` | 원격 코드에 네이티브 권한을 주지 않고 오프라인 시작을 보장 |
| identifier | `app.bugeon.journey` | Android와 제품 정체성을 맞추되 플랫폼 설치물은 독립 |
| main window label | `main` | capability가 정확히 한 창만 가리키게 함 |
| production origin | `https://tauri.localhost` | secure-context 계열을 유지하며 첫 설치 뒤 변경 금지 |
| 저장소 | Windows WebView2 전용 localStorage·IndexedDB | 브라우저 프로필 직접 복사 금지 |
| 기기 이동 | Supabase canonical sync 또는 공식 백업/복원 | 앱의 검증·복구 경계를 그대로 통과 |
| 권한 | `main` 최소 capability | broad fs·shell·임의 proxy 금지 |
| 설치 | NSIS current-user 우선 | 관리자 권한 없이 설치 가능 |

`useHttpsScheme`나 identifier 변경은 단순 설정 수정이 아니다. 오리진별 IndexedDB·localStorage가 달라지므로 사용자 데이터 마이그레이션과 rollback이 필요한 변경이다.

## 3. 데이터와 동기화

> 축: Windows 기기의 기록 생성·이동·삭제 생명주기
> 근거: 원장 파생

Windows판은 새로운 기기 id를 가진다. 로컬에만 있는 기록은 기존과 같은 원자 커밋 후 일반 동기화로 전파한다. canonical version이 바뀌면 클라우드 최종본을 적용만 하고 다시 병합 업로드하지 않는다. 삭제는 tombstone과 영구삭제 원장을 그대로 따른다.

Chrome·Edge의 프로필 DB 파일을 Tauri 저장소로 복사하지 않는다. 최초 이동은 다음 둘뿐이다.

1. 로그인 → Supabase 최종본 동기화
2. 앱에서 만든 백업 파일 → 무결성 검사 → 복원 → read-back

## 4. 지도와 네트워크

> 축: 국가별 지도 제공자와 외부 오리진
> 근거: 원장 파생

공급자 판정은 기존 정책을 그대로 쓴다.

- 한국 좌표: Kakao Map
- 우즈베키스탄·카자흐스탄·키르기스스탄 좌표: TomTom
- 그 밖 또는 공급자 실패: 기존 MapLibre/OpenStreetMap

Windows 운영 오리진을 쓰려면 외부 대시보드에 다음 값이 필요하다.

- Kakao JavaScript SDK: `https://tauri.localhost`
- TomTom domain whitelist: `tauri.localhost`
- R2 CORS allowed origin: `https://tauri.localhost`

기존 Vite publishable 키는 Windows 빌드에도 쓸 수 있지만 service-role·R2 secret 같은 서버 전용 값은 installer에 넣지 않는다.

## 5. 단계

> 축: 증거가 쌓이는 구현 순서
> 근거: 손목록

### Phase 1 · 골격

- Tauri 2 Rust 셸과 `windows-dist/` 생성
- HTTPS 오리진·identifier·최소 capability 고정
- NSIS 컴파일 가능성 확인
- 웹·Android 경로 무회귀

### Phase 2 · 플랫폼 어댑터와 인증

- 브라우저 / Android / Windows 판정을 한 공용 어댑터에서 제공 — Phase 1에서 기반 완료
- 시스템 브라우저 OAuth — `skipBrowserRedirect`로 URL만 받은 뒤 scoped opener가 정확한 Supabase authorize 주소만 연다
- strict callback — 스킴·host·path·비어 있지 않은 code를 모두 확인한다
- single instance — Windows가 콜백으로 두 번째 프로세스를 띄워도 기존 main 창으로 전달하고 포커스한다
- Android도 같은 변경에서 intent-filter를 `auth-callback` host까지 좁혔다

`single-instance`는 Rust builder에서 `deep-link`보다 먼저 등록한다. 순서가 바뀌면 Windows에서 실행 중인
앱으로 URL이 전달되지 않는다. capability는 `core:default`, `deep-link:default`, 이 프로젝트의 Supabase
`/auth/v1/authorize*` 하나를 여는 scoped opener만 허용한다.

### Phase 3 · 파일과 실동작

- 백업 저장·복원과 파일 선택기의 WebView2 지원 실측
- Clipboard·위치·미디어 API 실측
- 필요한 기능만 scoped native bridge 추가

### Phase 4 · 설치와 배포

- clean install → launch → 기록 저장 → 종료 → 재실행 read-back
- uninstall/reinstall 및 클라우드/백업 복구
- 코드 서명과 updater는 installer 안정화 뒤 별도 릴리스

## 6. rollback

> 축: 플랫폼별 되돌림 단위
> 근거: 손목록

Windows 도입이 실패해도 웹과 Android는 계속 배포할 수 있어야 한다. rollback 단위는 `src-tauri/`, Windows npm script·의존성, Windows 전용 어댑터·게이트·워크플로다. DB migration이나 동기화 프로토콜을 Phase 1에서 바꾸지 않으므로 원격 사용자 기록은 영향받지 않는다.

## 7. 아직 증명하지 못해 보지 못하는 사각지대

> 축: 실제 Windows 실행 없이는 판정할 수 없는 항목
> 근거: 손목록

- WebView2에서 Kakao·TomTom 실제 렌더
- Google 계정 선택부터 실제 세션 생성까지의 전체 OAuth 왕복
- Windows 설치본의 localStorage 재실행 보존은 확인했다. IndexedDB 기록 재실행과 앱 재설치 뒤 보존·복구는 미확인이다.
- 백업 파일 저장·복원과 대용량 메모리
- 마이크·위치·Clipboard 권한
- 서명된 installer와 updater

각 항목은 해당 Phase의 실제 실행 증거가 생기기 전에는 지원 완료로 표시하지 않는다.
