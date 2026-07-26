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
import { storeHeadline } from '../../src/ui/panels/diagnostics';
import type { Level } from '../../src/ui/panels/verdict';
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

describe('⑥ 판정 문장이 **엉뚱한 곳을 가리키지 않는다** (2026-07-26 사용자 실기기)', () => {
  // 실제로 이렇게 나왔다: 개수 대조는 전부 정상인데 문장이 `클라우드와 다른 항목이 1가지 있어요`.
  // 진짜 문제는 사진 파일이었다. §8의 "판정한다"는 **맞는 것을 판정한다**는 뜻이다 —
  // 엉뚱한 것을 가리키면 관측보다 나쁘다(사용자를 틀린 곳으로 보낸다).
  const base = { level: 'ok' as Level, countBad: 0, fileBad: 0, stranded: 0, alive: 3, trashed: 0 };

  it('사진 파일만 문제면 사진 파일이라고 말한다', () => {
    const h = storeHeadline({ ...base, level: 'problem', fileBad: 1 });
    expect(h).toContain('사진 파일');
    expect(h).not.toContain('클라우드와 다른'); // ← 그때 실제로 나온 틀린 문장
  });

  it('개수만 다르면 클라우드 대조라고 말한다', () => {
    const h = storeHeadline({ ...base, level: 'todo', countBad: 2 });
    expect(h).toContain('클라우드와 다른 항목이 2가지');
    expect(h).not.toContain('사진 파일');
  });

  it('둘 다면 둘 다 말한다 — 하나로 뭉뚱그리지 않는다', () => {
    const h = storeHeadline({ ...base, level: 'problem', countBad: 1, fileBad: 2 });
    expect(h).toContain('1가지');
    expect(h).toContain('2가지');
  });

  it('정상도 아닌데 어느 무리도 안 잡히면 **확인 불가**라고 말한다(정상으로 반올림 금지)', () => {
    expect(storeHeadline({ ...base, level: 'unknown' })).toContain('대조하지 못했');
  });
});

describe('⑦ 정상일 때 **무엇이 같은지** 말한다 (2026-07-26 사용자 지적)', () => {
  // 사용자: *"클라우드와 동일한 게 아니잖아요? 이미 휴지통으로 자료가 이동했는데."*
  // 옛 문장은 「이 기기는 클라우드와 같습니다」였다. 대조는 맞았지만 **비교한 것이 활성 개수뿐**
  // 이라는 사실을 말하지 않았다. 특히 활성이 양쪽 0일 때가 최악이다 — 0 == 0을 초록 정상으로
  // 칠하면, 자료를 전부 휴지통으로 옮긴 사용자는 자기 자료가 어디 있는지 모른 채 화면을 떠난다.
  const ok = { level: 'ok' as Level, countBad: 0, fileBad: 0, stranded: 0 };

  it('살아 있는 기록이 있으면 **그 개수와 함께** 같다고 말한다', () => {
    const h = storeHeadline({ ...ok, alive: 12, trashed: 0 });
    expect(h).toContain('12건');
    expect(h).toContain('클라우드와 같');
  });

  it('활성 0 + 휴지통 있음 → **자료가 어디 있는지** 말한다(그냥 "같습니다"라고 하지 않는다)', () => {
    const h = storeHeadline({ ...ok, alive: 0, trashed: 13 });
    expect(h).toContain('휴지통');
    expect(h).toContain('13건');
    expect(h).not.toBe('이 기기는 클라우드와 같습니다'); // ← 사용자가 지적한 그 문장
  });

  it('활성 0 + 휴지통 0 → 빈 앱이라고 말한다(같다고 자랑하지 않는다)', () => {
    expect(storeHeadline({ ...ok, alive: 0, trashed: 0 })).toBe('아직 기록이 없어요');
  });

  it('휴지통이 있어도 살아 있는 기록이 있으면 그쪽을 먼저 말한다', () => {
    const h = storeHeadline({ ...ok, alive: 5, trashed: 13 });
    expect(h).toContain('5건');
  });

  it('정상이 아니면 활성/휴지통 문구가 끼어들지 않는다', () => {
    const h = storeHeadline({ ...ok, level: 'todo', countBad: 1, alive: 0, trashed: 13 });
    expect(h).not.toContain('휴지통');
  });
});
