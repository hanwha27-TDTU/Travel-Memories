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
//   2) **사용자 폴더는 서버가 만든다.** 첫 칸은 검증된 JWT의 `sub`에서만 나오므로 남의 폴더를
//      가리킬 방법이 없다. 그 **안쪽 이름**은 앱이 정한다(2026-07-27~) — 사용자가 요구한
//      `여행제목/날짜_시간_제목__id` 규칙을 만들려면 여행 제목과 촬영시각이 필요한데 이 함수는
//      DB를 보지 않기 때문이다. 대신 `safeRest()`가 모양을 못박는다(깊이 2 이하·`.`/`..` 금지·
//      제어문자 금지·**우리가 만드는 확장자만** — 사진 `.webp` + 소리 `.webm`/`.m4a`/`.ogg`/
//      `.mp3`/`.wav`). 즉 앱이 틀린 이름을 보내도 **자기 폴더 안에서만** 틀릴 수 있다.
//      그건 보안이 아니라 정합의 문제이고, 그쪽은 진단의 사진 대조가 잡는다.
//      · `deleteMany`는 한 걸음 더 간다 — **자기가 목록에서 본 키만** 지운다(클라이언트가 준
//        문자열을 지우지 않는다). 이름이 id에서 파생되지 않게 되면서 오히려 더 좁아졌다.
//   3) 인증은 플랫폼 `verify_jwt` 설정에 **의존하지 않는다.** 매 요청 `/auth/v1/user`로 직접
//      확인한다(verify_jwt가 꺼진 채 배포돼도 sub 위조가 성립하지 않게).
//   4) 삭제는 브라우저에 권한을 주지 않는다 — 이 함수가 서명하고 이 함수가 실행한다.
//      · 2026-07-26 추가: 여러 건 삭제(`deleteMany`)는 지운 뒤 **목록을 다시 읽어** 확인한다.
//        "성공 응답"을 완료로 치지 않는다 — 그 습관이 없어서 M-0029(바이트 삭제 실패가
//        조용히 증발)가 났다.
//      · `abortMultipart`는 **내 폴더 아래 미완료 조각만** 중단한다. 이 조각들은 객체 목록에도
//        대시보드에도 안 보이면서 용량을 먹는다 — 보이지 않는 것을 보이게 만드는 것이 진단이다.
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
// 검사 가능성: 순수 부분(presign·objectKey·safeRest·uriEncode)을 export하고 `Deno.serve`는 Deno에서만
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
 * 객체 키의 **접미**(사용자 폴더 뒤쪽) 검증.
 *
 * 2026-07-27 이전엔 함수가 `{sub}/{mediaId}.webp`를 통째로 만들었다. 클라이언트가 키에 전혀
 * 손댈 수 없다는 뜻이라 단순하고 강했다. 그런데 사용자가 *"폴더는 여행 제목, 파일명은
 * 날짜_시간_제목_id"*를 원했고, **함수는 여행 제목도 촬영시각도 모른다**(DB를 안 본다).
 *
 * 그래서 권한의 경계만 남기고 이름은 앱에 넘긴다:
 *  · **첫 칸은 여전히 검증된 sub다.** 이 값은 요청 본문에서 오지 않는다 — 남의 폴더는
 *    원리적으로 못 만든다. 인가 모델은 그대로다.
 *  · 그 **안쪽**만 앱이 정하되 모양을 못박는다: `폴더/파일.<확장자>` 또는 `파일.<확장자>`(옛 형식).
 *    빈 칸·`.`·`..`·중첩 더 깊은 경로는 거부한다.
 *  · 확장자는 **우리가 만드는 것만** 받는다(`KNOWN_EXT_RE`). 이걸 열어 두면 버킷이 임의
 *    파일 저장소가 된다 — 자기 폴더 안이라도 그건 이 앱이 약속한 바가 아니다.
 *
 * 즉 앱이 틀린 이름을 보내도 **자기 폴더 안**에서만 틀릴 수 있다. 그건 보안이 아니라
 * 정합의 문제이고, 그쪽은 진단의 사진 대조가 잡는다.
 */
export function safeRest(rest: string): string | null {
  if (typeof rest !== 'string' || rest.length === 0 || rest.length > 400) return null;
  if (!KNOWN_EXT_RE.test(rest)) return null;
  const parts = rest.split('/');
  if (parts.length < 1 || parts.length > 2) return null;
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') return null;
    // 제어문자·백슬래시는 키에 넣지 않는다(서명·목록 파싱이 흔들린다).
    if (/[\u0000-\u001f\\]/.test(p)) return null;
  }
  return rest;
}

/**
 * 객체 키. 사용자 폴더는 **검증된 sub**에서만 나온다(클라이언트 입력 아님).
 * 앱의 `mediaStoragePath`와 형식이 같아야 한다 — `tests/unit/mediaNaming`이 왕복으로 잠근다.
 */
export function objectKey(userId: string, rest: string): string {
  return `${userId}/${rest}`;
}

// ── 목록 조회(ListObjectsV2) ────────────────────────────────────────
/**
 * 한 번에 받을 객체 수와 페이지 상한. 개인 여행 앱이라 수천 장이 상한이면 충분하고,
 * 무한 루프를 구조적으로 막는다. **상한에 걸리면 `truncated`로 반드시 말한다** —
 * 조용히 자르고 "고아 0건"이라 판정하면 그건 거짓말이다(비타협 원칙 #4).
 */
export const LIST_PAGE_SIZE = 1000;
export const LIST_MAX_PAGES = 10;

/**
 * 이 함수가 지원하는 연산과 **판**(version).
 *
 * 왜 필요한가(2026-07-26): 클라이언트가 새 필드를 기대하는데 서버에 **옛 함수가 배포돼 있으면**
 * 앱은 그걸 알 방법이 없어 방어 코드(`?? 0`)로 조용히 넘어간다 — 그 순간 "0개"와 "모름"이
 * 구분되지 않는다. 실제로 그날 그 방어 코드를 썼다. 함수가 **자기 능력을 스스로 밝히면**
 * 화면이 「앱이 기대하는 기능이 서버에 없어요」라고 정직하게 말할 수 있다(비타협 원칙 #4).
 *
 * 규칙: **연산을 추가하면 이 목록에 넣는다.** 넣지 않으면 클라이언트가 없는 것으로 취급한다.
 */
/**
 * 이 앱이 만드는 확장자. **`domain/media/naming.ts`의 `AUDIO_EXTS`와 같은 목록이어야 한다** —
 * 앱이 `.webm`으로 올리는데 여기서 거부하면 소리는 영영 서버에 못 간다. 두 파일은 다른 배포
 * 단위(브라우저/Deno)에 살아 손으로 맞출 수 없으므로 `tests/unit/audioRowmap.test.ts`가 잠근다.
 */
export const PHOTO_EXTS = ['webp'] as const;
export const AUDIO_EXTS = ['webm', 'm4a', 'ogg', 'mp3', 'wav'] as const;
const KNOWN_EXT_RE = new RegExp(`\\.(?:${[...PHOTO_EXTS, ...AUDIO_EXTS].join('|')})$`, 'i');
const AUDIO_EXT_RE = new RegExp(`\\.(?:${AUDIO_EXTS.join('|')})$`, 'i');

/** 이 키는 소리인가. 종류는 **확장자가 말한다**(사진과 같은 폴더에 살기 때문에). */
export function isAudioKey(key: string): boolean {
  return AUDIO_EXT_RE.test(key);
}

export const FN_VERSION = 6;
export const FN_OPS = ['probe', 'capabilities', 'list', 'put', 'get', 'delete', 'deleteMany', 'abortMultipart'] as const;

/** 한 번에 지울 수 있는 최대 개수 — 요청 하나가 무한정 길어지지 않게. */
export const DELETE_MANY_MAX = 200;

/** XML 엔티티 되돌리기. 우리 키엔 없지만 없다고 가정하지 않는다. */
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
  /** 이 페이지 객체들의 **바이트 합계**. 앱이 "내 사진 N개 · X MB"를 스스로 말할 수 있게 한다. */
  bytes: number;
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
  let bytes = 0;
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1] ?? '';
    const k = block.match(/<Key>([\s\S]*?)<\/Key>/);
    if (!k) continue;
    keys.push(xmlUnescape(k[1] ?? ''));
    // 크기를 못 읽으면 0으로 더한다 — 합계를 **부풀리지 않는다**(모르면 작게, 거짓 경보 방지).
    const sz = block.match(/<Size>\s*(\d+)\s*<\/Size>/);
    bytes += sz ? Number(sz[1]) : 0;
  }
  const prefixes: string[] = [];
  for (const m of xml.matchAll(/<CommonPrefixes>[\s\S]*?<Prefix>([\s\S]*?)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g)) {
    prefixes.push(xmlUnescape(m[1] ?? ''));
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const tok = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
  return { keys, bytes, prefixes, nextToken: truncated && tok ? xmlUnescape(tok[1] ?? '') : null };
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
 * **미완료 멀티파트 업로드** 목록 파싱(`GET /{bucket}?uploads`).
 *
 * 왜 필요한가(2026-07-26 사용자 실기기): 버킷 최상위가 **완전히 비었는데** 대시보드는
 * 2.87MB를 계속 보여줬다. 사용자가 물었다 — *"설마 휴지통 이런 데 간 거 아님?"*
 *
 * R2에 휴지통은 없다. 그러나 **미완료 멀티파트 업로드**는 실제로 그렇게 행동한다:
 * 업로드가 중간에 끊기면 조각이 남는데 **객체 목록에도 대시보드 파일 목록에도 안 보이면서
 * 저장 공간은 차지한다.** 앱이 이걸 못 보면 "다 지웠는데 왜 용량이 남지?"를 영영 설명할 수 없다.
 *
 * 보이지 않는 것을 보이게 만드는 것이 진단의 일이다(§8).
 */
export interface MultipartUpload {
  key: string;
  uploadId: string;
}

export function parseMultipartXml(xml: string): MultipartUpload[] {
  const out: MultipartUpload[] = [];
  for (const m of xml.matchAll(/<Upload>([\s\S]*?)<\/Upload>/g)) {
    const block = m[1] ?? '';
    const k = block.match(/<Key>([\s\S]*?)<\/Key>/);
    const u = block.match(/<UploadId>([\s\S]*?)<\/UploadId>/);
    if (k && u) out.push({ key: xmlUnescape(k[1] ?? ''), uploadId: xmlUnescape(u[1] ?? '') });
  }
  return out;
}

/**
 * 키에서 mediaId를 뽑는다. **폴더(uid) 부분은 버린다** — 응답에 다시 담지 않기 위해서다.
 * 우리 형식이 아니면 null(호출부가 따로 세어 보고한다 — 조용히 버리지 않는다).
 */
export function mediaIdOfKey(key: string): string | null {
  const last = key.split('/').pop() ?? '';
  const base = last.replace(KNOWN_EXT_RE, '');
  // 새 형식: `날짜_시간_제목__<하이픈 뺀 32자>`. 사람이 읽는 앞부분에 `__`가 몇 번 나오든
  // **맨 뒤 조각**만 본다(여행 제목에 밑줄이 들어갈 수 있다).
  const tail = base.split('__').pop() ?? '';
  if (/^[0-9a-f]{32}$/i.test(tail)) {
    const h = tail.toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  // 옛 형식: `<uuid>.webp`. 서비스워커가 옛 앱을 잠시 살려 둘 수 있으므로 계속 받는다 —
  // 못 읽으면 멀쩡한 사진이 「설명할 수 없는 파일」이라는 **문제**로 뜬다.
  return UUID_RE.test(base) ? base : null;
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

/**
 * 내 폴더의 키 한 페이지를 읽는다. **실패하면 null** — 빈 배열로 반올림하지 않는다
 * (빈 목록은 "없다"이고 null은 "모른다"이다. 둘을 섞으면 지우지도 않은 것을 지웠다고 말한다).
 *
 * `deleteMany`의 **선행 조회**와 **되읽기**가 이 한 곳을 쓴다 — 두 곳에 손으로 쓰면
 * 한쪽만 고쳐지는 날이 온다(§7).
 */
async function listKeysOnce(env: R2Env, prefix: string): Promise<string[] | null> {
  try {
    const url = await presign(env, 'GET', '', Date.now(), [
      ['list-type', '2'],
      ['prefix', prefix],
      ['max-keys', String(LIST_PAGE_SIZE)],
    ]);
    const r = await fetch(url);
    if (!r.ok) return null;
    return parseListXml(await r.text()).keys;
  } catch {
    return null;
  }
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body: { op?: unknown; mediaId?: unknown; path?: unknown; mediaIds?: unknown };
  try {
    body = (await req.json()) as { op?: unknown; mediaId?: unknown; path?: unknown; mediaIds?: unknown };
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
  // capabilities: **이 함수가 무엇을 할 줄 아는가.** 비밀은 담지 않으므로 인증 전에 답한다 —
  // 인증이 깨진 상황에서도 "서버 판이 낡았나"를 앱이 구분할 수 있어야 한다.
  if (op === 'capabilities') {
    return json({
      version: FN_VERSION,
      ops: FN_OPS,
      // 서버 시각 — 클라이언트 시계가 어긋나면 서명이 만료로 거절된다. 그 진단의 재료다.
      serverTime: new Date().toISOString(),
      secretsOk: env !== null,
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
    const ids: string[] = []; // 사진(.webp)
    // 🔴 소리를 **같은 배열에 담으면 안 된다.** 앱은 이 목록을 사진 기록과 1:1로 대조하므로,
    //    섞으면 멀쩡한 소리가 전부 「기록 없는 사진 파일」로 뜨고 화면은 그걸 치우라고 권한다.
    const audioIds: string[] = [];
    let foreign = 0; // 우리 형식이 아닌 키 — 조용히 버리지 않고 개수로 보고한다
    let bytes = 0; // 내 폴더 총 바이트
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
        bytes += parsed.bytes;
        for (const k of parsed.keys) {
          const id = mediaIdOfKey(k);
          if (!id) { foreign++; continue; }
          if (isAudioKey(k)) audioIds.push(id);
          else ids.push(id);
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

    // ── 미완료 멀티파트 업로드 ─────────────────────────────────────
    // 2026-07-26 사용자: 버킷 최상위가 **완전히 비었는데** 대시보드는 2.87MB를 계속 보여줬다.
    // *"설마 휴지통 이런 데 간 거 아님?"* — R2에 휴지통은 없다. 그런데 **미완료 멀티파트
    // 업로드**는 정확히 그렇게 행동한다: 객체 목록에도 대시보드 파일 목록에도 **안 보이는데
    // 저장 공간은 차지한다.** 앱이 이걸 못 보면 그 질문에 영영 답할 수 없다.
    //
    // 보이지 않는 것을 보이게 만드는 것이 진단의 일이다(§8).
    let mpMine = 0;
    let mpOutside = 0;
    let mpKnown = false;
    try {
      const url = await presign(env, 'GET', '', Date.now(), [['uploads', '']]);
      const r = await fetch(url);
      if (r.ok) {
        for (const u of parseMultipartXml(await r.text())) {
          if (u.key.startsWith(prefix)) mpMine++;
          else mpOutside++;
        }
        mpKnown = true;
      }
    } catch {
      /* mpKnown=false — 못 본 것을 0으로 반올림하지 않는다. */
    }

    // 키 전체가 아니라 mediaId만 돌려준다(폴더=uid는 다시 담지 않는다).
    return json({
      ids,
      audioIds,
      foreign,
      truncated,
      count: ids.length,
      bytes, // 내 폴더 총 바이트 — 앱이 "N개 · X MB"를 스스로 말할 수 있게
      outside,
      outsideKnown,
      multipart: { mine: mpMine, outside: mpOutside, known: mpKnown },
      version: FN_VERSION,
    });
  }

  // ── deleteMany: 여러 장을 한 번에, 그리고 **되읽어 확인** ──────────
  // 왜(2026-07-26 M-0029): 영구삭제의 바이트 삭제가 "최선노력"이라 실패해도 op을 지웠다.
  // 재시도 기회가 없어 잔재가 남았고, 사용자는 Cloudflare 콘솔을 직접 열어야 했다.
  // 그리고 정리할 때 3건이면 3왕복이었다 — 100장이면 100왕복이고 매번 JWT를 다시 검증한다.
  //
  // 여기서는 ① 한 번에 받고 ② 지운 뒤 ③ **목록을 다시 읽어** 실제로 사라졌는지 확인한다.
  // "성공 응답"을 완료로 치지 않는다(데이터 안전 불변식의 read-back과 같은 규율).
  if (op === 'deleteMany') {
    const raw = Array.isArray(body.mediaIds) ? body.mediaIds : [];
    const idsIn = raw.filter((x): x is string => typeof x === 'string' && UUID_RE.test(x));
    if (!idsIn.length) return json({ error: 'no_media_ids' }, 400);
    if (idsIn.length > DELETE_MANY_MAX) return json({ error: 'too_many', max: DELETE_MANY_MAX }, 400);

    const prefix = `${userId}/`;
    const errors: { id: string; status: number }[] = [];
    let sent = 0;

    // ① **먼저 목록을 읽어 실제 키를 알아낸다.** 예전엔 id로 키를 다시 만들었는데, 이제 키에
    //    여행 제목·촬영시각이 들어가서 id만으로는 만들 수 없다. 그리고 이 편이 **더 안전하다**:
    //    함수는 자기가 목록에서 본 키만 지운다 — 클라이언트가 준 문자열을 지우지 않는다.
    const before = await listKeysOnce(env, prefix);
    if (!before) return json({ error: 'r2_list_failed' }, 502);
    const keyOfId = new Map<string, string>();
    for (const k of before) {
      const id = mediaIdOfKey(k);
      if (id) keyOfId.set(id, k);
    }

    for (const id of idsIn) {
      const key = keyOfId.get(id);
      // 목록에 없으면 이미 없는 것이다(멱등) — 실패로 세지 않는다.
      if (!key) { sent++; continue; }
      try {
        const url = await presign(env, 'DELETE', key, Date.now());
        const r = await fetch(url, { method: 'DELETE' });
        // R2는 없는 객체 삭제도 성공을 준다(멱등).
        if (r.ok || r.status === 404) sent++;
        else errors.push({ id, status: r.status });
      } catch {
        errors.push({ id, status: 0 });
      }
    }

    // ③ 되읽기 — 한 번의 목록 조회로 전부 확인한다(건당 확인보다 싸고 더 정확하다).
    let stillThere: string[] = [];
    let verified = false;
    const after = await listKeysOnce(env, prefix);
    if (after) {
      const left = new Set(after.map(mediaIdOfKey).filter((x): x is string => x !== null));
      stillThere = idsIn.filter((id) => left.has(id));
      verified = true;
    } // null이면 verified=false — 확인하지 못한 것을 성공으로 적지 않는다.

    return json({ requested: idsIn.length, sent, stillThere, verified, errors, version: FN_VERSION });
  }

  // ── abortMultipart: 보이지 않는 조각 치우기 ────────────────────────
  // 미완료 멀티파트 업로드는 객체 목록에 안 보이면서 용량을 먹는다. 지표를 만들었으면
  // **고칠 곳도 만든다**(진단 §7-B — 그날 이걸 두 번 어겼다).
  //
  // 🔐 **내 폴더 아래 것만** 중단한다. 남의 조각은 세기만 하고 손대지 않는다.
  if (op === 'abortMultipart') {
    const prefix = `${userId}/`;
    let aborted = 0;
    const failed: { key: string; status: number }[] = [];
    let listed = false;
    try {
      const lu = await presign(env, 'GET', '', Date.now(), [['uploads', '']]);
      const lr = await fetch(lu);
      if (lr.ok) {
        listed = true;
        for (const u of parseMultipartXml(await lr.text())) {
          if (!u.key.startsWith(prefix)) continue; // 남의 것은 건드리지 않는다
          const du = await presign(env, 'DELETE', u.key, Date.now(), [['uploadId', u.uploadId]]);
          const dr = await fetch(du, { method: 'DELETE' });
          if (dr.ok || dr.status === 204 || dr.status === 404) aborted++;
          else failed.push({ key: u.key.slice(prefix.length), status: dr.status });
        }
      }
    } catch {
      /* listed=false — 못 봤으면 "0건 정리"라고 말하지 않는다. */
    }
    if (!listed) return json({ error: 'r2_multipart_list_failed' }, 502);
    return json({ aborted, failed, version: FN_VERSION });
  }

  // 키의 **안쪽 이름**은 앱이 정한다(여행 제목·촬영시각을 함수는 모른다). 바깥 폴더는 여전히
  // 검증된 sub다. 옛 앱(서비스워커 캐시)이 `mediaId`만 보낼 수 있으므로 그 형식도 받는다.
  const rawPath = typeof body.path === 'string' ? body.path : '';
  const legacyId = typeof body.mediaId === 'string' ? body.mediaId : '';
  const rest = rawPath ? safeRest(rawPath) : UUID_RE.test(legacyId) ? `${legacyId}.webp` : null;
  if (!rest) return json({ error: 'bad_media_path' }, 400);
  const key = objectKey(userId, rest);

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
