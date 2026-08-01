---
name: android-apk-dev
description: 안드로이드 APK 생성·배포 개발 프롬프트 — android-shell/**(Capacitor 셸)·.github/workflows/android-apk.yml·src/app/apk.ts·src/services/(appUpdate|nativePhotos|capacitorShell).ts·scripts/(check-apk-release-link|check-update-signal|gen-version-file).mjs를 만들거나 수정하기 전에 반드시 로드한다. 웹은 웹대로 셸은 셸대로 분리하는 원칙·「항상 최신 APK」 고정 릴리스 계약·네이티브 브리지 패턴·과거 결함 사례를 담은 작업 헌장. 셸 변경, APK 배포 방식 변경, 네이티브 플러그인 추가, 다른 프로젝트로 이 구조를 이식할 때 사용.
---

# 안드로이드 APK 생성·배포 개발 프롬프트 (Android APK Dev Charter)

이 앱은 **웹앱 그대로**다. 안드로이드 셸은 새 앱이 아니라 **WebView 하나 + 네이티브 문 하나**다
(ADR-0036). 이 문서가 정본인 것은 "셸을 어떻게 짜는가"이고, 셸이 왜 필요한가(사진 GPS
원본 접근)의 도메인 규율은 `photo-storage-dev`가 정본이다 — **둘 다 읽는다.**

## 0. 파일 지도

| 파일 | 역할 | 성격 |
|---|---|---|
| `android-shell/capacitor.config.json` | `server.url`이 배포된 웹사이트를 가리킴 | **웹 자산을 번들하지 않는다**는 계약의 심장 |
| `android-shell/android/app/src/main/java/app/bugeon/journey/MainActivity.java` | Capacitor 표준 진입점 | 거의 손대지 않음(딥링크 처리 정도) |
| `android-shell/android/app/src/main/java/app/bugeon/journey/OriginalPhotosPlugin.java` | **셸의 존재 이유** — SAF+MediaStore+`ACCESS_MEDIA_LOCATION`으로 원본 사진 바이트를 base64로 웹에 넘김 | 네이티브 플러그인 예시. 실패해도 사진은 돌려주고 사유(`reason`)만 적는다(§8 — 판정 안 함) |
| `.github/workflows/android-apk.yml` | CI가 Gradle로 debug APK를 굽고, main이면 고정 릴리스에 `--clobber` | 「항상 최신」 계약의 ①번 자리 |
| `src/app/apk.ts` | 고정 다운로드 URL(`APK_LATEST_URL`)·설치 안내 데이터 | 「항상 최신」 계약의 ②번 자리 — **SSOT, 손편집 중복 금지** |
| `src/ui/screens/guide.ts` | 위 상수를 import해서 버튼 href로 씀 | 계약의 ③번 자리 |
| `scripts/check-apk-release-link.mjs` | 워크플로·상수·가이드 세 자리가 같은 계약인지 대조 | 게이트 — §4 비공허 자체검사 포함 |
| `src/services/capacitorShell.ts` | `window.Capacitor` 감지·플러그인 접근의 **단일 진실원** | 여기 말고 다른 곳에서 `window.Capacitor`를 직접 읽지 않는다 |
| `src/services/nativePhotos.ts` | 네이티브 문의 웹 쪽 절반 — 받은 바이트를 **기존 `<input>`에 주입** | 새 파이프라인 만들지 않는다(§7 2층) |
| `src/services/appUpdate.ts` | 접속 시 `version.json`을 묻고 안전할 때만 새로고침 | 셸 재설치 없이 웹 콘텐츠만 갱신 |
| `scripts/gen-version-file.mjs` | 빌드 시 `dist/version.json`에 현재 버전을 심음(SSOT는 changelog) | 「접속하면 스스로 최신」 계약의 생성기 |
| `scripts/check-update-signal.mjs` | 빌드 체인·생성기·앱·서비스워커 네 자리가 한 계약인지 대조 | 게이트 |

## 1. 불변 계약

1. **웹은 웹대로, 셸은 셸대로** — `capacitor.config.json`의 `server.url`이 배포된 웹사이트를
   가리킨다. **웹 자산을 셸에 번들하지 않는다.** 웹 코드를 고쳐 배포(push)만 하면 앱 내용이
   바로 갱신되고, APK 재빌드는 셸 자체(권한·아이콘·네이티브 코드)가 바뀔 때만 필요하다.
   - 이유(ADR-0036): PWA/TWA는 크롬이 `ACCESS_MEDIA_LOCATION`을 요청하지 않아 **원리적으로**
     사진 원본 GPS를 못 받는다(실측 3종으로 확정 — 갤러리·파일 선택기 0/0, ZIP만 생존, 채팅
     사본과 해시 동일). 웹 코드의 문제가 아니라 **권한 계층**의 문제라 웹 안에서 대안이 없다.
2. **CI가 빌드한다** — 개발 샌드박스에는 Android SDK가 없다. `android-apk.yml`이 셸 관련
   경로(`android-shell/**`, 워크플로 파일 자체)가 바뀔 때만 돈다. 개인용·사이드로드 목적이라
   **debug 서명**으로 충분하다(Play 스토어 낼 때만 release 서명 키를 Secrets로 추가).
3. **「항상 최신 APK」는 고정 태그 + `--clobber`다** — 커밋마다 새 릴리스 태그를 만들지 않는다.
   `apk-latest` 하나에 계속 덮어써서 다운로드 URL이 **절대 안 바뀌게** 한다. 이 계약은 세 자리
   (워크플로·`src/app/apk.ts`·가이드 화면)가 같은 값을 가리켜야 하고, `check-apk-release-link`가
   그 대조를 기계화한다. 세 곳 중 한 곳이라도 손으로 URL을 다시 적으면 §7 위반이다.
4. **네이티브 기능은 기존 입력을 대체하지 않고 주입한다** — `nativePhotos.ts`가 새
   `<input>`이나 새 미리보기 경로를 만들지 않고, 네이티브 문이 돌려준 바이트를 **기존
   `<input>`의 `FileList`에 추가**하고 `change` 이벤트를 쏜다. 그래야 미리보기·EXIF 읽기·
   압축·저장이 전부 원래 쓰던 문을 그대로 지난다(§7 2층 — 두 번째 파이프라인은 반드시
   한쪽이 낡는다. M-0060이 그 형태였다).
5. **브라우저(셸 밖)에서는 브리지 감지가 실패해서 아무것도 안 바뀐다** — `shellPlugin()`이
   `null`을 돌려주는 것으로 전부 조용히 비켜선다. 셸 전용 분기를 여러 파일에 흩지 말고
   `capacitorShell.ts` **한 곳**에서만 `window.Capacitor`를 읽는다.
6. **실패는 기능을 죽이지 않는다** — 네이티브 플러그인에서 권한 거부·변환 실패가 나도
   사진은 돌려주고 부가 정보(위치)만 포기한다. **무엇을 포기했는지(`reason`)를 함께
   돌려준다** — 판정은 웹 쪽 관측 창이 하지 여기서 하지 않는다(§8, §12).
7. **웹 콘텐츠 갱신에 재설치가 필요 없다** — `appUpdate.ts`가 시작·복귀·화면전환 시점에
   `version.json`(캐시 우회 `no-store` + `?ts=`)을 묻고, **안전할 때만**(열린 모달 없음·
   최근 키 입력 없음) 새로고침한다. 안전하지 않으면 다음 화면 전환까지 미룬다 — 입력 중인
   글을 날리는 것은 비타협 원칙 #1의 이웃(저장 안 된 기억)이다.
8. **서비스워커는 `version.json`을 만지지 않는다** — 캐시하면 신호 자체가 낡는다. `?ts=`
   변형을 캐시하면 캐시 용량 상한이 진짜 자산을 밀어낸다.

## 2. 코드 관례 (실제로 걸렸던 것)

- **네이티브 코드는 최소 표면**: 플러그인 하나(`OriginalPhotosPlugin`)로 끝낸다. 로직·검증·
  UI는 전부 웹에 둔다 — 네이티브 코드는 CI에서만 빌드되고 이 샌드박스에서 못 고쳐 보므로,
  많을수록 "안 재본 채 배포"하는 표면이 늘어난다.
- **SAF를 쓰고 시스템 사진 선택기(`ACTION_PICK_IMAGES`)는 쓰지 않는다** — 선택기 제공자
  URI는 `MediaStore.getMediaUri` 변환이 보장되지 않는다. SAF 문서 URI는 변환 경로가
  문서화돼 있다(구체 사례는 `OriginalPhotosPlugin.java` 머리주석).
- **권한이 일부만 있어도 선택기는 연다**: 사진을 아예 못 고르게 막는 것이 최악이다.
- **`reason` 문자열을 지어내지 않는다**: 실패 단계마다 다른 문자열("pre-Q",
  "no-media-location-permission", "getMediaUri-null", "promote-failed:...")을 그대로
  돌려줘서, 실기기에서 결과가 이상할 때 **스크린샷 한 장이 어디서 무너졌는지 말하게** 한다.
- **버전의 SSOT는 changelog다**: `gen-version-file.mjs`가 `dist/version.json`을 만들 때도,
  APK 안내 문구도, 버전을 다른 곳에 손으로 다시 적지 않는다(§7).

## 3. 결정 기록 (ADR) 요약

- **ADR-0036 · 안드로이드 셸(Capacitor)을 입는다**: PWA/TWA로는 사진 원본 GPS를 원리적으로
  못 받는다는 실측 확정 이후의 결정. 기각안: TWA(크롬 안이라 같은 제약) · 시스템 사진
  선택기(URI 변환 미보장) · 웹 자산 번들(웹 수정마다 APK 재빌드가 되어 「항상 최신」이 깨짐).
  되돌리기: `android-shell/`·워크플로·`nativePhotos.ts` 삭제만으로 원복(브리지 감지가 전부
  무행동으로 떨어진다 — 웹앱은 셸 없이도 그대로 돈다).
- **ADR-0037 · 구글 로그인은 커스텀 스킴 딥링크로 돌아온다**: 셸 안에서 OAuth 리다이렉트가
  시스템 브라우저에 남으면 셸이 무의미해진다 — 이 문서 범위 밖(인증 스킬 참고),
  다만 셸을 만들 때 로그인 플로우가 있으면 반드시 같이 검토한다.
- 전체 상세는 `docs/DECISIONS.md`의 해당 ADR을 정본으로 본다 — 이 절은 요약일 뿐이다.

## 4. 검증 레시피 (정직한 완료)

자동층:
1. `npm run harness` — `check-apk-release-link`(3자리 계약) + `check-update-signal`(4자리 계약)
2. CI(`android-apk.yml`)가 실제로 Gradle 빌드에 성공하는가 — **이 샌드박스는 Android SDK가
   없어 로컬로 재현할 수 없다.** 컴파일 확인은 CI 몫이다(정직한 경계).

실기기(정적 게이트가 못 보는 층 — §10):
1. APK를 설치하고 사진 고르기 버튼을 눌러 실제로 네이티브 선택기가 뜨는가.
2. 🔬 관측 창(있다면)이 `original: true/false`와 `reason`을 실제로 보여주는가 — 이게 그
   폰에서 `setRequireOriginal` 승격이 됐는지 판정하는 유일한 창이다.
3. 웹만 배포를 새로 했을 때, 앱을 다시 설치하지 않고 재실행만으로 새 화면이 뜨는가
   (`appUpdate.ts`가 실제로 도는지).

**정직한 한계**: 이 개발 환경에는 Android SDK도 실기기도 없다. 컴파일은 CI가, 네이티브
동작 확인(권한 승격이 실제로 되는가)은 사용자 실기기가 한다.

## 5. 변경 후 의무

- `changelog.ts` +0.01 · `docs/HANDOFF.md` · 새 교훈은 이 문서 §3(또는 §6)에 추가
- `check-apk-release-link`·`check-update-signal`이 걸린 파일을 바꿨다면 그 셀프테스트가
  여전히 비공허한지 확인(§4·§11 — 넓히면 새 게이트다, 다시 주입해 RED 확인)
- 네이티브 플러그인을 추가/변경했다면 `docs/DECISIONS.md`에 ADR을 남긴다(왜 이 권한이,
  왜 이 API가 필요했는가 — 다음에 같은 조사를 반복하지 않게)

## 6. 다른 프로젝트로 이식할 때 (2026-08-01 사용자 요청)

이 구조(웹은 웹대로/셸은 셸대로 + 고정 릴리스 + 자동 갱신)를 다른 프로젝트에도 적용하고
싶다면, 그 프로젝트의 AI 세션에 아래를 그대로 붙여넣는다. **이 파일이 그 지시문의
SSOT다** — 필요할 때마다 여기서 복사하고, 이 문서가 갱신되면 그 지시문도 최신을 반영한다.

```
이 웹앱을 안드로이드에 설치 가능한 앱으로 만들어줘. 요구사항은 다음과 같아.

## 0. 먼저 확인할 것
- 이 웹앱은 배포된 고정 URL이 있어? 없으면 먼저 정적 배포부터 만들어줘.
- 브라우저 권한만으로는 원리적으로 못 하는 기능이 필요해?
  (예: 사진 원본 GPS — 안드로이드 10+는 미디어 저장소 경유 사진의 EXIF 위치를 지워서 주고,
   ACCESS_MEDIA_LOCATION + setRequireOriginal로만 원본을 받는데 크롬은 그 권한을 요청 안 함)
  → 필요 없으면 "5. 네이티브 플러그인"은 건너뛰고 순수 WebView 셸만 만들어.

## 1. 셸 프로젝트 (android-shell/ 폴더, 웹 리포와 같은 저장소에)
- Capacitor 7: `npx @capacitor/cli init` → `npx cap add android`.
- capacitor.config.json의 server.url이 배포된 웹 주소를 가리키게(웹 자산 번들 금지):
  { "appId": "<역도메인>", "appName": "<이름>", "webDir": "www",
    "server": { "url": "<배포 URL>", "allowNavigation": ["<그 URL의 호스트명>"] } }

## 2. CI가 APK를 굽는다
- android-shell/** 경로 변경 시에만 트리거. npm ci → npx cap sync android →
  ./gradlew assembleDebug(debug 서명 — 사이드로드용. Play면 release 키 별도 관리).
- 산출물은 artifact로 30일 보관 + main 브랜치면 아래 3단계로.

## 3. "항상 최신" 고정 다운로드 링크 (제일 중요)
- main에 셸 변경이 들어가면 고정 태그 릴리스(예: apk-latest)에 --clobber로 덮어써.
  매번 새 태그 만들지 마 — 주소가 절대 안 바뀌어야 해.
- 앱 상수 하나(예: src/app/apk.ts)에 태그와 URL을 SSOT로 두고, 다운로드 버튼은 그 상수를
  import해서만 써. 워크플로/상수/안내 화면 세 곳이 같은 값을 가리키는지 검사하는 스크립트를
  하나 만들고, "일부러 하나씩 깨뜨렸을 때 검사가 실제로 실패하는가"까지 확인해줘.

## 4. 네이티브 기능이 필요한 경우에만
- Capacitor 플러그인 하나만: 시스템 문서 선택기(SAF)로 고르고, 필요하면 MediaStore URI
  변환 + 원본 승격 권한을 적용해 바이트를 base64로 웹에 넘겨.
- 🔴 실패해도 기능 자체를 죽이지 마(예: 사진은 주되 부가정보만 포기) — 무엇이, 어느
  단계에서 실패했는지 사유 문자열을 함께 돌려줘(다음 조사 때 스크린샷이 원인을 말하게).
- 웹 쪽은 새 입력 경로를 만들지 말고, 셸 브리지가 있으면 그 바이트를 **기존 input에
  주입**해서(FileList에 추가 + change 이벤트) 미리보기·검증·저장이 원래 경로를 그대로 타게 해.
  브라우저(셸 밖)에서는 브리지 감지가 실패해서 아무 영향 없어야 해. 셸 감지는 한 곳
  (예: capacitorShell.ts)에서만 하고 다른 파일이 각자 감지 로직을 만들지 않게 해.

## 5. 웹 콘텐츠 자동 갱신 (재설치 없이)
- 빌드 시 dist/version.json에 현재 버전을 심어(SSOT는 changelog 등 한 곳).
- 시작·복귀 시 캐시 우회로 이 파일을 fetch해서 더 최신이면 새로고침하되, 열린 모달이나
  최근 키 입력이 있으면 지금은 건드리지 말고 다음 화면 전환 때 적용해.
- 서비스워커가 있다면 version.json은 캐시하지 마(신호 자체가 낡는다).

## 하지 말 것
- 웹 자산을 셸에 번들하지 마(웹 수정마다 APK 재빌드가 되면 "항상 최신" 계약이 깨진다).
- TWA는 브라우저 권한 밖 기능이 필요한 경우엔 못 쓴다(크롬 안이라 같은 제약).
- 릴리스 태그를 커밋마다 새로 만들지 마 — 고정 태그 + --clobber여야 링크가 안 바뀐다.

먼저 0단계 판단 결과부터 알려주고 나서 구현을 시작해줘.
```
