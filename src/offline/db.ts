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
  /** 마지막으로 확인한 서버 최종본 세대. canonical 교체 뒤 옛 기기 쓰기를 막는 fence다. */
  baseCanonicalVersion?: string;
  clientOperationId?: string;
}

export type CanonicalStage = 'uploading' | 'publishing' | 'read-back' | 'local-commit';

/**
 * 「이 기기 → 클라우드 최종본」의 재시작 가능한 작업 기록.
 * 메타 스냅샷만 보관하고 Blob은 도메인 store의 내구성 사본을 사용한다.
 */
export interface PendingCanonicalSnapshot {
  expectedVersion: string;
  nextVersion: string;
  operationId: string;
  device: string;
  stage: CanonicalStage;
  createdAt: string;
  queuedOperationIds: string[];
  stagedPaths: string[];
  previousPaths: string[];
  trips: Record<string, unknown>[];
  places: Record<string, unknown>[];
  moments: Record<string, unknown>[];
  media: Record<string, unknown>[];
  expenses: Record<string, unknown>[];
  audio: Record<string, unknown>[];
  purgedIds: string[];
}

/** 동기화 제어 상태. 사용자 기억이 아니므로 백업·서버 병합 대상이 아니다. */
export interface LocalSyncState {
  id: string;
  userId: string;
  canonicalVersion?: string;
  pendingCanonical?: PendingCanonicalSnapshot;
  updatedAt: string;
}

export interface LocalTrip extends SyncMeta {
  title: string;
  startDate: string;
  endDate: string;
  status: 'planned' | 'active' | 'completed' | 'archived';
  /**
   * 🔴 **이 여행을 겪은 시간대**(IANA id, 예 `'Asia/Ho_Chi_Minh'`). 비어 있으면 **미지정**.
   *
   * 왜 오프셋이 아니라 id인가: 오프셋은 시간대의 성질이 아니라 **시간대 × 순간**의 성질이다
   * (파리는 여름 +120, 겨울 +60). id를 두면 브라우저의 tzdata가 DST까지 처리한다 —
   * 데이터셋 0바이트(`domain/time.ts` 머리주석).
   *
   * **미지정을 기기 시간대로 채우지 않는다**(M-0049). 옛 여행에 추측을 써 넣으면 그건
   * 사용자가 말한 적 없는 사실이 기록에 남는 것이다. 화면이 「추정」이라 말하고 사용자가 정한다.
   */
  timeZone?: string;
}

// 순간(Moment) — 여행 안의 한 기억. 선택 필드는 null 대신 ''로 통일(과적재 금지, SYNC_PROTOCOL).
export interface LocalMoment extends SyncMeta {
  tripId: string;
  occurredAt: string; // ISO — 발생 시각(정렬·날짜 그룹 **기준값은 절대시각**)
  /**
   * 이 순간의 **오프셋 예외**(분). 여행 시간대와 다를 때만 채운다 — 사진 EXIF
   * `OffsetTimeOriginal`이 알려줬거나, 사용자가 직접 고쳤을 때.
   *
   * `undefined`/`null`이면 **여행 시간대에서 파생**한다(`resolveOffsetMin` 사다리).
   * 한 여행이 여러 시간대를 걸치는 경우(환승·국경)를 이 필드 하나가 감당한다.
   */
  tzOffsetMin?: number | null;
  title: string; // 한 줄 기록
  note: string; // 추가 메모(선택)
  emotion: string; // 감정 이모지(선택)
  placeName: string; // 장소명(선택)
  placeLat?: number | null; // 장소 좌표(지오코딩 선택) — 있으면 지도에 표시
  placeLng?: number | null;
  /**
   * 장소 라이브러리 링크(선택 · 마이그레이션 0023).
   *
   * 🔴 위 세 칸을 **대체하지 않는다.** 저 셋은 *그때 그렇게 기록한 사실*이고, 이 링크는
   * "라이브러리의 그 장소를 골라 적었다"는 부가 정보다. 라이브러리의 좌표를 나중에 고쳐도
   * 과거 순간의 기록은 바뀌지 않는다(사용자가 쓴 것을 앱이 고쳐 쓰지 않는다).
   * 자유 입력·지도 직접 지정은 링크가 없는 것이 **정상**이다.
   */
  placeId?: string | null;
}

// 사진(Media) — 클라우드 확인 전에는 원본을 내구성 스테이징하고, 확인 뒤에는 표시본이 정본이다.
export interface LocalMedia extends SyncMeta {
  momentId: string;
  tripId: string;
  mime: string;
  /**
   * 클라우드 표시본이 검증되기 전까지의 임시 원본 사본.
   * R2 GET read-back으로 `displayBlob`과 같은 바이트임을 확인한 뒤 제거한다.
   * 사진 입력 파일 자체는 앱이 수정·삭제하지 않는다.
   */
  originalBlob?: Blob;
  displayBlob: Blob; // 표시본(≤1600 WebP)
  thumbBlob: Blob; // 썸네일(≤320 WebP)
  width: number;
  height: number;
  takenAt: string; // EXIF 촬영시각 또는 파일 mtime(ISO)
  gpsLat: number | null; // EXIF GPS(기본 비공개 — 공유 시 제거)
  gpsLng: number | null;
  /**
   * 한 순간 안에서 **사용자가 정한 자리**(0부터). `null`이면 아직 안 정한 것이고, 그때는
   * 촬영시각 순으로 놓는다(`domain/media/order.ts`). 🔴 `null`과 `0`은 다른 뜻이다.
   */
  sortOrder: number | null;
  bytesOriginal: number;
  bytesDisplay: number;
  /**
   * **서버 행이 현재 가리키는 실제 객체 키.** 파생값이 아니며, DB OCC가 승인한 새 바이트
   * 작업이 착지할 때만 작업별 불변 키로 전진한다(M-0087).
   *
   * 왜 기억하나(2026-07-27): 키에 여행 제목이 들어가면서 경로가 **움직이는 값의 함수**가 됐다.
   * 매번 다시 계산하면 제목을 바꾼 뒤의 재전송이 **다른 키**로 올라가 옛 파일이 고아로 남는다.
   * R2에는 '이름 바꾸기'가 없으니 그 고아는 사람이 치워야 하고, 앱은 그걸 「설명할 수 없는
   * 사진 파일」이라는 **문제**로 띄운다 — 제목 한 번 고쳤을 뿐인데.
   *
   * 그래서 **DB read-back으로 승인된 바이트 키가 곧 진실**이고, 파생이 아니라 데이터로 둔다.
   * 인덱스는 필요 없다(조회 대상이 아님) → Dexie 스키마 버전 증가 없이 붙는 평범한 속성.
   * 옛 행에는 없을 수 있으므로 선택 필드다(없으면 그때 계산해 채운다).
   */
  storagePath?: string;
  /**
   * **서버에 바이트가 없음을 확인했다**(2026-08-01 · M-0059). 다음 push가 tombstone이어도 올린다.
   *
   * 왜 「`storagePath`가 없다」로 대신할 수 없나: 사진에서 경로 기억이 없다는 것은
   * ①옛 키 형식 행(바이트는 **있다**)과 ②확인된 부재, **두 가지**를 뜻한다. 추측하면 ①을
   * 다시 올려 고아를 만든다. 그래서 **의도를 명시한다** — 판정은 `mustUploadBytes` 한 곳에서.
   *
   * 성공적으로 올린 그 트랜잭션에서 지운다(M-0033 — "곧 이어서 지울 것"은 안 지운 것과 같다).
   * 인덱스가 아니므로 Dexie 버전을 올리지 않는다.
   */
  bytesMissing?: true;
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

/**
 * **오디오 노트** — 순간에 붙는 짧은 녹음(≤60초). 소리와 말을 회수한다.
 *
 * ── 왜 별도 테이블인가 (§7 2층) ───────────────────────────────────────
 * `LocalMedia`에 `audioBlob?` 필드를 붙이는 방법도 있었지만 **그러면 안 된다.**
 * `check-backup-coverage`는 **테이블 단위**로 본다(`db.ts`의 `Table<...>` 선언을 뽑는다) —
 * 필드를 추가하면 테이블 목록이 그대로라 게이트가 **GREEN인 채로** 백업에서 조용히 빠진다.
 * 별도 테이블이면 게이트가 **자동으로** 걸린다. "다음 형제가 자동으로 따라오는가"에 예다.
 *
 * `SyncMeta`를 상속하므로 tombstone·version·LWW·좀비 차단 규율을 **자동 승계**한다
 * (`mergeDecision`은 `SyncMeta`만 참조한다 — 서버 동기화를 붙일 때 그대로 쓰인다).
 *
 * ── 계층(DISASTER_RECOVERY) ───────────────────────────────────────────
 * 오디오는 **①로컬 + ②서버 + ③백업** 세 계층에 산다 — 사진과 같다.
 *
 * v1.14에서는 ②가 없었다(로컬+백업 두 계층). 사용자가 그 판단을 뒤집었다(2026-07-27):
 * *"핵심은 모든 기기에서 모든 정보를 확인해야 합니다. 따라서 서버에 올라가는 순간 클라우드가
 * 정본이 되야 합니다."* 그 말이 옳고, **로컬에만 있는 자료는 기능이 아니라 결함**이었다.
 * 마이그레이션 0019(`journey.audio`)와 `domain/audio/rowmap.ts`가 그 빚의 상환이다.
 */
export interface LocalAudio extends SyncMeta {
  momentId: string;
  tripId: string;
  /** 녹음 바이트(원본 그대로 — 재인코딩하지 않는다). 사진과 달리 **이게 유일본**이라 그대로 올린다. */
  blob: Blob;
  /** 실제 저장된 형식(`audio/webm;codecs=opus` 등). 재생 `type` 힌트에 쓴다. */
  mime: string;
  /** 길이(초). 화면 칩 `🔊 0:14`가 읽는다. */
  durationSec: number;
  /** 녹음한 시각(ISO). `occurredAt`이 아니라 **만든 시각**이다. */
  recordedAt: string;
  /**
   * **서버에 실제로 올라간 객체 키.** `LocalMedia.storagePath`와 **같은 이유·같은 규율**이다 —
   * 키가 여행 제목의 함수라서, 다시 계산하면 제목을 바꾼 뒤의 재전송이 다른 키로 올라가
   * 옛 파일이 고아로 남는다. 바이트가 착지한 키가 곧 진실이므로 파생이 아니라 데이터로 둔다.
   *
   * 인덱스가 아니므로 Dexie 스키마 버전을 올리지 않는다(평범한 속성). 옛 행에는 없다 —
   * 없으면 그때 계산해 채운다(`pushPendingAudio`).
   */
  storagePath?: string;
  /**
   * **서버에 바이트가 없음을 확인했다** — `LocalMedia.bytesMissing`과 **같은 규율**이다(§7).
   *
   * 소리는 키 형식이 하나뿐이라 「경로 기억 없음 = 올라간 적 없음」이 성립하고, 그 조건은
   * `mustUploadBytes(…, true)`가 이미 처리한다. 그래도 이 표시를 **똑같이 갖는다**: 복구
   * 경로(`requeueMissingBytes`)는 두 형제를 같은 코드로 다루고, 형제 하나만 표시를 못 받으면
   * 그 순간부터 둘의 동작이 갈라진다 — M-0059가 정확히 그 형태였다.
   */
  bytesMissing?: true;
}

/**
 * 장소 라이브러리 항목(마이그레이션 0022).
 *
 * 🔴 **여행의 자식이 아니다.** 형제(media·expenses·audio)는 전부 `momentId`/`tripId`를 갖고
 * 부모가 지워지면 함께 지워진다. 장소는 **사용자 소유**다 — 한 장소는 여러 여행에 걸치고,
 * 작년 여행을 지웠다고 그 카페를 잊어야 할 이유가 없다. 이 비대칭은 설계 단계에서 심사한
 * 것이며 이유를 여기 적어 둔다(§7 — 안 적으면 다음 사람이 "형제들처럼" 고친다).
 */
export interface LocalPlace extends SyncMeta {
  /** 사용자가 부르는 이름. 자유 입력 — 지오코더에 없는 곳도 담아야 한다(map-place-dev §1 3항). */
  name: string;
  formattedAddress: string | null;
  /** 어느 지오코더가 준 답인가. 지도에서 직접 찍었으면 null(그것도 사실이다). */
  provider: string | null;
  providerPlaceId: string | null;
  /**
   * `provider/providerPlaceId` 합성 인덱스 키 — Dexie는 복합 유니크를 못 걸어서
   * **한 칸으로 합쳐** 인덱스한다. 둘 중 하나라도 없으면 `undefined`(인덱스에서 빠진다 —
   * 지도로 찍은 장소끼리는 중복 판정을 하지 않는다. 같은 이름이어도 다른 지점일 수 있다).
   */
  providerKey?: string;
  countryCode: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  district: string | null;
  postcode: string | null;
  category: string | null;
  memo: string | null;
  /** 좌표의 진실원. 서버의 `location`(생성 컬럼)은 이 둘에서 유도된다 — 앱은 쓰지 않는다. */
  longitude: number;
  latitude: number;
  /** 이 좌표가 무엇을 가리키는가. `domain/place/precision.ts`의 등급과 같은 어휘. */
  precision: string | null;
  spanMeters: number | null;
  /** 사용자가 지도에서 직접 찍어 확정했는가 — 검색 좌표보다 강한 진실이다. */
  mapPicked: boolean;
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

/** 큐 항목 상태 — 셋뿐(SyncQueueItem.state 주석 참조). 성공은 행 삭제로 표현한다. */
export type SyncQueueState = 'local_only' | 'retryable_failed' | 'permanent_failed';

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
  /**
   * 큐 항목의 처리 상태. **문자열이 아니라 닫힌 유니온이다** — 오타나 없는 상태가 컴파일에서
   * 걸리게(전수 감사 정리). 값은 셋뿐이다:
   *  · `local_only`       — 아직 서버에 못 보냄(기본·재시도 대기). 성공하면 큐에서 **삭제**된다.
   *  · `retryable_failed` — 일시 실패(백오프 후 재시도). `nextRetryAt`이 다음 시각을 정한다.
   *  · `permanent_failed` — 영구 실패(사람이 봐야 함). 자동 재시도하지 않는다.
   * 성공은 별도 상태가 아니라 **행 삭제**로 표현한다(남아 있는 것이 곧 미완이다).
   */
  state: SyncQueueState;
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
  /**
   * **영구삭제 op 전용** — 지울 원격 바이트의 경로. 없으면 서버에 물어본다.
   *
   * 🔴 왜 필요한가(2026-08-05 · M-0107): `pushPurges`는 "지우기 전에 서버에 경로를 묻는다".
   * 그런데 **부모 cascade가 이미 데려간 자식**은 서버 행이 없어 물어볼 곳이 없고, 로컬 행도
   * 영구삭제가 지운다 — 그러면 R2 바이트가 영원히 고아로 남는다(사용자 실기기: 「설명할 수
   * 없는 사진 파일 13개」). 행이 사라지는 그 순간에 적어 두는 것이 유일한 방법이다.
   *
   * 서버 경로와 **더해서** 쓴다(대체가 아니다). 옛 키·새 키가 다를 수 있고, 지우는 대상은
   * 어차피 이 id의 바이트뿐이라 더해서 손해 볼 것이 없다.
   */
  bytePath?: string;
  /**
   * **영구삭제 op 전용** — 이 대상은 같은 묶음의 **뿌리 op이 가족까지 쓸어 간다**는 표시.
   *
   * 왜 필요한가: 부모(여행·순간)의 영구삭제는 `hardDeleteFamily`로 자손을 한 번에 지운다.
   * 그런데 자식들도 각자 op을 갖고, 그중 순간은 자신도 부모다 — 표시가 없으면 순간 20개짜리
   * 여행 하나가 **가족 쓸기를 21번** 한다(요청 수백 건). 표시는 **op을 만드는 곳**이 붙인다:
   * 서버 응답(`familyIds`)으로 추론하면 그 목록이 잘리거나 비었을 때 조용히 어긋난다.
   */
  purgeUnderRoot?: true;
  /**
   * **마지막 실패의 HTTP 상태**(있을 때). `classifyError`가 이 값으로 영구/일시를 갈랐다.
   *
   * 🔴 왜 남기나(2026-08-05 · M-0107): 사용자 기기에 `permanent_failed` 13건이 박혀 있었는데
   * 앱은 **왜인지 말할 수 없었다** — 큐가 사유를 안 갖고 있었다. 원인을 알아내는 데 실서버를
   * 직접 조회해야 했다(§12 — 앱이 아는 것을 사람에게 대신 시킨 자리). 상태 코드 하나로도
   * 갈래가 갈린다: 401/403은 권한, 409는 관계 충돌, 400은 스키마.
   */
  lastStatus?: number;
  /** 마지막 실패 사유(사람이 읽는 한 줄). 없으면 `''` — **옛 사유를 남겨 두지 않는다.** */
  lastError?: string;
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
  /** 영구삭제된 엔티티 id(여행·순간·사진·비용·소리 모두 같은 목록에 담는다). */
  id: string;
  /**
   * 어느 도메인이었는가. **`'unknown'`은 거짓이 아니라 사실이다** — 서버 원장(ADR-0030)은
   * id만 담으므로(자료를 남기지 않는 것이 목적) 다른 기기가 알려준 영구삭제는 종류를 모른다.
   * 모르는 것을 아는 척 적지 않는다(비타협 원칙 #4).
   */
  entityType: 'trip' | 'moment' | 'media' | 'expense' | 'audio' | 'place' | 'unknown';
  purgedAt: string;
}

export class JourneyDB extends Dexie {
  localTrips!: Table<LocalTrip, string>;
  localMoments!: Table<LocalMoment, string>;
  localMedia!: Table<LocalMedia, string>;
  localExpenses!: Table<LocalExpense, string>;
  localAudio!: Table<LocalAudio, string>;
  localPlaces!: Table<LocalPlace, string>;
  localFxRates!: Table<LocalFxRate, string>;
  purgedIds!: Table<PurgedId, string>;
  syncQueue!: Table<SyncQueueItem, string>;
  syncState!: Table<LocalSyncState, string>;

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
    // v7: 오디오 노트(≤60초). 순간·여행 관계키로 조회. Blob 저장이라 인덱스는 관계키만.
    // **기존 버전을 고치지 않고 새 version을 추가한다**(버전 체인 규율 — sync-offline SKILL §0).
    this.version(7).stores({
      localAudio: 'id, momentId, tripId, updatedAt',
    });
    // v8: 장소 라이브러리(마이그레이션 0022). **여행의 자식이 아니라 사용자 소유**라
    // tripId/momentId 인덱스가 없다 — 한 장소는 여러 여행에 걸친다(0022 주석 참조).
    // 근처 검색은 서버(PostGIS)와 로컬(전수 스캔) 둘 다 가능하다: 개인 앱 규모(수백 건)에서
    // 전수 스캔은 밀리초라, 로컬에 공간 인덱스를 흉내 내는 복잡도를 들일 이유가 없다.
    this.version(8).stores({
      localPlaces: 'id, updatedAt, providerKey',
    });
    // v9: canonical 세대·재시작 상태. 기억 데이터가 아니라 동기화 fence라 별도 store로 둔다.
    this.version(9).stores({
      syncState: 'id, userId, updatedAt',
    });
  }
}

let _db: JourneyDB | null = null;
export function db(): JourneyDB {
  if (!_db) _db = new JourneyDB();
  return _db;
}
