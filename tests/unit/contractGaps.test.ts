// tests/unit/contractGaps.test.ts — **계약 문서에는 있는데 코드에 없던 것들.**
//
// 2026-07-27 동영상 설계 조사에서 부산물로 드러난 결함 묶음이다. 공통점이 하나였다:
// **문서가 "이렇게 한다"고 적어 뒀는데 코드가 따라가지 않았다.** 영상과 무관하게 이미 있었고,
// 조사를 안 했으면 계속 몰랐을 것이다.
//
//  ① 재시도 백오프  — `SYNC_PROTOCOL.md:31`이 5초/15초/60초/5분/15분을 규정했는데
//                     `markFail`은 `attempts`를 증가만 시키고 **아무도 읽지 않았다**(grep 0건)
//  ② quota 사전점검 — `MEDIA_PIPELINE.md:42-43`이 요구했는데 인테이크에 없었다
//  ③ ZIP 한계      — 4GiB/65,535개를 넘으면 **오류가 아니라 조용한 손상**이었다
//  ④ 편집기 좌표계  — 탭은 rd 공간에 기록되는데 bake는 gd로 재투영했다
//
// 넷 다 「이름이 있는 것과 불리는 것은 다르다」의 변주다(M-0036 §①과 같은 근본형).

import { describe, it, expect } from 'vitest';
import { retryDelayMs, isRetryDue, RETRY_SCHEDULE_MS } from '../../src/sync/merge';
import { quotaVerdict, estimateLocalBytes, humanBytes, BLOCK_RATIO } from '../../src/domain/media/quota';
import { zipCapacityError, ZIP_MAX_ENTRIES } from '../../src/services/zip';
import { screenToGeo, geoDims, freshEdit, type Quad } from '../../src/media/editor-core';

describe('① 재시도 백오프 — 계약(SYNC_PROTOCOL.md:31)을 코드가 따라간다', () => {
  const noJitter = (): number => 0.5; // 정확히 base

  it('실패 횟수마다 계약된 간격을 준다(5초 · 15초 · 60초 · 5분 · 15분)', () => {
    expect([1, 2, 3, 4, 5].map((n) => retryDelayMs(n, noJitter))).toEqual([...RETRY_SCHEDULE_MS]);
  });

  it('5회를 넘으면 15분에서 멈춘다(무한히 늘어나지 않는다)', () => {
    expect(retryDelayMs(99, noJitter)).toBe(900_000);
  });

  it('jitter는 ±20%인데 **계약보다 빨라지지는 않는다**(하한 80%)', () => {
    expect(retryDelayMs(1, () => 0)).toBe(4_000); // 5초의 80%
    expect(retryDelayMs(1, () => 1)).toBe(6_000); // 5초의 120%
  });

  it('0회·음수는 1회로 본다(첫 실패도 대기가 있다)', () => {
    expect(retryDelayMs(0, noJitter)).toBe(5_000);
    expect(retryDelayMs(-3, noJitter)).toBe(5_000);
  });

  it('대기 중이면 이번 회차에 밀지 않는다', () => {
    expect(isRetryDue({ nextRetryAt: '2026-07-27T10:00:00.000Z' }, '2026-07-27T09:59:59.000Z')).toBe(false);
    expect(isRetryDue({ nextRetryAt: '2026-07-27T10:00:00.000Z' }, '2026-07-27T10:00:00.000Z')).toBe(true);
  });

  it('**표식이 없으면 민다** — 옛 큐 항목이 영영 안 나가면 안 된다', () => {
    expect(isRetryDue({}, '2026-07-27T10:00:00.000Z')).toBe(true);
  });

  it('못 읽는 시각으로 막지 않는다(모르는 값이 기억을 가두지 않게)', () => {
    expect(isRetryDue({ nextRetryAt: 'nope' }, '2026-07-27T10:00:00.000Z')).toBe(true);
  });
});

describe('② quota 사전점검 — 넘칠 것 같으면 **미리** 막는다', () => {
  const GB = 1024 ** 3;

  it('여유가 넉넉하면 침묵한다(§8 — 정상은 말하지 않는다)', () => {
    const v = quotaVerdict(10 * 1024 ** 2, { usage: 1 * GB, quota: 10 * GB });
    expect(v.level).toBe('ok');
    expect(v.message).toBe('');
    expect(v.allow).toBe(true);
  });

  it('한도를 넘길 것 같으면 막고 **숫자로 이유를 말한다**', () => {
    const v = quotaVerdict(1 * GB, { usage: 9.5 * GB, quota: 10 * GB });
    expect(v.allow).toBe(false);
    expect(v.level).toBe('blocked');
    expect(v.message).toContain('저장 공간이 부족해요');
    expect(v.message).toContain('GB'); // 지금 얼마 쓰는지·여유가 얼마인지
  });

  it('80%를 넘으면 경고하되 **진행한다**(겁주는 것은 거짓 경보만큼 나쁘다)', () => {
    const v = quotaVerdict(0.5 * GB, { usage: 8 * GB, quota: 10 * GB });
    expect(v.level).toBe('tight');
    expect(v.allow).toBe(true);
    expect(v.message).toContain('곧 찹니다');
  });

  it('🔴 **브라우저가 모르면 막지 않는다** — 미지원 기기에서 앱을 못 쓰게 되면 안 된다', () => {
    const v = quotaVerdict(1 * GB, { usage: null, quota: null });
    expect(v.level).toBe('unknown');
    expect(v.allow).toBe(true);
    expect(v.message).toBe(''); // 모르는 것을 문제로도 정상으로도 반올림하지 않는다
  });

  it('차단 기준은 95%다(텍스트 기억이 계속 저장될 여유를 남긴다)', () => {
    expect(BLOCK_RATIO).toBe(0.95);
    expect(quotaVerdict(0, { usage: 0.94 * GB, quota: 1 * GB }).allow).toBe(true);
    expect(quotaVerdict(0, { usage: 0.96 * GB, quota: 1 * GB }).allow).toBe(false);
  });

  it('필요 바이트는 **넉넉히** 잡는다(적게 잡아 통과시키면 커밋에서 터진다)', () => {
    expect(estimateLocalBytes(1000)).toBeGreaterThan(1000);
  });

  it('크기는 사람이 읽는 단위로', () => {
    expect(humanBytes(500)).toBe('500B');
    expect(humanBytes(1024 ** 2 * 1.5)).toBe('1.5MB');
    expect(humanBytes(1024 ** 3 * 2.25)).toBe('2.3GB');
  });
});

describe('③ ZIP 한계 — 조용한 손상 대신 **정직한 거부**', () => {
  const entry = (n: number) => ({ name: 'x', data: { length: n } });

  it('담을 수 있으면 통과', () => {
    expect(zipCapacityError([entry(1000), entry(2000)])).toBeNull();
  });

  it('4GB를 넘으면 거절하고 **왜인지 말한다**', () => {
    const msg = zipCapacityError([entry(5 * 1024 ** 3)]);
    expect(msg).toContain('너무 커요');
    expect(msg).toContain('4GB');
    expect(msg).toContain('나눠서'); // 무엇을 하면 되는지
  });

  it('파일 수가 65,535개를 넘으면 거절한다', () => {
    const many = Array.from({ length: ZIP_MAX_ENTRIES + 1 }, () => entry(1));
    expect(zipCapacityError(many)).toContain('너무 많아요');
  });

  it('경계값은 통과한다(불필요하게 막지 않는다)', () => {
    expect(zipCapacityError(Array.from({ length: ZIP_MAX_ENTRIES }, () => entry(1)))).toBeNull();
  });
});

describe('④ 편집기 좌표계 — 화면→상태와 bake가 **같은 공간**을 본다', () => {
  const SRC_W = 4000;
  const SRC_H = 3000;
  /** 원근이 있는 사다리꼴 — gd ≠ rd가 되도록 위쪽을 좁힌다. */
  const QUAD: Quad = [
    { x: 0.15, y: 0.1 }, { x: 0.85, y: 0.1 }, { x: 1.0, y: 0.9 }, { x: 0.0, y: 0.9 },
  ];

  it('전제: quad가 있으면 기하 공간이 회전 후 크기와 **다르다**', () => {
    const s = { ...freshEdit(), quad: QUAD };
    const gd = geoDims(SRC_W, SRC_H, s);
    expect(gd.w).not.toBe(SRC_W); // 다르지 않으면 아래 검사가 공허해진다
  });

  it('quad가 없으면 회전 후 크기와 같다(지금까지 결함이 안 드러난 이유)', () => {
    expect(geoDims(SRC_W, SRC_H, freshEdit())).toEqual({ w: SRC_W, h: SRC_H });
  });

  // ⚠️ 처음 쓴 검사는 **공허했다.** 「원근 펴기 상태에서 화면 중앙 탭이 0.5로 간다」를 쟀는데,
  // 창이 가운데 정렬이라 **중앙은 rd에서도 gd에서도 0.5**다 — 옛 코드를 주입해도 통과했다.
  // 구별하려면 창이 이미지 전체가 아니어야 하고(비율 크롭), 점이 중앙이 아니어야 한다.
  it('🔴 **원근 펴기 + 비율 크롭에서 좌표가 gd 기준으로 나온다**(이게 어긋났던 결함)', () => {
    const s = { ...freshEdit(), quad: QUAD, aspect: '1:1' as const };
    const g = screenToGeo(0, 0, SRC_W, SRC_H, s); // 보이는 창의 **좌상단**
    const gd = geoDims(SRC_W, SRC_H, s);
    // gd(3400×2474)에 내접하는 정사각형의 왼쪽 여백 비율
    const expected = (gd.w - Math.min(gd.w, gd.h)) / 2 / gd.w;
    expect(g.x).toBeCloseTo(expected, 6);
    // 옛 코드(rd=4000×3000 기준)라면 (4000-3000)/2/4000 = 0.125가 나온다 — 달라야 한다.
    expect(g.x).not.toBeCloseTo(0.125, 3);
  });

  it('회전해도 중앙은 중앙이다', () => {
    const s = { ...freshEdit(), rotate90: 1 as const };
    const g = screenToGeo(0.5, 0.5, SRC_W, SRC_H, s);
    expect(g.x).toBeCloseTo(0.5, 6);
    expect(g.y).toBeCloseTo(0.5, 6);
  });

  it('확대·이동해도 창 안 상대 위치를 지킨다', () => {
    const s = { ...freshEdit(), zoom: 2, panX: 0.5 };
    const a = screenToGeo(0, 0, SRC_W, SRC_H, s);
    const b = screenToGeo(1, 1, SRC_W, SRC_H, s);
    expect(b.x - a.x).toBeCloseTo(0.5, 6); // zoom 2 → 창이 절반 폭
    expect(a.x).toBeGreaterThan(0.2); // panX로 오른쪽으로 밀렸다
  });

  it('브러시 반경은 **창 폭 대비 비율**이다(확대하면 정규화 반경이 작아진다)', () => {
    const wide = screenToGeo(0.5, 0.5, SRC_W, SRC_H, freshEdit(), 10);
    const zoomed = screenToGeo(0.5, 0.5, SRC_W, SRC_H, { ...freshEdit(), zoom: 2 }, 10);
    expect(zoomed.r).toBeCloseTo(wide.r / 2, 6);
  });

  it('brushPct를 안 주면 반경 0(좌표만 필요한 호출)', () => {
    expect(screenToGeo(0.5, 0.5, SRC_W, SRC_H, freshEdit()).r).toBe(0);
  });
});
