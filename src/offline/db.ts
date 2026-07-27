// offline/db.ts — Dexie(IndexedDB) 로컬 스키마 스텁 (docs/SYNC_PROTOCOL.md)
// 오프라인 우선: 저장은 여기에 먼저 커밋한 뒤 동기화 대기열에 올린다.
// Phase 0B는 스키마 선언까지만. 실제 CRUD/동기화 로직은 이후 Phase.

import Dexie, { type Table } from 'dexie';
import type { EditState } from '../media/editor-core';

// 공통 동기화 메타 (docs/DATA_MODEL.md). 실제 도메인 필드는 Phase 1에서 확장.
export interface SyncMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  deletedAt: string | null;
  updatedByDevice?: string;
  baseVersion?: number;
  clientOperationId?: string;
}

export interface LocalTrip extends SyncMeta {
  title: string;
  startDate: string;
  endDate: string;
  status: 'planned' | 'active' | 'completed' | 'archived';
}

// 순간(Moment) — 여행 안의 한 기억. 선택 필드는 null 대신 ''로 통일(과적재 금지, SYNC_PROTOCOL).
export interface LocalMoment extends SyncMeta {
  tripId: string;
  occurredAt: string; // ISO — 발생 시각(정렬·날짜 그룹 기준)
  title: string; // 한 줄 기록
  note: string; // 추가 메모(선택)
  emotion: string; // 감정 이모지(선택)
  placeName: string; // 장소명(선택)
  placeLat?: number | null; // 장소 좌표(지오코딩 선택) — 있으면 지도에 표시
  placeLng?: number | null;
}

// 사진(Media) — 로컬 전용(3a). 원본 Blob은 절대 수정하지 않는다(§0).
// 클라우드 업로드(압축본·썸네일)는 후속(3b)에서 syncQueue로 추가.
export interface LocalMedia extends SyncMeta {
  momentId: string;
  tripId: string;
  mime: string;
  originalBlob: Blob; // 원본 보존(로컬)
  displayBlob: Blob; // 표시본(≤1600 WebP)
  thumbBlob: Blob; // 썸네일(≤320 WebP)
  width: number;
  height: number;
  takenAt: string; // EXIF 촬영시각 또는 파일 mtime(ISO)
  gpsLat: number | null; // EXIF GPS(기본 비공개 — 공유 시 제거)
  gpsLng: number | null;
  bytesOriginal: number;
  bytesDisplay: number;
  /**
   * **서버에 실제로 올라간 객체 키.** 한 번 정해지면 안 바뀐다 — 다시 계산하지 않는다.
   *
   * 왜 기억하나(2026-07-27): 키에 여행 제목이 들어가면서 경로가 **움직이는 값의 함수**가 됐다.
   * 매번 다시 계산하면 제목을 바꾼 뒤의 재전송이 **다른 키**로 올라가 옛 파일이 고아로 남는다.
   * R2에는 '이름 바꾸기'가 없으니 그 고아는 사람이 치워야 하고, 앱은 그걸 「설명할 수 없는
   * 사진 파일」이라는 **문제**로 띄운다 — 제목 한 번 고쳤을 뿐인데.
   *
   * 그래서 **바이트가 착지한 키가 곧 진실**이고, 파생이 아니라 데이터로 둔다.
   * 인덱스는 필요 없다(조회 대상이 아님) → Dexie 스키마 버전 증가 없이 붙는 평범한 속성.
   * 옛 행에는 없을 수 있으므로 선택 필드다(없으면 그때 계산해 채운다).
   */
  storagePath?: string;
  // 비파괴 편집 상태(선택) — 재편집 시 이전 편집을 이어서 조정. 원본에서 파생하므로
  // 직렬화 가능한 순수 값만 담는다(회전·자르기·색보정·잡티). 원본 Blob은 절대 안 바뀐다(§0).
  editState?: EditState;
}

// 비용(Expense) — 순간에 딸린 지출. 원금액은 양수·불변(H-04), 통화는 ISO 4217.
// 환율/기준통화 환산 열은 후속(nullable) — 로컬 MVP는 원금액만 저장한다.
export interface LocalExpense extends SyncMeta {
  momentId: string;
  tripId: string;
  originalAmount: number; // > 0
  originalCurrency: string; // ISO 4217 (KRW·USD…)
  category: string; // 분류(선택)
  note: string; // 메모(선택)
}

// 환율 표(FxRateTable) 로컬 캐시 — **파생·재취득 가능한 공개 데이터**이지 사용자의 기억이 아니다.
// 그래서 동기화하지 않고 백업에도 담지 않는다(syncQueue와 같은 성격 — check-backup-coverage 제외 목록).
// 과거 날짜의 기준환율은 확정값이라 한 번 받으면 안 바뀐다 → 캐시가 표시 안정성을 보장한다.
export interface LocalFxRate {
  id: string; // `${date}|${BASE}` (domain/expense/fx.ts fxKey)
  date: string; // 실제 적용 환율 날짜 'YYYY-MM-DD'
  base: string; // 기준통화(대문자)
  rates: Record<string, number>;
  source: string;
  fetchedAt: string;
}

export interface SyncQueueItem {
  operationId: string;
  entityType: string;
  entityId: string;
  /** `purge` = 영구삭제 전파(ADR-0027). 로컬 행이 이미 없으므로 도메인 push 루프가 처리하지 않는다. */
  /**
   * `unpurge` — 백업 복원이 만든 **원장 되돌리기** 의사(2026-07-26).
   * 복원은 "영구히 치움"보다 우선하는 새 의도인데, 서버 원장을 그대로 두면 push가 트리거에
   * 막히고 이어서 원장 pull이 로컬 행까지 지운다. 그 순서를 끊기 위해 큐에 올린다.
   */
  operationType: 'insert' | 'update' | 'delete' | 'finalize_upload' | 'purge' | 'unpurge';
  state: string;
  attempts: number;
  createdAt: string;
  /**
   * **이 시각 전에는 다시 시도하지 않는다**(ISO). 지수 백오프의 저장 형태.
   *
   * 2026-07-27까지 `attempts`는 **증가만 하고 아무도 읽지 않았다** — `SYNC_PROTOCOL.md:31`이
   * 5초/15초/60초/5분/15분+jitter를 계약으로 적어 뒀는데 코드에 백오프가 없었다.
   * 사진 크기에서는 무해했지만, `autoSync`가 `online`·`visibilitychange`·5분 주기로 도는 탓에
   * 실패한 op이 **화면을 오갈 때마다 즉시 재시도**된다(대용량이면 그 자체가 공격이 된다).
   *
   * 인덱스가 아니라 **값**이다(Dexie 스키마 변경 불필요). 없으면 "지금 시도 가능"으로 읽는다.
   */
  nextRetryAt?: string;
}

// 영구삭제 표식(A안, ADR 예정) — "이 기기에서 영구히 치운 것"의 목록.
//
// 왜 필요한가(실제 결함): 휴지통 영구삭제는 로컬 행을 하드 삭제하는데, `mergeDecision`은
// **로컬에 없으면 무조건 서버를 채택**한다(`if (!local) return 'take-server'`). 그래서 다음
// pull에서 그대로 되살아났다 — 영구삭제가 이름값을 못 했다.
//
// 서버 행을 하드 삭제하는 길(B안)은 택하지 않았다: 그 사실을 모르는 다른 기기가 자기 사본을
// 다시 올려 **좀비**를 만들 수 있고, tombstone 전용 규율(§0)도 깨진다. 대신 서버에는
// tombstone을 남기고 **이 기기만 그 id를 무시**한다 — 하드 삭제 없이 목적을 이룬다.
//
// 성격: 기억이 아니라 **로컬 표시 상태**다. 잃어도 사용자의 기억은 그대로이고, 휴지통에 다시
// 나타날 뿐이다 → 동기화·백업 대상이 아니다(localFxRates·syncQueue와 같은 분류).
export interface PurgedId {
  /** 영구삭제된 엔티티 id(여행·순간·사진·비용 모두 같은 목록에 담는다). */
  id: string;
  /**
   * 어느 도메인이었는가. **`'unknown'`은 거짓이 아니라 사실이다** — 서버 원장(ADR-0030)은
   * id만 담으므로(자료를 남기지 않는 것이 목적) 다른 기기가 알려준 영구삭제는 종류를 모른다.
   * 모르는 것을 아는 척 적지 않는다(비타협 원칙 #4).
   */
  entityType: 'trip' | 'moment' | 'media' | 'expense' | 'unknown';
  purgedAt: string;
}

export class JourneyDB extends Dexie {
  localTrips!: Table<LocalTrip, string>;
  localMoments!: Table<LocalMoment, string>;
  localMedia!: Table<LocalMedia, string>;
  localExpenses!: Table<LocalExpense, string>;
  localFxRates!: Table<LocalFxRate, string>;
  purgedIds!: Table<PurgedId, string>;
  syncQueue!: Table<SyncQueueItem, string>;

  constructor() {
    super('journey-archive');
    this.version(1).stores({
      // 인덱스만 선언. Blob/대용량은 별도 store로 Phase 1에서 추가.
      // deletedAt은 인덱스로 걸지 않는다: IndexedDB는 null을 인덱스 키로 저장할 수
      // 없어 활성 행(deletedAt=null)이 인덱스에서 통째로 빠진다(M-0005).
      // tombstone 필터는 .filter()로 하고, 인덱스가 필요해지면 Phase 1에서
      // 센티널(0 | ISO 문자열) 마이그레이션으로 도입한다(docs/SYNC_PROTOCOL.md).
      localTrips: 'id, updatedAt, status',
      syncQueue: 'operationId, entityId, state, createdAt',
    });
    // v2: 순간(Moment) 로컬 store 추가(로컬우선; 서버 동기화는 후속).
    this.version(2).stores({
      localMoments: 'id, tripId, occurredAt, updatedAt',
    });
    // v3: 사진(Media) 로컬 store. Blob 저장(원본+파생). 대용량이므로 인덱스는 관계키만.
    this.version(3).stores({
      localMedia: 'id, momentId, tripId, updatedAt',
    });
    // v4: 비용(Expense) 로컬 store. 순간·여행 관계키로 조회.
    this.version(4).stores({
      localExpenses: 'id, momentId, tripId, updatedAt',
    });
    // v5: 환율 표 캐시. 파생 데이터라 동기화·백업 대상 아님(위 LocalFxRate 주석).
    this.version(5).stores({
      localFxRates: 'id, date, base',
    });
    // v6: 영구삭제 표식. pull이 이 id를 건너뛰어 "지운 것이 되살아나는" 부활을 막는다.
    this.version(6).stores({
      purgedIds: 'id, entityType, purgedAt',
    });
  }
}

let _db: JourneyDB | null = null;
export function db(): JourneyDB {
  if (!_db) _db = new JourneyDB();
  return _db;
}
