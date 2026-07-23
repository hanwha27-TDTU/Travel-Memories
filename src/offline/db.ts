// offline/db.ts — Dexie(IndexedDB) 로컬 스키마 스텁 (docs/SYNC_PROTOCOL.md)
// 오프라인 우선: 저장은 여기에 먼저 커밋한 뒤 동기화 대기열에 올린다.
// Phase 0B는 스키마 선언까지만. 실제 CRUD/동기화 로직은 이후 Phase.

import Dexie, { type Table } from 'dexie';

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
}

export interface SyncQueueItem {
  operationId: string;
  entityType: string;
  entityId: string;
  operationType: 'insert' | 'update' | 'delete' | 'finalize_upload';
  state: string;
  attempts: number;
  createdAt: string;
}

export class JourneyDB extends Dexie {
  localTrips!: Table<LocalTrip, string>;
  localMoments!: Table<LocalMoment, string>;
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
  }
}

let _db: JourneyDB | null = null;
export function db(): JourneyDB {
  if (!_db) _db = new JourneyDB();
  return _db;
}
