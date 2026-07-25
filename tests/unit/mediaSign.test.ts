// tests/unit/mediaSign.test.ts — R2 출입구(Edge Function)의 구조 불변식 (ADR-0024)
//
// 정직한 범위: 여기서 통과해도 **서명값이 R2에서 실제로 받아들여지는지는 증명하지 못한다**
// (샌드박스는 R2에 붙지 못한다). 그건 검증 사다리 3번(실기기 업로드)의 몫이다.
// 대신 자동으로 잡을 수 있는 것을 전부 잡는다:
//   - 앱 경로 규약 ↔ 함수 키 생성의 **형식 일치**(어긋나면 사진을 못 찾는다 = 원칙 #1)
//   - 클라이언트가 보낸 폴더/경로를 함수가 **무시**하는가(남의 폴더 접근 차단)
//   - 서명 재료(비밀키)가 URL·응답에 **새지 않는가**
//   - 정규 URI가 서명에 실제로 **참여**하는가(키가 달라지면 서명이 달라진다)

import { describe, it, expect, beforeAll } from 'vitest';
import { mediaStoragePath } from '../../src/domain/media/rowmap';
import { mediaIdFromPath } from '../../src/services/r2';

const UID_A = '11111111-2222-4333-8444-555555555555';
const UID_B = '99999999-8888-4777-8666-555555555555';
const MID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SECRET = 'sUpErSeCrEtR2Key0000';

const ENV: Record<string, string> = {
  R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  R2_BUCKET: 'travel-log-media',
  R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  R2_SECRET_ACCESS_KEY: SECRET,
  SUPABASE_URL: 'https://example.supabase.co',
  // SUPABASE_ANON_KEY는 **일부러 넣지 않는다** — 새 키 체계 프로젝트에서는 주입되지 않는다.
  // 요청의 apikey 헤더로 폴백하는 경로가 실제로 동작해야 인증이 성립한다.
};

/** auth 확인 호출이 실제로 받은 apikey(테스트에서 폴백 경로를 확인하기 위해 기록). */
let lastApiKey: string | null = null;

type Fn = typeof import('../../supabase/functions/media-sign/index');
let fn: Fn;

beforeAll(async () => {
  // Deno 전역을 먼저 세운 뒤 import해야 함수가 "Deno에서 도는 것처럼" 동작한다.
  (globalThis as unknown as { Deno: unknown }).Deno = {
    env: { get: (k: string): string | undefined => ENV[k] },
    serve: (): void => {}, // 테스트에서 포트를 열지 않는다
  };
  // 인증 확인(/auth/v1/user)만 가로챈다 — R2로는 실제로 나가지 않는다.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) {
      lastApiKey = new Headers(init?.headers).get('apikey');
      // apikey 없이 오면 실제 Supabase도 401을 준다 — 그 현실을 그대로 흉내낸다.
      if (!lastApiKey) return new Response('{"message":"No API key found"}', { status: 401 });
      return new Response(JSON.stringify({ id: UID_A }), { status: 200 });
    }
    if (init?.method === 'DELETE') return new Response('', { status: 204 });
    throw new Error(`예상치 못한 외부 호출: ${url}`);
  }) as typeof fetch;
  fn = await import('../../supabase/functions/media-sign/index');
});

function post(body: unknown): Request {
  return new Request('https://example.functions.supabase.co/media-sign', {
    method: 'POST',
    headers: { Authorization: 'Bearer fake-jwt', apikey: 'publishable-from-client', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('경로 규약 파리티 — 어긋나면 사진을 잃는다', () => {
  it('함수의 objectKey가 앱의 mediaStoragePath와 같은 형식이다', () => {
    expect(fn.objectKey(UID_A, MID)).toBe(mediaStoragePath(UID_A, MID));
  });

  it('mediaIdFromPath는 폴더를 버리고 mediaId만 남긴다', () => {
    expect(mediaIdFromPath(mediaStoragePath(UID_A, MID))).toBe(MID);
    expect(mediaIdFromPath(`${UID_B}/${MID}.webp`)).toBe(MID); // 폴더가 무엇이든 무관
  });

  it('UUID가 아닌 경로는 거부한다(경로 조작 시도 포함)', () => {
    expect(mediaIdFromPath('../../etc/passwd')).toBeNull();
    expect(mediaIdFromPath(`${UID_A}/not-a-uuid.webp`)).toBeNull();
  });
});

describe('접근 통제 — 서버가 키를 만든다', () => {
  it('클라이언트가 남의 폴더/키를 보내도 검증된 sub로 덮어쓴다', async () => {
    const res = await fn.handler(post({ op: 'put', mediaId: MID, key: `${UID_B}/evil.webp`, path: '../../evil' }));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { key: string; url: string };
    expect(j.key).toBe(`${UID_A}/${MID}.webp`); // UID_B가 아니라 인증된 UID_A
    expect(j.url).toContain(`/${UID_A}/${MID}.webp`);
    expect(j.url).not.toContain(UID_B);
  });

  it('mediaId가 UUID가 아니면 서명하지 않는다', async () => {
    const res = await fn.handler(post({ op: 'put', mediaId: 'a/../b' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_media_id');
  });

  it('Authorization 없이는 401 — 서명 URL이 나가지 않는다', async () => {
    const req = new Request('https://x/media-sign', { method: 'POST', body: JSON.stringify({ op: 'get', mediaId: MID }) });
    const res = await fn.handler(req);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('X-Amz-Signature');
  });

  it('SUPABASE_ANON_KEY가 없어도 요청의 apikey로 인증이 성립한다(새 키 체계 프로젝트)', async () => {
    lastApiKey = null;
    const res = await fn.handler(post({ op: 'get', mediaId: MID }));
    expect(res.status).toBe(200);
    expect(lastApiKey).toBe('publishable-from-client'); // 환경변수가 아니라 헤더에서 왔다
  });

  it('apikey도 Authorization도 없으면 401 — 폴백이 구멍이 되지 않는다', async () => {
    const req = new Request('https://x/media-sign', {
      method: 'POST',
      headers: { Authorization: 'Bearer fake-jwt' }, // apikey 없음
      body: JSON.stringify({ op: 'get', mediaId: MID }),
    });
    expect((await fn.handler(req)).status).toBe(401);
  });

  it('알 수 없는 op은 거부한다', async () => {
    const res = await fn.handler(post({ op: 'list', mediaId: MID }));
    expect(res.status).toBe(400);
  });
});

describe('서명 URL의 형태와 비밀 유출 방지', () => {
  it('필수 쿼리·호스트·수명 300초를 갖추고 비밀키는 담기지 않는다', async () => {
    const url = await fn.presign(
      { accountId: ENV.R2_ACCOUNT_ID!, bucket: ENV.R2_BUCKET!, accessKeyId: ENV.R2_ACCESS_KEY_ID!, secretAccessKey: SECRET },
      'PUT',
      `${UID_A}/${MID}.webp`,
      Date.UTC(2026, 6, 25, 12, 0, 0),
    );
    const u = new URL(url);
    expect(u.host).toBe(`${ENV.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    expect(u.pathname).toBe(`/${ENV.R2_BUCKET}/${UID_A}/${MID}.webp`);
    expect(u.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(u.searchParams.get('X-Amz-Date')).toBe('20260725T120000Z');
    expect(u.searchParams.get('X-Amz-Credential')).toBe(`${ENV.R2_ACCESS_KEY_ID}/20260725/auto/s3/aws4_request`);
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    // 🔐 비밀키가 URL 어디에도 없어야 한다
    expect(url).not.toContain(SECRET);
  });

  it('쿼리 파라미터가 사전순으로 정렬돼 있다(정규 요청 규약)', async () => {
    const url = await fn.presign(
      { accountId: 'a'.repeat(32), bucket: 'b', accessKeyId: 'k', secretAccessKey: SECRET },
      'GET',
      `${UID_A}/${MID}.webp`,
      0,
    );
    const names = [...new URL(url).searchParams.keys()].filter((n) => n !== 'X-Amz-Signature');
    expect(names).toEqual([...names].sort());
  });

  it('키가 다르면 서명도 다르다 — 정규 URI가 서명에 참여한다', async () => {
    const env = { accountId: 'a'.repeat(32), bucket: 'b', accessKeyId: 'k', secretAccessKey: SECRET };
    const at = Date.UTC(2026, 6, 25, 12, 0, 0);
    const s = async (key: string): Promise<string> =>
      new URL(await fn.presign(env, 'GET', key, at)).searchParams.get('X-Amz-Signature')!;
    expect(await s(`${UID_A}/${MID}.webp`)).not.toBe(await s(`${UID_B}/${MID}.webp`));
    // 같은 입력은 같은 결과(결정적) — 재시도가 서명을 흔들지 않는다
    expect(await s(`${UID_A}/${MID}.webp`)).toBe(await s(`${UID_A}/${MID}.webp`));
  });

  it('메서드가 다르면 서명도 다르다 — GET 서명을 PUT에 재사용할 수 없다', async () => {
    const env = { accountId: 'a'.repeat(32), bucket: 'b', accessKeyId: 'k', secretAccessKey: SECRET };
    const at = Date.UTC(2026, 6, 25, 12, 0, 0);
    const g = new URL(await fn.presign(env, 'GET', `${UID_A}/${MID}.webp`, at)).searchParams.get('X-Amz-Signature');
    const p = new URL(await fn.presign(env, 'PUT', `${UID_A}/${MID}.webp`, at)).searchParams.get('X-Amz-Signature');
    expect(g).not.toBe(p);
  });

  it("uriEncode는 encodeURIComponent가 남기는 !'()* 까지 인코딩한다", () => {
    expect(fn.uriEncode("a!b'c(d)e*f")).toBe('a%21b%27c%28d%29e%2Af');
    expect(fn.uriEncode('a/b')).toBe('a%2Fb'); // 세그먼트 단위로 부르므로 슬래시도 인코딩된다
  });
});

describe('probe — 진단은 주되 값은 주지 않는다', () => {
  it('시크릿이 모두 있으면 ok, 응답에 값이 없다', async () => {
    const res = await fn.handler(post({ op: 'probe' }));
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ ok: true, readPolicy: 'presigned', missing: [] });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(ENV.R2_ACCESS_KEY_ID!);
  });
});
