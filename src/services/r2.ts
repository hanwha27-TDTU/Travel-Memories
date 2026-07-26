// services/r2.ts — 사진 표시본 바이트의 R2 어댑터 (ADR-0024, docs/STORAGE_R2_PROPOSAL.md)
//
// 포트/어댑터: `MediaRemote`(sync.ts)의 **바이트 3종**(uploadDisplay/download/remove)만 갈아끼운다.
// 메타(journey.media 테이블)·RLS·좀비 트리거·동기화 병합 규율은 **바뀌지 않는다**.
//
// 읽기 정책 B(사용자 결정 2026-07-25): 버킷은 비공개, 읽기도 5분 서명 URL.
//   비용이 작은 이유: 이 앱은 화면에 **로컬 blob**을 그린다(tripDetail의 thumbBlob/displayBlob).
//   서명이 필요한 순간은 "새 기기가 그 사진을 처음 받아올 때" 사진당 1회뿐이다.
//
// 🔐 이 파일에는 R2 자격증명이 없다(있으면 안 된다). 브라우저가 받는 것은 5분짜리 URL뿐이며,
//    **객체 키는 서버가 검증된 JWT의 sub로 만든다** — 여기서 보내는 경로는 힌트가 아니라
//    mediaId 하나뿐이다. 남의 폴더를 가리킬 방법이 구조적으로 없다.
//
// 되돌리기: `VITE_MEDIA_STORE`를 지우면(기본값) 즉시 Supabase Storage 경로로 복귀한다.
//    옛 객체를 스윕하기 전까지 두 경로 모두 살아 있으므로 되돌리기가 무손실이다.

import type { JourneyClient } from './supabase/client';

const FN = 'media-sign';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 바이트 저장소 포트 — MediaRemote의 바이트 3종과 같은 모양. */
export interface BlobStore {
  uploadDisplay(path: string, blob: Blob): Promise<{ error?: string | undefined; status?: number | undefined }>;
  download(path: string): Promise<{ data: Blob | null; error?: string | undefined; status?: number | undefined }>;
  remove(path: string): Promise<{ error?: string | undefined }>;
}

/** 'r2' | 'supabase'. 설정이 없으면 supabase(현행 유지) — 새 경로는 명시적으로만 켜진다. */
export function mediaStoreKind(): 'r2' | 'supabase' {
  const v = (import.meta.env.VITE_MEDIA_STORE as string | undefined)?.trim().toLowerCase();
  return v === 'r2' ? 'r2' : 'supabase';
}

/**
 * 저장 경로 `{userId}/{mediaId}.webp`에서 mediaId만 뽑는다.
 * 서버가 폴더를 다시 만들기 때문에 userId 부분은 **의도적으로 버린다**(신뢰하지 않는다).
 */
export function mediaIdFromPath(path: string): string | null {
  const last = path.split('/').pop() ?? '';
  const id = last.replace(/\.webp$/i, '');
  return UUID_RE.test(id) ? id : null;
}

interface SignResult {
  url?: string;
  key?: string;
  error?: string;
}

async function callSign(
  client: JourneyClient,
  op: 'put' | 'get' | 'delete' | 'probe' | 'list',
  mediaId: string | null,
): Promise<{ data: SignResult | null; error?: string }> {
  try {
    const body: Record<string, unknown> = { op };
    if (mediaId) body['mediaId'] = mediaId;
    const r = await client.functions.invoke(FN, { body });
    if (r.error) return { data: null, error: r.error.message };
    const d = r.data as SignResult | null;
    if (d?.error) return { data: null, error: d.error };
    return { data: d };
  } catch (e) {
    return { data: null, error: (e as Error).message };
  }
}

/** 함수 응답의 원인 코드를 사람이 읽을 수 있게. 진단표(앱 내 가이드)와 같은 어휘를 쓴다. */
export function explainR2Error(code: string): string {
  switch (code) {
    case 'r2_env_missing':
      return '함수에 R2 시크릿이 없습니다 — Supabase › Edge Functions › Secrets 확인(7단계)';
    case 'unauthorized':
      return '로그인 정보가 함수에 닿지 않았습니다 — 다시 로그인해 주세요';
    case 'bad_media_id':
      return '사진 식별자 형식이 올바르지 않습니다(앱 결함일 수 있음)';
    case 'sign_failed':
      return '서명 생성 실패 — 시크릿 값에 공백이 섞였을 수 있습니다';
    case 'r2_delete_failed':
      return 'R2가 삭제를 거부했습니다 — 버킷 잠금 규칙이 켜졌는지 확인(5b단계)';
    case 'r2_list_failed':
      return 'R2가 목록 조회를 거부했습니다 — 토큰 권한에 읽기(Object Read)가 있는지 확인(6단계)';
    default:
      return code;
  }
}

/** 함수·시크릿까지 닿는지 확인(검증 사다리 2번). R2로의 실제 업로드는 증명하지 못한다. */
export async function r2Probe(client: JourneyClient): Promise<{ ok: boolean; detail: string }> {
  const r = await callSign(client, 'probe', null);
  if (r.error) return { ok: false, detail: explainR2Error(r.error) };
  const d = r.data as ({ ok?: boolean; missing?: string[] } & SignResult) | null;
  if (!d) return { ok: false, detail: '응답이 비었습니다' };
  if (d.ok) return { ok: true, detail: '함수와 시크릿 4개 확인됨 — 실제 업로드(CORS)는 사진 저장으로만 증명됩니다' };
  return { ok: false, detail: `빠진 시크릿: ${(d.missing ?? []).join(', ') || '알 수 없음'}` };
}

/**
 * 서버에 실제로 있는 사진 파일 목록(내 폴더만).
 *
 * 왜 필요한가(사용자 지적 2026-07-26): 지금까지 "R2에 고아 파일이 남았나"를 확인하는 유일한
 * 방법이 **사용자가 Cloudflare 콘솔을 열어 화면을 캡처해 주는 것**이었다. 그건 §8("진단 도구는
 * 관측이 아니라 판정을 한다")에 어긋난다 — 앱이 스스로 말할 수 있는 일을 사람이 대신했다.
 *
 * 응답에는 **mediaId만** 온다(폴더=uid는 함수가 떼고 준다). 목록 서명 URL은 브라우저에
 * 오지 않는다 — 함수가 호출하고 결과만 준다.
 */
export interface R2Listing {
  /** 서버에 파일이 있는 사진 id들. */
  ids: string[];
  /** 우리 형식(`{uuid}.webp`)이 아닌 키의 수. 조용히 버리지 않고 개수로 보고한다. */
  foreign: number;
  /** 페이지 상한에 걸려 **다 못 봤다**. true면 "고아 0건"이라 말하면 안 된다. */
  truncated: boolean;
  error?: string;
}

export async function r2ListObjects(client: JourneyClient): Promise<R2Listing> {
  const r = await callSign(client, 'list', null);
  if (r.error) return { ids: [], foreign: 0, truncated: false, error: explainR2Error(r.error) };
  const d = r.data as ({ ids?: unknown; foreign?: unknown; truncated?: unknown } & SignResult) | null;
  if (!d || !Array.isArray(d.ids)) return { ids: [], foreign: 0, truncated: false, error: '목록 응답이 비었습니다' };
  return {
    ids: (d.ids as unknown[]).filter((x): x is string => typeof x === 'string'),
    foreign: typeof d.foreign === 'number' ? d.foreign : 0,
    truncated: d.truncated === true,
  };
}

export function r2BlobStore(client: JourneyClient): BlobStore {
  async function signed(op: 'put' | 'get', path: string): Promise<{ url?: string; error?: string }> {
    const mediaId = mediaIdFromPath(path);
    if (!mediaId) return { error: 'bad_media_id' };
    const r = await callSign(client, op, mediaId);
    if (r.error) return { error: explainR2Error(r.error) };
    if (!r.data?.url) return { error: '서명 URL이 응답에 없습니다' };
    return { url: r.data.url };
  }

  return {
    async uploadDisplay(path, blob) {
      const s = await signed('put', path);
      if (s.error || !s.url) return { error: s.error ?? 'no_url' };
      try {
        const res = await fetch(s.url, { method: 'PUT', body: blob, headers: { 'Content-Type': 'image/webp' } });
        // 403은 서명 만료·시크릿 오입력, CORS 실패는 fetch가 예외로 던진다(진단표 참조).
        if (!res.ok) return { error: `R2 업로드 실패(${res.status})`, status: res.status };
        return {};
      } catch (e) {
        return { error: `R2 업로드 실패 — CORS 설정(5단계)일 가능성이 큽니다: ${(e as Error).message}` };
      }
    },

    async download(path) {
      const s = await signed('get', path);
      if (s.error || !s.url) return { data: null, error: s.error ?? 'no_url' };
      try {
        const res = await fetch(s.url);
        if (!res.ok) return { data: null, error: `R2 내려받기 실패(${res.status})`, status: res.status };
        return { data: await res.blob() };
      } catch (e) {
        return { data: null, error: `R2 내려받기 실패: ${(e as Error).message}` };
      }
    },

    async remove(path) {
      const mediaId = mediaIdFromPath(path);
      if (!mediaId) return { error: 'bad_media_id' };
      // 삭제는 브라우저가 하지 않는다 — 함수가 서명하고 함수가 실행한다.
      const r = await callSign(client, 'delete', mediaId);
      if (r.error) return { error: explainR2Error(r.error) };
      return {};
    },
  };
}
