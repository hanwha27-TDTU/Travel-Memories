// services/syncReleaseDiagnostics.ts — 운영 Edge 계약과 현재 동기화 진행을 읽기 전용으로 수집한다.

import { syncProgressLabel } from '../domain/syncProgress';
import { r2Capabilities } from './r2';
import { syncStatus } from './autoSync';
import type { JourneyClient } from './supabase/client';
import type { SyncReleaseObservation } from '../domain/syncReleaseVerdict';

export async function collectSyncReleaseObservation(client: JourneyClient): Promise<SyncReleaseObservation> {
  const edge = await r2Capabilities(client);
  const runtime = syncStatus();
  return {
    edge,
    runtime: {
      phase: runtime.phase,
      progressLabel: runtime.progress ? syncProgressLabel(runtime.progress) : null,
      startedAt: runtime.startedAt,
      progressAt: runtime.progressAt,
    },
    nowIso: new Date().toISOString(),
  };
}
