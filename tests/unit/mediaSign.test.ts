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
import { mediaIdFromPath, restOfPath } from '../../src/services/r2';

const UID_A = '11111111-2222-4333-8444-555555555555';
const UID_B = '99999999-8888-4777-8666-555555555555';
const MID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
/** 경로 계산에 필요한 최소한만 — 이 검사의 관심은 경로 규약이지 사진 내용이 아니다. */
const MEDIA = { id: MID, tripId: 'cccccccc-dddd-4eee-8fff-999999999999', takenAt: '2026-07-16T14:32:00.000Z' };
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
  it('함수가 붙이는 폴더 + 앱이 정한 이름 = 앱이 만든 전체 경로', () => {
    const full = mediaStoragePath(UID_A, MEDIA, '제주 여행');
    const rest = restOfPath(full)!;
    // 앱은 접미만 보내고, 함수가 **검증된 sub**를 앞에 붙여 같은 키를 만든다.
    expect(fn.objectKey(UID_A, rest)).toBe(full);
  });

  it('mediaIdFromPath는 폴더를 버리고 mediaId만 남긴다', () => {
    expect(mediaIdFromPath(mediaStoragePath(UID_A, MEDIA, '제주 여행'))).toBe(MID);
    expect(mediaIdFromPath(`${UID_B}/${MID}.webp`)).toBe(MID); // 옛 형식도 계속 읽는다
  });

  it('UUID가 아닌 경로는 거부한다(경로 조작 시도 포함)', () => {
    expect(mediaIdFromPath('../../etc/passwd')).toBeNull();
    expect(mediaIdFromPath(`${UID_A}/not-a-uuid.webp`)).toBeNull();
  });
});

describe('접근 통제 — 서버가 키를 만든다', () => {
  // 2026-07-27부터 **이름은 앱이 정한다**(여행 제목·촬영시각을 함수는 모른다).
  // 바뀐 것은 이름뿐이고, **첫 칸이 검증된 sub라는 것**은 그대로다 — 아래 셋이 그 경계를 잰다.
  it('접미에 남의 uid를 넣어도 그건 **내 폴더 안의 하위 폴더**가 될 뿐이다', async () => {
    const res = await fn.handler(post({ op: 'put', path: `${UID_B}/evil.webp` }));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { key: string; url: string };
    expect(j.key).toBe(`${UID_A}/${UID_B}/evil.webp`); // 남의 폴더가 아니라 내 폴더 **아래**
    expect(j.key.startsWith(`${UID_A}/`)).toBe(true);
    expect(j.url).toContain(`/${UID_A}/`);
  });

  it('상위로 올라가려는 접미는 **거부한다**(옛 판은 조용히 무시했다)', async () => {
    for (const bad of ['../../evil.webp', 'a/../b.webp', '/x.webp', 'a/b/c.webp', 'x.txt']) {
      const res = await fn.handler(post({ op: 'put', path: bad }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('bad_media_path');
    }
  });

  it('옛 앱이 mediaId만 보내도 받는다 — 다만 UUID가 아니면 서명하지 않는다', async () => {
    const ok = await fn.handler(post({ op: 'put', mediaId: MID }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { key: string }).key).toBe(`${UID_A}/${MID}.webp`);

    const bad = await fn.handler(post({ op: 'put', mediaId: 'a/../b' }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('bad_media_path');
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
    // 옛 예시는 'list'였다 — 2026-07-26에 실제 op이 되면서 이 검사가 502를 받고 RED가 됐다.
    // 검사가 잡아준 게 맞다: "알 수 없는 op"의 예시는 **실제로 없는 이름**이어야 한다.
    const res = await fn.handler(post({ op: 'exfiltrate', mediaId: MID }));
    expect(res.status).toBe(400);
  });

  it('list는 mediaId 없이도 받는다 — 대신 prefix를 서버가 만든다', async () => {
    // 여기서 502가 나오는 것은 **정상**이다: 인증·op 분기를 통과해 R2 fetch까지 갔고,
    // 이 환경엔 R2가 없어 거기서 멈춘다. 400(bad_media_id)이면 분기가 잘못된 것이다.
    const res = await fn.handler(post({ op: 'list' }));
    expect(res.status).not.toBe(400);
  });

  // "요청 본문의 prefix를 읽지도 않는가"는 **소스 구조**의 불변식이라 게이트가 본다
  // (check-verdict-symmetry의 `listPrefixIsServerBuilt`). 유닛은 런타임 동작만 맡는다.
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

// ── 2026-07-26: 함수가 자기 능력을 정직하게 밝히는가 ────────────────────────
// 왜(사후분석 근본형 B): 클라이언트가 새 필드를 기대하는데 서버에 **옛 함수가 배포돼 있으면**
// 앱은 알 방법이 없어 `?? 0` 방어 코드로 넘어간다 — 그 순간 "0개"와 "모름"이 구분되지 않는다.
// 실제로 그날 그 코드를 썼다. 그래서 함수가 버전과 op 목록을 스스로 밝히게 했다.
describe('함수 능력 선언 — 값의 경계', () => {
  // 선언↔구현 **대칭**은 소스를 읽어야 해서 게이트(`check-edge-fn-ops`)가 맡는다.
  // 여기서는 파일을 안 읽고도 확인할 수 있는 것만 본다(node:fs는 이 검사 설정 밖이다).
  it('버전은 올라가기만 한다(내려가면 클라이언트 판단이 뒤집힌다)', () => {
    expect(fn.FN_VERSION).toBeGreaterThanOrEqual(4);
  });

  it('한 번에 지울 수 있는 개수에 **상한이 있다**(요청 하나가 무한정 길어지지 않게)', () => {
    expect(fn.DELETE_MANY_MAX).toBeGreaterThan(0);
    expect(fn.DELETE_MANY_MAX).toBeLessThanOrEqual(1000);
  });

  it('선언 목록이 비어 있지 않다(비면 클라이언트가 아무것도 못 한다고 판단한다)', () => {
    expect(fn.FN_OPS.length).toBeGreaterThan(0);
  });
});

describe('미완료 멀티파트 — 보이지 않는데 용량을 먹는 것', () => {
  // 2026-07-26 사용자: 버킷 최상위가 **완전히 비었는데** 대시보드는 2.87MB였다.
  // *"설마 휴지통 이런 데 간 거 아님?"* — R2에 휴지통은 없지만 미완료 조각은 그렇게 행동한다.
  const xml = `<?xml version="1.0"?><ListMultipartUploadsResult>
    <Upload><Key>uid-a/photo1.webp</Key><UploadId>ABC123</UploadId></Upload>
    <Upload><Key>uid-b/photo2.webp</Key><UploadId>DEF456</UploadId></Upload>
  </ListMultipartUploadsResult>`;

  it('키와 uploadId를 뽑는다', () => {
    expect(fn.parseMultipartXml(xml)).toEqual([
      { key: 'uid-a/photo1.webp', uploadId: 'ABC123' },
      { key: 'uid-b/photo2.webp', uploadId: 'DEF456' },
    ]);
  });

  it('조각이 없으면 빈 목록이다(없는 것을 지어내지 않는다)', () => {
    expect(fn.parseMultipartXml('<ListMultipartUploadsResult></ListMultipartUploadsResult>')).toEqual([]);
  });

  it('uploadId가 없는 항목은 버린다 — 중단할 수 없는 것을 목록에 넣지 않는다', () => {
    expect(fn.parseMultipartXml('<Upload><Key>a/b.webp</Key></Upload>')).toEqual([]);
  });
});

describe('목록이 **바이트 합계**를 함께 센다', () => {
  // 왜: 앱이 "내 사진 10개 · 2.87MB"를 스스로 말할 수 있어야 대시보드 숫자와 대조할 수 있다.
  // 그게 없어서 사용자가 콘솔을 열고 사진을 찍어 보내야 했다.
  it('Size를 더한다', () => {
    const x = `<ListBucketResult>
      <Contents><Key>a/1.webp</Key><Size>1000</Size></Contents>
      <Contents><Key>a/2.webp</Key><Size>2500</Size></Contents>
    </ListBucketResult>`;
    const p = fn.parseListXml(x);
    expect(p.keys.length).toBe(2);
    expect(p.bytes).toBe(3500);
  });

  it('Size가 없으면 **0으로** 더한다 — 합계를 부풀리지 않는다(거짓 경보 방지)', () => {
    expect(fn.parseListXml('<Contents><Key>a/1.webp</Key></Contents>').bytes).toBe(0);
  });

  it('객체가 없으면 0바이트다', () => {
    expect(fn.parseListXml('<ListBucketResult></ListBucketResult>').bytes).toBe(0);
  });
});
