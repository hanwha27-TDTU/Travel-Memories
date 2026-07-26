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
//   5) **목록의 범위도 서버가 못박는다.** prefix는 검증된 sub에서만 나오고, 요청 본문의
//      prefix/delimiter/bucket은 읽지도 않는다. 목록 서명 URL은 브라우저로 나가지 않는다.
//      · 2026-07-26 추가: 내 폴더 **밖**을 최상위 한 번만 훑어 **개수 하나**(`outside`)를
//        돌려준다. 키는 응답에 담지 않는다 — 앱이 알아야 할 것은 "내가 못 보는 자리에
//        뭔가 있다"까지이고, 그 이상은 Cloudflare 콘솔의 몫이다(최소 노출).
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
 *
 * `key`가 빈 문자열이면 **버킷 자체**를 가리킨다(ListObjectsV2용). 이때 `extraQuery`로
 * `list-type=2`·`prefix` 등을 넘긴다 — 이들도 **서명에 포함**되므로 중간에서 prefix를
 * 바꿔치기할 수 없다. 이게 "목록의 범위를 서버가 못박는다"의 실제 구현이다.
 */
export async function presign(
  env: R2Env,
  method: 'PUT' | 'GET' | 'DELETE',
  key: string,
  nowMs: number,
  extraQuery: [string, string][] = [],
): Promise<string> {
  const host = `${env.accountId}.r2.cloudflarestorage.com`;
  const amzDate = amzDateOf(nowMs);
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const canonicalUri = key
    ? `/${uriEncode(env.bucket)}/${key.split('/').map(uriEncode).join('/')}`
    : `/${uriEncode(env.bucket)}`;

  const canonicalQuery = (
    [
      ['X-Amz-Algorithm', ALGO],
      ['X-Amz-Credential', `${env.accessKeyId}/${scope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(EXPIRES_SEC)],
      ['X-Amz-SignedHeaders', 'host'],
      ...extraQuery,
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

// ── 목록 조회(ListObjectsV2) ────────────────────────────────────────
/**
 * 한 번에 받을 객체 수와 페이지 상한. 개인 여행 앱이라 수천 장이 상한이면 충분하고,
 * 무한 루프를 구조적으로 막는다. **상한에 걸리면 `truncated`로 반드시 말한다** —
 * 조용히 자르고 "고아 0건"이라 판정하면 그건 거짓말이다(비타협 원칙 #4).
 */
export const LIST_PAGE_SIZE = 1000;
export const LIST_MAX_PAGES = 10;

/** XML 엔티티 되돌리기. 우리 키(`{uuid}/{uuid}.webp`)엔 없지만 없다고 가정하지 않는다. */
export function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export interface ListPage {
  keys: string[];
  /**
   * `delimiter=/`로 조회했을 때 서버가 접어서 돌려주는 **최상위 폴더들**(`CommonPrefixes`).
   * 폴더 안을 열어보지 않고 "내 폴더 말고 뭐가 더 있나"를 한 번의 요청으로 알 수 있다.
   */
  prefixes: string[];
  /** 서버가 준 다음 페이지 토큰(없으면 끝). */
  nextToken: string | null;
}

/**
 * ListObjectsV2 응답 XML에서 키와 다음 토큰만 뽑는다.
 *
 * DOM 파서 없이 정규식을 쓰는 이유: Deno 런타임에 XML 파서가 없고, S3 응답은 스키마가
 * 고정된 기계 생성물이라 `<Contents><Key>…</Key>` 형태가 변하지 않는다. **순수 함수라
 * 유닛이 실제 응답 형태로 직접 돌린다** — 서명과 달리 이건 이 환경에서 증명 가능하다.
 */
export function parseListXml(xml: string): ListPage {
  const keys: string[] = [];
  for (const m of xml.matchAll(/<Contents>[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<\/Contents>/g)) {
    keys.push(xmlUnescape(m[1] ?? ''));
  }
  const prefixes: string[] = [];
  for (const m of xml.matchAll(/<CommonPrefixes>[\s\S]*?<Prefix>([\s\S]*?)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g)) {
    prefixes.push(xmlUnescape(m[1] ?? ''));
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const tok = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
  return { keys, prefixes, nextToken: truncated && tok ? xmlUnescape(tok[1] ?? '') : null };
}

/**
 * **내 폴더 밖에 몇 개가 있나** — 개수만 센다. 순수 함수라 유닛이 직접 돌린다.
 *
 * 왜 개수만인가(2026-07-26 사용자 요청): 진단이 「사진 파일 0개」라고 말할 때 그건
 * *"내 폴더에는 0개"*라는 뜻이지 "버킷이 비었다"가 아니다. 그 한정을 화면이 말하지 않아
 * 사용자가 대시보드를 직접 열어 확인해야 했다(M-0028과 같은 결함 — 문장이 한정을 생략).
 *
 * 그렇다고 남의 키를 응답에 담을 이유는 없다. **"몇 개가 더 있다"까지가 앱이 알아야 할
 * 전부**이고, 그 이상은 Cloudflare 콘솔의 몫이다. 최소 노출 원칙.
 */
export function countOutside(page: ListPage, myPrefix: string): number {
  // 최상위 파일(폴더에 안 든 것) + 내 것이 아닌 폴더.
  return page.keys.length + page.prefixes.filter((p) => p !== myPrefix).length;
}

/**
 * 키에서 mediaId를 뽑는다. **폴더(uid) 부분은 버린다** — 응답에 다시 담지 않기 위해서다.
 * 우리 형식이 아니면 null(호출부가 따로 세어 보고한다 — 조용히 버리지 않는다).
 */
export function mediaIdOfKey(key: string): string | null {
  const last = key.split('/').pop() ?? '';
  const id = last.replace(/\.webp$/i, '');
  return UUID_RE.test(id) ? id : null;
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

  // ── list: 내 폴더의 객체 목록 ────────────────────────────────────
  // 🔐 prefix는 **검증된 sub에서만** 나온다. 요청 본문의 prefix/delimiter/bucket은
  //    읽지도 않는다 — 파싱해 두면 언젠가 쓰게 되고, 그 순간 버킷 전체가 열린다.
  //    서명 URL도 브라우저에 주지 않는다: 목록 URL은 "이 접두사 아래 전부"를 뜻해
  //    유출 시 단건 URL보다 손해가 크다(삭제와 같은 이유로 함수가 직접 호출한다).
  if (op === 'list') {
    const prefix = `${userId}/`;
    const ids: string[] = [];
    let foreign = 0; // 우리 형식이 아닌 키 — 조용히 버리지 않고 개수로 보고한다
    let token: string | null = null;
    let truncated = false;
    try {
      for (let page = 0; page < LIST_MAX_PAGES; page++) {
        const q: [string, string][] = [
          ['list-type', '2'],
          ['prefix', prefix],
          ['max-keys', String(LIST_PAGE_SIZE)],
        ];
        if (token) q.push(['continuation-token', token]);
        const url = await presign(env, 'GET', '', Date.now(), q);
        const r = await fetch(url);
        if (!r.ok) return json({ error: 'r2_list_failed', status: r.status }, 502);
        const parsed: ListPage = parseListXml(await r.text());
        for (const k of parsed.keys) {
          const id = mediaIdOfKey(k);
          if (id) ids.push(id);
          else foreign++;
        }
        token = parsed.nextToken;
        if (!token) break;
        // 마지막 페이지까지 돌았는데도 토큰이 남았다 = 더 있다.
        if (page === LIST_MAX_PAGES - 1) truncated = true;
      }
    } catch {
      return json({ error: 'r2_list_failed' }, 502);
    }
    // ── 내 폴더 **밖**에 무엇이 있나 — 개수만 ──────────────────────
    // 왜 필요한가(2026-07-26 사용자): 위 목록은 `prefix`로 내 폴더만 본다. 그래서 앱이
    // 「사진 파일 0개」라고 말해도 그건 *내 폴더 기준*이고, 버킷 전체가 비었다는 뜻이 아니다.
    // 사용자는 그 차이를 확인하려고 Cloudflare 콘솔을 매번 직접 열어야 했다.
    //
    // 🔐 경계는 그대로다: **키를 돌려주지 않는다.** `delimiter=/`로 최상위만 접어서 받아
    //    "내 것이 아닌 폴더 수 + 최상위 파일 수"라는 **숫자 하나**만 응답에 담는다.
    //    요청 본문의 prefix/delimiter/bucket은 여전히 읽지 않는다.
    //
    // 조회에 실패하면 0이 아니라 **'모른다'**로 둔다 — 못 본 것을 정상으로 반올림하지 않는다.
    let outside = 0;
    let outsideKnown = false;
    try {
      const url = await presign(env, 'GET', '', Date.now(), [
        ['list-type', '2'],
        ['delimiter', '/'],
        ['max-keys', String(LIST_PAGE_SIZE)],
      ]);
      const r = await fetch(url);
      if (r.ok) {
        const page = parseListXml(await r.text());
        // 다음 페이지가 남았다면 최상위가 1000개를 넘는다는 뜻 — 그건 "다 봤다"가 아니다.
        if (page.nextToken === null) {
          outside = countOutside(page, prefix);
          outsideKnown = true;
        }
      }
    } catch {
      /* outsideKnown=false 로 남긴다 — 화면이 '확인 불가'라고 말한다. */
    }

    // 키 전체가 아니라 mediaId만 돌려준다(폴더=uid는 다시 담지 않는다).
    return json({ ids, foreign, truncated, count: ids.length, outside, outsideKnown });
  }

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
