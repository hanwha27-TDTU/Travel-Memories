// services/audio.ts — **오디오 노트의 저장·삭제·복원.** 로컬 우선·내구성 커밋·read-back.
//
// ── 형제의 규율을 물려받는다 (§7 · M-0033) ────────────────────────────
// 새 미디어 종류는 **기존 형제가 지키는 계약을 자동으로 물려받지 않는다.** M-0033이 정확히
// 그 사고였다 — 새 op 하나만 규율 바깥에서 태어났다. 그래서 형제 목록을 훑고 한 줄씩 맞췄다:
//
//  · 내구성 커밋 + read-back      → `media.ts`와 같은 형태(add 후 되읽어 확인)
//  · tombstone 전용 삭제 + 복원   → `softDeleteAudio`/`restoreAudio` **쌍**으로
//  · 저장 공간 사전점검           → `quotaVerdict`(2026-07-27 신설)를 **같이** 지난다
//  · 시각 표기                    → 로컬 생성이라 `toISOString()`이 곧 정규형(M-0034)
//  · 백업 export/import          → 별도 테이블이라 `check-backup-coverage`가 강제한다
//  · 저장 용량 집계               → `storage.ts`에 「소리」 항목으로 **따로** 센다
//  · **변경마다 큐 op**           → 아래 `audioOp` — 형제 넷과 **같은 형태·같은 트랜잭션**
//
// ── 예전에 여기 적혀 있던 예외를 지웠다 (2026-07-27 사용자 결정) ──────
// v1.14의 이 주석은 *"서버 동기화 op를 만들지 않는다 — 서버에 오디오 테이블이 없다"*였고,
// 그건 `check-domain-symmetry`의 `NO_OP_REQUIRED`에 이유와 함께 등록돼 있었다. 사용자가
// 그 판단을 뒤집었다:
//
//   *"당연히 서버동기화를 진행해야죠. 사진과 동일하게... 핵심은 모든 기기에서 모든 정보를
//     확인해야 합니다. 따라서 서버에 올라가는 순간 클라우드가 정본이 되야 합니다."*
//
// **로컬에만 있는 자료는 기능이 아니라 결함**이다. 그 예외는 정당한 사정이 아니라 *갚아야 할
// 빚*이었고(§7 3항 — "아직 못 했다"는 사정이 될 수 있지만 영구 면허는 아니다), 마이그레이션
// 0019 + `domain/audio/rowmap.ts` + `sync.ts`의 push/pull이 그 상환이다.
//
// 🔴 **엔티티와 op은 한 트랜잭션이다**(비타협 원칙 #1의 atomic commit · M-0033). 나눠 쓰면
//    그 사이에 앱이 죽었을 때 "로컬엔 있는데 서버엔 영영 안 가는" 행이 생긴다 — 그리고 그건
//    조용하다. M-0033이 정확히 그 형태였고, **고친 그 커밋에서** 났다.

import { db, type LocalAudio, type SyncQueueItem } from '../offline/db';
import { quotaVerdict, estimateLocalBytes } from '../domain/media/quota';
import { acceptRecording, MAX_SECONDS } from '../domain/audio/note';

const uuid = (): string => crypto.randomUUID();

/**
 * 'audio' 동기화 op 하나 — `media.ts`의 `mediaOp`와 **같은 모양**이다.
 *
 * 여기서 만드는 `entityType`이 `sync.ts`의 `pushPendingAudio`가 고르는 값이고, 다른 도메인
 * push 루프(`if (op.entityType !== 'trip') continue`)가 자연히 건너뛰는 값이기도 하다.
 */
export function audioOp(
  operationId: string,
  entityId: string,
  operationType: SyncQueueItem['operationType'],
  createdAt: string,
): SyncQueueItem {
  return { operationId, entityType: 'audio', entityId, operationType, state: 'local_only', attempts: 0, createdAt };
}

/** 브라우저 저장 현황(미지원이면 null — 추측하지 않는다). `media.ts`와 같은 규율. */
async function readStorageEstimate(): Promise<{ usage: number | null; quota: number | null }> {
  try {
    if (!navigator.storage?.estimate) return { usage: null, quota: null };
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? null, quota: e.quota ?? null };
  } catch {
    return { usage: null, quota: null };
  }
}

/**
 * 녹음을 순간에 붙인다. **로컬 커밋 + read-back까지 마친 뒤에야 "저장됨"이다**(불변식 #1).
 *
 * 실패는 전부 **사람이 읽는 이유**로 던진다 — 조용히 버리면 사용자는 녹음이 사라진 줄 모른다.
 */
export async function addAudioToMoment(
  target: { momentId: string; tripId: string },
  blob: Blob,
  durationSec: number,
  mime: string,
): Promise<LocalAudio> {
  const verdict = acceptRecording(durationSec, blob.size);
  if (!verdict.ok) throw new Error(verdict.reason);

  // 저장 공간 사전점검 — 사진과 **같은 함수**를 지난다(§7: 규율은 한 곳에 구현한다).
  const q = quotaVerdict(estimateLocalBytes(blob.size), await readStorageEstimate());
  if (!q.allow) throw new Error(q.message);

  const now = new Date().toISOString(); // 로컬 생성 → 이미 정규 표기(M-0034)
  const opId = uuid();
  const row: LocalAudio = {
    id: uuid(),
    momentId: target.momentId,
    tripId: target.tripId,
    blob,
    mime,
    durationSec: Math.min(Math.round(durationSec), MAX_SECONDS),
    recordedAt: now,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    clientOperationId: opId,
  };

  const d = db();
  // 행과 op은 **한 트랜잭션**이다 — 둘 중 하나만 남는 창을 만들지 않는다(M-0033).
  await d.transaction('rw', d.localAudio, d.syncQueue, async () => {
    await d.localAudio.add(row);
    await d.syncQueue.add(audioOp(opId, row.id, 'insert', now));
  });

  // **read-back으로 확인한 뒤에야 성공이다.** 성공 응답·예외 없음은 저장의 증거가 아니다.
  const back = await d.localAudio.get(row.id);
  if (!back || back.blob.size === 0) throw new Error('내구성 커밋 확인 실패: 녹음 read-back 불일치');
  return back;
}

/** 이 순간의 오디오 노트(활성만, 녹음 순서대로). */
export async function listAudioByMoment(momentId: string): Promise<LocalAudio[]> {
  const rows = await db().localAudio.where('momentId').equals(momentId).toArray();
  return rows.filter((a) => a.deletedAt === null).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

/** 이 여행의 오디오 노트(활성만) — 타임라인·저장 용량이 읽는다. */
export async function listAudioByTrip(tripId: string): Promise<LocalAudio[]> {
  const rows = await db().localAudio.where('tripId').equals(tripId).toArray();
  return rows.filter((a) => a.deletedAt === null);
}

/**
 * 삭제 — **하드 삭제 없음**(§0). `deletedAt` tombstone만 세우고 blob은 그대로 둔다.
 * 그래야 `restoreAudio`가 완전 복원한다(실행취소가 진짜 되돌리기가 된다).
 */
export async function softDeleteAudio(id: string): Promise<void> {
  const d = db();
  const cur = await d.localAudio.get(id);
  if (!cur || cur.deletedAt !== null) return; // 멱등 — 두 번 눌러도 같다
  const now = new Date().toISOString();
  const opId = uuid();
  await d.transaction('rw', d.localAudio, d.syncQueue, async () => {
    await d.localAudio.put({
      ...cur,
      deletedAt: now,
      updatedAt: now,
      version: cur.version + 1,
      baseVersion: cur.version,
      clientOperationId: opId,
    });
    await d.syncQueue.add(audioOp(opId, id, 'delete', now));
  });
  const back = await d.localAudio.get(id);
  if (!back || back.deletedAt === null) throw new Error('내구성 커밋 확인 실패: 녹음 삭제 read-back 불일치');
}

/** 되살리기 — 삭제와 **쌍**이다(`check-domain-symmetry`가 이 대칭을 강제한다). */
export async function restoreAudio(id: string): Promise<void> {
  const d = db();
  const cur = await d.localAudio.get(id);
  if (!cur || cur.deletedAt === null) return;
  const now = new Date().toISOString();
  const opId = uuid();
  await d.transaction('rw', d.localAudio, d.syncQueue, async () => {
    await d.localAudio.put({
      ...cur,
      deletedAt: null,
      updatedAt: now,
      version: cur.version + 1,
      baseVersion: cur.version,
      clientOperationId: opId,
    });
    await d.syncQueue.add(audioOp(opId, id, 'update', now));
  });
  const back = await d.localAudio.get(id);
  if (!back || back.deletedAt !== null) throw new Error('내구성 커밋 확인 실패: 녹음 되살리기 read-back 불일치');
}
