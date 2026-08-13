---
name: windows-tauri-dev
description: Bugeon Journey의 Tauri 2 Windows 셸, src-tauri, Windows 웹 번들, WebView2 오리진, capability, OAuth 딥링크, NSIS 설치·업데이트를 설계·구현·검증할 때 사용한다.
---

# Windows Tauri 개발

## 먼저 읽기

1. `docs/WINDOWS_TAURI.md`
2. `docs/HARNESS_RELEASE_LAW.md`
3. 인증을 바꾸면 `src/services/auth.ts`와 Android 딥링크 계약도 함께 읽기
4. 저장·복원을 바꾸면 backup 관련 프로젝트 스킬을 함께 읽기

## 불변식

- Tauri는 제품 코어가 아니라 세 번째 실행 표면이다. Vite·TypeScript 공통 코어를 다시 쓰지 않는다.
- 운영 창은 원격 GitHub Pages가 아니라 빌드된 로컬 `windows-dist/`만 적재한다.
- `windows-dist/`, `src-tauri/target/`, `src-tauri/gen/`은 생성물이며 커밋하지 않는다.
- Windows는 독립 기기다. Chrome·Edge 프로필의 IndexedDB를 복사하지 않고 Supabase canonical sync 또는 공식 백업으로 이동한다.
- `identifier=app.bugeon.journey`, main label, `useHttpsScheme=true`는 저장소 오리진 불변식이다. 바꾸면 IndexedDB·localStorage 마이그레이션이 필요한 파괴적 변경으로 취급한다.
- capability는 `main` 창에 필요한 명령만 허용한다. broad fs, shell/process, 임의 URL native proxy를 추가하지 않는다.
- 서버 전용 키를 Rust, 설정, installer, 로그에 넣지 않는다. 프런트엔드에는 기존 publishable 키만 사용한다.
- 네이티브 기능은 공용 웹 경로를 대체하지 않고 어댑터 뒤에서 보완한다. 브라우저와 Android는 기존 동작을 유지한다.
- OAuth는 시스템 브라우저 + 고정 custom scheme + PKCE + single instance로 완성하기 전에는 Windows 로그인을 완료로 표시하지 않는다.
- 설치 파일 생성 성공은 실행 성공이 아니다. clean install, launch, 저장소 read-back, uninstall/reinstall을 별도 증거로 남긴다.

## 구현 순서

1. `npm run brief`로 바뀔 파일과 형제를 확인한다.
2. Tauri·플러그인 버전은 공식 문서와 현재 registry에서 확인해 정확히 고정한다.
3. `npm run windows:web`으로 상대 base의 로컬 payload를 만든다.
4. `npm run windows:build`로 NSIS를 만들고 산출물 경로·크기·해시를 기록한다.
5. Windows 계약 게이트에서 identifier, 로컬 payload, HTTPS 오리진, 최소 capability, 버전 형식을 확인한다.
6. 새 게이트는 정상·결함·오탐 대조군과 실제 소스 주입 RED→복원 GREEN을 확인한다.
7. 기존 `npm run build`와 Android 관련 게이트가 그대로 통과하는지 확인한다.

## 단계별 완료 경계

- 골격: 로컬 payload와 Rust 셸이 컴파일됨. OAuth·설치 실동작은 미완료로 표시.
- 인증: 시스템 브라우저 왕복과 잘못된 callback 거부를 실제 실행으로 확인.
- 저장: 백업 파일을 저장하고 다시 읽어 길이·해시·복원 결과를 확인.
- 배포: 서명·업데이터·릴리스 메타데이터·rollback과 공개 다운로드 read-back까지 확인.

## 금지

- Windows 전용 앱 코어 또는 두 번째 화면 소스 만들기
- `https://hanwha27-tdtu.github.io/...`를 운영 Tauri 창에 직접 로드하기
- 기존 Android `server.url` 계약을 Windows 때문에 바꾸기
- 오리진이나 identifier를 버전 사이에서 조용히 바꾸기
- WebView2에서 직접 재지 않은 API를 “지원”이라고 기록하기
