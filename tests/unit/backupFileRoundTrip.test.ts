// 실제 파일 복원 왕복: 내려받을 Blob → File 선택 경계 → production import → read-back → abort.
// 성공 뒤 시험 id·queue·purged 원장이 0건인지를 fake-indexeddb로 잠근다.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, type LocalTrip } from '../../src/offline/db';
import {
  BACKUP_ROUND_TRIP_TITLE_PREFIX,
  BACKUP_ROUND_TRIP_MAX_AGE_MS,
  createBackupRoundTripFile,
  runBackupFileRoundTrip,
  lastBackupRoundTrip,
} from '../../src/services/backupRoundTrip';
import { deserializeZip } from '../../src/services/backup';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function userTrip(): LocalTrip {
  return {
    id: USER_ID,
    title: '사용자 여행',
    startDate: '2026-08-01',
    endDate: '2026-08-02',
    status: 'completed',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    version: 3,
    deletedAt: null,
  };
}

async function asFile(blob: Blob, filename: string): Promise<File> {
  return new File([await blob.arrayBuffer()], filename, { type: 'application/zip' });
}

beforeEach(async () => {
  const d = db();
  await Promise.all([
    d.localTrips.clear(), d.localMoments.clear(), d.localMedia.clear(),
    d.localExpenses.clear(), d.localAudio.clear(), d.localVideos.clear(), d.localPlaces.clear(),
    d.syncQueue.clear(), d.purgedIds.clear(),
  ]);
  await d.localTrips.add(userTrip());
});

describe('백업 파일 복원 왕복', () => {
  it('실제 File을 복원·되읽은 뒤 시험 변경 전체를 롤백한다', async () => {
    const made = await createBackupRoundTripFile();
    const exported = deserializeZip(await made.blob.arrayBuffer());
    expect(exported.trips).toHaveLength(1);
    expect(exported.moments).toHaveLength(1);
    expect(exported.videos).toHaveLength(1);
    expect(exported.trips[0]!.title).toContain(BACKUP_ROUND_TRIP_TITLE_PREFIX);
    expect(exported.trips[0]).toMatchObject({
      timeZone: 'Asia/Tashkent',
      updatedByDevice: 'backup-round-trip-diagnostic',
      baseVersion: 0,
      baseCanonicalVersion: 'backup-round-trip-canonical-v1',
    });
    expect(exported.trips[0]!.clientOperationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(exported.trips)).not.toContain('사용자 여행');
    expect(made.filename).toMatch(/^\d{8}_\d{4}_Bugeon-Journey_왕복검사\.zip$/);
    const afterCreate = await db().localTrips.toArray();
    expect(afterCreate).toEqual([userTrip()]);
    expect(await db().syncQueue.count()).toBe(0);

    const run = await runBackupFileRoundTrip(await asFile(made.blob, made.filename));
    expect(run).toMatchObject({ state: 'pass', filename: made.filename, error: null, leftover: null });

    const trips = await db().localTrips.toArray();
    expect(trips).toEqual([userTrip()]);
    expect(trips.some((t) => t.title.startsWith(BACKUP_ROUND_TRIP_TITLE_PREFIX))).toBe(false);
    expect(await db().localMoments.count()).toBe(0);
    expect(await db().localVideos.count()).toBe(0);
    expect(await db().syncQueue.count()).toBe(0);
    expect(await db().purgedIds.count()).toBe(0);
  });

  it('다른 바이트를 고르면 실패하고 사용자 기록과 큐를 건드리지 않는다', async () => {
    const made = await createBackupRoundTripFile();
    const tampered = new File([await made.blob.arrayBuffer(), new Uint8Array([0])], made.filename, { type: 'application/zip' });

    await expect(runBackupFileRoundTrip(tampered)).rejects.toThrow(/바이트가 다릅니다/);
    expect(await db().localTrips.toArray()).toEqual([userTrip()]);
    expect(await db().syncQueue.count()).toBe(0);
    expect(await db().purgedIds.count()).toBe(0);
  });

  it('시험 전부터 같은 id의 기록·큐·원장이 있으면 실패하되 하나도 지우지 않는다', async () => {
    const made = await createBackupRoundTripFile();
    const fixture = deserializeZip(await made.blob.arrayBuffer()).trips[0]!;
    const operationId = '22222222-2222-4222-8222-222222222222';
    await db().localTrips.add(fixture);
    await db().syncQueue.add({
      operationId, entityType: 'trip', entityId: fixture.id, operationType: 'update',
      state: 'permanent_failed', attempts: 3, createdAt: fixture.createdAt,
    });
    await db().purgedIds.add({ id: fixture.id, entityType: 'trip', purgedAt: fixture.createdAt });

    await expect(runBackupFileRoundTrip(await asFile(made.blob, made.filename))).rejects.toThrow(/시작하기 전부터/);
    expect(await db().localTrips.get(fixture.id)).toEqual(fixture);
    expect(await db().syncQueue.get(operationId)).toBeDefined();
    expect(await db().purgedIds.get(fixture.id)).toBeDefined();
  });

  it('새 시험 파일을 만들면 이전 파일의 통과 결과를 현재 초록으로 재사용하지 않는다', async () => {
    const first = await createBackupRoundTripFile();
    await runBackupFileRoundTrip(await asFile(first.blob, first.filename));
    expect(lastBackupRoundTrip()?.state).toBe('pass');

    await createBackupRoundTripFile();
    expect(lastBackupRoundTrip()).toBeNull();
  });

  it('24시간이 지난 왕복 성공 캐시는 현재 통과 증거로 재사용하지 않는다', async () => {
    const made = await createBackupRoundTripFile();
    const run = await runBackupFileRoundTrip(await asFile(made.blob, made.filename));
    const now = vi.spyOn(Date, 'now').mockReturnValue(new Date(run.at).getTime() + BACKUP_ROUND_TRIP_MAX_AGE_MS + 1);
    expect(lastBackupRoundTrip()).toBeNull();
    now.mockRestore();
  });
});
