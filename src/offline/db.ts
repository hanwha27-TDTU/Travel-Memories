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
  localMedia!: Table<LocalMedia, string>;
  localExpenses!: Table<LocalExpense, string>;
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
  }
}

let _db: JourneyDB | null = null;
export function db(): JourneyDB {
  if (!_db) _db = new JourneyDB();
  return _db;
}
