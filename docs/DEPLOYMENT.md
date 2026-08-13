---
shape: prose-debt
---
# DEPLOYMENT · Bugeon Journey

**GitHub Pages 정적 배포가 필수 목표다** (ADR-0010). 모든 설계는 정적 호스팅 제약에 맞춘다.

## 왜 정적으로 가능한가

GitHub Pages는 서버 없이 정적 파일만 제공한다. Bugeon Journey는 서버가 필요 없다 — 백엔드는 **Supabase(BaaS)**가 담당하고, 브라우저가 Supabase를 직접 호출한다. Vite는 정적 파일로 빌드되고, Service Worker·IndexedDB·MapLibre는 모두 브라우저에서 동작한다. 따라서 정적 배포와 완벽히 호환된다.

## 정적 배포 제약 (설계에 못박음)

1. **하위경로(base path).** 프로젝트 사이트는 `https://<user>.github.io/Travel-Memories/` 하위경로로 서빙된다.
   - Vite `base: '/Travel-Memories/'` 설정.
   - 라우터는 이 base를 인식(절대경로 `/` 가정 금지).
   - 모든 정적 자원(아이콘·manifest·타일 스타일)은 base 상대경로.
2. **Service Worker scope.** SW는 `/Travel-Memories/` scope로 등록. `manifest.webmanifest`의 `start_url`·`scope`도 동일.
3. **SPA 폴백.** GitHub Pages는 SPA 404 폴백이 없다 → 해시 라우팅 또는 `404.html`을 `index.html`로 복제하는 우회. (라우팅 방식은 Phase 0에서 확정.)
4. **서버 없음.** 서버측 로직이 필요한 것(Signed URL 발급 등)은 **Supabase Edge Function**으로 옮긴다(GitHub이 아니라 Supabase에서 실행).
5. **비밀 없음.** 번들에는 Supabase URL + anon/publishable 키만. `service_role`·DB 비밀번호·시크릿 절대 금지(SECURITY의 `check-secret-leak` 게이트).
6. **CORS.** Supabase 프로젝트에 Pages 도메인(`https://<user>.github.io`)을 허용 오리진으로 등록.
7. **지도 타일.** 정적 사이트에서 CDN 타일을 부르므로 제공자 약관·사용량 준수, HTTPS 필수. 제공자는 환경변수로 교체 가능(A-006).

## 변경 축적과 배포 파이프라인 (GitHub Actions)

```
작업·축적(Draft): 관련 유닛·개별 게이트·typecheck·필요한 화면 실측
  → 문서 단독 변경과 비긴급 기능은 여기서 기다린다

릴리스 결정(Ready): 버전·CHANGELOG 확정 → 앱 build → harness + live-render
  → 같은 커밋 머지 → main 배포 산출물 build(base·운영 변수 적용)
  → 시크릿 검사 → 아티팩트 업로드 → Pages 배포
```
- **전체 하네스는 릴리스할 때만** 실행한다. 하네스·머지·배포는 한 묶음이며, main 배포에서
  하네스를 다시 반복하지 않는다(`check-ci-policy`가 순서와 중복을 검사).
- **문서 개정만으로 앱 버전·build·harness·merge·deploy를 일으키지 않는다.** 다음 기능 릴리스에
  묶는다. 기능도 기본은 모아서 배포하고, 데이터 유실·보안 노출·핵심 흐름 차단·호환성 파손처럼
  기다리는 비용이 더 큰 경우만 단독 긴급 릴리스한다(헌법 §15).
- **완료 = 병합이 아니라 배포 그린 확인**(AGENTS.md). Actions가 배포 성공을 보고한 뒤에만 완료 처리.
- `check-secret-leak`가 빌드 아티팩트를 스캔해 시크릿 유출 없음을 확인한 뒤 배포.
- 클라이언트 설정(`VITE_SUPABASE_URL`·`VITE_SUPABASE_PUBLISHABLE_KEY`·`VITE_MAP_STYLE_URL`·`VITE_KAKAO_JAVASCRIPT_KEY`)은
  **Repository Variables**로 주입한다(`deploy-pages.yml`의 `env:`, `vars.*` 참조).
  publishable 키는 설계상 공개 값이라 Secrets가 아니라 Variables가 맞다(마스킹 불필요·감사 용이).
  진짜 비밀(secret/service_role/DB 비밀번호)은 Secrets에도 넣지 않는다 — 클라이언트 빌드에 쓸 일이 없어야 정상.
  Variables 미설정 시 빈 값으로 빌드되고 앱은 로컬 전용 모드로 동작한다(null 폴백). `.env.example`로 형태만 문서화.

### `media-sign`이 함께 바뀌는 릴리스 — Edge 선배포 계약

헌법 §18-F에 따라 `supabase/functions/media-sign/**` 또는 동기화 릴리스 계약이 바뀌면 일반
Pages 순서 앞에 다음 의존 간선이 생긴다.

```
소스·schemas/sync-release-contract.json 확정
  → npm run gen:sync-release
  → check-sync-release-contract
  → 구형 앱 하위 호환을 유지한 media-sign 선배포
  → npm run verify:sync-release-live
  → Ready PR Required CI
  → squash merge → Pages 배포 → version.json read-back
```

- `FN_VERSION` 일치만으로는 통과하지 않는다. 운영 `capabilities.sourceSha256`가 계약의
  `sourceSha256`와 정확히 같고, protocol·필수 ops·`secretsOk`도 맞아야 한다.
- Edge 배포 명령 성공만으로 앱 배포를 열지 않는다. `verify:sync-release-live` 종료코드 0이
  운영 실물 증거이며, Ready PR harness와 Pages build가 각각 다시 확인한다.
- 불일치나 조회 불가면 앱 배포를 멈춘다. 운영 앱으로 시험하거나 사용자 데이터를 변경하는
  우회는 금지한다.
- 롤백은 앱을 아직 올리지 않은 상태에서 이전 하위 호환 Edge 소스를 다시 배포하는 것이 기본이다.
  앱 배포까지 끝난 뒤라면 앱·Edge 두 표면의 호환 조합과 각 read-back을 함께 복구한다.
- 정확한 프로젝트 id·배포 명령·영향 조건·read-back 필드는 `schemas/release-profile.json`이
  실행 가능한 정본이다. 이 문서는 순서와 실패 경계만 설명한다.

### 배포 활성화 절차 (1회, 저장소 관리자)

1. **Settings → Pages → Build and deployment → Source = "GitHub Actions"** 로 설정한다. 이 설정 없이는 `deploy-pages.yml`이 실패한다.
2. (Supabase 프로비저닝 후) **Settings → Secrets and variables → Actions → Variables**에 `VITE_SUPABASE_URL`·`VITE_SUPABASE_PUBLISHABLE_KEY` 등록. 그 전까지는 로컬 전용 모드로 배포된다.
3. `deploy-pages.yml`은 **`main` push에만 발동**한다 — 작업 브랜치가 main에 병합되기 전에는 어떤 배포도 일어나지 않으며, "배포 그린"은 병합 후에만 확인할 수 있다. 이 워크플로는 배포 산출물 build·시크릿 검사·업로드만 하고 전체 하네스는 Ready PR에서 이미 끝낸다.

### 카카오맵 설정 — 처음 하는 사람도 따라 하는 순서

앱은 **한국 좌표만 카카오맵**, 한국 밖 좌표와 지역을 아직 모르는 새 위치 선택은 기존
MapLibre/OpenStreetMap 지도를 사용한다. 카카오 로딩이 실패해도 기존 지도로 자동 복귀한다.
얀덱스 지도는 사용하지 않는다(ADR-0069).

먼저 열 곳:

- [Kakao Developers 내 애플리케이션](https://developers.kakao.com/console/app)
- [Kakao Maps API 사용 설정 설명](https://developers.kakao.com/docs/latest/ko/kakaomap/common)
- [GitHub Actions 변수 설명](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-variables)
- [Supabase Edge Function 시크릿 설명](https://supabase.com/docs/guides/functions/secrets)

1. **카카오 사이트 주소를 등록한다.** Kakao Developers에서 이 앱 → **제품 설정 → 카카오맵**을
   `ON`으로 켠다. 이어 **앱 → 플랫폼 키 → JavaScript 키 → JavaScript SDK 도메인**에 아래
   세 주소를 한 줄씩 등록한다. 주소 끝의 `/Travel-Memories/` 같은 길은 붙이지 않는다.

   ```text
   https://hanwha27-tdtu.github.io
   http://localhost:5173
   http://127.0.0.1:5173
   ```

   카카오 로그인을 설정하는 일이 아니므로 **카카오 로그인 리다이렉트 URI는 비워 둔다.**

2. **화면 지도를 위한 JavaScript 키를 GitHub에 넣는다.** 저장소의 **Settings → Secrets and
   variables → Actions → Variables → New repository variable**에서 이름은 정확히
   `VITE_KAKAO_JAVASCRIPT_KEY`, 값은 Kakao Developers의 **JavaScript 키**로 저장한다.
   `REST API 키`를 이 칸에 넣으면 지도가 뜨지 않는다. JavaScript 키는 브라우저에 전달되는
   공개 식별자이므로 도메인 등록이 실제 보호선이다.

3. **한국 장소 검색을 위한 REST 키를 Supabase에 넣는다.** Supabase 프로젝트 → **Edge
   Functions → Secrets → Add new secret**에서 이름은 정확히 `KAKAO_REST_KEY`, 값은 Kakao
   Developers의 **REST API 키**로 저장한다. REST 키는 비밀이므로 GitHub Variable이나
   `.env` 파일, 채팅, 스크린샷에 값을 붙이지 않는다. Supabase 문서 기준으로 저장 직후 함수에서
   사용할 수 있으며 시크릿만 바꿨다면 함수 재배포는 필요 없다.

4. **확인한다.** GitHub에는 변수 **이름** `VITE_KAKAO_JAVASCRIPT_KEY`, Supabase에는 시크릿
   **이름** `KAKAO_REST_KEY`가 보여야 한다. 다음 배포 뒤 서울처럼 한국 좌표가 든 여행 지도를
   열어 카카오 지도가 나오는지 보고, 해외 좌표는 기존 지도가 나오는지 확인한다. 키 값을 화면에
   다시 공개해서 확인하지 않는다.

자주 틀리는 곳: `Default JS Key`라는 **키 이름**은 바꿀 필요가 없다. GitHub에 만드는 변수의
이름만 위 철자와 같으면 된다. 도메인은 `https://hanwha27-tdtu.github.io/Travel-Memories/`가
아니라 origin인 `https://hanwha27-tdtu.github.io`까지만 등록한다.

## 보안 헤더 · 롤백 (S-05 결정)

v0.2 리뷰는 GitHub Pages가 커스텀 보안 헤더(CSP·HSTS 등 HTTP 응답 헤더)를 설정할 수 없음을 지적했다. 사용자 결정(ADR-0013): **GitHub Pages를 주 배포로 유지하고, 헤더 가능 호스트를 병행 미러로 둔다.**

- **주 배포**: GitHub Pages (사용자 필수 요건). 헤더 한계는 다음으로 완화 —
  - CSP는 `<meta http-equiv="Content-Security-Policy">`로 부분 적용(응답 헤더보다 약하나 XSS 완화에 유효), 자체 호스팅 인라인 자산·`connect-src`를 Supabase 도메인으로 제한.
  - 롤백은 GitHub Actions에서 이전 성공 빌드로 재배포(git revert/재실행).
- **병행 미러(옵션, 후속)**: Cloudflare Pages 또는 Netlify — 동일 정적 산출물을 배포하되 **보안 응답 헤더(CSP/HSTS/Referrer-Policy/Permissions-Policy)와 즉시 롤백**을 제공. 운영 강화가 필요할 때 활성화. Supabase CORS 허용 오리진에 미러 도메인도 등록.
- 두 호스트 모두 정적·서버리스이므로 백엔드(Supabase 직접 호출)·비밀 규칙은 동일하게 적용된다.

## 보조 빌드

`scripts/build-single-html.ts`로 휴대용 단일 HTML판 생성(로컬 아카이브 열람 중심의 제한된 보조판 — `file://`은 SW·설치형 PWA와 동등하지 않음). 배포 우선순위: ① 운영 PWA(여러 파일, GitHub Pages 주) → ② 헤더 호스트 미러(옵션) → ③ 단일 HTML 보조.

## 검증

- 배포 후 하위경로에서 자원 404 없음, SW 등록·scope 정상, manifest 설치 가능.
- anon 키 외 시크릿 부재(빌드 아티팩트 스캔).
- Supabase CORS·RLS가 Pages 도메인에서 정상.
