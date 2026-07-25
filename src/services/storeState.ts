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
import { PURGE_DOMAINS, DOMAIN_PURGE, type PurgeDomain } from './purge';
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
   * 서버에 **표식만 남은** 행 수 — 지운 것(tombstone)과 영구삭제한 것(purged).
   *
   * 왜 이걸 보여주는가(2026-07-26 사용자 혼란): 영구삭제해도 서버 행은 **일부러 남긴다**
   * (ADR-0027 — 행을 지우면 그 사실을 모르는 기기가 사본을 다시 올려 좀비가 된다).
   * 그런데 앱이 그 사실을 한 번도 말하지 않아, 사용자가 Supabase를 직접 열어 보고
   * "안 지워졌다"고 판단할 수밖에 없었다. **앱이 스스로 설명하게 한다.**
   */
  remnants: { tombstoned: number; purged: number };
}

/** 원격 포트 — 네트워크 격리(테스트에서 fake 주입). */
export interface StoreStatePort {
  /** 도메인별 **활성**(tombstone·영구삭제 제외) 행 수. */
  activeCounts(): Promise<Record<PurgeDomain, number>>;
  /** `updated_by_device`가 찍힌 행들의 (기기, 올린 시각). */
  deviceStamps(): Promise<{ stamp: string; at: string }[]>;
  /** 서버에 표식만 남은 행 — 지움(tombstone) / 영구삭제(purged). 둘은 성격이 다르므로 나눠 센다. */
  remnantCounts(): Promise<{ tombstoned: number; purged: number }>;
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
          .is('deleted_at', null)
          .is('purged_at', null);
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
      let purged = 0;
      for (const d of PURGE_DOMAINS) {
        const t = await client
          .from(DOMAIN_PURGE[d].remoteTable)
          .select('id', { count: 'exact', head: true })
          .not('deleted_at', 'is', null)
          .is('purged_at', null);
        if (t.error) throw new Error(`${DOMAIN_PURGE[d].remoteTable} 지움 개수 조회 실패: ${t.error.message}`);
        tombstoned += t.count ?? 0;

        const p = await client
          .from(DOMAIN_PURGE[d].remoteTable)
          .select('id', { count: 'exact', head: true })
          .not('purged_at', 'is', null);
        if (p.error) throw new Error(`${DOMAIN_PURGE[d].remoteTable} 영구삭제 개수 조회 실패: ${p.error.message}`);
        purged += p.count ?? 0;
      }
      return { tombstoned, purged };
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

export async function compareStore(port: StoreStatePort): Promise<StoreComparison> {
  const [cloud, local, stamps, remnants] = await Promise.all([
    port.activeCounts(),
    localActiveCounts(),
    port.deviceStamps(),
    port.remnantCounts(),
  ]);
  const counts = {} as StoreComparison['counts'];
  for (const d of PURGE_DOMAINS) counts[d] = { cloud: cloud[d], local: local[d] };
  const devices = foldDevices(stamps, shortDeviceId(deviceId()));
  const lastCloudWriteAt = stamps.reduce<string | null>((m, r) => (m === null || r.at > m ? r.at : m), null);
  return { counts, devices, lastCloudWriteAt, remnants };
}

/** 사람이 읽는 도메인 이름 — 화면이 손으로 다시 적지 않게 여기 한 곳. */
export const DOMAIN_LABEL: Record<PurgeDomain, string> = {
  trip: '여행',
  moment: '순간',
  media: '사진',
  expense: '비용',
};
