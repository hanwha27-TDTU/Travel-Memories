// services/mediaMigrate.ts — 사진 바이트를 **옛 저장소에서 새 저장소로 옮긴다**.
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 생겼나 (사용자 제안 2026-07-26)
// ─────────────────────────────────────────────────────────────────────────────
// "어차피 앞으로는 supabase에 사진을 저장하지 않을 거니까, 일단 내가 직접 다 삭제하고
//  supabase 이미지 저장 경로를 아예 제거해버리면 어떨까?"
//
// 방향은 옳다. 그런데 확인해 보니 **살아 있는 사진 10장 중 8장의 서버 사본이 옛 저장소에만**
// 있었다(R2엔 2장뿐). 먼저 지웠다면 그 8장은 서버 백업이 사라진다 — 기기에서 지우거나 브라우저
// 데이터가 날아가면 영영 못 찾는다. 비타협 원칙 #1과 정면으로 부딪힌다.
//
// 그래서 순서를 뒤집는다: **복사 → 되읽어 확인 → 확인된 것만 삭제.**
//
// ─────────────────────────────────────────────────────────────────────────────
// "옮긴다"는 연산은 없다 (sync-offline-dev §2-B)
// ─────────────────────────────────────────────────────────────────────────────
// 옮기기는 **복사와 삭제 두 개**이고, 그 사이에 되읽기가 반드시 들어간다.
//
//  · 업로드 200으로 원본을 지우지 않는다. 200은 "받았다"이지 "있다"가 아니다(불변식 #5).
//  · 한 장씩 `복사→삭제`로 돌지 않는다 — 중간에 끊기면 **양쪽 어디에도 없는 사진**이 생긴다.
//    전부 복사한 뒤 새 저장소를 **다시 훑어**, 실제로 있는 것만 삭제 대상으로 삼는다.
//  · 한 장이 실패해도 멈추지 않는다. 멈추면 나머지가 영영 안 옮겨진다. 대신 조용히 넘기지
//    않고 개수와 사유를 남긴다(원칙 #4).
//  · 멱등이다. 사용자는 실패하면 다시 누른다 — 이미 옮긴 것은 건너뛴다.

/** 이관 포트 — 저장소 두 곳을 **모양으로만** 받는다(어느 백엔드인지 여기서 몰라도 된다). */
export interface MigratePorts {
  /** 옛 저장소에 있는 사진 id들. */
  oldIds(): Promise<{ ids: string[]; error?: string | undefined }>;
  /** 새 저장소에 있는 사진 id들. **되읽기에도 같은 함수를 쓴다** — 확인 경로가 하나여야 한다. */
  newIds(): Promise<{ ids: string[]; error?: string | undefined }>;
  /** 옛 저장소에서 받는다. */
  download(id: string): Promise<{ blob: Blob | null; error?: string | undefined }>;
  /** 새 저장소로 올린다. */
  upload(id: string, blob: Blob): Promise<{ error?: string | undefined }>;
  /** 옛 저장소에서 지운다 — **되읽기로 확인된 id에만** 호출된다. */
  removeOld(id: string): Promise<{ error?: string | undefined }>;
}

export interface MigrateReport {
  /** 옛 저장소에 있던 사진 수. */
  total: number;
  /** 이번에 실제로 복사한 수. */
  copied: number;
  /** 이미 새 저장소에 있어 건너뛴 수(멱등). */
  already: number;
  /** 복사하지 못한 수. */
  failed: number;
  /** 되읽기로 확인된 뒤 옛 저장소에서 지운 수. */
  removed: number;
  /** 새 저장소에 있는 것이 확인돼 **지워도 되는데 아직 옛 저장소에 남은** 수. */
  safeToRemove: number;
  /** 사람이 읽는 실패 사유(중복 제거·상한). 조용히 삼키지 않는다. */
  errors: string[];
}

/** 화면에 늘어놓을 오류 줄 상한 — 넘으면 개수로 접는다(진단 §5.2·5.3). */
export const ERROR_CAP = 5;

function pushErr(errors: string[], msg: string): void {
  if (errors.length < ERROR_CAP && !errors.includes(msg)) errors.push(msg);
}

/**
 * 옛 저장소 → 새 저장소 이관.
 *
 * @param removeAfter 되읽기로 확인된 것을 옛 저장소에서 지울지. **기본값 false** —
 *   지우는 것은 별도의 명시적 행동이어야 한다(영구삭제와 같은 규율).
 */
export async function migrateMediaBytes(
  ports: MigratePorts,
  removeAfter = false,
): Promise<MigrateReport> {
  const errors: string[] = [];
  const old = await ports.oldIds();
  if (old.error) return { total: 0, copied: 0, already: 0, failed: 0, removed: 0, safeToRemove: 0, errors: [old.error] };

  const before = await ports.newIds();
  if (before.error) {
    // 새 저장소를 못 읽으면 **아무것도 하지 않는다.** 이미 있는지 모르는 채 올리면 멱등이 깨지고,
    // 더 나쁘게는 "확인했다"고 착각한 채 옛 것을 지우게 된다.
    return { total: old.ids.length, copied: 0, already: 0, failed: 0, removed: 0, safeToRemove: 0, errors: [before.error] };
  }

  const have = new Set(before.ids);
  const todo = old.ids.filter((id) => !have.has(id));
  const already = old.ids.length - todo.length;

  // ── ① 전부 복사한다. 실패해도 멈추지 않는다 ──────────────────────────────
  let copied = 0;
  let failed = 0;
  for (const id of todo) {
    const got = await ports.download(id);
    if (got.error || !got.blob) {
      failed++;
      pushErr(errors, `받기 실패: ${got.error ?? '내용이 비어 있음'}`);
      continue;
    }
    const put = await ports.upload(id, got.blob);
    if (put.error) {
      failed++;
      pushErr(errors, `올리기 실패: ${put.error}`);
      continue;
    }
    copied++;
  }

  // ── ② 되읽는다. 업로드 응답이 아니라 **목록을 다시 받아** 확인한다 ────────
  const after = await ports.newIds();
  if (after.error) {
    // 확인을 못 했으면 **지우지 않는다.** 여기서 지우면 200만 믿고 지우는 것과 같다.
    pushErr(errors, `확인 실패(옛 파일은 그대로 둡니다): ${after.error}`);
    return { total: old.ids.length, copied, already, failed, removed: 0, safeToRemove: 0, errors };
  }
  const confirmed = new Set(after.ids);
  const removable = old.ids.filter((id) => confirmed.has(id));

  // ── ③ 확인된 것만 지운다(선택) ───────────────────────────────────────────
  let removed = 0;
  if (removeAfter) {
    for (const id of removable) {
      const rm = await ports.removeOld(id);
      if (rm.error) pushErr(errors, `옛 파일 지우기 실패: ${rm.error}`);
      else removed++;
    }
  }

  return {
    total: old.ids.length,
    copied,
    already,
    failed,
    removed,
    safeToRemove: removable.length - removed,
    errors,
  };
}

/** 결과를 사람이 읽는 한 문장으로. 화면 세 곳이 각자 문장을 짓지 않게 여기 한 곳(§7). */
export function describeMigration(r: MigrateReport): string {
  if (r.errors.length && !r.total) return `옮기지 못했어요 — ${r.errors[0]}`;
  if (!r.total) return '옛 저장소에 남은 사진이 없어요.';
  const parts: string[] = [];
  if (r.copied) parts.push(`${r.copied}장 옮김`);
  if (r.already) parts.push(`${r.already}장은 이미 옮겨져 있었어요`);
  if (r.removed) parts.push(`옛 파일 ${r.removed}개 정리`);
  if (r.failed) parts.push(`${r.failed}장 실패`);
  // 실패가 있으면 **다시 눌러도 된다**고 말해준다 — 멱등이라는 사실을 사용자가 알아야 재시도한다.
  const tail = r.failed ? ' 다시 눌러도 안전해요(이미 옮긴 것은 건너뜁니다).' : '';
  const why = r.errors.length ? ` 사유: ${r.errors.join(' / ')}` : '';
  return `${parts.join(' · ') || '옮길 것이 없었어요'}.${tail}${why}`;
}
