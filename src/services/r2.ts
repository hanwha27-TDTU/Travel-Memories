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
// 2026-07-26: **R2가 유일한 바이트 저장소가 됐다.** 옛 Supabase Storage 경로는 이관을 마치고
//    제거했다(v0.86) — 바이트가 R2에만 남는 순간 `VITE_MEDIA_STORE` 되돌리기는 **이미 죽은**
//    탈출구였고, 살아 있지도 않은 탈출구를 코드에 남겨두면 다음 사람을 속인다.

import type { JourneyClient } from './supabase/client';

const FN = 'media-sign';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSIENT_ATTEMPTS = 3;
const SIGN_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 모바일 브라우저의 순간 전송 단절만 짧게 재시도한다. 인증·입력 오류는 그대로 돌려준다. */
export function isTransientFunctionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: unknown; message?: unknown; context?: unknown };
  if (e.name === 'FunctionsFetchError' || e.name === 'FunctionsRelayError') return true;
  // functions-js 옛 판이나 테스트 대역이 name을 보존하지 않아도 표준 전송 오류 문구는 식별한다.
  if (e.message === 'Failed to send a request to the Edge Function') return true;
  const context = e.context as { status?: unknown } | undefined;
  const status = typeof context?.status === 'number' ? context.status : undefined;
  return status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500);
}

function functionErrorDetail(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const e = error as { name?: unknown; message?: unknown };
  const message = typeof e.message === 'string' ? e.message : String(error);
  return typeof e.name === 'string' && e.name !== 'Error' ? `${e.name}: ${message}` : message;
}

function retryDelayMs(failedAttempt: number): number {
  return 300 * (2 ** Math.max(0, failedAttempt - 1));
}

/** 바이트 저장소 포트 — MediaRemote의 바이트 3종과 같은 모양. */
export interface BlobStore {
  /**
   * 바이트를 올린다. `contentType`을 **인자로 받는 이유**: 사진(`image/webp`)과 소리
   * (`audio/webm`…)가 같은 경로를 지난다. 하드코딩하면 소리가 사진 타입으로 올라가고,
   * 나중에 그 URL을 그대로 재생하려는 곳에서 디코더가 엉뚱한 선택을 한다.
   *
   * 서명은 host만 덮으므로 Content-Type을 바꿔도 서명이 깨지지 않는다(presign 머리주석).
   */
  upload(path: string, blob: Blob, contentType: string): Promise<{ error?: string | undefined; status?: number | undefined }>;
  /** 사진 표시본 전용 별칭 — 기존 호출부(MediaRemote)의 어휘를 지킨다. */
  uploadDisplay(path: string, blob: Blob): Promise<{ error?: string | undefined; status?: number | undefined }>;
  download(path: string): Promise<{ data: Blob | null; error?: string | undefined; status?: number | undefined }>;
  remove(path: string): Promise<{ error?: string | undefined }>;
}

/**
 * 저장 경로에서 mediaId를 뽑는다. 두 형식을 다 읽는다:
 *  · 새 형식 `…/제주여행__c9ff5188/20260716_1432_제주여행__<32자>.webp` (2026-07-27~)
 *  · 옛 형식 `…/<uuid>.webp`
 *
 * ⚠️ **Edge Function의 `mediaIdOfKey`와 같은 규칙이어야 한다.** 둘은 다른 배포 단위(브라우저/Deno)에
 * 살아서 손으로는 맞출 수 없다 — `tests/unit/mediaNaming.test.ts`가 왕복으로 잠근다.
 */
export function mediaIdFromPath(path: string): string | null {
  // 확장자는 사진(.webp)만이 아니다 — 소리(.webm·.m4a·…)도 같은 폴더에 산다(2026-07-27~).
  const base = (path.split('/').pop() ?? '').replace(/\.(?:webp|webm|m4a|ogg|mp3|wav)$/i, '');
  const tail = base.split('__').pop() ?? ''; // 제목에 밑줄이 있어도 **맨 뒤**만 본다
  if (/^[0-9a-f]{32}$/i.test(tail)) {
    const h = tail.toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return UUID_RE.test(base) ? base : null;
}

/**
 * 전체 경로에서 **사용자 폴더를 뗀 접미**를 돌려준다 — 함수에 보낼 값이다.
 *
 * 왜 떼나: 첫 칸은 함수가 **검증된 sub로 직접** 붙인다. 클라이언트가 보낸 값을 쓰지 않으므로
 * 남의 폴더를 가리키는 것이 원리적으로 불가능하다. 그 경계를 지키려면 여기서 떼어 보내야 한다.
 */
export function restOfPath(path: string): string | null {
  const parts = path.split('/').filter((p) => p !== '');
  if (parts.length < 2) return null; // 최소 `{uid}/{파일}`
  return parts.slice(1).join('/');
}

interface SignResult {
  url?: string;
  key?: string;
  error?: string;
}

async function callSign(
  client: JourneyClient,
  op: 'put' | 'get' | 'delete' | 'probe' | 'list' | 'deleteMany' | 'abortMultipart' | 'capabilities',
  mediaId: string | null,
  extra?: Record<string, unknown>,
): Promise<{ data: SignResult | null; error?: string }> {
  const body: Record<string, unknown> = { op, ...extra };
  if (mediaId) body['mediaId'] = mediaId;
  const attempts = op === 'get' ? TRANSIENT_ATTEMPTS : 1;
  let lastError = '함수 요청 실패';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const r = await client.functions.invoke(FN, { body, timeout: SIGN_TIMEOUT_MS });
      if (r.error) {
        lastError = functionErrorDetail(r.error);
        if (!isTransientFunctionError(r.error)) return { data: null, error: lastError };
      } else {
        const d = r.data as SignResult | null;
        if (d?.error) return { data: null, error: d.error };
        return { data: d };
      }
    } catch (e) {
      lastError = functionErrorDetail(e);
      // invoke 바깥으로 나온 TypeError는 fetch 계층 단절이다. 그 밖의 프로그래밍 오류는 숨기지 않는다.
      if (!(e instanceof TypeError) && !isTransientFunctionError(e)) return { data: null, error: lastError };
    }
    if (attempt < attempts) await wait(retryDelayMs(attempt));
  }
  return { data: null, error: `함수 요청 ${attempts}회 실패: ${lastError}` };
}

function isRetryableDownloadStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function downloadSignedUrl(url: string): Promise<{ data: Blob | null; error?: string; status?: number }> {
  let lastError = '네트워크 오류';
  for (let attempt = 1; attempt <= TRANSIENT_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        lastError = `R2 내려받기 실패(${res.status})`;
        if (!isRetryableDownloadStatus(res.status) || attempt === TRANSIENT_ATTEMPTS) {
          return { data: null, error: lastError, status: res.status };
        }
        await res.body?.cancel();
      } else {
        // 타이머는 body까지 다 읽은 뒤 해제한다. 응답 헤더만 받고 바이트가 멎는 경우도 유한해야 한다.
        return { data: await res.blob() };
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt === TRANSIENT_ATTEMPTS) return { data: null, error: `R2 내려받기 실패: ${lastError}` };
    } finally {
      clearTimeout(timer);
    }
    await wait(retryDelayMs(attempt));
  }
  return { data: null, error: `R2 내려받기 실패: ${lastError}` };
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
  /** 서버에 파일이 있는 사진 id들(`.webp`). */
  ids: string[];
  /**
   * 서버에 파일이 있는 **소리** id들. 사진과 같은 폴더에 살지만 대조 상대가 다르므로 나눠 받는다.
   * 옛 함수(v5 이하)는 이 필드를 주지 않는다 → `undefined`("소리 파일 0개"가 아니라 **모른다**).
   */
  audioIds?: string[] | undefined;
  /** 우리 형식(`{uuid}.webp`)이 아닌 키의 수. 조용히 버리지 않고 개수로 보고한다. */
  foreign: number;
  /** 페이지 상한에 걸려 **다 못 봤다**. true면 "고아 0건"이라 말하면 안 된다. */
  truncated: boolean;
  /**
   * **내 폴더 밖**에 있는 최상위 항목 수(다른 폴더 + 폴더에 안 든 파일). 개수만 온다 — 키는
   * 서버가 응답에 담지 않는다. `outsideKnown`이 false면 이 값은 의미가 없다('확인 불가').
   */
  outside: number;
  outsideKnown: boolean;
  /** 내 폴더 총 바이트 — 앱이 "N개 · X MB"를 스스로 말할 수 있게(대시보드와 대조 가능). */
  bytes: number;
  /**
   * **미완료 멀티파트 업로드** — 객체 목록에도 대시보드에도 **안 보이는데 용량을 먹는** 조각.
   * 2026-07-26에 "버킷이 비었는데 왜 2.87MB?"의 유력 후보였다. 보이게 만든다.
   */
  multipart: { mine: number; outside: number; known: boolean };
  /** 서버에 배포된 함수 판. 클라이언트가 기대하는 판보다 낮으면 화면이 그렇게 말한다. */
  version: number;
  error?: string;
}

export async function r2ListObjects(client: JourneyClient): Promise<R2Listing> {
  const r = await callSign(client, 'list', null);
  const empty = {
    ids: [],
    audioIds: undefined,
    foreign: 0,
    truncated: false,
    outside: 0,
    outsideKnown: false,
    bytes: 0,
    multipart: { mine: 0, outside: 0, known: false },
    version: 0,
  };
  if (r.error) return { ...empty, error: explainR2Error(r.error) };
  const d = r.data as
    | ({
        ids?: unknown;
        audioIds?: unknown;
        foreign?: unknown;
        truncated?: unknown;
        outside?: unknown;
        outsideKnown?: unknown;
        bytes?: unknown;
        multipart?: unknown;
        version?: unknown;
      } & SignResult)
    | null;
  if (!d || !Array.isArray(d.ids)) return { ...empty, error: '목록 응답이 비었습니다' };
  const mp = d.multipart as { mine?: unknown; outside?: unknown; known?: unknown } | undefined;
  return {
    ids: (d.ids as unknown[]).filter((x): x is string => typeof x === 'string'),
    // 배열이 아니면 **없는 것이 아니라 모르는 것**이다(옛 함수) — undefined로 남긴다.
    audioIds: Array.isArray(d.audioIds)
      ? (d.audioIds as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined,
    foreign: typeof d.foreign === 'number' ? d.foreign : 0,
    truncated: d.truncated === true,
    // 옛 버전 함수가 배포돼 있으면 이 필드가 없다 → **0이 아니라 '모른다'**로 둔다.
    outside: typeof d.outside === 'number' ? d.outside : 0,
    outsideKnown: d.outsideKnown === true,
    bytes: typeof d.bytes === 'number' ? d.bytes : 0,
    multipart: {
      mine: typeof mp?.mine === 'number' ? mp.mine : 0,
      outside: typeof mp?.outside === 'number' ? mp.outside : 0,
      known: mp?.known === true,
    },
    // 판을 안 밝히는 함수 = v3 이하. 0으로 두면 화면이 "낡았다"고 말할 수 있다.
    version: typeof d.version === 'number' ? d.version : 0,
  };
}

/**
 * 여러 장을 **한 번에** 지우고, 함수가 **되읽어 확인한** 결과를 받는다.
 *
 * 왜(M-0029): 건당 왕복이면 100장에 100번이고 매번 JWT를 다시 검증한다. 더 중요한 건
 * "성공 응답"을 완료로 치지 않는 것이다 — 함수가 지운 뒤 목록을 다시 읽어 `stillThere`를 준다.
 */
export async function r2DeleteMany(
  client: JourneyClient,
  mediaIds: string[],
): Promise<{ requested: number; sent: number; stillThere: string[]; verified: boolean; error?: string }> {
  if (!mediaIds.length) return { requested: 0, sent: 0, stillThere: [], verified: true };
  const r = await callSign(client, 'deleteMany', null, { mediaIds });
  if (r.error) return { requested: mediaIds.length, sent: 0, stillThere: mediaIds, verified: false, error: explainR2Error(r.error) };
  const d = r.data as { requested?: unknown; sent?: unknown; stillThere?: unknown; verified?: unknown } | null;
  return {
    requested: typeof d?.requested === 'number' ? d.requested : mediaIds.length,
    sent: typeof d?.sent === 'number' ? d.sent : 0,
    stillThere: Array.isArray(d?.stillThere) ? (d.stillThere as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    // 확인하지 못한 것을 성공으로 적지 않는다.
    verified: d?.verified === true,
  };
}

/** 내 폴더 아래 **미완료 멀티파트 조각**을 중단한다(보이지 않으면서 용량을 먹던 것). */
export async function r2AbortMultipart(client: JourneyClient): Promise<{ aborted: number; error?: string }> {
  const r = await callSign(client, 'abortMultipart', null);
  if (r.error) return { aborted: 0, error: explainR2Error(r.error) };
  const d = r.data as { aborted?: unknown } | null;
  return { aborted: typeof d?.aborted === 'number' ? d.aborted : 0 };
}

export function r2BlobStore(client: JourneyClient): BlobStore {
  async function signed(op: 'put' | 'get', path: string): Promise<{ url?: string; error?: string }> {
    // 이름은 앱이 정하고 **폴더는 함수가 붙인다** — 그래서 접미만 보낸다.
    const rest = restOfPath(path);
    if (!rest) return { error: 'bad_media_path' };
    const r = await callSign(client, op, null, { path: rest });
    if (r.error) return { error: explainR2Error(r.error) };
    if (!r.data?.url) return { error: '서명 URL이 응답에 없습니다' };
    return { url: r.data.url };
  }

  async function upload(
    path: string,
    blob: Blob,
    contentType: string,
  ): Promise<{ error?: string | undefined; status?: number | undefined }> {
    const s = await signed('put', path);
    if (s.error || !s.url) return { error: s.error ?? 'no_url' };
    try {
      const res = await fetch(s.url, { method: 'PUT', body: blob, headers: { 'Content-Type': contentType } });
      // 403은 서명 만료·시크릿 오입력, CORS 실패는 fetch가 예외로 던진다(진단표 참조).
      if (!res.ok) return { error: `R2 업로드 실패(${res.status})`, status: res.status };
      return {};
    } catch (e) {
      return { error: `R2 업로드 실패 — CORS 설정(5단계)일 가능성이 큽니다: ${(e as Error).message}` };
    }
  }

  return {
    upload,
    uploadDisplay: (path, blob) => upload(path, blob, 'image/webp'),

    async download(path) {
      const s = await signed('get', path);
      if (s.error || !s.url) return { data: null, error: s.error ?? 'no_url' };
      return downloadSignedUrl(s.url);
    },

    async remove(path) {
      const rest = restOfPath(path);
      if (!rest) return { error: 'bad_media_path' };
      // 삭제는 브라우저가 하지 않는다 — 함수가 서명하고 함수가 실행한다.
      const r = await callSign(client, 'delete', null, { path: rest });
      if (r.error) return { error: explainR2Error(r.error) };
      return {};
    },
  };
}
