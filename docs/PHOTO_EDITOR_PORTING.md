# 사진 편집기 이식 명세 (PHOTO_EDITOR_PORTING)

> **목적**: 이 문서만 읽고 다른 앱(메디컬 앱 등)에 편집기를 **그대로 재현**할 수 있게 한다.
> 작성 2026-07-27 · 근거는 전부 `파일:줄` 실측. 코드 변경 0건.
>
> **읽는 법**: §1~§6은 *무엇을 만드는가*(재현에 필요한 전부), §7~§8은 *왜 그렇게 만드는가*(이걸 모르면 이식하면서 같은 결함을 다시 만든다), §9는 *이식하면 안 되는 것*, §10은 메디컬 앱 특수 고려.

---

## 0. 이식 대상과 비용

| 파일 | 줄 | 역할 | 이식 난이도 |
|---|---|---|---|
| `src/media/pixelops.ts` | 198 | 픽셀 연산(색·샤픈·힐·그레인·원근워프) | **그대로 복사 가능** — 순수 함수, DOM 없음 |
| `src/media/editor-core.ts` | 375 | `EditState`·크롭 기하·bake 파이프라인 | **거의 그대로** — `bakeToCanvas`만 DOM(canvas) |
| `src/ui/photoEditor.ts` | 895 | 편집 모달 UI(제스처·이력·미리보기) | **재작성 권장** — UI 프레임워크에 종속 |
| `src/media/compress.ts` | 78 | 저장용 표시본·썸네일 생성 | 선택 — 저장 정책에 따라 |
| `src/media/exif.ts` | 144 | JPEG EXIF(촬영시각·GPS) 파서 | 선택 — 무의존 |

> ✅ **외부 런타임 의존성 0.** `pixelops.ts`·`editor-core.ts` 어디에도 npm 패키지 import가 없다(실측 확인). 브라우저 `canvas` 2D와 `ImageBitmap`만 쓴다. 즉 **이식 비용의 대부분은 UI 재작성**이고, 알고리즘 층은 파일 두 개 복사로 끝난다.

**최소 이식 = `pixelops.ts` + `editor-core.ts` (573줄).** 이 둘이 편집기의 "두뇌"이고, 나머지는 그것을 부르는 껍데기다.

---

## 1. 설계 원칙 다섯 (이걸 어기면 나머지가 무너진다)

1. **비파괴** — 원본 Blob은 **읽기만** 한다. 결과는 항상 새 Blob. 메타데이터(촬영시각·GPS)는 **원본에서** 읽는다(압축 후에는 사라진다).
2. **WYSIWYG 단일 경로** — 미리보기와 최종 저장이 **같은 `bakeToCanvas`**를 쓴다. 미리보기 전용 지름길(CSS `filter` 등) **금지**. 두 경로를 두면 "보이는 것과 저장된 것이 다르다"가 반드시 생긴다.
3. **`EditState`는 순수 JSON 값** — DB 저장·백업 왕복·재편집 복원에 **그대로** 쓰인다. 함수·DOM 참조·비직렬화 값 금지.
4. **모든 조정은 0이 "변화 없음"인 델타** — `brightness: 0`이 원본. `1.0`이 원본인 배율 모델을 섞지 마라. 초기화·프리셋·`isIdentity` 판정이 전부 이 규약에 의존한다.
5. **무편집이면 재인코딩 금지** — `isIdentity(state)`면 원본 Blob을 그대로 쓴다. 안 그러면 열었다 닫기만 해도 JPEG 세대손실이 쌓인다.

---

## 2. 데이터 모델 — `EditState`

```ts
interface ColorAdjust {
  brightness: number;  // -1..1  곱연산 밝기
  contrast: number;    // -1..1
  saturation: number;  // -1..1  (-1 = 흑백)
  warmth: number;      // -1..1  (+따뜻 / -차가움)
  exposure: number;    // -1..1  2^x 스탑
}

interface EditState extends ColorAdjust {
  rotate90: 0 | 1 | 2 | 3;      // 90° CW 횟수
  flipH: boolean;                // 좌우 반전
  angle: number;                 // 수평 보정(도, -15..15)
  quad: Quad | null;             // 원근 펴기 4점 — TL,TR,BR,BL 순서 고정
  aspect: 'orig'|'1:1'|'4:5'|'16:9'|'free';
  zoom: number;                  // 1..3
  panX: number; panY: number;    // -1..1  크롭 창 이동
  freeCrop: {x,y,w,h} | null;    // aspect='free'일 때
  heals: {x,y,r}[];              // 잡티 지점(적용 순서대로)
  vignette: number;              // 0..1
  sharpenAmt: number;            // 0..1
  grainAmt: number;              // 0..1
}
```

**모든 좌표(`quad`·`freeCrop`·`heals`)는 0..1 정규화**다. 픽셀 좌표를 저장하면 해상도가 바뀌는 순간 깨진다. `heals[].r`은 **"창 폭 대비 비율"** — 그래야 화면 체감 브러시 크기가 해상도와 무관하게 유지된다.

**프리셋**은 `Partial<EditState>` 맵이다. 이 저장소의 값(절제 기조 — 사진 원색 존중):

| 이름 | 값 |
|---|---|
| 자연 | `saturation +0.10, contrast +0.06, brightness +0.02` |
| 필름 | `warmth +0.18, contrast +0.10, saturation −0.08, grain 0.18, vignette 0.15` |
| 흑백 | `saturation −1, contrast +0.12` |
| 따뜻 | `warmth +0.30, brightness +0.04` |
| 차분 | `warmth −0.18, saturation −0.12, contrast +0.04` |

---

## 3. 좌표계 계약 — **이 문서의 핵심**

편집기 결함의 대부분이 여기서 난다. 공간이 **셋**이고 이름을 정확히 구분해야 한다.

```
원본 픽셀 (srcW × srcH)
   │  rotate90 (+flipH, +angle)
   ▼
rd = rotatedDims(srcW, srcH, rotate90)        ← 회전 후 축 크기
   │  quad(원근 펴기)가 있으면
   ▼
gd = quad ? quadOutputDims(quad, rd.w, rd.h) : rd    ← **기하 공간**
   │  resolveWindow(gd.w, gd.h, state) = 크롭 창
   ▼
출력 (outW × outH)
```

> 🔴 **`heals`·`freeCrop`은 `gd` 공간의 0..1 좌표다.** `rd`가 아니다. `quad`만 `rd` 공간이다(펴기의 입력이므로).

```ts
rotatedDims(w, h, r) = r % 2 === 1 ? {w: h, h: w} : {w, h}

quadOutputDims(q, W, H):           // 마주보는 변 길이의 평균 (문서 스캐너 관례)
  d(a,b) = hypot((a.x-b.x)*W, (a.y-b.y)*H)
  w = (d(q0,q1) + d(q3,q2)) / 2
  h = (d(q0,q3) + d(q1,q2)) / 2
```

### 3-1. 회전·반전 시 **함께 변환**해야 하는 것

회전만 하고 좌표를 안 옮기면 기존 잡티·크롭·펴기 모서리가 엉뚱한 곳으로 간다.

```ts
rotateHeals90(h)    = {x: 1 - h.y,          y: h.x,   r: h.r}
flipHealsH(h)       = {x: 1 - h.x,          y: h.y,   r: h.r}
rotateFreeCrop90(f) = {x: 1-(f.y+f.h), y: f.x, w: f.h, h: f.w}
flipFreeCropH(f)    = {x: 1-(f.x+f.w), y: f.y, w: f.w, h: f.h}

rotateQuad90(q):  r(p) = {x: 1 - p.y, y: p.x}
                  return [r(q[3]), r(q[0]), r(q[1]), r(q[2])]   // 새 TL=옛 BL …
flipQuadH(q):     f(p) = {x: 1 - p.x, y: p.y}
                  return [f(q[1]), f(q[0]), f(q[3]), f(q[2])]   // TL↔TR, BL↔BR
```

**`quad` 변환에서 점만 회전하고 배열 순서를 안 바꾸면 TL/TR/BR/BL 의미가 깨진다** — 사영 계수가 뒤집혀 이미지가 접힌다.

### 3-2. 크롭 창

```ts
cropWindow(W, H, aspect, zoom, panX, panY):
  A  = aspectRatio(aspect, W, H)          // 'orig'|'free' → W/H
  w0 = W; h0 = w0 / A
  if (h0 > H) { h0 = H; w0 = h0 * A }     // (W,H)에 내접하는 최대 창
  w = w0 / zoom;  h = h0 / zoom
  cx = W/2 + panX * (W - w)/2             // pan은 -1..1 → 가장자리까지
  cy = H/2 + panY * (H - h)/2
  return {x: cx - w/2, y: cy - h/2, w, h}

resolveWindow(W, H, s) =
  (s.aspect === 'free' && s.freeCrop)
    ? {x: fc.x*W, y: fc.y*H, w: fc.w*W, h: fc.h*H}
    : cropWindow(W, H, s.aspect, s.zoom, s.panX, s.panY)
```

### 3-3. 수평 보정(`angle`)의 특이 규약

`angle`은 **창 계산에 들어가지 않는다.** 대신 기하 단계에서 "커버 확대"로 처리해 회전으로 생긴 빈 모서리를 덮는다.

```ts
angleCoverScale(w, h, deg):
  t = |deg| * π/180;  if (t === 0) return 1
  r = max(w/h, h/w)
  return cos(t) + sin(t) * r
```

**탭 좌표 역투영과 bake 재투영이 같은 `resolveWindow`를 쓰기 때문에** 이 비대칭이 일관을 유지한다. 이 대칭을 깨지 마라.

### 3-4. 원근 펴기 — 사영 계수 (Heckbert)

단위 정사각형 `(s,t) ∈ (0..1)²` → `quad`(px 공간) 사영. **출력에서 원본을 찾아 샘플하는 역매핑**이다.

```
x = (a·s + b·t + c) / (g·s + h·t + 1)
y = (d·s + e·t + f) / (g·s + h·t + 1)
```

```ts
squareToQuadCoeffs(q, W, H):
  (x0,y0)=q0*·, (x1,y1)=q1*·, (x2,y2)=q2*·, (x3,y3)=q3*·   // 각 점에 W,H 곱
  dx1 = x1-x2;  dy1 = y1-y2
  dx2 = x3-x2;  dy2 = y3-y2
  sx  = x0-x1+x2-x3;  sy = y0-y1+y2-y3
  g = h = 0
  if (|sx| > 1e-9 || |sy| > 1e-9):
     den = dx1*dy2 - dx2*dy1
     g = (sx*dy2 - dx2*sy) / den
     h = (dx1*sy - sx*dy1) / den
  a = x1-x0 + g*x1;   b = x3-x0 + h*x3;   c = x0
  d = y1-y0 + g*y1;   e = y3-y0 + h*y3;   f = y0
```

> `|sx|,|sy| ≤ 1e-9` 분기는 **quad가 평행사변형일 때 `den`이 0이 되는 것**을 막는다. 빼면 NaN이 화면 전체로 번진다.

---

## 4. bake 파이프라인 — **순서가 계약이다**

```
bakeToCanvas(src, srcW, srcH, state, maxEdge) → HTMLCanvasElement

0) 배율 먼저 정한다  ← 성능의 전부
   rd    = rotatedDims(srcW, srcH, rotate90)
   gd    = quad ? quadOutputDims(quad, rd.w, rd.h) : rd
   win   = resolveWindow(gd.w, gd.h, state)
   scale = min(1, maxEdge / max(win.w, win.h))

1) 기하: canvas(rd.w*scale × rd.h*scale)
   translate(W/2, H/2)
   rotate(rotate90*π/2 + angle*π/180)
   cover = angleCoverScale(rd.w, rd.h, angle)
   scale(flipH ? -cover : cover, cover) × scale
   drawImage(src, -srcW/2, -srcH/2)

1.5) 원근 펴기 (quad가 있을 때만, 픽셀 패스 1회)
   coeffs = squareToQuadCoeffs(quad, g.width, g.height)
   warped = warpPerspective(imgData, g.w, g.h, gd.w*scale, gd.h*scale, coeffs)

2) 크롭 → 출력 캔버스(win.w*scale × win.h*scale)
   drawImage(geo, win.x*scale, win.y*scale, win.w*scale, win.h*scale, 0,0, outW,outH)

3) 픽셀 조정 — **순서 고정**
   ① heals   (원색 기준으로 먼저 메꾼다)
   ② 색 조정 (applyColorAdjust)
   ③ 샤픈
   ④ 그레인  (고정 시드 PRNG)

4) 비네팅 — 방사형 그라데이션(픽셀 루프 아님)
```

**heal 재투영**(gd 정규화 → 출력 px):

```ts
hx = ((hp.x * gd.w - win.x) / win.w) * outW
hy = ((hp.y * gd.h - win.y) / win.h) * outH
hr = ((hp.r * gd.w) / win.w) * outW
if (창 밖) continue        // hx < -hr || hy < -hr || hx > outW+hr || hy > outH+hr
```

### 왜 이 순서인가

| 단계 | 이유 |
|---|---|
| **0번이 맨 앞** | 기하 중간 캔버스를 원본 전해상도로 만들면 12MP 사진에서 **슬라이더 틱마다 수십 MB 할당** → 모바일 버벅임의 근본 원인이었다(v0.24) |
| heal이 색보정보다 **먼저** | 잡티는 **원색 기준**으로 메꿔야 자연스럽다. 색을 바꾼 뒤 메꾸면 주변 링 샘플이 이미 변형된 색이다 |
| 샤픈이 색보정 **뒤** | 대비를 올린 뒤 샤픈해야 의도한 강도가 나온다 |
| 그레인이 **맨 뒤** | 필름 질감은 최종 화면 위에 얹히는 것 |
| 비네팅이 픽셀 루프 **밖** | 그라데이션 `fillRect`가 픽셀 루프보다 훨씬 싸다 |

---

## 5. 픽셀 연산 사양

전부 **순수 함수, DOM 없음 → 유닛테스트 대상**이다.

### 5-1. 색 조정 (제자리 수정)

```
bright = (1 + brightness) * 2^exposure     // 밝기×노출 결합 곱
cont   = 1 + contrast
sat    = 1 + saturation
warmR  = warmth * 28;  warmB = -warmth * 28

각 픽셀:
  r,g,b ×= bright
  r,g,b  = (v - 128) * cont + 128                    // 중간값 기준 대비
  lum    = 0.299r + 0.587g + 0.114b                  // Rec.601 휘도
  r,g,b  = lum + (v - lum) * sat                     // 채도 보간
  r += warmR;  b += warmB                            // 색온도(선형)
  clamp 0..255
```

`isNoAdjust(adj)`면 **루프를 아예 돌지 않는다**(조기 반환).

### 5-2. 샤픈 — 언샤프 마스크

```
3×3 평균 블러와의 차이를 amount×2 만큼 증폭
v = data[i] + (data[i] - blur) * amount * 2
가장자리 1픽셀은 건너뜀 (y,x ∈ 1..height-2, 1..width-2)
```

> ⚠️ **새 버퍼를 반환한다**(입력 불변). 제자리 수정하면 이미 샤픈된 값이 이웃의 블러 계산에 들어가 결과가 번진다.

### 5-3. 스팟 힐링 (잡티 제거)

```
링 반경 = r * 1.25, 16방향 샘플 채취
반경 r 안의 각 픽셀에 대해:
   가중치 = 1 / ((x-rx)² + (y-ry)² + 1)      // 역거리제곱 (+1은 0나눗셈 방지)
   보간색 = Σ(색 × 가중치) / Σ가중치
   t = d / r;  a = 1 - t²                     // 중심 강하게, 가장자리 자연 감쇠
   결과 = 원색 × (1-a) + 보간색 × a
r < 1이면 즉시 반환
```

### 5-4. 그레인

```
strength = amount * 26
픽셀마다 n = (rand() - 0.5) * 2 * strength   // 모노 노이즈(RGB 동일값 가산)
```

> 🔴 **`rand`는 반드시 주입 가능해야 하고, bake는 고정 시드 PRNG를 넘긴다.** `Math.random`이면 미리보기가 갱신마다 **어른거리고** 저장 재현성이 깨진다.

```ts
mulberry32(seed):                    // 32bit 결정적 PRNG
  a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
// bake가 쓰는 시드: 0x51ab_cafe
```

### 5-5. 원근 워프 (역매핑 + bilinear)

```
출력 (i,j) → s = (i+0.5)/dw, t = (j+0.5)/dh       // 픽셀 중심 관례
den = g·s + h·t + 1
x = (a·s + b·t + c)/den - 0.5                      // -0.5: 연속좌표 → 샘플 인덱스
y = (d·s + e·t + f)/den - 0.5
bilinear 샘플, 경계는 가장자리 클램프, 알파 포함 4채널
```

> `-0.5` 두 줄과 `+0.5` 두 줄이 **짝**이다. 하나만 빼면 결과가 반 픽셀 밀린다 — 눈에 잘 안 보이지만 반복 편집에서 누적된다.

---

## 6. UI 상태기계 (재작성하더라도 이 규칙은 옮긴다)

### 6-1. 2단계 미리보기 — 성능의 핵심

| 상수 | 값 | 뜻 |
|---|---|---|
| `PREVIEW_MAX` | 900 | 손 뗀 뒤 정밀 미리보기 |
| `FAST_MAX` | 420 | 제스처 **중** 임시 해상도 |
| `OUTPUT_MAX` | 2400 | 편집 결과 상한(이후 압축이 표시본 생성) |
| `MIN_CROP` | 0.08 | 자유 크롭 최소 변 |

> **규칙**: 연속 제스처는 `input` → `repaint(fast=true)`, `change`/`pointerup` → `repaint()`.
> 새 연속 제스처를 추가하면 **반드시 이 패턴을 따른다.**
> `PREVIEW_MAX`는 **표시 폭 이상**이어야 한다(작으면 미리보기가 흐리다).

### 6-2. 실행취소 — 전역 이력 스택 하나

```
history: EditState[]  (최대 50, 넘으면 shift)

이산 조작(회전·반전·비율·프리셋·잡티 탭·초기화)
   → 조작 **직전** pushHistory()

연속 제스처(슬라이더·팬·핀치·크롭 드래그)
   → 시작 시  pendingSnap = clone(state)
   → 종료 시  commitPending():
        if (pendingSnap && JSON.stringify(pendingSnap) !== JSON.stringify(state))
            pushHistory(pendingSnap)
        pendingSnap = null
```

> **값이 실제로 바뀐 경우만 커밋한다** — 안 그러면 슬라이더를 잡았다 놓기만 해도 빈 undo 단계가 쌓인다.
> `undo()`는 먼저 `commitPending()`을 부른다(진행 중 제스처를 먼저 확정).

### 6-3. 제스처 배타 규칙 (뷰어)

```
scale ≤ 1 : 단일 드래그 = 스와이프 넘기기  (|dx| > 48 && |dx| > 1.5·|dy|)
scale > 1 : 단일 드래그 = 팬
두 손가락 : 항상 핀치
```

확대는 `zoomAround`(화면점 고정 — 휠·핀치·더블탭 공통) + `clampPan`(화면 밖 이탈 방지). 사진을 넘기면 리셋.

### 6-4. 그 밖의 UI 계약

- **닫기 보호**: `!isIdentity(state)`면 ✕/Esc는 confirm.
- **리스너 정리**: 모달이 문서에 단 `keydown`은 `finish()`에서 **반드시** 제거(누수 결함 실제로 겪음).
- **길게 누르는 버튼**(원본 비교): `contextmenu` preventDefault + `touch-action: none`.
- **프리셋 활성 표시**: `aria-pressed`. 판정은 `textContent` 비교가 아니라 **상태 기준 헬퍼**로.
- **스테이지 레이아웃**: 스크롤 flex 컨테이너 안의 `overflow:hidden` 자식은 자동 최소크기가 0이라 짜부라진다 → `flex: 0 0 auto`(수축 금지) 명시.

---

## 7. 성능·메모리 규율

1. **전해상도 중간 캔버스 금지** — bake 0단계의 `scale`이 이것을 강제한다.
2. **픽셀 루프는 출력 크기에서만** — 크롭 **전** 전체 이미지에 픽셀 연산을 걸지 마라.
3. **`needsPixels` 게이트** — 색·샤픈·그레인·heal이 모두 비어 있으면 `getImageData`/`putImageData` 자체를 건너뛴다. 이 왕복이 가장 비싸다.
4. **비네팅은 픽셀 루프 밖**(그라데이션 fill).
5. `createImageBitmap(blob, { imageOrientation: 'from-image' })` + 폴백 — 안 하면 **세로 사진이 눕는다**(v0.23 실제 결함).

---

## 8. 결함 등록부 — **왜 이 규칙들이 있는가**

이식하는 사람이 "이 제약 왜 있지?" 하고 풀어버리는 것을 막기 위한 절이다. 전부 실제로 밟았다.

| 결함 | 근본형 | 규칙 |
|---|---|---|
| 미리보기 흐림 | 미리보기 해상도 < 표시 폭 | `PREVIEW_MAX ≥ 표시 폭` |
| 세로 사진 눕혀 표시 | EXIF Orientation 미반영 | `imageOrientation:'from-image'` + 폴백 |
| 슬라이더 버벅임 | 중간 캔버스가 원본 전해상도 | bake 0단계 프리스케일 |
| 자유 크롭 서/북 핸들이 **반대 변**을 늘림 | 클램프를 `x`/`w`에 걸어 변이 결합됨 | `resizeFreeCrop`을 **변 좌표(left/right/top/bottom) 기준**으로 클램프 |
| 그레인 어른거림 | 프레임마다 `Math.random` | 고정 시드 PRNG |
| Esc 리스너 누수 · 사진 탭 시 닫힘 | 닫기 경로별 정리 누락 · 이벤트 버블 | `close()` 한 곳에서 일괄 제거 · `stopPropagation` |
| 세로 사진 미리보기 위쪽만 보임 | 스크롤 flex 안 `overflow` 자식의 자동 최소크기 0 | `flex: 0 0 auto` |
| 가로 태블릿에서 전체보기 상하 잘림 | `display:grid; place-items:center`에서 `img{max-height:100%}`가 auto 트랙에 대해 해석 안 됨 | **flex 중앙정렬** + `object-fit: contain` 안전망 |

> **자유 크롭 클램프**가 가장 자주 재발하는 형태다. `x`와 `w`를 각각 클램프하면 서쪽 핸들을 경계 밖으로 끌 때 동쪽 변이 따라 늘어난다. **반드시 네 변 좌표로 계산하고 마지막에 `w = right - left`로 환산**한다.

```ts
resizeFreeCrop(f, mode, dx, dy, minSize):
  if (mode === 'move') → x,y만 이동하고 0..1-w 범위로 클램프
  left=f.x; top=f.y; right=f.x+f.w; bottom=f.y+f.h
  if (mode has 'w') left   = clamp(f.x+dx,      0,          right - minSize)
  if (mode has 'e') right  = clamp(f.x+f.w+dx,  left+minSize, 1)
  if (mode has 'n') top    = clamp(f.y+dy,      0,          bottom - minSize)
  if (mode has 's') bottom = clamp(f.y+f.h+dy,  top+minSize,  1)
  return {x: left, y: top, w: right-left, h: bottom-top}
```

---

## 9. 🔴 이식하면 **안 되는** 것 — 이 저장소에 남아 있는 결함

이 명세를 쓰며 좌표계를 대조하다 **실제 불일치 하나**를 찾았다. 이식하면서 그대로 옮기지 마라.

### 잡티 탭 좌표가 `rd` 공간에 기록되는데, bake는 `gd` 공간으로 재투영한다

```ts
// src/ui/photoEditor.ts:466-471  — 탭을 기록할 때
const rd  = rotatedDims(w, h, state.rotate90);
const win = resolveWindow(rd.w, rd.h, state);      // ← rd
state.heals.push({ x: (win.x + u*win.w) / rd.w, … });

// src/media/editor-core.ts:298-299, 348-350  — 구울 때
const gd  = s.quad ? quadOutputDims(s.quad, rd.w, rd.h) : rd;
const win = resolveWindow(gd.w, gd.h, s);          // ← gd
const hx  = ((hp.x * gd.w - win.x) / win.w) * outW;
```

실측: **`photoEditor.ts`는 `quadOutputDims`를 한 번도 부르지 않는다**(grep 0건). 즉 편집기 UI는 `gd` 공간의 존재를 모른다.

- **`quad`가 없으면** `gd === rd`라 일치한다 → 지금까지 안 드러났다.
- **`quad`가 있으면**(원근 펴기 적용 후 잡티를 찍으면) 기록 공간과 굽는 공간이 달라 **잡티가 엉뚱한 곳에 찍힌다.**

이건 이 저장소의 편집기 헌장 §4가 **예견해 둔 바로 그 형태**다 — *"새 기하 변형을 넣으면 이 치환을 빠뜨리지 말 것"*. 헌장에 적어 놓고 UI 쪽 한 곳을 빠뜨렸다.

> **이식 시 처방**: 화면 좌표 → 상태 좌표 변환을 **순수 함수 하나로 뽑고**(`screenToGeo(u, v, state, srcW, srcH)`), bake와 **같은 `gd` 계산**을 쓰게 한다. 두 곳에 손으로 구현하면 드리프트는 시간 문제다.
>
> **정직**: 이 결함은 코드 대조로 확인했고 **실기기 재현은 하지 않았다.** 사용자에게 보이는 어긋남의 크기는 quad가 원본 사각형에서 얼마나 벗어났는지에 비례한다.

---

## 10. 메디컬 앱 이식 시 반드시 다시 판단할 것

이 편집기는 **여행 사진**을 전제로 만들어졌다. 의료 이미지는 전제가 다르다. 아래는 **결정이 필요한 지점**이지 답이 아니다.

| 항목 | 여행 앱의 선택 | 메디컬에서 다시 물어야 하는 것 |
|---|---|---|
| **손실 압축** | WebP 재인코딩 허용 | 🔴 **진단용 이미지에 손실 압축이 허용되는가?** 아니라면 bake 결과를 PNG 등 무손실로 내보내고 `compress.ts`를 이식하지 마라 |
| **색 조정** | 자유롭게 허용 | 🔴 **밝기·대비 조작이 판독을 바꾸는가?** 그렇다면 「조정값을 기록에 남기고 원본과 항상 나란히 보여주기」가 필요할 수 있다 |
| **잡티 제거(heal)** | 좋은 기능 | 🔴 **의료 이미지에서 픽셀을 지어내는 연산**이다. 병변을 지울 수 있다. 기본 비활성 또는 제외를 강하게 권한다 |
| **그레인·비네팅** | 감성 효과 | 제외 권장 — 진단 가치가 0이고 잡음만 더한다 |
| **원근 펴기** | 사진 보정 | 문서(동의서·검사지) 촬영에는 유용. 해부 구조에는 **기하 왜곡**을 만든다 |
| **EXIF/메타** | GPS는 서버 미전송 | 🔴 **PHI(환자 식별 정보)가 메타에 있을 수 있다.** DICOM이면 태그 처리가 완전히 다른 문제다 — 이 파서(`exif.ts`)는 JPEG EXIF 전용이다 |
| **원본 보존** | 로컬 원본 유지 | 의료기록 보존 의무가 있다면 **원본 파기 금지가 법적 요건**일 수 있다 |
| **`EditState` 감사추적** | 없음 | 누가·언제·무엇을 조정했는지 남겨야 할 수 있다. `EditState`가 JSON이라 감사 로그에 그대로 넣기 쉽다 — **이 설계의 이점** |

> **가장 중요한 한 줄**: 이 편집기의 `EditState`는 **비파괴 + JSON 직렬화**다. 즉 "원본은 그대로 두고 조정 내역만 기록한다"가 구조적으로 보장된다. 의료 맥락에서 이건 우연한 장점이 아니라 **가장 값진 부분**이다 — 원본 픽셀을 덮어쓰는 편집기를 쓰는 것보다 훨씬 안전하다.

---

## 11. 검증 레시피 (이식 후 이걸로 확인한다)

**자동층**
1. **순수 함수 유닛** — `pixelops`(색·샤픈·힐·그레인·워프)와 `editor-core`의 기하 함수(`resizeFreeCrop`·`cropWindow`·`rotate*`·`squareToQuadCoeffs`). 이 저장소는 `resizeFreeCrop`에 5건을 걸어 두었다.
2. **비공허 확인** — 알려진 실패를 주입해 **RED가 나는지** 본 뒤에만 그 테스트를 믿는다.
3. **왕복 검사** — `rotateHeals90`을 4번 적용하면 원위치여야 한다. `flipHealsH`는 2번이면 원위치. `rotateQuad90` 4회도 마찬가지.

**라이브(헤드리스 브라우저)**
- 슬라이더 조작 후 **캔버스 픽셀 read-back으로 실제 변화 확인**(스크린샷 육안 아님).
- 원본 비교 홀드 왕복 → 픽셀이 원복되는지.
- 닫기 confirm, 배치 진행, **콘솔 에러 0**.
- ⚠️ 함정: `적용` 직후 모달 존재 확인은 **이전 모달**과 매칭된다 → 파일 라벨 텍스트(`2/2`)로 대기할 것.

**수동(자동화 불가 — 그렇게 표기한다)**
- 실기기 핀치 줌·긴 누름 비교, 대용량(12MP+) 체감 속도, iOS Safari 캔버스 메모리.

---

## 12. 이식 순서 권고

1. **`pixelops.ts` 복사 → 유닛테스트 먼저 이식.** 순수 함수라 즉시 검증된다. 여기서 §9 결함과 무관하게 신뢰 기반이 생긴다.
2. **`editor-core.ts` 복사 → 기하 함수 유닛 이식.** `bakeToCanvas`만 canvas 의존이므로 마지막에.
3. **§10 표를 먼저 결정.** heal·grain·vignette를 뺄 거면 `EditState`에서 지우고 시작하는 편이 낫다(나중에 빼면 저장된 상태와 호환이 깨진다).
4. **UI는 새로 쓰되 §6의 세 규칙(2단계 미리보기·이력 모델·제스처 배타)은 그대로 옮긴다.**
5. **§9의 `screenToGeo` 순수 함수를 처음부터 만든다** — 이 저장소가 두 곳에 손으로 구현해 어긋난 자리다.

---

## 부록 — 실측 근거 파일

`src/media/pixelops.ts` · `src/media/editor-core.ts` · `src/ui/photoEditor.ts` · `src/media/compress.ts` · `src/media/exif.ts` · `src/ui/photoViewer.ts` · `.claude/skills/photo-editor-dev/SKILL.md` · `tests/unit/pixelops.test.ts` · `tests/unit/exif.test.ts`
