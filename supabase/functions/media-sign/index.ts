// supabase/functions/media-sign — R2 표시본 바이트의 **유일한 출입구** (ADR-0024)
//
// 왜 이 함수가 존재하나: R2에는 RLS가 없다. Postgres에서 행을 지켜주던 `auth.uid()` 술어가
// 바이트 저장소에는 없으므로, 접근 통제가 **DB → 이 함수 + 토큰 스코프**로 이동한다.
// 그래서 이 파일은 "편의 함수"가 아니라 **보안 경계 그 자체**다.
//
// 읽기 정책 B(사용자 결정 2026-07-25): 버킷은 **비공개**로 두고 읽기도 5분 서명 URL로 준다.
//   → `R2_PUBLIC_BASE` 시크릿을 쓰지 않는다. 공개 개발 URL을 켜지 않는다.
//   근거: 원칙 #3(개인자료 기본 비공개). 우리 앱은 사진이 주인공이라 "URL을 모르면 안전"은
//   보안이 아니라 은닉이다. 표시는 로컬 blob이 담당하므로 읽기 서명은 사진당 1회뿐이다.
//
// 🔐 불변식
//   1) R2 자격증명은 **여기(함수 시크릿)에만** 있다. 응답 본문·오류 메시지에 값이 나가지 않는다.
//   2) **객체 키는 서버가 만든다.** 클라이언트는 mediaId만 보내고, 사용자 폴더는 검증된
//      JWT의 `sub`에서 나온다 → 남의 폴더를 지정하거나 경로를 조작할 방법이 없다.
//   3) 인증은 플랫폼 `verify_jwt` 설정에 **의존하지 않는다.** 매 요청 `/auth/v1/user`로 직접
//      확인한다(verify_jwt가 꺼진 채 배포돼도 sub 위조가 성립하지 않게).
//   4) 삭제는 브라우저에 권한을 주지 않는다 — 이 함수가 서명하고 이 함수가 실행한다.
//
// 배포: Supabase 대시보드 › Edge Functions › Deploy a new function › Via Editor,
//       함수 이름 `media-sign`. **이 파일 한 개**를 통째로 붙여넣는다(시크릿 4개는 앱 내
//       가이드 참조). 편집기가 Deno 전역을 몰라 빨간 타입 경고를 내지만 배포·실행에 무해하다.
//
// 검사 가능성: 순수 부분(presign·objectKey·uriEncode)을 export하고 `Deno.serve`는 Deno에서만
//       호출한다 → Node/Vitest에서 이 파일을 그대로 import해 구조 불변식을 검사할 수 있다
//       (tests/unit/mediaSign.test.ts). **서명값 자체의 정합은 실제 R2가 있어야 증명된다**
//       (검증 사다리 3번) — 이 환경에서 통과했다고 서명이 맞다고 말하지 않는다.

/** Deno 런타임 전역. Node에서는 undefined → serve를 호출하지 않고 순수 함수만 노출한다. */
const DENO = (globalThis as unknown as {
  Deno?: {
    env: { get(k: string): string | undefined };
    serve(handler: (req: Request) => Promise<Response>): void;
  };
}).Deno;

const envGet = (k: string): string | undefined => DENO?.env.get(k);

export const ALGO = 'AWS4-HMAC-SHA256';
export const REGION = 'auto';
export const SERVICE = 's3';
export const EXPIRES_SEC = 300; // 5분 — 유출돼도 창이 좁다
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export interface R2Env {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export const R2_SECRET_NAMES = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const;

function r2Env(): R2Env | null {
  const [accountId, bucket, accessKeyId, secretAccessKey] = R2_SECRET_NAMES.map((n) => envGet(n));
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;
  // 실패 원인 1위가 시크릿 앞뒤 공백 혼입(증상: SignatureDoesNotMatch)이라 여기서 깎아낸다.
  return {
    accountId: accountId.trim(),
    bucket: bucket.trim(),
    accessKeyId: accessKeyId.trim(),
    secretAccessKey: secretAccessKey.trim(),
  };
}

// ── SigV4 (쿼리 서명) ──────────────────────────────────────────────
const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

async function sha256hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

/** RFC 3986. encodeURIComponent가 남기는 !'()* 까지 인코딩한다(S3 정규화 요구). */
export function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** ISO 문자열 → SigV4 basic 형식(YYYYMMDDTHHMMSSZ). */
export function amzDateOf(ms: number): string {
  return new Date(ms).toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
}

/**
 * presigned URL 생성. 헤더는 host만 서명하므로 브라우저가 Content-Type을 덧붙여도
 * 서명이 깨지지 않는다(쿼리 서명에서 미서명 헤더는 검증 대상이 아니다).
 */
export async function presign(
  env: R2Env,
  method: 'PUT' | 'GET' | 'DELETE',
  key: string,
  nowMs: number,
): Promise<string> {
  const host = `${env.accountId}.r2.cloudflarestorage.com`;
  const amzDate = amzDateOf(nowMs);
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const canonicalUri = `/${uriEncode(env.bucket)}/${key.split('/').map(uriEncode).join('/')}`;

  const canonicalQuery = (
    [
      ['X-Amz-Algorithm', ALGO],
      ['X-Amz-Credential', `${env.accessKeyId}/${scope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(EXPIRES_SEC)],
      ['X-Amz-SignedHeaders', 'host'],
    ] as [string, string][]
  )
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [method, canonicalUri, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join(
    '\n',
  );
  const stringToSign = [ALGO, amzDate, scope, await sha256hex(canonicalRequest)].join('\n');

  let k: ArrayBuffer | Uint8Array = enc.encode(`AWS4${env.secretAccessKey}`);
  k = await hmac(k, dateStamp);
  k = await hmac(k, REGION);
  k = await hmac(k, SERVICE);
  k = await hmac(k, 'aws4_request');
  const signature = hex(await hmac(k, stringToSign));

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * 객체 키. 사용자 폴더는 **검증된 sub**에서만 나온다(클라이언트 입력 아님).
 * 앱의 `mediaStoragePath(userId, mediaId)`와 형식이 같아야 한다 — 유닛으로 잠근다.
 */
export function objectKey(userId: string, mediaId: string): string {
  return `${userId}/${mediaId}.webp`;
}

// ── 인증 — 플랫폼 설정에 의존하지 않는 실제 확인 ──────────────────
/**
 * auth API 호출에 쓸 publishable(anon) 키.
 * 프로젝트가 새 키 체계(`SUPABASE_PUBLISHABLE_KEYS`)를 쓰면 `SUPABASE_ANON_KEY`가
 * 주입되지 않을 수 있다 → 그때는 **요청에 실려온 apikey 헤더**를 쓴다.
 * 안전한 이유: 신원은 apikey가 아니라 **JWT**에서 나오고 그 검증은 Supabase auth 서버가 한다.
 * 위조 apikey를 보내면 호출이 실패해 null이 되므로(=401) 우회로가 생기지 않는다.
 * anon 키는 애초에 브라우저에 공개된 값이라 여기서 비밀이 새는 것도 아니다.
 */
function publishableKey(req: Request): string | null {
  return envGet('SUPABASE_ANON_KEY') ?? req.headers.get('apikey') ?? null;
}

async function verifiedUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const base = envGet('SUPABASE_URL');
  const anon = publishableKey(req);
  if (!base || !anon) return null;
  try {
    const r = await fetch(`${base}/auth/v1/user`, { headers: { Authorization: auth, apikey: anon } });
    if (!r.ok) return null;
    const u = (await r.json()) as { id?: unknown };
    return typeof u.id === 'string' && UUID_RE.test(u.id) ? u.id : null;
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body: { op?: unknown; mediaId?: unknown };
  try {
    body = (await req.json()) as { op?: unknown; mediaId?: unknown };
  } catch {
    return json({ error: 'bad_json' }, 400);
  }
  const op = typeof body.op === 'string' ? body.op : '';

  const env = r2Env();
  // probe: 어떤 시크릿이 비었는지 **이름만** 알려준다. 값은 절대 담지 않는다.
  if (op === 'probe') {
    return json({
      ok: env !== null,
      readPolicy: 'presigned', // B — 공개 URL 아님
      missing: env ? [] : R2_SECRET_NAMES.filter((n) => !envGet(n)),
    });
  }
  if (!env) return json({ error: 'r2_env_missing' }, 500);

  const userId = await verifiedUserId(req);
  if (!userId) return json({ error: 'unauthorized' }, 401);

  const mediaId = typeof body.mediaId === 'string' ? body.mediaId : '';
  if (!UUID_RE.test(mediaId)) return json({ error: 'bad_media_id' }, 400);
  const key = objectKey(userId, mediaId);

  try {
    if (op === 'put' || op === 'get') {
      const url = await presign(env, op === 'put' ? 'PUT' : 'GET', key, Date.now());
      return json({ url, key, expiresIn: EXPIRES_SEC });
    }
    if (op === 'delete') {
      // 삭제는 브라우저에 넘기지 않는다 — 여기서 서명하고 여기서 실행한다.
      const url = await presign(env, 'DELETE', key, Date.now());
      const r = await fetch(url, { method: 'DELETE' });
      // R2는 없는 객체 삭제도 성공을 준다(멱등) — tombstone 재시도에 안전하다.
      if (!r.ok && r.status !== 404) return json({ error: 'r2_delete_failed', status: r.status }, 502);
      return json({ ok: true, key });
    }
  } catch {
    // 예외 메시지에 서명 재료가 섞여 나가지 않도록 형태만 반환한다.
    return json({ error: 'sign_failed' }, 500);
  }
  return json({ error: 'unknown_op' }, 400);
}

// Deno에서만 서버를 연다. Node(테스트)에서는 import해도 아무 일도 일어나지 않는다.
if (DENO) DENO.serve(handler);
