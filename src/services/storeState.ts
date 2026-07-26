// services/storeState.ts — **저장 상태 확인 및 기기별 현황**(읽기 전용).
//
// 왜(사용자 제안 2026-07-26, Medical-Note의 「저장본 버전 확인」 화면을 참고):
// 2기기 문제("태블릿에서 지웠는데 휴대폰엔 남아 있다")를 지금까지 **추측으로** 좇았다.
// 서버와 이 기기의 개수를 나란히 놓고, 각 기기가 마지막으로 올린 시각을 보이면
// **어느 쪽이 뒤처졌는지가 즉시 보인다.** 진단 도구의 제1 규율(§8) — 관측이 아니라 판정.
//
// 정직함(비타협 원칙 #4) — 이 화면이 말할 수 있는 것과 없는 것:
//  · 말할 수 있다: 서버의 활성 행 수 · 이 기기의 활성 행 수 · 각 기기가 **마지막으로 올린** 시각
//  · 말할 수 없다: 각 기기가 **마지막으로 받아간(pull)** 시각.
//    받기만 한 기기는 서버에 흔적을 남기지 않는다. 그래서 라벨을 "마지막 동기화"가 아니라
//    **"마지막으로 올림"**이라고 쓴다. 한 글자 차이가 거짓말과 사실을 가른다.
//  · 개수가 다르다고 **결함이 아니다** — 대개 "아직 안 올렸다/안 받았다"이고 동기화로 풀린다.
//    그래서 판정은 '문제'가 아니라 '할 일'이다. 진짜 실패는 동기화 도구가 따로 말한다.

import { db } from '../offline/db';
import { PURGE_DOMAINS, DOMAIN_PURGE, purgedIdSet, type PurgeDomain } from './purge';
import { parseDeviceStamp, shortDeviceId, deviceId } from '../app/deviceId';
import type { JourneyClient } from './supabase/client';

export interface DeviceSeen {
  /** `라벨#짧은id`에서 뽑은 사람이 읽는 이름. */
  label: string;
  /** 짧은 기기 id. */
  id: string;
  /** 이 기기가 **마지막으로 올린** 시각(ISO). pull은 흔적을 남기지 않으므로 '동기화'가 아니다. */
  lastPushAt: string;
  /** 지금 보고 있는 이 기기인가. */
  isThis: boolean;
}

export interface StoreComparison {
  /** 도메인별 활성 개수 — 서버 / 이 기기. */
  counts: Record<PurgeDomain, { cloud: number; local: number }>;
  devices: DeviceSeen[];
  /** 서버에서 본 가장 최근 올림 시각. */
  lastCloudWriteAt: string | null;
  /**
   * 서버에 남은 **표식**의 수 — 성격이 완전히 다른 둘을 나눠 센다.
   *
   *  · `tombstoned` — 휴지통에 있는 행. **자료가 그대로 있다**(복원하면 돌아온다).
   *  · `purged` — 영구삭제 원장(`journey.purged_ids`)의 줄 수. **자료는 없다.**
   *    id·소유자·시각만 남고 제목·메모·좌표·금액은 서버에서 사라졌다(ADR-0030).
   *    이 줄이 남는 이유는 오직 하나 — 사정 모르는 다른 기기가 사본을 다시 올리는 것을
   *    서버가 거부하기 위해서다.
   *
   * 왜 보여주는가(2026-07-26 사용자 혼란): 앱이 서버 상태를 한 번도 말하지 않아,
   * 사용자가 Supabase를 직접 열어 보고 판단할 수밖에 없었다. **앱이 스스로 설명하게 한다.**
   */
  remnants: { tombstoned: number; purged: number };
  /** 서버 사진 기록↔파일 대조. **조회할 수 없으면 null** — 정상이 아니라 '확인 불가'다. */
  fileAudit: MediaFileAudit | null;
  /** 대조를 못 한 이유(사람이 읽는 한 줄). 대조에 성공했으면 null. */
  fileAuditNote: string | null;
  /**
   * **이 기기가 영구삭제했다고 믿는데 서버엔 아직 남아 있는** id들.
   *
   * 0이 정상이다. 0이 아니면 사용자의 의도가 서버에 반영되지 않은 상태이고, 로컬 표식 때문에
   * 휴지통에도 안 보여 **어디서도 손댈 수 없다** — 앱이 말해주지 않으면 영원히 남는다.
   */
  unpropagatedPurges: string[];
}

/**
 * **사진 파일 대조** — 서버 기록과 서버 파일이 짝이 맞는가(2026-07-26 신설).
 *
 * 두 방향은 성격이 완전히 다르다. 한 숫자로 합치면 사용자가 할 일이 정반대인 둘이 섞인다
 * (진단 §4의 "대기 중인 작업 3건"이 정확히 그 실수였다):
 *  · `orphans` — 파일은 있는데 **기록이 없다.** 잉여 파일이다. 기억은 안전하고 용량만 먹는다.
 *  · `missing` — 기록은 있는데 **파일이 없다.** 다른 기기가 그 사진을 영영 못 받는다 —
 *    이쪽이 **기억 손실 위험**이라 훨씬 무겁다.
 */
export interface MediaFileAudit {
  /** 서버에 파일이 있는 사진 수(우리 형식만). */
  files: number;
  /** 서버 기록 중 저장 경로를 가진 수. */
  rows: number;
  /** 기록 없는 파일의 사진 id. */
  orphans: string[];
  /** 파일 없는 기록의 사진 id. */
  missing: string[];
  /** 우리 형식이 아닌 키의 수. */
  foreign: number;
  /** 목록을 다 못 봤다 — true면 `orphans`가 0이어도 "없다"고 말하면 안 된다. */
  truncated: boolean;
}

/** 한 저장소의 목록 응답. */
export interface Listing {
  ids: string[];
  foreign?: number;
  truncated?: boolean;
  error?: string | undefined;
}

/**
 * **여러 저장소의 목록을 합친다**(2026-07-26 — 저장소 혼재 상태 때문에 생겼다).
 *
 * R2 전환(07-25) 이전 사진의 바이트는 여전히 Supabase Storage에 있다. 한 곳만 보고
 * "파일이 없다"고 판정하면 멀쩡한 사진 여러 장을 문제로 단정하는 **거짓 경보**가 된다.
 *
 * **한쪽이라도 못 읽으면 합집합 전체를 버린다.** 이게 이 함수의 존재 이유다 —
 * 읽지 못한 저장소를 "비어 있다"로 취급하면 거기 있는 사진이 **전부** '파일 없음'으로
 * 잡힌다. 부분 정보로 만든 합집합은 정보가 아니라 거짓말이다(비타협 원칙 #4·M-0008).
 */
export function unionListings(listings: Listing[]): Listing {
  const failed = listings.find((l) => l.error);
  if (failed) return { ids: [], foreign: 0, truncated: false, error: failed.error };
  return {
    ids: [...new Set(listings.flatMap((l) => l.ids))],
    foreign: listings.reduce((a, l) => a + (l.foreign ?? 0), 0),
    truncated: listings.some((l) => l.truncated === true),
  };
}

/**
 * 대조 자체는 **순수 함수**다 — 유닛이 네트워크 없이 모든 경계를 직접 돌린다.
 * (동기화 결정 로직을 `sync/merge.ts`로 뽑아낸 것과 같은 이유 — LESSONS §6.)
 */
export function auditMediaFiles(
  fileIds: string[],
  rowIds: string[],
  opts: { foreign?: number; truncated?: boolean } = {},
): MediaFileAudit {
  const files = new Set(fileIds);
  const rows = new Set(rowIds);
  return {
    files: files.size,
    rows: rows.size,
    orphans: [...files].filter((id) => !rows.has(id)),
    // 목록이 잘렸으면 "파일이 없다"고 단정할 수 없다 — 뒤쪽 페이지에 있을 수 있다.
    // 모르는 것을 문제로 반올림하지 않는다(비타협 원칙 #4). 판정은 호출부가 unknown으로 낸다.
    missing: opts.truncated ? [] : [...rows].filter((id) => !files.has(id)),
    foreign: opts.foreign ?? 0,
    truncated: opts.truncated === true,
  };
}

/** 원격 포트 — 네트워크 격리(테스트에서 fake 주입). */
export interface StoreStatePort {
  /** 도메인별 **활성**(tombstone·영구삭제 제외) 행 수. */
  activeCounts(): Promise<Record<PurgeDomain, number>>;
  /** `updated_by_device`가 찍힌 행들의 (기기, 올린 시각). */
  deviceStamps(): Promise<{ stamp: string; at: string }[]>;
  /** 서버에 표식만 남은 행 — 지움(tombstone) / 영구삭제(purged). 둘은 성격이 다르므로 나눠 센다. */
  remnantCounts(): Promise<{ tombstoned: number; purged: number }>;
  /**
   * 저장 경로를 가진 서버 사진 기록의 id들.
   *
   * **tombstone된 것도 포함한다** — ADR-0029 이후 휴지통에 있는 동안 파일은 서버에 남아 있고,
   * 그래야 어느 기기에서 복원해도 사진이 돌아온다. 활성만 세면 휴지통 사진이 전부 "고아"로
   * 잘못 잡힌다(라벨이 말할 수 있는 것만 말하게 한다 — 진단 §5.9).
   */
  mediaRowIds(): Promise<string[]>;
  /**
   * 서버에서 **tombstone(휴지통) 상태인 행의 id**들.
   *
   * 왜 필요한가(2026-07-26 실기기): 로컬에 영구삭제 표식이 있으면 pull이 그 id를 건너뛰므로
   * **휴지통에도 안 보인다.** 그런데 서버엔 남아 있으면 사용자는 "지웠다"고 믿고 서버는
   * "안 지웠다"고 안다 — 그 어긋남을 보려면 서버 tombstone 목록이 있어야 한다.
   */
  tombstonedIds(): Promise<string[]>;
}

export function storeStateRemote(client: JourneyClient): StoreStatePort {
  return {
    async activeCounts() {
      const out = {} as Record<PurgeDomain, number>;
      for (const d of PURGE_DOMAINS) {
        // head+exact — 행 본문을 받지 않는다(egress 절약). 실패는 -1이 아니라 0으로 두지 않고
        // 예외로 올려 보낸다 — "0건"과 "못 셌다"를 섞으면 그게 거짓말이다.
        const r = await client
          .from(DOMAIN_PURGE[d].remoteTable)
          .select('id', { count: 'exact', head: true })
          .is('deleted_at', null);
        if (r.error) throw new Error(`${DOMAIN_PURGE[d].remoteTable} 개수 조회 실패: ${r.error.message}`);
        out[d] = r.count ?? 0;
      }
      return out;
    },
    async deviceStamps() {
      const rows: { stamp: string; at: string }[] = [];
      for (const d of PURGE_DOMAINS) {
        const r = await client
          .from(DOMAIN_PURGE[d].remoteTable)
          .select('updated_by_device, updated_at')
          .not('updated_by_device', 'is', null);
        if (r.error) throw new Error(`${DOMAIN_PURGE[d].remoteTable} 기기 조회 실패: ${r.error.message}`);
        for (const x of (r.data ?? []) as { updated_by_device: string | null; updated_at: string }[]) {
          if (x.updated_by_device) rows.push({ stamp: x.updated_by_device, at: x.updated_at });
        }
      }
      return rows;
    },
    async remnantCounts() {
      let tombstoned = 0;
      for (const d of PURGE_DOMAINS) {
        const t = await client
          .from(DOMAIN_PURGE[d].remoteTable)
          .select('id', { count: 'exact', head: true })
          .not('deleted_at', 'is', null);
        if (t.error) throw new Error(`${DOMAIN_PURGE[d].remoteTable} 지움 개수 조회 실패: ${t.error.message}`);
        tombstoned += t.count ?? 0;
      }

      // 영구삭제된 것은 **행이 없다**(ADR-0030). 남은 건 id 원장 한 줄뿐이라 도메인별로 셀 수
      // 없고, 셀 필요도 없다 — 사용자가 알고 싶은 건 "자료가 남았나"이고 답은 항상 아니오다.
      const p = await client.from('purged_ids').select('id', { count: 'exact', head: true });
      if (p.error) throw new Error(`영구삭제 원장 조회 실패: ${p.error.message}`);
      return { tombstoned, purged: p.count ?? 0 };
    },
    async tombstonedIds() {
      const ids: string[] = [];
      for (const d of PURGE_DOMAINS) {
        const r = await client.from(DOMAIN_PURGE[d].remoteTable).select('id').not('deleted_at', 'is', null);
        if (r.error) throw new Error(`${DOMAIN_PURGE[d].remoteTable} 휴지통 조회 실패: ${r.error.message}`);
        for (const x of (r.data ?? []) as { id: string }[]) ids.push(x.id);
      }
      return ids;
    },
    async mediaRowIds() {
      const r = await client.from('media').select('id').not('storage_path', 'is', null);
      if (r.error) throw new Error(`사진 기록 조회 실패: ${r.error.message}`);
      return ((r.data ?? []) as { id: string }[]).map((x) => x.id);
    },
  };
}

/** 서버 스탬프 목록 → 기기별 최신 1건. **순수 함수**(유닛이 모든 경계를 직접 돌린다). */
export function foldDevices(rows: { stamp: string; at: string }[], thisId: string): DeviceSeen[] {
  const byId = new Map<string, DeviceSeen>();
  for (const r of rows) {
    const { label, id } = parseDeviceStamp(r.stamp);
    const key = id || label;
    const cur = byId.get(key);
    if (!cur || r.at > cur.lastPushAt) {
      byId.set(key, { label, id, lastPushAt: r.at, isThis: id === thisId });
    }
  }
  // 최근에 올린 기기가 위로. 이 기기는 항상 맨 위(사용자가 자기 자리를 먼저 찾게).
  return [...byId.values()].sort((a, b) => (a.isThis ? -1 : b.isThis ? 1 : b.lastPushAt.localeCompare(a.lastPushAt)));
}

/** 로컬 활성 개수 — 서버와 **같은 기준**(tombstone 제외)으로 센다. 기준이 다르면 대조가 거짓이 된다. */
export async function localActiveCounts(): Promise<Record<PurgeDomain, number>> {
  const d = db();
  const [trips, moments, media, expenses] = await Promise.all([
    d.localTrips.toArray(),
    d.localMoments.toArray(),
    d.localMedia.toArray(),
    d.localExpenses.toArray(),
  ]);
  const alive = (rows: { deletedAt: string | null }[]): number => rows.filter((r) => r.deletedAt === null).length;
  return { trip: alive(trips), moment: alive(moments), media: alive(media), expense: alive(expenses) };
}

/**
 * 파일 목록 포트 — R2 어댑터를 그대로 받지 않고 **필요한 모양만** 받는다.
 * storeState가 R2를 import하면 저장소 종류를 아는 게 되고, 그러면 Supabase Storage로
 * 되돌릴 때 이 파일도 고쳐야 한다(되돌리기가 환경변수 하나여야 한다는 계약이 깨진다).
 */
export interface FilesPort {
  list(): Promise<{ ids: string[]; foreign: number; truncated: boolean; error?: string | undefined }>;
}

export async function compareStore(port: StoreStatePort, files?: FilesPort): Promise<StoreComparison> {
  const [cloud, local, stamps, remnants, serverTombstones, purged] = await Promise.all([
    port.activeCounts(),
    localActiveCounts(),
    port.deviceStamps(),
    port.remnantCounts(),
    port.tombstonedIds(),
    purgedIdSet(),
  ]);
  // 내가 지웠다고 믿는데(로컬 표식) 서버엔 tombstone으로 남은 것 = 전파가 안 된 영구삭제.
  const unpropagatedPurges = serverTombstones.filter((id) => purged.has(id));
  const counts = {} as StoreComparison['counts'];
  for (const d of PURGE_DOMAINS) counts[d] = { cloud: cloud[d], local: local[d] };
  const devices = foldDevices(stamps, shortDeviceId(deviceId()));
  const lastCloudWriteAt = stamps.reduce<string | null>((m, r) => (m === null || r.at > m ? r.at : m), null);

  // 파일 대조는 **선택**이다. 포트가 없으면(Supabase Storage 경로 등) 못 한 것이지 정상이 아니다
  // → null로 두고 화면이 '확인 불가'로 말한다. 조회 실패도 같다(모르는 것을 정상으로 반올림하지 않는다).
  let fileAudit: MediaFileAudit | null = null;
  let fileAuditNote: string | null = files ? null : '이 기기의 사진 저장소가 R2가 아니라 목록을 물어볼 수 없어요';
  if (files) {
    try {
      const [listing, rowIds] = await Promise.all([files.list(), port.mediaRowIds()]);
      if (listing.error) fileAuditNote = listing.error;
      else fileAudit = auditMediaFiles(listing.ids, rowIds, { foreign: listing.foreign, truncated: listing.truncated });
    } catch (e) {
      fileAuditNote = (e as Error).message;
    }
  }
  return { counts, devices, lastCloudWriteAt, remnants, fileAudit, fileAuditNote, unpropagatedPurges };
}

/** 사람이 읽는 도메인 이름 — 화면이 손으로 다시 적지 않게 여기 한 곳. */
export const DOMAIN_LABEL: Record<PurgeDomain, string> = {
  trip: '여행',
  moment: '순간',
  media: '사진',
  expense: '비용',
};
