# DEPLOYMENT · Journey Archive

**GitHub Pages 정적 배포가 필수 목표다** (ADR-0010). 모든 설계는 정적 호스팅 제약에 맞춘다.

## 왜 정적으로 가능한가

GitHub Pages는 서버 없이 정적 파일만 제공한다. Journey Archive는 서버가 필요 없다 — 백엔드는 **Supabase(BaaS)**가 담당하고, 브라우저가 Supabase를 직접 호출한다. Vite는 정적 파일로 빌드되고, Service Worker·IndexedDB·MapLibre는 모두 브라우저에서 동작한다. 따라서 정적 배포와 완벽히 호환된다.

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

## 배포 파이프라인 (GitHub Actions)

```
push → GitHub Actions:
  install → typecheck → harness(Required 게이트) → vite build(base 적용)
  → 아티팩트 업로드 → Pages 배포
```
- **완료 = 병합이 아니라 배포 그린 확인**(AGENTS.md). Actions가 배포 성공을 보고한 뒤에만 완료 처리.
- `check-secret-leak`가 빌드 아티팩트를 스캔해 시크릿 유출 없음을 확인한 뒤 배포.
- 환경변수(anon 키 등)는 GitHub Actions Secrets에서 주입(저장소에 커밋 금지). `.env.example`로 형태만 문서화.

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
