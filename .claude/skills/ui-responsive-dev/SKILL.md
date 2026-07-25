---
name: ui-responsive-dev
description: UI 셸·반응형·디자인 시스템 개발 프롬프트 — ui/styles/app.css·tokens.css·ui/theme.ts·ui/dom.ts와 화면 레이아웃을 만들거나 수정하기 전에 반드시 로드한다. 토큰 규율·반응형 측정 규율(세로/가로 둘 다)·상태 시각 위계·CSS 결함군 등록부·라이브 측정 레시피를 담은 작업 헌장. 새 화면, 레이아웃 변경, 브레이크포인트, 색·간격 작업 시 사용.
---

# UI 셸·반응형 개발 프롬프트 (UI Shell & Responsive Dev Charter)

이 앱은 **사진과 기억이 주인공**이다. UI는 그걸 방해하지 않는 선에서만 존재한다.
여기 규칙과 코드가 어긋나면 **코드가 진실**이고 이 문서를 갱신한다.
편집기·뷰어 전용 규칙은 `.claude/skills/photo-editor-dev`가 정본이다(중복 서술 금지).

## 0. 파일 지도

| 파일 | 역할 | 성격 |
|---|---|---|
| `src/ui/styles/tokens.css` | 색·간격·반경·그림자·시맨틱 토큰(`--sem-*`) | **모든 값의 SSOT** |
| `src/ui/styles/app.css` | 전 화면 스타일 + 반응형 분기 | 하드코딩 색 금지 — 토큰만 |
| `src/ui/theme.ts` | 라이트/다크 + 계절 테마(localStorage) | 표시 선호만(기억 데이터 아님) |
| `src/ui/dom.ts` | `el()` 생성 헬퍼 + `setNote()` 상태 위계 | **자유 텍스트는 textContent만**(innerHTML 금지) |
| `src/ui/screens/*.ts` | 화면 셸 | DOM. 순수 로직이 생기면 `domain/`으로 내려보낼 것 |

## 1. 불변 계약

1. **토큰만 쓴다**: 색·간격·반경을 하드코딩하지 않는다. 새 값이 필요하면 토큰을 추가한다(하드코딩은 테마·다크모드에서 조용히 깨진다).
2. **`innerHTML` 금지**: 자유 텍스트(사용자 입력·외부 API 결과)는 `textContent`로만. CSP·XSS 게이트가 이를 전제한다.
3. **DOM 순서 = 논리 순서**: 시각 배치는 **CSS로만** 바꾼다. 2단 레이아웃을 만들 때도 DOM은 논리 순서(입력 → 목록)를 유지해 화면읽기·키보드 탐색이 흔들리지 않게 한다.
4. **한 줄을 무한정 늘리지 않는다**: 넓은 화면에서 `max-width`만 키우면 입력·본문이 읽기 나빠진다. **남는 폭은 구조로 쓴다**(2단·다열). 현재 상한: `≥1100px`에서 1200px, `≥1600px`에서 1360px.
5. **상태 표시는 위계를 가진다**(`setNote`): `ok`=정상은 거의 안 보이게 · `info`=알아둘 것은 옅게 · `error`=놓치면 안 되는 것만 뚜렷하게. **성질이 다른 상태에 균일한 시각 무게를 주지 않는다.**
6. **어포던스는 모바일에서 성립해야 한다**: `title`(hover 툴팁)에만 담긴 정보는 휴대폰에서 **없는 것과 같다**. 근거·상세는 탭으로 펼치는 실제 요소로 준다.
7. **터치 영역·초점**: 버튼은 충분한 높이, `:focus-visible` 윤곽 유지. 모달은 초점 이동 + Esc 닫기 + 리스너 정리.

## 2. 반응형 측정 규율 (이 절이 이 문서의 핵심)

> **반응형 회귀는 "보는 것"이 아니라 "재는 것"으로 잡는다. 그리고 한 방향만 재면 절반을 놓친다.**

- **세로·가로 둘 다 측정한다.** 세로 화면은 폭이 제약이고 가로 화면은 높이가 제약이라, 높이 제약 결함은 세로에서 안 드러난다(§3 v0.41이 그 사례).
- **경계값을 재라**: 분기점 직전/직후(예: 1099/1100/1101)와 흔한 기기 폭(412·768·1024·1280·1480·1920).
- **가로 넘침은 0이어야 한다**: `documentElement.scrollWidth - clientWidth <= 0`을 모든 폭에서 확인.
- **측정은 수치로 남긴다**: "괜찮아 보임"이 아니라 렌더 rect·본문 폭·넘침 px를 표로 기록한다.
- 새 레이아웃 분기를 넣으면 `scripts/verify-editor-live.mjs`에 **영구 회귀 검사**를 추가한다.

## 3. CSS 결함군 등록부 (같은 형이 보이면 즉시 의심)

| 버전 | 결함 | 근본형 | 재발 방지 |
|---|---|---|---|
| 0.x | 선택 후 결과창이 안 닫힘 | `display`를 가진 클래스가 `[hidden]` 속성을 이김 | 전역 `[hidden]{display:none!important}` — 단건이 아니라 **결함군으로 박멸** |
| 0.26 | 세로 사진 미리보기 위쪽만 보임(압착) | 스크롤 flex 컨테이너에서 `overflow:hidden` 자식은 자동 최소크기가 0 → 내용이 넘치면 짜부라짐 | 수축 금지(`flex:0 0 auto`). **스크롤 flex 부모 안의 overflow 자식은 항상 shrink 여부를 명시** |
| 0.41 | 가로 태블릿에서 사진 위아래 잘림 | `display:grid; place-items:center`에서 `img{max-height:100%}`가 auto-sized 트랙에 대해 해석 안 됨 → 높이 제약 실패(**세로 화면에선 안 드러남**) | flex 중앙정렬 + `object-fit:contain` 안전망. **가로 뷰포트로도 측정** |
| 0.53 | 태블릿에서 본문이 780px 기둥에 갇히고 양옆이 빔 | 폭 상한이 단일 값 — 넓은 화면에 대한 구조가 없음 | `≥1100px` 2단 그리드 + 다열 + 단계적 상한. DOM 순서는 유지 |
| 0.53 | 짧은 여행에서 상태 배지가 뒤로가기 버튼과 겹침 | 절대배치 버튼줄이 차지할 공간을 컨테이너가 안 비워둠 | 히어로 `padding-top`으로 버튼줄 공간 예약. **absolute 요소 위에 흐르는 콘텐츠가 있으면 항상 예약** |
| 0.54 | "동기화됨" 두 단어가 전폭 배너 | 성질이 다른 상태에 균일한 시각 무게 | `setNote` ok/info/error 위계 + 내용 폭 알약 |

**결함 → 결함군 승격**: 위 근본형이 다른 화면에서 보이면 단건 수정하지 말고 형제 위치를 쓸고, 가능하면 라이브 측정 검사를 추가한다.

## 4. 검증 레시피

자동층: `npm run typecheck` · `npm run harness`(**`check-csp`** 포함 — 새 외부 호스트를 쓰면 `index.html`과 게이트의 `REQUIRED`를 **같은 커밋**에 갱신) · `npm run build`

라이브 측정(`node scripts/verify-editor-live.mjs` 확장):
```js
await page.setViewportSize({ width: W, height: H });
const m = await page.evaluate(() => ({
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  rect: document.querySelector('.타깃').getBoundingClientRect(),
}));
```
- 여러 폭을 훑고 **넘침 0**·의도한 배치(2단 여부)·요소 겹침 없음을 단언
- **콘솔 에러 0**까지 확인

시각 확인(수치로 못 잡는 것):
- 스크린샷을 실제로 열어 본다(비율·여백·겹침). 다만 "확인함"은 **수치 단언과 함께** 적는다.
- 색 대비·미세 정렬·실기기 촉감은 **사용자 확인 권장**으로 분리 표기(자동층이 아님).

## 5. 변경 후 의무

- `changelog.ts` +0.01(사용자 언어) · `researchLog.ts` · `docs/HANDOFF.md` · 새 교훈은 **이 문서 §3에 행 추가**
- 새 화면을 추가하면 `app/blueprint.ts` SCREENS에 등록(`check-blueprint`가 파일 실재를 대조)
