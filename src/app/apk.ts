// app/apk.ts — **안드로이드 앱(APK) 배포 사실의 단일 진실원**(SSOT · §7).
//
// 사용자 지시(2026-08-01): *"항상 최신 APK 파일도 다운로드 가능하게. 업데이트마다 APK 파일
// 갱신은 100퍼센트 놓치는 일 없게"* — 그래서 이 파일과 세 개의 기계 층이 한 계약을 이룬다:
//
//   ① CI(.github/workflows/android-apk.yml)가 셸이 바뀔 때마다 APK를 굽고, main이면
//      **고정 태그 릴리스(apk-latest)에 --clobber로 덮어쓴다** — 사람 손이 없다.
//   ② 아래 URL은 그 고정 태그를 가리키므로 **언제 눌러도 최신**이다(로그인 불필요).
//   ③ `check-apk-release-link` 게이트가 워크플로·이 상수·가이드 화면이 같은 계약인지
//      대조한다 — 셋 중 하나가 조용히 갈라지면 RED.
//
// 🔴 이 URL을 다른 파일에 손으로 다시 적지 않는다(손편집 중복이 결함이다). 화면은 여기서
// import 한다 — 게이트가 가이드의 하드코딩 URL을 잡는다.

/** CI가 덮어쓰는 고정 릴리스 태그 — 워크플로의 `gh release upload` 대상과 1:1. */
export const APK_RELEASE_TAG = 'apk-latest';

/** 항상 최신 APK를 주는 고정 주소. GitHub 릴리스 자산은 공개 저장소라 로그인 없이 받아진다. */
export const APK_LATEST_URL = `https://github.com/hanwha27-TDTU/Travel-Memories/releases/download/${APK_RELEASE_TAG}/app-debug.apk`;

/**
 * 설치 순서 — **초등학생도 따라 할 수 있게**(사용자 지시). 화면(가이드)은 이 데이터를
 * 그대로 그린다(§10 ③ — 사용자에게 가는 문장은 데이터로 두고 유닛이 직접 읽는다).
 * 전문 용어 금지: 유닛이 「아티팩트·CI·사이드로드·딥링크」 같은 말이 섞이면 RED를 낸다.
 */
export const APK_INSTALL_STEPS: ReadonlyArray<{ title: string; desc: string }> = [
  {
    title: '아래 「최신 앱 내려받기」 버튼을 눌러요',
    desc: 'app-debug.apk 파일이 받아져요. 로그인 같은 건 필요 없어요. 언제 눌러도 항상 최신 앱이 받아져요.',
  },
  {
    title: '받아진 파일을 눌러요',
    desc: '화면 위 알림에서 눌러도 되고, 「내 파일」 앱 → 다운로드에서 app-debug.apk를 눌러도 돼요.',
  },
  {
    title: '「설치」를 눌러요',
    desc: '"이 앱을 설치할까요?"라고 물으면 설치를 눌러요. "이 출처 허용" 같은 걸 물으면 허용을 눌러요.',
  },
  {
    title: '경고가 떠도 괜찮아요',
    desc: '"알 수 없는 개발자" 경고는 가게(스토어)를 거치지 않은 개인 앱이라 나오는 거예요. 「자세히 알아보기」를 누른 다음 「무시하고 설치」를 눌러요.',
  },
  {
    title: '끝! 홈 화면에서 Bugeon Journey를 열어요',
    desc: '이미 설치돼 있었다면 그 위에 새로 덮어써져요. 기록·사진은 하나도 지워지지 않아요.',
  },
];

/**
 * 🎨 앱 아이콘 목록 (ADR-0038) — **키·라벨·순서의 SSOT.**
 * `key`는 네이티브 `IconSwitcherPlugin.ALIASES`의 키와 **글자 단위로 같아야 한다**(전환기 동작).
 * 썸네일은 `public/icons/app-icons/{key}.png`. 첫째(passport)가 기본.
 * 셸(APK)에서만 전환 가능 — 웹/PWA는 설치 시 아이콘이 고정된다.
 */
export const APP_ICONS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'passport', label: '여권·노을' },
  { key: 'compass', label: '나침반' },
  { key: 'globe', label: '지구본·비행기' },
  { key: 'suitcase', label: '캐리어·핀' },
  { key: 'mountain', label: '산·여정' },
];

/** 설치 안내 아래 붙는 사실 문장들 — 역시 데이터로 두고 유닛이 읽는다. */
export const APK_FACTS: ReadonlyArray<string> = [
  '화면·기능 업데이트는 앱을 다시 설치하지 않아도 자동으로 들어와요 — 앱을 열면 항상 최신 화면이에요.',
  '앱을 다시 설치해야 하는 일은 드물어요(사진 문·로그인 문 같은 속 부품이 바뀔 때뿐). 그때는 업데이트 소식에 「앱 다시 설치 필요」라고 알려드려요.',
  '위 버튼의 주소는 고정이에요 — 새 앱이 나올 때마다 기계가 같은 자리에 갈아 끼워요. 즐겨찾기해 두셔도 돼요.',
  '휴대폰에서는 이 앱으로 쓰는 것이 가장 좋아요 — 갤러리 사진의 위치가 살아 있는 유일한 길이에요. 컴퓨터에서는 웹으로 쓰셔도 위치가 살아요.',
];
