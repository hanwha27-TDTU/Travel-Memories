// 동기화 결정 순수함수 테스트 (SYNC_PROTOCOL 불변식을 게이트로 잠금).
import { describe, it, expect } from 'vitest';
import { mergeDecision, isEmptyCloudAnomaly, classifyError, writeLanded } from '../../src/sync/merge';
import type { LocalTrip } from '../../src/offline/db';

function trip(over: Partial<LocalTrip>): LocalTrip {
  return {
    id: 't1', title: 'A', startDate: '', endDate: '', status: 'planned',
    version: 1, createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z',
    deletedAt: null, ...over,
  };
}

describe('mergeDecision (LWW + tombstone 우선)', () => {
  it('로컬이 없으면 서버를 취한다', () => {
    expect(mergeDecision(undefined, trip({}))).toBe('take-server');
  });
  it('서버 updatedAt이 더 최신이면 서버', () => {
    const local = trip({ updatedAt: '2026-07-22T10:00:00.000Z' });
    const server = trip({ updatedAt: '2026-07-22T11:00:00.000Z' });
    expect(mergeDecision(local, server)).toBe('take-server');
  });
  it('로컬이 더 최신이면 로컬 유지', () => {
    const local = trip({ updatedAt: '2026-07-22T12:00:00.000Z' });
    const server = trip({ updatedAt: '2026-07-22T11:00:00.000Z' });
    expect(mergeDecision(local, server)).toBe('keep-local');
  });
  it('tombstone(삭제)이 더 최신이면 활성 로컬을 이긴다', () => {
    const local = trip({ updatedAt: '2026-07-22T10:00:00.000Z', deletedAt: null });
    const server = trip({ updatedAt: '2026-07-22T11:00:00.000Z', deletedAt: '2026-07-22T11:00:00.000Z' });
    expect(mergeDecision(local, server)).toBe('take-server');
  });
  it('동일 시각이면 tombstone이 활성보다 우선', () => {
    const ts = '2026-07-22T10:00:00.000Z';
    const local = trip({ updatedAt: ts, deletedAt: null });
    const server = trip({ updatedAt: ts, deletedAt: ts });
    expect(mergeDecision(local, server)).toBe('take-server');
  });
});

// 좀비데이터 절대 방지 — 삭제한 데이터가 되살아나는 모든 경로를 게이트로 잠근다(비공허: 옛 시각-우선 로직이면 RED).
describe('mergeDecision — 좀비 방지(tombstone 우위)', () => {
  it('로컬 tombstone을, 시각만 앞선 활성 서버가 못 이긴다(같은 version)', () => {
    // 삭제(v2, 10:00) vs 스큐로 시각이 앞선 활성 사본(v2, 11:00) → 예전엔 부활(좀비)했다.
    const local = trip({ version: 2, updatedAt: '2026-07-22T10:00:00.000Z', deletedAt: '2026-07-22T10:00:00.000Z' });
    const server = trip({ version: 2, updatedAt: '2026-07-22T11:00:00.000Z', deletedAt: null });
    expect(mergeDecision(local, server)).toBe('keep-local');
  });
  it('로컬 tombstone을, version이 더 낮은 활성 서버가 시각이 앞서도 못 이긴다', () => {
    const local = trip({ version: 3, updatedAt: '2026-07-22T10:00:00.000Z', deletedAt: '2026-07-22T10:00:00.000Z' });
    const server = trip({ version: 2, updatedAt: '2026-07-22T12:00:00.000Z', deletedAt: null });
    expect(mergeDecision(local, server)).toBe('keep-local');
  });
  it('오래된 백업(활성·낮은 version)이 로컬 tombstone을 되살리지 못한다', () => {
    const localTombstone = trip({ version: 5, updatedAt: '2026-07-22T15:00:00.000Z', deletedAt: '2026-07-22T15:00:00.000Z' });
    const oldBackupActive = trip({ version: 3, updatedAt: '2026-07-22T10:00:00.000Z', deletedAt: null });
    expect(mergeDecision(localTombstone, oldBackupActive)).toBe('keep-local');
  });
  it('진짜 복원(version이 tombstone보다 높은 활성)은 되살린다', () => {
    const localTombstone = trip({ version: 2, updatedAt: '2026-07-22T10:00:00.000Z', deletedAt: '2026-07-22T10:00:00.000Z' });
    const restore = trip({ version: 3, updatedAt: '2026-07-22T09:00:00.000Z', deletedAt: null }); // 시각이 이르러도 version이 높으면 복원
    expect(mergeDecision(localTombstone, restore)).toBe('take-server');
  });
  it('로컬 활성 vs 서버 tombstone(같은 version) → 삭제 수용(부활 안 함)', () => {
    const localActive = trip({ version: 2, updatedAt: '2026-07-22T12:00:00.000Z', deletedAt: null });
    const serverTombstone = trip({ version: 2, updatedAt: '2026-07-22T10:00:00.000Z', deletedAt: '2026-07-22T10:00:00.000Z' });
    expect(mergeDecision(localActive, serverTombstone)).toBe('take-server');
  });
  it('둘 다 tombstone이면 평범한 LWW(시각 최신)', () => {
    const local = trip({ version: 2, updatedAt: '2026-07-22T10:00:00.000Z', deletedAt: '2026-07-22T10:00:00.000Z' });
    const server = trip({ version: 2, updatedAt: '2026-07-22T11:00:00.000Z', deletedAt: '2026-07-22T11:00:00.000Z' });
    expect(mergeDecision(local, server)).toBe('take-server');
  });
});

describe('isEmptyCloudAnomaly (빈-클라우드 가드)', () => {
  it('서버 0행 + 로컬 활성 있음 = 이상(로컬 보존)', () => {
    expect(isEmptyCloudAnomaly(0, 3)).toBe(true);
  });
  it('서버 0행 + 로컬도 0 = 정상(빈 상태)', () => {
    expect(isEmptyCloudAnomaly(0, 0)).toBe(false);
  });
  it('서버에 데이터 있으면 정상', () => {
    expect(isEmptyCloudAnomaly(2, 3)).toBe(false);
  });
});

describe('writeLanded (M-3 · operation id 기반 read-back)', () => {
  it('같은 operation + 같거나 높은 서버 version = 내 쓰기가 착지', () => {
    expect(writeLanded({ version: 4, clientOperationId: 'op-1' }, 3, 'op-1')).toBe(true);
  });
  it('🔴 제목 같은 남의 행이어도 operation이 다르면 착지 아님', () => {
    expect(writeLanded({ version: 4, clientOperationId: 'other-op' }, 3, 'op-1')).toBe(false);
  });
  it('서버 version이 보낸 값보다 낮으면 같은 operation이어도 착지 아님', () => {
    expect(writeLanded({ version: 2, clientOperationId: 'op-1' }, 3, 'op-1')).toBe(false);
  });
  it('사진·소리는 operation 외에 경로도 같아야 한다', () => {
    expect(writeLanded({ version: 3, clientOperationId: 'op-1', storagePath: 'u/a.webp' }, 3, 'op-1', 'u/a.webp')).toBe(true);
    expect(writeLanded({ version: 3, clientOperationId: 'op-1', storagePath: 'u/other.webp' }, 3, 'op-1', 'u/a.webp')).toBe(false);
  });
});

describe('classifyError (재시도 vs 영구)', () => {
  it('네트워크 미도달(undefined) = 재시도', () => expect(classifyError(undefined)).toBe('retryable'));
  it('5xx = 재시도', () => expect(classifyError(503)).toBe('retryable'));
  it('429 = 재시도', () => expect(classifyError(429)).toBe('retryable'));
  it('401/403 = 영구(인증/권한)', () => {
    expect(classifyError(401)).toBe('permanent');
    expect(classifyError(403)).toBe('permanent');
  });
  it('400 검증 = 영구', () => expect(classifyError(400)).toBe('permanent'));
});
