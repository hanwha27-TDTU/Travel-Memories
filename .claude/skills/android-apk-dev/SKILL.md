---
name: android-apk-dev
description: 안드로이드 APK 생성·배포·동작 검증 프롬프트 — android-shell/**(Capacitor 셸)·.github/workflows/android-apk.yml·src/app/apk.ts·src/services/(appUpdate|nativePhotos|capacitorShell).ts·scripts/(check-apk-release-link|check-update-signal|gen-version-file).mjs를 만들거나 수정하기 전에 반드시 로드한다. Windows AVD Bugeon_API35, Android Emulator, adb, scrcpy, Playwright로 APK나 Android 모바일 UI를 검증할 때도 사용한다. 웹/셸 분리 원칙·「항상 최신 APK」 계약·네이티브 브리지·에뮬레이터 우선 실동작 검증을 담은 작업 헌장.
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
| `android-shell/android/app/src/main/java/app/bugeon/journey/BackupFilesPlugin.java` | 백업·사진·영상 같은 큰 앱 파일의 MediaStore Download 기본 저장 + SAF 다른 폴더 저장 + 같은 URI 길이·SHA-256 되읽기 | wire 이름은 구형 APK 호환으로 유지. 실제 요청 파일명·MIME을 쓰고 실패한 부분 문서만 정리 |
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
2. **CI와 로컬 AVD가 서로 다른 것을 증명한다** — `android-apk.yml`은 셸 관련 경로
   (`android-shell/**`, 워크플로 파일 자체)가 바뀔 때 Gradle 빌드·산출물을 증명한다. Windows
   개발 환경에서는 설치된 SDK와 AVD `Bugeon_API35`로 같은 셸을 직접 빌드·설치·실행해 사용자
   흐름을 확인한다. 개인용·사이드로드 목적이라 **debug 서명**으로 충분하다(Play 스토어에
   낼 때만 release 서명 키를 Secrets로 추가).
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
9. **셸 자체가 바뀌면(재설치 필요) 앱 안 배너로 알린다**(ADR-0040) — 웹 갱신(#7)으론 못
   바꾸는 아이콘·권한·서명·네이티브가 바뀌면 `shellUpdate.ts`가 `현재 build < 최신 build`일 때만
   배너를 띄운다. 계약이 **네 자리**로 맞물린다: 워크플로가 `-PAPP_VERSION_CODE=${{ github.run_number }}`로
   versionCode를 올리고 릴리스 설명에 `<!-- shell-version: {"versionCode": N} -->`를 심는다 ·
   `build.gradle`이 `APP_VERSION_CODE` 속성을 읽는다 · `apk.ts`가 `APK_RELEASE_API`(api.github.com —
   자산 URL은 CORS로 막힘·함정 D)+`parseShellBuild`를 가진다. `check-apk-release-link`가 넷을
   대조한다. 🔴 「닫기」는 세션 한정(함정 E) — 저장하면 미루는 사용자를 영영 놓친다.
10. **사용자 파일 저장은 결정적인 기본 문 + 실제 URI 되읽기로 끝까지 확인한다** — 백업처럼
    잃으면 안 되는 큰 Blob은 취소 가능한 선택기를 **유일한 저장 문**으로 두지 않는다. Android
    10+(API 29+)의 기본 버튼은 MediaStore `Download/Bugeon Journey`에 `IS_PENDING=1`로 만들고,
    다른 위치를 원하는 사용자가 누른 보조 버튼만 `ACTION_CREATE_DOCUMENT`를 연다. 직접 저장을
    지원하지 않는 옛 Android나 MediaStore 생성 실패 때만 SAF로 내려간다. 고정 크기 청크를
    순서대로 쓴 뒤 같은 URI를 다시 열어 길이+SHA-256이 모두 맞아야 `IS_PENDING=0`으로 공개하고
    성공이다. WebView의 `<a download>` 클릭은 저장 완료 증거가 아니며, 네이티브 문이 없는
    브라우저 fallback은 요청 상태로만 보고한다.

## 2. 코드 관례 (실제로 걸렸던 것)

- **네이티브 코드는 최소 표면**: 플러그인 하나(`OriginalPhotosPlugin`)로 끝낸다. 로직·검증·
  UI는 전부 웹에 둔다. 네이티브 표면은 CI 컴파일과 로컬 AVD 실동작을 모두 거치되, 많을수록
  기기·API별로 재야 할 표면이 늘어난다.
- **SAF를 쓰고 시스템 사진 선택기(`ACTION_PICK_IMAGES`)는 쓰지 않는다** — 선택기 제공자
  URI는 `MediaStore.getMediaUri` 변환이 보장되지 않는다. SAF 문서 URI는 변환 경로가
  문서화돼 있다(구체 사례는 `OriginalPhotosPlugin.java` 머리주석).
- **권한이 일부만 있어도 선택기는 연다**: 사진을 아예 못 고르게 막는 것이 최악이다.
- **`reason` 문자열을 지어내지 않는다**: 실패 단계마다 다른 문자열("pre-Q",
  "no-media-location-permission", "getMediaUri-null", "promote-failed:...")을 그대로
  돌려줘서, 실기기에서 결과가 이상할 때 **스크린샷 한 장이 어디서 무너졌는지 말하게** 한다.
- **버전의 SSOT는 changelog다**: `gen-version-file.mjs`가 `dist/version.json`을 만들 때도,
  APK 안내 문구도, 버전을 다른 곳에 손으로 다시 적지 않는다(§7).
- **대용량 브리지는 `begin → append* → finish`**: 전체 Blob을 한 번에 base64로 넘기면 JS·Java
  양쪽 피크 메모리가 커진다. 청크마다 JS 원본 SHA-256을 함께 보내 네이티브 수신값과 먼저
  결박하고, 청크 순서·활성 URI·picker 대기 락은 플러그인이 소유한다. 중간 실패·취소 때는
  그 호출이 만든 부분 문서만 지운다. 사용자 기존 파일이나 외부 원본은 건드리지 않는다.
- **네이티브 성공은 되읽기까지**: 출력 스트림 close 성공만으로 끝내지 않는다. 동일 URI를 다시
  읽어 길이와 digest를 확인하고, 불일치·재열기 실패는 성공으로 반올림하지 않는다.
- **저장 위치는 요청값이 아니라 영수증이다**: `begin`/`finish`가 실제 `destination`을 돌려주고,
  웹은 그 값을 사용자 문장과 백업 신선도 판정에 쓴다. 구형 APK처럼 이 필드가 없으면
  `picker`로 보수적으로 분류한다 — 새 웹을 배포했다고 옛 네이티브 셸이 MediaStore 저장을
  얻은 것처럼 말하지 않는다. 셸 변경은 새 APK 설치 전까지 기기에 존재하지 않는다.
- **취소는 관측까지만 말한다**: 확인된 사실은 `RESULT_OK` URI를 받지 못해 파일을 만들지
  못했다는 것뿐이다. 사용자 취소인지 제공자 종료인지 추측하지 말고, 「파일이 생기지 않았음」과
  다음 행동(기본 백업 또는 다른 폴더 다시 선택)을 함께 말한다. 취소·실패 때 백업 완료 시각을
  갱신하지 않고, 이 호출이 만든 pending URI만 정리한다.

## 3. 결정 기록 (ADR) 요약

- **ADR-0036 · 안드로이드 셸(Capacitor)을 입는다**: PWA/TWA로는 사진 원본 GPS를 원리적으로
  못 받는다는 실측 확정 이후의 결정. 기각안: TWA(크롬 안이라 같은 제약) · 시스템 사진
  선택기(URI 변환 미보장) · 웹 자산 번들(웹 수정마다 APK 재빌드가 되어 「항상 최신」이 깨짐).
  되돌리기: `android-shell/`·워크플로·`nativePhotos.ts` 삭제만으로 원복(브리지 감지가 전부
  무행동으로 떨어진다 — 웹앱은 셸 없이도 그대로 돈다).
- **ADR-0037 · 구글 로그인은 커스텀 스킴 딥링크로 돌아온다**: 셸 안에서 OAuth 리다이렉트가
  시스템 브라우저에 남으면 셸이 무의미해진다 — 이 문서 범위 밖(인증 스킬 참고),
  다만 셸을 만들 때 로그인 플로우가 있으면 반드시 같이 검토한다.
- **ADR-0038 · 앱 아이콘 여행 디자인 + APK 앱 내 전환기**: 아이콘=activity-alias(정확히 하나만
  enabled), LAUNCHER를 MainActivity→alias로 이동(딥링크·singleTask는 MainActivity 유지).
  `IconSwitcherPlugin`이 `setComponentEnabledSetting(DONT_KILL_APP)`로 토글. 웹/PWA엔 없다
  (설치 시 아이콘 고정 — 셸 전용). 적응형 아이콘은 **배경에 전체 이미지 + 투명 전경**(가장자리
  꽉 찬 디자인·아래 글자가 마스크에 안 잘리게). 🔴 **키 SSOT가 셋에 손으로 맞물린다**:
  `src/app/apk.ts`의 `APP_ICONS` ↔ `IconSwitcherPlugin.ALIASES` ↔ manifest alias 이름 —
  아이콘 추가 시 세 곳을 함께 고친다(교차언어라 게이트 없음, 주석으로 못박음).
- **ADR-0040 · 새 APK가 나오면 앱 안 배너로 알린다**: 웹은 자동 갱신되지만(§5) **셸 자체**가
  바뀌면 재설치가 필요한데 사용자가 그 사실을 몰랐다. `shellUpdate.ts`가 시작·복귀 때
  `현재 build < 최신 build`면 하단 배너를 띄운다. 🔴 **함정 D**: 릴리스 '자산'(releases/download/…)은
  302+CORS 없음이라 fetch가 조용히 막힌다 → **api.github.com의 릴리스 '설명'**에 심은
  `<!-- shell-version: {"versionCode": N} -->` 마커를 `parseShellBuild`로 읽는다. 🔴 **함정 E**:
  「닫기」를 저장하지 않는다(세션 한정) — 저장하면 설치를 미룬 사용자가 영영 안내를 못 받는다.
  🔴 **셋이 맞물린다**: 워크플로가 `-PAPP_VERSION_CODE=${{ github.run_number }}`로 versionCode를
  올리고 릴리스 설명에 마커를 심는다 · `build.gradle`이 `APP_VERSION_CODE` 속성을 읽는다 ·
  `apk.ts`가 `APK_RELEASE_API`+`parseShellBuild`를 가진다 → `check-apk-release-link`가 넷을 대조.
  배너는 **이 빌드 이상을 설치한 기기에서만** 뜬다(옛 앱엔 비교 기준 없음) → 다음 배포부터 작동.
- **ADR-0041 · 설치 가이드(플레이북)를 문서로 내려받게**: `src/app/playbook.ts`가 화면 가이드와
  **같은 SSOT**(`apk.ts` 설치순서·사실 + `changelog` 버전)에서 HTML·Markdown을 **런타임 조립**해
  Blob으로 내려준다. 버전=앱 버전(자동 통일), 앱 업데이트 시 문서도 자동 최신. 앱 이름·주소만
  주입되므로 다른 앱도 재현. 🔴 손으로 문서에 복제 금지(§7) — `playbook.test.ts`가 「버전 통일·
  모든 단계 포함·전문용어 없음·HTML 자체완결」을 잠근다.
- **ADR-0042 · 앱 아이콘 두 층 구조**(ADR-0038의 아이콘 방식 교체): 예전 **배경=전체이미지/
  전경=투명**은 적응형 바깥 ~18dp bleed에서 아래 글자가 **잘렸다**(M-0083 · 실기기 반증).
  이제 **배경=흐린 장면(cover+blur) · 전경=흰 여백 자른 선명한 카드를 안전지대(~72%)**에 둔다.
  🔴 아이콘/마스크가 걸리는 자리는 **가정하지 말고 원·스퀘어클 두 마스크로 렌더해 눈으로 본다**
  (§13 — 정적 게이트가 못 보는 층). anydpi-v26 XML 10개는 생성기가 SSOT로 함께 쓴다.
- **ADR-0058 · 뷰어 개별 저장도 같은 검증 문을 쓴다**: `BackupFiles`라는 wire 이름은 백업 전용
  의미가 아니라 이미 설치된 APK와의 호환 경계다. 사진·영상은 요청한 이름·MIME으로 저장하고,
  표시명 조회 실패 때 고정 ZIP명을 돌려주지 않는다. 개별 저장은 외부 원본이 아니라 앱 보관본이며
  백업 완료 시각을 갱신하지 않는다.
- 전체 상세는 `docs/DECISIONS.md`의 해당 ADR을 정본으로 본다 — 이 절은 요약일 뿐이다.

## 4. 검증 레시피 (정직한 완료)

자동층:
1. `npm run harness` — `check-apk-release-link`(고정 URL 3자리 + 배너 4자리 계약) + `check-update-signal`(4자리 계약)
2. CI(`android-apk.yml`)와 로컬 `:app:assembleDebug`가 실제로 Gradle 빌드에 성공하는가.
3. 네이티브 파일 저장을 바꿨다면 `tests/unit/fileSave.test.ts`에서 기본 버튼은 `downloads`,
   보조 버튼은 `picker`, 취소는 미완료, 실제 `destination`별 안내가 갈리는지 확인한다. 가능하면
   `:app:compileDebugJavaWithJavac`도 실행하되, 그 결과는 실기기 MediaStore/SAF 동작 증거가 아니다.

### Windows AVD 직접 검증 — 사용자에게 넘기기 전 기본 경로

Android/APK 동작 검증은 사용자의 수동 확인을 기본값으로 두지 말고 다음 순서로 직접 수행한다.

1. **전제와 초기 상태를 확인한다.** `emulator -list-avds`에 `Bugeon_API35`가 있는지 확인하고,
   `adb devices -l`로 기존 연결을 기록한다. 도구가 PATH에 없으면 Windows Android SDK 기본
   위치와 설치 정보를 찾아 실행 파일을 확정한다. 실행하지 못한 전제는 성공으로 반올림하지 않는다.
2. **AVD를 부팅하고 준비 완료를 기다린다.** `Bugeon_API35`를 시작한 뒤 `adb wait-for-device`와
   `adb shell getprop sys.boot_completed`가 `1`인지 확인한다. 기존 emulator가 있으면 serial을
   명시해 다른 기기에 명령하지 않는다. 테스트 전 화면·회전·네트워크·앱 프로세스 상태를 기록한다.
3. **웹 표면을 Android Chrome에서 먼저 잰다.** Vite를 외부 접속 가능 주소로 실행하고
   `adb reverse tcp:5173 tcp:5173` 뒤 emulator Chrome에서 `http://127.0.0.1:5173`을 연다.
   Playwright의 Android/CDP 연결을 쓸 수 있으면 trace·console을 함께 수집하고, 불가능하면 adb
   좌표/키 입력과 `uiautomator dump`를 사용한다. 데스크톱 Chromium 결과를 Android 통과로 쓰지 않는다.
4. **APK 자체를 설치해 별도로 잰다.** `android-shell/android`에서 debug APK를 빌드하고
   `adb install -r`로 설치한다. manifest/Gradle과 `cmd package resolve-activity --brief`로 package와
   launcher activity를 확인한 뒤 `am start -n`으로 실행한다. 원격 웹이 보였다는 사실과 새
   네이티브 플러그인이 설치됐다는 사실을 구분한다.
5. **실제 모바일 흐름을 자동 수행한다.** emulator 해상도와 density를 기록하고 화면의 실제
   터치 좌표 또는 접근성 노드를 사용한다. 필요하면 adb로 권한, 키보드, GPS, 회전, 네트워크를
   설정한다. 변경한 상태와 복구 여부를 결과에 남긴다. scrcpy는 대화형 관찰이 필요할 때 쓰되,
   자동 판정 증거는 스크린샷·UI dump·로그·read-back으로 남긴다.
6. **성공은 결과를 되읽어 판정한다.** 화면 문구만 보지 말고 파일, URI, 길이·해시, 앱 데이터,
   현재 activity 등 기능의 권위 저장소를 다시 읽는다. 기본 백업은 Downloads 파일과 영수증을,
   SAF 취소는 새 파일·백업 완료 시각이 생기지 않았음을 확인한다.
7. **실패 증거를 보존한다.** 실패 시 최소한 emulator 스크린샷, `uiautomator dump`, 대상 앱의
   `adb logcat`, 현재 activity/package 상태를 수집한다. Playwright를 사용했다면 trace와 console도
   남긴다. 테스트 뒤 emulator·앱 상태와 남은 파일/권한 변경을 다시 기록한다.
8. **판정을 분리한다.** 직접 실행해 확인한 항목만 PASS로 쓴다. 도구·AVD·로그인·외부 서비스
   전제가 없어 실행하지 못한 항목은 SKIP 또는 확인 불가로 적는다. 물리 카메라, 제조사 ROM,
   실제 저사양 메모리/PSS, 실제 GPS 센서처럼 AVD가 대표하지 못하는 동작만 「실기기 전용」으로
   명시하며, 그 이유 없이 사용자에게 확인을 넘기지 않는다.

### 대표 흐름

1. APK를 설치하고 사진 고르기 버튼을 눌러 네이티브 선택기가 뜨는지 확인한다.
2. 관측 창이 `original: true/false`와 실제 `reason`을 표시하는지 확인한다. AVD의 가상 미디어
   결과를 물리 기기의 원본 승격 보증으로 확대하지 않는다.
3. 웹만 갱신했을 때 APK 재설치 없이 재실행으로 새 화면이 뜨는지 확인한다.
4. 기본 백업이 `Download/Bugeon Journey`에 생기고 길이·SHA-256 되읽기가 일치하는지 확인한다.
   「다른 폴더」 SAF 취소 뒤에는 파일과 마지막 백업 시각이 생기지 않아야 한다.
5. 기존 앱 위에 최신 APK를 `-r`로 설치해 셸 build와 새 네이티브 method가 실제로 바뀌었는지 확인한다.

## 5. 변경 후 의무

- 앱 동작·셸 계약을 바꾼 릴리스라면 `changelog.ts` +0.01 · `docs/HANDOFF.md` · 새 교훈은 이
  문서 §3(또는 §6)에 추가한다. **스킬 산문만 보강한 후속 정리는 앱 버전을 올리지 않는다.**
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
  아직 저장 안 된 입력이 있으면 지금은 건드리지 말고 다음 화면 전환 때 적용해.
- 🔴 「다음 화면 전환」을 hashchange로 듣지 마 — History API(pushState/popstate) 라우터면
  hash가 안 바뀌어 그 이벤트는 한 번도 발화하지 않는다(우리는 이걸로 안전판이 죽었었다).
  라우터가 화면을 그릴 때 커스텀 이벤트를 쏘게 하고 그걸 들어라.
- 🔴 입력 감지는 keydown 말고 beforeinput으로 — 붙여넣기·음성입력·제스처·IME가 전부 지난다.
  그리고 복귀(visibilitychange)마다 입력 이력을 리셋하지 마 — 글 쓰다 나갔다 돌아온 것이
  「안전」으로 둔갑해 새로고침이 글을 날린다. 리셋은 화면 전환(입력을 떠남) 때만.
- 서비스워커가 있다면 version.json은 캐시하지 마(신호 자체가 낡는다).

## 하지 말 것
- 웹 자산을 셸에 번들하지 마(웹 수정마다 APK 재빌드가 되면 "항상 최신" 계약이 깨진다).
- TWA는 브라우저 권한 밖 기능이 필요한 경우엔 못 쓴다(크롬 안이라 같은 제약).
- 릴리스 태그를 커밋마다 새로 만들지 마 — 고정 태그 + --clobber여야 링크가 안 바뀐다.

먼저 0단계 판단 결과부터 알려주고 나서 구현을 시작해줘.
```
