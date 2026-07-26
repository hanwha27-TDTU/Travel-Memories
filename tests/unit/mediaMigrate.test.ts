// tests/unit/mediaMigrate.test.ts — 저장소 이관(sync-offline-dev §2-B).
//
// 왜 이 검사가 있는가 (사용자 제안 2026-07-26): "어차피 supabase에 사진을 저장하지 않을 거니
// 직접 다 삭제하면 어떨까?" — 확인해 보니 **살아 있는 사진 10장 중 8장의 서버 사본이 옛
// 저장소에만** 있었다. 먼저 지웠다면 그 8장의 서버 백업이 사라진다(비타협 원칙 #1).
//
// 그래서 이 검사가 잠그는 것은 전부 **"언제 지우는가"**에 관한 것이다:
//  ① 업로드 200으로 원본을 지우지 않는다 — 되읽어 확인한 것만 지운다.
//  ② 확인(newIds)이 실패하면 **아무것도 지우지 않는다.**
//  ③ 한 장이 실패해도 나머지는 계속 옮긴다. 그리고 그 실패한 장의 원본은 **살아남는다.**
//  ④ 멱등 — 다시 눌러도 이미 옮긴 것은 건너뛴다(사용자는 실패하면 다시 누른다).

import { describe, it, expect } from 'vitest';
import { migrateMediaBytes, describeMigration, ERROR_CAP, type MigratePorts } from '../../src/services/mediaMigrate';

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const C = 'cccccccc-3333-4333-8333-333333333333';

const blob = (): Blob => new Blob(['x'], { type: 'image/webp' });

/** 두 저장소를 흉내내는 가짜. **집합 두 개**가 곧 세상의 상태다. */
function fake(
  old: string[],
  next: string[] = [],
  over: Partial<MigratePorts> = {},
): MigratePorts & { old: Set<string>; next: Set<string>; removed: string[] } {
  const o = new Set(old);
  const n = new Set(next);
  const removed: string[] = [];
  const base: MigratePorts = {
    oldIds: () => Promise.resolve({ ids: [...o] }),
    newIds: () => Promise.resolve({ ids: [...n] }),
    download: (id) => Promise.resolve(o.has(id) ? { blob: blob() } : { blob: null, error: '없음' }),
    upload: (id) => {
      n.add(id);
      return Promise.resolve({});
    },
    removeOld: (id) => {
      o.delete(id);
      removed.push(id);
      return Promise.resolve({});
    },
  };
  return { ...base, ...over, old: o, next: n, removed };
}

describe('① 복사는 하되, 지우는 건 별개다', () => {
  it('기본값은 복사만 — 옛 파일을 건드리지 않는다', async () => {
    const f = fake([A, B]);
    const r = await migrateMediaBytes(f);
    expect(r.copied).toBe(2);
    expect(r.removed).toBe(0);
    expect(f.old.size).toBe(2); // 그대로 있어야 한다
    expect(r.safeToRemove).toBe(2); // "지워도 된다"고 알려주기만 한다
  });

  it('명시적으로 요청해야 지운다 — 그리고 되읽기를 통과한 것만', async () => {
    const f = fake([A, B]);
    const r = await migrateMediaBytes(f, true);
    expect(r.removed).toBe(2);
    expect(f.old.size).toBe(0);
    expect(f.next.size).toBe(2);
  });
});

describe('② 확인하지 못하면 지우지 않는다', () => {
  it('되읽기가 실패하면 removed=0 — 200만 믿고 지우지 않는다', async () => {
    let calls = 0;
    const f = fake([A, B], [], {
      newIds: () => {
        calls++;
        // 첫 호출(사전 조회)은 성공, 두 번째(되읽기)에서 실패시킨다.
        return Promise.resolve(calls === 1 ? { ids: [] } : { ids: [], error: '목록 조회 실패' });
      },
    });
    const r = await migrateMediaBytes(f, true);
    expect(r.copied).toBe(2);
    expect(r.removed).toBe(0);
    expect(f.old.size).toBe(2); // 원본 살아 있음
    expect(r.errors.join()).toContain('확인 실패');
  });

  it('새 저장소를 처음부터 못 읽으면 **아무것도 하지 않는다**', async () => {
    const f = fake([A, B], [], { newIds: () => Promise.resolve({ ids: [], error: '권한 없음' }) });
    const r = await migrateMediaBytes(f, true);
    expect(r.copied).toBe(0);
    expect(r.removed).toBe(0);
    expect(f.next.size).toBe(0); // 이미 있는지 모르는 채 올리지 않는다
    expect(r.errors).toEqual(['권한 없음']);
  });

  it('옛 저장소를 못 읽으면 즉시 멈춘다', async () => {
    const f = fake([A], [], { oldIds: () => Promise.resolve({ ids: [], error: '옛 저장소 오류' }) });
    const r = await migrateMediaBytes(f, true);
    expect(r.total).toBe(0);
    expect(r.errors).toEqual(['옛 저장소 오류']);
  });
});

describe('③ 한 장이 실패해도 멈추지 않고, 그 장의 원본은 살아남는다', () => {
  it('받기 실패한 장을 건너뛰고 나머지를 옮긴다', async () => {
    const f = fake([A, B, C], [], {
      download: (id) => (id === B ? Promise.resolve({ blob: null, error: '받기 오류' }) : Promise.resolve({ blob: blob() })),
    });
    const r = await migrateMediaBytes(f, true);
    expect(r.copied).toBe(2);
    expect(r.failed).toBe(1);
    expect(f.old.has(B)).toBe(true); // ← 핵심: 못 옮긴 장은 옛 저장소에 남아 있어야 한다
    expect(f.removed.sort()).toEqual([A, C].sort());
  });

  it('올리기 실패도 같다 — 그 장은 지워지지 않는다', async () => {
    // 주의: upload를 덮어쓸 때 **성공 갈래에서 새 저장소에 실제로 넣어야** 한다.
    // 안 넣으면 되읽기가 비고, 그러면 "확인 안 됐으니 안 지운다"가 옳게 동작해 검사가 헷갈린다.
    const f: ReturnType<typeof fake> = fake([A, B], [], {
      upload: (id) => {
        if (id === A) return Promise.resolve({ error: '올리기 오류' });
        f.next.add(id);
        return Promise.resolve({});
      },
    });
    const r = await migrateMediaBytes(f, true);
    expect(r.failed).toBe(1);
    expect(f.old.has(A)).toBe(true);
    expect(f.removed).toEqual([B]);
  });

  it('실패 사유를 조용히 삼키지 않는다', async () => {
    const f = fake([A], [], { download: () => Promise.resolve({ blob: null, error: '네트워크 끊김' }) });
    const r = await migrateMediaBytes(f);
    expect(r.errors.join()).toContain('네트워크 끊김');
  });

  it('오류 줄에 상한이 있다(화면이 목록에 파묻히지 않게)', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `${i}`.padStart(8, '0') + '-1111-4111-8111-111111111111');
    const f = fake(ids, [], { download: (id) => Promise.resolve({ blob: null, error: `실패 ${id}` }) });
    const r = await migrateMediaBytes(f);
    expect(r.failed).toBe(20);
    expect(r.errors.length).toBeLessThanOrEqual(ERROR_CAP);
  });
});

describe('④ 멱등 — 다시 눌러도 안전하다', () => {
  it('이미 새 저장소에 있는 것은 건너뛴다', async () => {
    const f = fake([A, B], [A]);
    const r = await migrateMediaBytes(f);
    expect(r.already).toBe(1);
    expect(r.copied).toBe(1);
  });

  it('두 번 돌려도 결과가 같다(두 번째는 전부 already)', async () => {
    const f = fake([A, B]);
    await migrateMediaBytes(f);
    const second = await migrateMediaBytes(f);
    expect(second.copied).toBe(0);
    expect(second.already).toBe(2);
    expect(second.failed).toBe(0);
  });

  it('옛 저장소가 비면 할 일 없음', async () => {
    const r = await migrateMediaBytes(fake([]));
    expect(r.total).toBe(0);
    expect(describeMigration(r)).toContain('남은 사진이 없어요');
  });
});

describe('⑤ 결과 문장', () => {
  it('실패가 있으면 **다시 눌러도 된다**고 알려준다(멱등을 사용자가 알아야 재시도한다)', async () => {
    const f = fake([A, B], [], { upload: () => Promise.resolve({ error: 'x' }) });
    expect(describeMigration(await migrateMediaBytes(f))).toContain('다시 눌러도 안전');
  });

  it('성공만 있으면 재시도 안내를 붙이지 않는다(불필요한 불안 금지)', async () => {
    expect(describeMigration(await migrateMediaBytes(fake([A])))).not.toContain('다시 눌러도');
  });

  it('옮긴 수와 이미 있던 수를 구분해 말한다', async () => {
    const s = describeMigration(await migrateMediaBytes(fake([A, B], [A])));
    expect(s).toContain('1장 옮김');
    expect(s).toContain('이미 옮겨져');
  });
});
