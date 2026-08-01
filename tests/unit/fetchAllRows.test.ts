// fetchAllRows.test.ts — 서버 목록을 **끝까지** 받는가 (M-10 · 불변식 #6).
//
// 🔴 예전엔 listAll이 select('*')만 써서 PostgREST가 1000행에서 조용히 잘랐다 — 그 잘린 목록으로
// 빈-클라우드 판단을 하면 사진 1000장 넘긴 기기가 새 기기에서 "나머지 없음"으로 동작했다.
// 이 검사는 페이지네이션이 **여러 페이지에 걸친 전체**를 받는지 잠근다.

import { describe, it, expect } from 'vitest';

// fetchAllRows는 내부 함수라 export되지 않는다 — 대신 listAll을 통해 간접 검증하되, 여기서는
// 페이지네이션 로직 자체를 가짜 클라이언트로 직접 잰다(포트 어댑터가 그 로직을 그대로 쓴다).
// 실제 구현과 동형인 페이지네이션을 재현해 계약을 문서화한다(회귀 시 이 케이스가 먼저 깨진다).
import { tripsRemote } from '../../src/services/sync';

/** N행을 1000씩 잘라 range로 돌려주는 가짜 Supabase 클라이언트. */
function fakeClientWithRows(total: number): unknown {
  const all = Array.from({ length: total }, (_, i) => ({ id: `id-${i}` }));
  return {
    from() {
      return {
        select() {
          return {
            range(fromIdx: number, toIdx: number) {
              return Promise.resolve({ data: all.slice(fromIdx, toIdx + 1), error: null });
            },
          };
        },
      };
    },
  };
}

describe('fetchAllRows (M-10 · listAll 페이지네이션)', () => {
  it('한 페이지(1000 미만)는 그대로 받는다', async () => {
    const r = await tripsRemote(fakeClientWithRows(42) as never).listAll();
    expect(r.error).toBeUndefined();
    expect(r.data.length).toBe(42);
  });

  it('🔴 1000을 넘으면 여러 페이지를 이어 받아 전체를 준다(옛 코드는 1000에서 잘렸다)', async () => {
    const r = await tripsRemote(fakeClientWithRows(2500) as never).listAll();
    expect(r.error).toBeUndefined();
    expect(r.data.length).toBe(2500);
    // 마지막 행까지 실제로 있는지 — 잘렸다면 여기서 실패한다.
    expect(r.data.some((x) => x.id === 'id-2499')).toBe(true);
  });

  it('정확히 1000의 배수여도 마지막 빈 페이지에서 멈춘다', async () => {
    const r = await tripsRemote(fakeClientWithRows(2000) as never).listAll();
    expect(r.data.length).toBe(2000);
  });
});
