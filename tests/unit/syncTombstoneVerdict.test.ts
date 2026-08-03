import { describe, expect, it, vi } from 'vitest';
import {
  classifyTombstoneSync,
  tombstoneFindingText,
  tombstoneSyncPresentation,
  type TombstoneSyncFinding,
  type TombstoneSyncRef,
} from '../../src/domain/syncTombstoneVerdict';
import { auditOpLessTombstones, type TombstoneAuditPort } from '../../src/services/diagnostics';
import { PURGE_DOMAINS, type PurgeDomain } from '../../src/services/purge';

const U = (n: number): string => `${String(n).padStart(8, '0')}-1111-4222-8333-444444444444`;

function ref(
  domain: PurgeDomain,
  id: string,
  patch: Partial<TombstoneSyncRef> = {},
): TombstoneSyncRef {
  return {
    domain,
    id,
    createdAt: '2026-08-02T21:55:00.000Z',
    updatedAt: '2026-08-02T21:56:28.559Z',
    deletedAt: '2026-08-02T21:56:28.559Z',
    version: 4,
    baseVersion: 4,
    clientOperationId: U(900),
    ...patch,
  };
}

function finding(state: TombstoneSyncFinding['state'], n = 1): TombstoneSyncFinding {
  const local = ref('expense', U(n));
  return { local, server: null, state };
}

describe('큐 없는 tombstone — 서버 증거 판정', () => {
  it('실측 expense v4: 같은 operation의 서버 tombstone이면 정상 반영이다', () => {
    const local = ref('expense', 'f9e7a210-1111-4222-8333-444444444444');
    const server = ref('expense', local.id);
    expect(classifyTombstoneSync(local, server, false)).toBe('confirmed-operation');
  });

  it('서버도 tombstone이면 operation이 달라도 삭제를 다시 보내지 않는다', () => {
    const local = ref('media', U(2));
    const server = ref('media', U(2), { clientOperationId: U(901), version: 3 });
    expect(classifyTombstoneSync(local, server, false)).toBe('confirmed-tombstone');
  });

  it('서버 active v3 / 로컬 tombstone v4는 삭제 재전파 대상이다', () => {
    const local = ref('trip', U(3));
    const server = ref('trip', U(3), { deletedAt: null, version: 3 });
    expect(classifyTombstoneSync(local, server, false)).toBe('needs-delete');
  });

  it('서버 active v5 / 로컬 tombstone v4는 더 최신 복원이며 삭제 재큐잉 금지다', () => {
    const local = ref('moment', U(4));
    const server = ref('moment', U(4), { deletedAt: null, version: 5 });
    expect(classifyTombstoneSync(local, server, false)).toBe('take-server');
  });

  it('서버 행 없음 + 원장 있음은 영구삭제 완료이며 재삽입 금지다', () => {
    expect(classifyTombstoneSync(ref('audio', U(5)), null, true)).toBe('purged');
  });

  it('서버 행과 원장이 모두 없으면 자동 복구하지 않고 확인 불가다', () => {
    expect(classifyTombstoneSync(ref('place', U(6)), null, false)).toBe('unknown');
  });
});

describe('삭제 반영 사용자 문장', () => {
  it('실측처럼 5건이 모두 확인되면 경고 없이 정상 한 줄이 된다', () => {
    const p = tombstoneSyncPresentation(
      Array.from({ length: 5 }, (_, i) => finding('confirmed-operation', i + 10)),
    );
    expect(p.level).toBe('ok');
    expect(p.actual).toBe('5건 모두 서버 반영');
    expect(p.headline).toBeNull();
  });

  it('더 최신 복원·영구삭제·재전파는 동기화할 일로, 증거 없음은 자동 수정 금지로 말한다', () => {
    const p = tombstoneSyncPresentation([
      finding('confirmed-tombstone', 20),
      finding('needs-delete', 21),
      finding('take-server', 22),
      finding('purged', 23),
      finding('unknown', 24),
    ]);
    expect(p.level).toBe('todo');
    expect(p.actual).toContain('서버 반영 1건');
    expect(p.actual).toContain('동기화 필요 3건');
    expect(p.actual).toContain('확인 불가 1건');
    expect(p.meaning).toContain('자동 수정하지 않습니다');
  });

  it('서버 조회 실패 이유를 숨기지 않는다', () => {
    const p = tombstoneSyncPresentation([finding('unknown')], '네트워크 끊김');
    expect(p.level).toBe('unknown');
    expect(p.meaning).toContain('네트워크 끊김');
  });

  it('접힌 근거는 상태별 다음 행동을 구분한다', () => {
    expect(tombstoneFindingText('needs-delete')).toContain('재전파');
    expect(tombstoneFindingText('take-server')).toContain('더 최신 복원본');
    expect(tombstoneFindingText('purged')).toContain('영구삭제');
    expect(tombstoneFindingText('unknown')).toContain('자동 수정 안 함');
  });
});

describe('서버 대조 포트 — 여섯 형제와 부분 실패', () => {
  it('여섯 도메인을 등록부에서 모두 대조하며 확인된 것은 전부 정상이다', async () => {
    const locals = PURGE_DOMAINS.map((domain, i) => ref(domain, U(100 + i)));
    const markers = vi.fn(async (domain: PurgeDomain, ids: string[]) =>
      locals.filter((x) => x.domain === domain && ids.includes(x.id)),
    );
    const port: TombstoneAuditPort = {
      generation: vi.fn(async () => 'canonical-v1'),
      markers,
      purgedIds: vi.fn(async () => []),
    };
    const result = await auditOpLessTombstones(port, locals);
    expect(markers.mock.calls.map(([domain]) => domain)).toEqual(PURGE_DOMAINS);
    expect(result.map((x) => x.state)).toEqual(PURGE_DOMAINS.map(() => 'confirmed-operation'));
  });

  it('한 테이블 조회라도 실패하면 일부 성공을 반환하지 않는다', async () => {
    const locals = [ref('trip', U(201)), ref('expense', U(202))];
    const port: TombstoneAuditPort = {
      generation: async () => 'canonical-v1',
      markers: async (domain) => {
        if (domain === 'expense') throw new Error('expenses 조회 실패');
        return [locals[0]!];
      },
      purgedIds: async () => [],
    };
    await expect(auditOpLessTombstones(port, locals)).rejects.toThrow('expenses 조회 실패');
  });

  it('대조 도중 canonical 세대가 바뀌면 혼합 snapshot을 정상으로 쓰지 않는다', async () => {
    let generationRead = 0;
    const local = ref('expense', U(301));
    const port: TombstoneAuditPort = {
      generation: async () => (++generationRead === 1 ? 'canonical-v1' : 'canonical-v2'),
      markers: async () => [local],
      purgedIds: async () => [],
    };
    await expect(auditOpLessTombstones(port, [local])).rejects.toThrow('최종본 세대가 바뀌었습니다');
  });
});
