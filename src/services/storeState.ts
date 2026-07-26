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
import { parseDeviceStamp, shortDeviceId, deviceId, deviceLabel } from '../app/deviceId';
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
  /**
   * **휴지통 대조** — 클라우드 / 이 기기.
   *
   * 활성만 대조하던 시절에는 자료가 전부 휴지통에 있으면 양쪽 0이 되어 화면이 「같습니다」라고
   * 말했다(2026-07-26 사용자 지적). 지운 것도 자료이므로 대조 대상이다.
   *
   * ⚠️ `local < cloud`는 **정상일 수 있다.** 비파괴 pull 규율(불변식 #8) 때문에 다른 기기에서
   * 지운 항목의 tombstone은 이 기기에 사본이 없으면 만들지 않는다. 그래서 판정은 `local > cloud`
   * (= 아직 안 올린 것이 있다)일 때만 '할 일'이다.
   */
  trashed: { cloud: number; local: number };
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
  /**
   * 서버에서 tombstone(휴지통) 상태인 id들 — **화면이 "지워도 되는 것"과 "지우면 안 되는 것"을
   * 가르는 데 쓴다.** 파일이 없는 기록 중 tombstone인 것은 자료가 이미 없으니 정리하면 되고,
   * 활성인 것은 **기억 손실 위험**이라 지우면 안 된다. 성격이 정반대다.
   */
  serverTombstoned: string[];
  /**
   * 서버 **영구삭제 원장**의 id들 — 화면이 「치워도 되는 파일」과 「지우면 안 되는 파일」을
   * 가르는 데 쓴다. 원장에 있으면 자료는 이미 없고, 없으면 그 파일이 마지막 사본일 수 있다.
   */
  serverPurged: string[];
  /**
   * **앱이 관리하지 않는 항목** — 사진 저장소에서 내 폴더 밖에 있는 최상위 항목 수.
   *
   * 왜 필요한가(2026-07-26 사용자): 앱의 목록 조회는 보안상 **내 폴더만** 본다. 그래서
   * 「사진 파일 0개」는 *내 폴더 기준*이지 "저장소가 비었다"가 아니다. 그 한정을 화면이
   * 말하지 않아 사용자가 Cloudflare 콘솔을 매번 직접 열어야 했다 — 앱이 스스로 말하게 한다.
   *
   * `known`이 false면 개수를 **쓰지 않는다**('확인 불가'). 못 본 것을 0으로 반올림하지 않는다.
   */
  outside: { count: number; known: boolean };
  /** 내 사진 파일의 총 바이트 — 대시보드 숫자와 대조할 수 있게(2026-07-26 "왜 2.87MB?"). */
  bytes: number;
  /**
   * **미완료 멀티파트 조각** — 객체 목록에도 대시보드 파일 목록에도 안 보이면서 용량을 먹는다.
   * "다 지웠는데 왜 용량이 남지?"의 유일한 설명 가능한 후보다.
   */
  multipart: { mine: number; outside: number; known: boolean };
  /** 서버 함수 판. 앱이 기대하는 판보다 낮으면 새 지표를 못 믿는다. */
  fnVersion: number;
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
  /** 내 폴더 **밖**의 최상위 항목 수. `outsideKnown`이 false면 이 값을 쓰지 않는다. */
  outside?: number;
  outsideKnown?: boolean;
  /** 내 폴더 총 바이트. */
  bytes?: number;
  /** 미완료 멀티파트 조각 — 목록에 안 보이면서 용량을 먹는다. */
  multipart?: { mine: number; outside: number; known: boolean };
  /** 서버에 배포된 함수 판(0 = 안 밝힘 = 낡음). */
  version?: number;
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
  if (failed) return { ids: [], foreign: 0, truncated: false, outside: 0, outsideKnown: false, error: failed.error };
  return {
    ids: [...new Set(listings.flatMap((l) => l.ids))],
    foreign: listings.reduce((a, l) => a + (l.foreign ?? 0), 0),
    truncated: listings.some((l) => l.truncated === true),
    outside: listings.reduce((a, l) => a + (l.outside ?? 0), 0),
    // **하나라도 모르면 전체를 모른다**(truncated와 같은 규율 — 부분 정보로 만든 합은 거짓말이다).
    outsideKnown: listings.length > 0 && listings.every((l) => l.outsideKnown === true),
    bytes: listings.reduce((a, l) => a + (l.bytes ?? 0), 0),
    multipart: {
      mine: listings.reduce((a, l) => a + (l.multipart?.mine ?? 0), 0),
      outside: listings.reduce((a, l) => a + (l.multipart?.outside ?? 0), 0),
      known: listings.length > 0 && listings.every((l) => l.multipart?.known === true),
    },
    // 판이 여럿이면 **가장 낮은 것**을 쓴다 — 하나라도 낡으면 그 기능은 못 믿는다.
    version: listings.length ? Math.min(...listings.map((l) => l.version ?? 0)) : 0,
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
  /**
   * **영구삭제 원장(`journey.purged_ids`)의 id들.**
   *
   * 왜 필요한가(2026-07-26 실기기): 서버 행이 하나도 없는데 R2에 파일 3개가 남았다.
   * 영구삭제 시 바이트 삭제는 **최선노력**이라(실패해도 op을 지운다) 재시도 기회가 없다.
   * 그 결과 「기록 없는 사진 파일」이 생기는데, 이 숫자만으로는 성격이 **정반대인 둘**이 섞인다:
   *
   *  · 원장에 있는 id → **영구삭제한 사진의 잔재.** 자료는 이미 없다. 치우면 된다.
   *  · 원장에 없는 id → **설명할 수 없는 파일.** 업로드는 됐는데 기록이 안 만들어졌을 수
   *    있다(그러면 그 파일이 그 사진의 **마지막 사본**이다). 지우면 기억을 잃는다.
   *
   * 「사진 파일이 사라진 기록」을 두 갈래로 쪼갠 것과 **같은 규율**이다(§7 대칭).
   */
  purgedLedgerIds(): Promise<string[]>;
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
    async purgedLedgerIds() {
      const r = await client.from('purged_ids').select('id');
      if (r.error) throw new Error(`영구삭제 원장 조회 실패: ${r.error.message}`);
      return ((r.data ?? []) as { id: string }[]).map((x) => x.id);
    },
    async mediaRowIds() {
      const r = await client.from('media').select('id').not('storage_path', 'is', null);
      if (r.error) throw new Error(`사진 기록 조회 실패: ${r.error.message}`);
      return ((r.data ?? []) as { id: string }[]).map((x) => x.id);
    },
  };
}

/**
 * 서버 스탬프 목록 → 기기별 최신 1건. **순수 함수**(유닛이 모든 경계를 직접 돌린다).
 *
 * `thisLabel`을 주면 **이 기기 줄만** 그 이름으로 덮어쓴다. 왜 필요한가(§9 4단계 — 옛 데이터를
 * 누가 데려오나): 이름은 push할 때 서버 행에 **찍힌 채로 남는다.** 사용자가 방금 이름을 바꿔도
 * 다음 저장 전까지 서버엔 옛 이름이 있어서, 화면이 서버 값을 그대로 그리면 **바꾼 이름이
 * 안 보인다.** 다른 기기 줄은 건드리지 않는다 — 그 기기가 스스로 밝힌 이름이 진실이다.
 */
export function foldDevices(rows: { stamp: string; at: string }[], thisId: string, thisLabel?: string): DeviceSeen[] {
  const byId = new Map<string, DeviceSeen>();
  for (const r of rows) {
    const { label, id } = parseDeviceStamp(r.stamp);
    const key = id || label;
    const isThis = id === thisId;
    const cur = byId.get(key);
    if (!cur || r.at > cur.lastPushAt) {
      byId.set(key, { label: isThis && thisLabel ? thisLabel : label, id, lastPushAt: r.at, isThis });
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
 * 로컬 **휴지통(tombstone)** 개수.
 *
 * 왜 필요한가(2026-07-26 사용자 지적): 지금까지 대조는 **활성만** 했다. 그래서 자료가 전부
 * 휴지통으로 옮겨가면 활성이 양쪽 0이 되어 화면이 「같습니다」라고 말했다 — 정작 13건이
 * 어디 있는지는 어느 지표도 말하지 않았다. **지운 것도 자료다.** 대조 대상이어야 한다.
 */
export async function localTombstoneCount(): Promise<number> {
  const d = db();
  const [trips, moments, media, expenses] = await Promise.all([
    d.localTrips.toArray(),
    d.localMoments.toArray(),
    d.localMedia.toArray(),
    d.localExpenses.toArray(),
  ]);
  const dead = (rows: { deletedAt: string | null }[]): number => rows.filter((r) => r.deletedAt !== null).length;
  return dead(trips) + dead(moments) + dead(media) + dead(expenses);
}

/**
 * 파일 목록 포트 — R2 어댑터를 그대로 받지 않고 **필요한 모양만** 받는다.
 * storeState가 R2를 import하면 저장소 종류를 아는 게 되고, 그러면 Supabase Storage로
 * 되돌릴 때 이 파일도 고쳐야 한다(되돌리기가 환경변수 하나여야 한다는 계약이 깨진다).
 */
export interface FilesPort {
  list(): Promise<Listing>;
}

export async function compareStore(port: StoreStatePort, files?: FilesPort): Promise<StoreComparison> {
  const [cloud, local, stamps, remnants, serverTombstones, purged, localTrash, serverPurged] = await Promise.all([
    port.activeCounts(),
    localActiveCounts(),
    port.deviceStamps(),
    port.remnantCounts(),
    port.tombstonedIds(),
    purgedIdSet(),
    localTombstoneCount(),
    port.purgedLedgerIds(),
  ]);
  // 내가 지웠다고 믿는데(로컬 표식) 서버엔 tombstone으로 남은 것 = 전파가 안 된 영구삭제.
  const unpropagatedPurges = serverTombstones.filter((id) => purged.has(id));
  const counts = {} as StoreComparison['counts'];
  for (const d of PURGE_DOMAINS) counts[d] = { cloud: cloud[d], local: local[d] };
  const devices = foldDevices(stamps, shortDeviceId(deviceId()), deviceLabel());
  const lastCloudWriteAt = stamps.reduce<string | null>((m, r) => (m === null || r.at > m ? r.at : m), null);

  // 파일 대조는 **선택**이다. 포트가 없으면(Supabase Storage 경로 등) 못 한 것이지 정상이 아니다
  // → null로 두고 화면이 '확인 불가'로 말한다. 조회 실패도 같다(모르는 것을 정상으로 반올림하지 않는다).
  let fileAudit: MediaFileAudit | null = null;
  let fileAuditNote: string | null = files ? null : '이 기기의 사진 저장소가 R2가 아니라 목록을 물어볼 수 없어요';
  let outside = { count: 0, known: false };
  let bytes = 0;
  let multipart = { mine: 0, outside: 0, known: false };
  let fnVersion = 0;
  if (files) {
    try {
      const [listing, rowIds] = await Promise.all([files.list(), port.mediaRowIds()]);
      if (listing.error) fileAuditNote = listing.error;
      else {
        fileAudit = auditMediaFiles(listing.ids, rowIds, { foreign: listing.foreign ?? 0, truncated: listing.truncated === true });
        outside = { count: listing.outside ?? 0, known: listing.outsideKnown === true };
        bytes = listing.bytes ?? 0;
        multipart = listing.multipart ?? { mine: 0, outside: 0, known: false };
        fnVersion = listing.version ?? 0;
      }
    } catch (e) {
      fileAuditNote = (e as Error).message;
    }
  }
  return {
    counts,
    devices,
    lastCloudWriteAt,
    remnants,
    trashed: { cloud: remnants.tombstoned, local: localTrash },
    fileAudit,
    fileAuditNote,
    unpropagatedPurges,
    serverTombstoned: serverTombstones,
    serverPurged,
    outside,
    bytes,
    multipart,
    fnVersion,
  };
}

/** 사람이 읽는 도메인 이름 — 화면이 손으로 다시 적지 않게 여기 한 곳. */
export const DOMAIN_LABEL: Record<PurgeDomain, string> = {
  trip: '여행',
  moment: '순간',
  media: '사진',
  expense: '비용',
};
