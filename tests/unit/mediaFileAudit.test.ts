// tests/unit/mediaFileAudit.test.ts — 서버 사진 기록↔파일 대조(2026-07-26 신설).
//
// 왜 이 검사가 있는가: 지금까지 "R2에 고아 파일이 남았나"를 확인하는 유일한 방법이 **사용자가
// Cloudflare 콘솔을 열어 캡처해 주는 것**이었다. §8("진단 도구는 관측이 아니라 판정을 한다")에
// 어긋난다 — 앱이 스스로 말할 수 있는 일을 사람이 대신했다.
//
// 이 검사가 잠그는 것:
//  ① 두 방향을 **섞지 않는다** — 고아 파일(용량만 먹음)과 없는 파일(기억 손실 위험)은 성격이
//     완전히 다르다. 한 숫자로 합치면 사용자가 할 일이 정반대인 둘이 같은 줄에 온다.
//  ② **목록이 잘렸으면 "없다"고 말하지 않는다** — 뒤쪽 페이지에 있을 수 있다. 모르는 것을
//     정상으로도 문제로도 반올림하지 않는다(비타협 원칙 #4).
//  ③ 목록 XML 파싱 — 서명과 달리 이건 이 환경에서 실제로 증명할 수 있는 층이다.
//  ④ 목록 prefix는 **검증된 sub에서만** 나온다(supabase-security-dev §2.8).

import { describe, it, expect } from 'vitest';
import { auditMediaFiles, unionListings } from '../../src/services/storeState';
import { parseListXml, mediaIdOfKey, xmlUnescape, presign, LIST_MAX_PAGES } from '../../supabase/functions/media-sign/index';

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const C = 'cccccccc-3333-4333-8333-333333333333';

describe('① 두 방향을 섞지 않는다', () => {
  it('짝이 맞으면 양쪽 다 0', () => {
    const r = auditMediaFiles([A, B], [A, B]);
    expect(r.orphans).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.files).toBe(2);
    expect(r.rows).toBe(2);
  });

  it('기록 없는 파일 = 고아(용량만 먹음)', () => {
    const r = auditMediaFiles([A, B], [A]);
    expect(r.orphans).toEqual([B]);
    expect(r.missing).toEqual([]);
  });

  it('파일 없는 기록 = 기억 손실 위험(반대 방향)', () => {
    const r = auditMediaFiles([A], [A, B]);
    expect(r.orphans).toEqual([]);
    expect(r.missing).toEqual([B]);
  });

  it('양쪽이 동시에 있어도 각자 잡힌다 — 상쇄되지 않는다', () => {
    const r = auditMediaFiles([A, B], [A, C]);
    expect(r.orphans).toEqual([B]);
    expect(r.missing).toEqual([C]);
  });

  it('중복은 개수를 부풀리지 않는다(집합으로 센다)', () => {
    const r = auditMediaFiles([A, A, A], [A]);
    expect(r.files).toBe(1);
    expect(r.orphans).toEqual([]);
  });
});

describe('② 목록이 잘렸으면 단정하지 않는다', () => {
  it('truncated면 missing을 비운다 — 뒤쪽 페이지에 있을 수 있다', () => {
    const r = auditMediaFiles([A], [A, B, C], { truncated: true });
    expect(r.truncated).toBe(true);
    expect(r.missing).toEqual([]); // "없다"고 말하지 않는다
  });

  it('truncated여도 고아는 확실하다 — 본 파일에 기록이 없는 건 사실이다', () => {
    const r = auditMediaFiles([A, B], [A], { truncated: true });
    expect(r.orphans).toEqual([B]);
  });

  it('형식 밖 키 개수를 조용히 버리지 않는다', () => {
    expect(auditMediaFiles([A], [A], { foreign: 3 }).foreign).toBe(3);
  });
});

describe('③ ListObjectsV2 응답 파싱', () => {
  const page = (keys: string[], next?: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Name>travel-log-media</Name><Prefix>u/</Prefix>
<IsTruncated>${next ? 'true' : 'false'}</IsTruncated>
${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}
${keys.map((k) => `<Contents><Key>${k}</Key><Size>1234</Size><ETag>&quot;x&quot;</ETag></Contents>`).join('\n')}
</ListBucketResult>`;

  it('키를 전부 뽑는다', () => {
    const r = parseListXml(page([`u/${A}.webp`, `u/${B}.webp`]));
    expect(r.keys).toEqual([`u/${A}.webp`, `u/${B}.webp`]);
    expect(r.nextToken).toBeNull();
  });

  it('다음 페이지 토큰을 읽는다', () => {
    expect(parseListXml(page([`u/${A}.webp`], 'TOK123')).nextToken).toBe('TOK123');
  });

  it('빈 버킷은 키 0개 — 오류가 아니다', () => {
    expect(parseListXml(page([])).keys).toEqual([]);
  });

  it('IsTruncated가 false면 토큰이 있어도 무시한다(끝났다는 뜻)', () => {
    const xml = page([`u/${A}.webp`]).replace('</ListBucketResult>', '<NextContinuationToken>X</NextContinuationToken></ListBucketResult>');
    expect(parseListXml(xml).nextToken).toBeNull();
  });

  it('XML 엔티티를 되돌린다', () => {
    expect(xmlUnescape('a&amp;b&lt;c&gt;d&quot;e&apos;f')).toBe(`a&b<c>d"e'f`);
  });

  it('키에서 mediaId만 뽑고 폴더(uid)는 버린다', () => {
    expect(mediaIdOfKey(`someuser/${A}.webp`)).toBe(A);
  });

  it('우리 형식이 아니면 null — 조용히 통과시키지 않는다', () => {
    expect(mediaIdOfKey('u/notauuid.webp')).toBeNull();
    expect(mediaIdOfKey('u/readme.txt')).toBeNull();
    expect(mediaIdOfKey('')).toBeNull();
  });

  it('페이지 상한이 유한하다 — 무한 루프가 구조적으로 불가능', () => {
    expect(LIST_MAX_PAGES).toBeGreaterThan(0);
    expect(Number.isFinite(LIST_MAX_PAGES)).toBe(true);
  });
});

describe('④ 목록 서명의 범위는 서버가 못박는다 (supabase-security-dev §2.8)', () => {
  const env = { accountId: 'acct', bucket: 'travel-log-media', accessKeyId: 'AK', secretAccessKey: 'SK' };
  const at = Date.UTC(2026, 6, 26, 0, 0, 0);

  it('prefix가 서명에 들어간다 — 중간에서 바꿔치기하면 서명이 깨진다', async () => {
    const url = await presign(env, 'GET', '', at, [
      ['list-type', '2'],
      ['prefix', `${A}/`],
    ]);
    expect(url).toContain('prefix=');
    expect(url).toContain(encodeURIComponent(`${A}/`).replace(/%2F/g, '%2F'));
    expect(url).toContain('X-Amz-Signature=');
  });

  it('prefix가 다르면 서명도 다르다(서명이 범위를 실제로 묶는다)', async () => {
    const mk = (p: string): Promise<string> =>
      presign(env, 'GET', '', at, [
        ['list-type', '2'],
        ['prefix', p],
      ]);
    const sig = (u: string): string => u.split('X-Amz-Signature=')[1] ?? '';
    expect(sig(await mk(`${A}/`))).not.toBe(sig(await mk(`${B}/`)));
  });

  it('key가 비면 버킷 자체를 가리킨다(객체 경로가 붙지 않는다)', async () => {
    const url = await presign(env, 'GET', '', at, [['list-type', '2']]);
    expect(url).toContain('/travel-log-media?');
    expect(url).not.toContain('.webp');
  });

  it('단건 서명은 예전 그대로 — 객체 경로가 붙는다(회귀 방지)', async () => {
    const url = await presign(env, 'GET', `${A}/${B}.webp`, at);
    expect(url).toContain(`/travel-log-media/${A}/${B}.webp?`);
  });

  it('비밀값이 URL에 나오지 않는다', async () => {
    const url = await presign(env, 'GET', '', at, [['list-type', '2']]);
    expect(url).not.toContain('SK');
  });
});

describe('⑤ 저장소가 둘이다 — 합집합 규칙 (2026-07-26 실측에서 나왔다)', () => {
  // 실측: 서버 사진 기록 13건 중 9건이 R2 버킷이 생기기 **전**에 만들어졌다. 그 바이트는
  // 여전히 Supabase Storage에 있다(HANDOFF Phase 9c의 "혼재 상태"). R2만 훑고 판정하면
  // 멀쩡한 사진 여러 장이 '파일 없음'으로 잡히는 **거짓 경보**가 된다 — M-0008의 재판.
  it('두 저장소의 id를 합친다(중복 제거)', () => {
    const r = unionListings([{ ids: [A, B] }, { ids: [B, C] }]);
    expect([...(r.ids ?? [])].sort()).toEqual([A, B, C].sort());
    expect(r.error).toBeUndefined();
  });

  it('옛 저장소에만 있는 사진은 고아가 아니다(거짓 경보 방지)', () => {
    const files = unionListings([{ ids: [A] }, { ids: [B] }]); // R2에 A, 옛 저장소에 B
    const audit = auditMediaFiles(files.ids, [A, B]);
    expect(audit.missing).toEqual([]); // B를 "파일 없음"이라 하면 거짓말이다
  });

  it('한쪽이라도 못 읽으면 **합집합 전체를 버린다** — 부분 정보는 거짓말이 된다', () => {
    const r = unionListings([{ ids: [A, B] }, { ids: [], error: '조회 실패' }]);
    expect(r.error).toBe('조회 실패');
    expect(r.ids).toEqual([]); // 읽은 쪽 id만 들고 판정하면 나머지가 전부 '없음'이 된다
  });

  it('잘림은 **전파된다** — 한 곳만 잘려도 전체가 잘린 것이다', () => {
    expect(unionListings([{ ids: [A] }, { ids: [B], truncated: true }]).truncated).toBe(true);
  });

  it('형식 밖 키 개수는 더해진다', () => {
    expect(unionListings([{ ids: [], foreign: 2 }, { ids: [], foreign: 3 }]).foreign).toBe(5);
  });
});
