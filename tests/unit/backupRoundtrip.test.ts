// 백업 복원 드릴 — export→import 왕복 파리티(순수 직렬화층)를 실기기 없이 검증.
// DR 감사관 기준 #7(restorability: 백업이 쓴 것 == 복원이 읽는 것)을 자동 드릴로 잠근다.
// db(Dexie)는 만지지 않는다 — 순수 serialize/deserialize만 대상(층 분리 덕분).
import { describe, it, expect } from 'vitest';
import {
  serializeJson,
  deserializeJson,
  serializeZip,
  deserializeZip,
  type CollectedRows,
} from '../../src/services/backup';
import { encryptBytes, decryptBytes, isEncryptedEnvelope } from '../../src/services/backupCrypto';
import { unzip } from '../../src/services/zip';
import type { LocalTrip, LocalMoment, LocalMedia, LocalExpense, LocalAudio, LocalPlace } from '../../src/offline/db';

const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const mkBlob = (nums: number[]) => new Blob([new Uint8Array(nums)], { type: 'image/webp' });

function sampleRows(): CollectedRows {
  const trip: LocalTrip = {
    id: 't-1111', title: '도쿄 여행 2024', startDate: '2024-05-01', endDate: '2024-05-05',
    status: 'completed', createdAt: '2024-05-01T00:00:00.000Z', updatedAt: '2024-05-06T00:00:00.000Z',
    version: 3, deletedAt: null,
  };
  const tripDeleted: LocalTrip = { ...trip, id: 't-2222', title: '삭제된 여행', version: 2, deletedAt: '2024-06-01T00:00:00.000Z' };
  const moment: LocalMoment = {
    id: 'm-1', tripId: 't-1111', occurredAt: '2024-05-02T03:00:00.000Z', title: '아사쿠사',
    note: '센소지', emotion: '😌', placeName: '센소지', placeLat: 35.71, placeLng: 139.79,
    createdAt: '2024-05-02T03:00:00.000Z', updatedAt: '2024-05-02T03:00:00.000Z', version: 1, deletedAt: null,
  };
  const media: LocalMedia = {
    id: 'md-1', momentId: 'm-1', tripId: 't-1111', mime: 'image/jpeg',
    originalBlob: mkBlob([10, 20, 30, 40, 50]), displayBlob: mkBlob([1, 2, 3]), thumbBlob: mkBlob([9, 8]),
    width: 1600, height: 1200, takenAt: '2024-05-02T03:00:00.000Z', gpsLat: 35.71, gpsLng: 139.79,
    bytesOriginal: 5, bytesDisplay: 3, version: 2, createdAt: '2024-05-02T03:00:00.000Z',
    updatedAt: '2024-05-02T03:05:00.000Z', deletedAt: null, clientOperationId: 'op-1',
  };
  const expense: LocalExpense = {
    id: 'e-1', momentId: 'm-1', tripId: 't-1111', originalAmount: 1200, originalCurrency: 'JPY',
    category: '식비', note: '라멘', createdAt: '2024-05-02T04:00:00.000Z', updatedAt: '2024-05-02T04:00:00.000Z',
    version: 1, deletedAt: null,
  };
  // 🔴 **소리·장소가 `[]`였다**(2026-08-01에 발견). 빈 배열은 왕복이 **공허하게 통과**한다 —
  // 두 테이블은 `check-backup-coverage`(정적)가 「참조된다」까지만 보고, 실제로 왕복하는지는
  // 아무도 재고 있지 않았다. §4가 말하는 그 자리다: 대상 0에서 초록인 검사는 검사가 아니다.
  const audio: LocalAudio = {
    id: 'a-1', momentId: 'm-1', tripId: 't-1111', blob: mkBlob([7, 7, 7]), mime: 'audio/webm',
    durationSec: 14, recordedAt: '2024-05-02T03:10:00.000Z', storagePath: 'u/t/a-1.webm',
    createdAt: '2024-05-02T03:10:00.000Z', updatedAt: '2024-05-02T03:10:00.000Z', version: 1, deletedAt: null,
  };
  const place: LocalPlace = {
    id: 'p-1', name: '센소지', formattedAddress: '도쿄도 다이토구 아사쿠사 2-3-1',
    provider: 'nominatim', providerPlaceId: 'osm:way/12345',
    countryCode: 'JP', country: '일본', region: '도쿄도', city: '다이토구', district: '아사쿠사',
    postcode: '111-0032', category: '사찰', memo: '연등이 컸다',
    latitude: 35.7148, longitude: 139.7967, precision: 'point', spanMeters: 30, mapPicked: false,
    createdAt: '2024-05-02T03:00:00.000Z', updatedAt: '2024-05-02T03:00:00.000Z', version: 1, deletedAt: null,
  };
  // 고아: 부모 여행이 목록에 없는 순간(완전성 — _orphans로 보존되어야 함)
  const orphanMoment: LocalMoment = { ...moment, id: 'm-orphan', tripId: 't-GONE', title: '고아 순간' };
  return { trips: [trip, tripDeleted], moments: [moment, orphanMoment], media: [media], expenses: [expense], audio: [audio], places: [place] };
}

/**
 * **Blob을 뺀 나머지 필드 전부**를 깊은 비교로 대조한다.
 *
 * 🔴 왜 필요했나(2026-08-01 · 사용자 질문 *"백업에 모든 데이터가 담겨있지?"*에서 드러남):
 * 이 파일의 파리티 검사는 **필드를 골라서** 확인하고 있었다 — id·tombstone·`placeLat`·
 * `category`·blob·version. 픽스처엔 `gpsLat: 35.71`이 있는데 **아무도 확인하지 않았다.**
 *
 * 그래서 **누가 필드를 하나 빠뜨려도 이 드릴은 초록**이었다. 직렬화가 rest spread라 구조적으로
 * 안전하긴 하지만, 그건 *지금 코드가 그렇다*는 것이지 **검사가 그 층을 재고 있다**는 뜻이 아니다.
 * 백업은 마지막 방어선이고, 여기서 조용히 빠진 필드는 **복원해도 안 돌아온다.**
 */
function stripBlobs(rows: CollectedRows): unknown {
  const noBlob = (o: object): Record<string, unknown> =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => !(v instanceof Blob)));
  const by = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  return {
    trips: [...rows.trips].sort(by).map(noBlob),
    moments: [...rows.moments].sort(by).map(noBlob),
    media: [...rows.media].sort(by).map(noBlob),
    expenses: [...rows.expenses].sort(by).map(noBlob),
    audio: [...(rows.audio ?? [])].sort(by).map(noBlob),
    places: [...(rows.places ?? [])].sort(by).map(noBlob),
  };
}

async function expectParity(back: CollectedRows, src: CollectedRows) {
  // 🔴 **먼저 전부 대조한다.** 아래 개별 단언들은 *무엇이 중요한지*를 사람에게 말하려고
  // 남겨 두지만, 「빠진 것이 없다」를 보증하는 것은 이 한 줄이다.
  expect(stripBlobs(back)).toEqual(stripBlobs(src));

  expect(back.trips.map((t) => t.id).sort()).toEqual(src.trips.map((t) => t.id).sort());
  expect(back.moments.map((m) => m.id).sort()).toEqual(src.moments.map((m) => m.id).sort());
  expect(back.expenses.map((e) => e.id).sort()).toEqual(src.expenses.map((e) => e.id).sort());
  expect(back.media.map((m) => m.id).sort()).toEqual(src.media.map((m) => m.id).sort());

  // tombstone 보존
  expect(back.trips.find((t) => t.id === 't-2222')!.deletedAt).toBe('2024-06-01T00:00:00.000Z');
  // 고아 순간 보존
  expect(back.moments.find((m) => m.id === 'm-orphan')!.tripId).toBe('t-GONE');
  // 순간 좌표·비용 분류 보존
  expect(back.moments.find((m) => m.id === 'm-1')!.placeLat).toBe(35.71);
  expect(back.expenses[0]!.category).toBe('식비');

  // 미디어 blob 바이트 동일(원본·표시본·썸네일)
  const bm = back.media.find((m) => m.id === 'md-1')!;
  const sm = src.media[0]!;
  expect([...(await bytesOf(bm.originalBlob))]).toEqual([...(await bytesOf(sm.originalBlob))]);
  expect([...(await bytesOf(bm.displayBlob))]).toEqual([...(await bytesOf(sm.displayBlob))]);
  expect([...(await bytesOf(bm.thumbBlob))]).toEqual([...(await bytesOf(sm.thumbBlob))]);
  expect(bm.version).toBe(2);
  expect(bm.clientOperationId).toBe('op-1');

  // 소리 바이트도 실제로 왕복하는가(픽스처가 비어 있어 아무도 재지 않던 자리).
  const ba = back.audio!.find((a) => a.id === 'a-1')!;
  expect([...(await bytesOf(ba.blob))]).toEqual([...(await bytesOf(src.audio![0]!.blob))]);
  // 장소는 blob이 없다 — 좌표가 그대로 왕복하는지 본다(뒤집히면 지구 반대편이 된다).
  const bp = back.places!.find((p) => p.id === 'p-1')!;
  expect([bp.latitude, bp.longitude]).toEqual([35.7148, 139.7967]);
}

describe('백업 복원 왕복 드릴(순수)', () => {
  it('JSON: serialize→deserialize 전 행·blob 파리티', async () => {
    const src = sampleRows();
    const back = deserializeJson(await serializeJson(src));
    await expectParity(back, src);
  });

  it('ZIP: serialize→deserialize 전 행·blob 파리티(원본 포함)', async () => {
    const src = sampleRows();
    const buf = await (await serializeZip(src, true)).arrayBuffer();
    await expectParity(deserializeZip(buf), src);
  });

  it('ZIP 가벼운 백업(원본 제외): 원본 파일 없음·더 작음·표시본 폴백(유실 아님)', async () => {
    const src = sampleRows();
    const full = await serializeZip(src, true);
    const light = await serializeZip(src, false);
    // 가벼운 백업이 완전백업보다 작다(원본 바이트만큼)
    expect(light.size).toBeLessThan(full.size);
    // 가벼운 ZIP엔 _원본 파일 엔트리가 없다
    const names = unzip(await light.arrayBuffer()).map((e) => e.name);
    expect(names.some((n) => n.includes('_원본.'))).toBe(false);
    expect(names.some((n) => n.includes('_표시본.'))).toBe(true);
    // 복원 시 원본 파일이 없으니 표시본으로 폴백(기억 유실 아님)
    const back = deserializeZip(await light.arrayBuffer());
    const bm = back.media.find((m) => m.id === 'md-1')!;
    expect([...(await bytesOf(bm.originalBlob))]).toEqual([...(await bytesOf(src.media[0]!.displayBlob))]);
  });

  it('비공허: 직렬화 후 한 행을 지우면 파리티가 깨진다(드릴이 살아있음)', async () => {
    const src = sampleRows();
    const back = deserializeJson(await serializeJson(src));
    back.trips.pop(); // 한 행 제거 → 개수 불일치여야 함
    await expect(expectParity(back, src)).rejects.toBeTruthy();
  });
});

describe('백업 암호화(AES-GCM 봉투)', () => {
  it('encrypt→decrypt 왕복 + 봉투 매직 감지', async () => {
    const plain = new TextEncoder().encode('여행 기억 — 비밀 백업 {"trips":1}');
    const env = await encryptBytes(plain, 'pw-비밀-123');
    expect(isEncryptedEnvelope(env)).toBe(true);
    expect(isEncryptedEnvelope(new TextEncoder().encode('{'))).toBe(false); // 평문 JSON은 봉투 아님
    const back = await decryptBytes(env, 'pw-비밀-123');
    expect([...back]).toEqual([...plain]);
  });

  it('틀린 암호는 복호 실패(throw)', async () => {
    const env = await encryptBytes(new TextEncoder().encode('secret'), 'right');
    await expect(decryptBytes(env, 'wrong')).rejects.toBeTruthy();
  });

  it('매 암호화마다 salt·iv가 달라 사이퍼텍스트가 바뀐다', async () => {
    const p = new TextEncoder().encode('same');
    const a = await encryptBytes(p, 'k');
    const b = await encryptBytes(p, 'k');
    expect([...a]).not.toEqual([...b]); // 결정적 노출 방지
  });
});
