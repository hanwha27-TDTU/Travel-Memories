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
import diagnosticsSource from '../../src/ui/panels/diagnostics.ts?raw';
import { auditMediaFiles, unionListings } from '../../src/services/storeState';
import {
  storeHeadline,
  storeBecause,
  classifyOrphanFiles,
  classifyMissingFiles,
  fileAuditMetrics,
  blockedByLedgerMetric,
} from '../../src/ui/panels/diagnostics';
import type { Metric } from '../../src/ui/panels/verdict';
import type { Level } from '../../src/ui/panels/verdict';
import { parseListXml, mediaIdOfKey, xmlUnescape, presign, LIST_MAX_PAGES, countOutside } from '../../supabase/functions/media-sign/index';

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

describe('⑥-B **설명 한 줄**이 판정과 같은 것을 말한다 (2026-08-01 사용자 실기기)', () => {
  // 🔴 실제 화면: 판정은 **「✓ 정상 · 살아 있는 기록 40건이 클라우드와 같아요」**인데
  // 바로 밑은 **「사진 기록과 서버 파일이 짝이 맞지 않아요」**. 두 문장이 서로를 부정했다.
  //
  // 원인: 이 문장이 호출부에 삼항으로 박혀 있었고 `fileBad`(**배열**)를 불리언으로 썼다.
  // `fileBadByNoun`은 명사당 한 칸을 돌려주므로 **언제나 참**이다 — 짝이 맞아도 저 문장이 나왔다.
  // 형제인 `storeHeadline`은 처음부터 `f.n > 0`을 세고 있었다(§7 — 같은 자료, 다른 규칙).
  const b = {
    countBad: 0,
    fileBad: [] as { noun: string; n: number }[],
    stranded: 0,
    blocked: 0,
    devices: 1,
    behind: 0,
  };

  it('🔴 짝이 맞으면 **짝 얘기를 하지 않는다** — 배열이 있다는 것만으로 참이 되면 안 된다', () => {
    // 명사 칸은 있는데 어긋난 것은 0 — 사용자가 본 바로 그 상태다.
    const s = storeBecause({ ...b, fileBad: [{ noun: '사진', n: 0 }, { noun: '소리', n: 0 }] });
    expect(s).not.toContain('짝이 맞지 않아요');
    expect(s).toContain('이 기기에서만');
  });

  it('실제로 어긋나면 짝 얘기를 한다', () => {
    const s = storeBecause({ ...b, fileBad: [{ noun: '사진', n: 3 }] });
    expect(s).toContain('짝이 맞지 않아요');
  });

  it('기기가 여럿이면 기기 얘기를 한다(파일이 멀쩡할 때)', () => {
    const s = storeBecause({ ...b, fileBad: [{ noun: '사진', n: 0 }], devices: 2, behind: 1 });
    expect(s).toContain('기기 2대');
    expect(s).toContain('1대는 최신본보다');
  });

  it('가장 무거운 것부터 — 되살리기 거부 > 전파 안 된 삭제 > 파일 (M-0021)', () => {
    expect(storeBecause({ ...b, blocked: 1, stranded: 1, fileBad: [{ noun: '사진', n: 1 }] })).toContain('되살린 기록');
    expect(storeBecause({ ...b, stranded: 1, fileBad: [{ noun: '사진', n: 1 }] })).toContain('서버까지 가지 못했어요');
  });
});

describe('⑥ 판정 문장이 **엉뚱한 곳을 가리키지 않는다** (2026-07-26 사용자 실기기)', () => {
  // 실제로 이렇게 나왔다: 개수 대조는 전부 정상인데 문장이 `클라우드와 다른 항목이 1가지 있어요`.
  // 진짜 문제는 사진 파일이었다. §8의 "판정한다"는 **맞는 것을 판정한다**는 뜻이다 —
  // 엉뚱한 것을 가리키면 관측보다 나쁘다(사용자를 틀린 곳으로 보낸다).
  const base = { level: 'ok' as Level, countBad: 0, fileBad: [] as { noun: string; n: number }[], stranded: 0, blocked: 0, alive: 3, trashed: 0 };
  const photo = (n: number) => [{ noun: '사진', n }];
  const sound = (n: number) => [{ noun: '소리', n }];

  it('사진 파일만 문제면 사진 파일이라고 말한다', () => {
    const h = storeHeadline({ ...base, level: 'problem', fileBad: photo(1) });
    expect(h).toContain('사진 파일');
    expect(h).not.toContain('클라우드와 다른'); // ← 그때 실제로 나온 틀린 문장
  });

  it('개수만 다르면 클라우드 대조라고 말한다', () => {
    const h = storeHeadline({ ...base, level: 'todo', countBad: 2 });
    expect(h).toContain('클라우드와 다른 항목이 2가지');
    expect(h).not.toContain('사진 파일');
  });

  it('둘 다면 둘 다 말한다 — 하나로 뭉뚱그리지 않는다', () => {
    const h = storeHeadline({ ...base, level: 'problem', countBad: 1, fileBad: photo(2) });
    expect(h).toContain('1가지');
    expect(h).toContain('2가지');
  });

  // 🔴 M-0048(2026-07-28 사용자 실기기): 사진은 9:9로 멀쩡한데 배너가 「**사진** 파일에
  // 확인할 것이 1가지 있어요」였다. 어긋난 것은 **소리**였다. 소리를 형제로 들이면서 이
  // 숫자가 소리까지 세게 됐는데 문장만 「사진」으로 못 박혀 있었다(§7 최빈형).
  it('🔴 소리만 문제면 **소리**라고 말한다 — 사진이라 하지 않는다(M-0048)', () => {
    const h = storeHeadline({ ...base, level: 'todo', fileBad: sound(1) });
    expect(h).toContain('소리 파일');
    expect(h).not.toContain('사진'); // ← 실기기에서 실제로 나온 틀린 문장
  });

  it('둘 다 어긋나면 둘 다 이름을 부른다', () => {
    const h = storeHeadline({ ...base, level: 'problem', fileBad: [{ noun: '사진', n: 1 }, { noun: '소리', n: 2 }] });
    expect(h).toContain('사진·소리 파일');
    expect(h).toContain('3가지');
  });

  it('정상인 종류는 문장에서 사라진다(§8 침묵이 정상)', () => {
    const h = storeHeadline({ ...base, level: 'todo', fileBad: [{ noun: '사진', n: 0 }, { noun: '소리', n: 2 }] });
    expect(h).toContain('소리 파일');
    expect(h).not.toContain('사진');
  });

  it('정상도 아닌데 어느 무리도 안 잡히면 **확인 불가**라고 말한다(정상으로 반올림 금지)', () => {
    expect(storeHeadline({ ...base, level: 'unknown' })).toContain('대조하지 못했');
  });

  // 2026-07-26 사용자: *"복원 내용은 앱에는 하나도 없고 서버에만 좀비처럼 살아났어요."*
  // 이건 **자료가 없어지는** 문제라 다른 어떤 것보다 먼저 말해야 한다.
  it('복원이 막혀 있으면 **그걸 제일 먼저** 말한다 — 기억을 잃는 쪽이 1위다', () => {
    const h = storeHeadline({ ...base, level: 'problem', blocked: 4, stranded: 2, countBad: 1, fileBad: photo(3) });
    expect(h).toContain('되살린 기록 4건');
    expect(h).not.toContain('지웠는데');
    expect(h).not.toContain('사진 파일');
  });
});

describe('⑦ 정상일 때 **무엇이 같은지** 말한다 (2026-07-26 사용자 지적)', () => {
  // 사용자: *"클라우드와 동일한 게 아니잖아요? 이미 휴지통으로 자료가 이동했는데."*
  // 옛 문장은 「이 기기는 클라우드와 같습니다」였다. 대조는 맞았지만 **비교한 것이 활성 개수뿐**
  // 이라는 사실을 말하지 않았다. 특히 활성이 양쪽 0일 때가 최악이다 — 0 == 0을 초록 정상으로
  // 칠하면, 자료를 전부 휴지통으로 옮긴 사용자는 자기 자료가 어디 있는지 모른 채 화면을 떠난다.
  const ok = { level: 'ok' as Level, countBad: 0, fileBad: [] as { noun: string; n: number }[], stranded: 0, blocked: 0 };

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

describe('⑧ 기록 없는 사진 파일을 **치울 것과 건드리면 안 될 것**으로 가른다 (2026-07-26 실기기)', () => {
  // 서버 행이 전부 0인데 R2에 파일 3개가 남았다. 영구삭제의 바이트 삭제는 최선노력이라
  // 실패해도 op을 지운다 — 재시도 기회가 없어 잔재가 남는다. 그 잔재와 "설명할 수 없는
  // 파일"은 사용자가 할 일이 **정반대**인데 예전엔 「기록 없는 사진 파일 3개」로 뭉뚱그렸다.
  const A = 'aaaaaaaa-1111-4111-8111-111111111111';
  const B = 'bbbbbbbb-2222-4222-8222-222222222222';
  const C = 'cccccccc-3333-4333-8333-333333333333';

  const none = new Set<string>();

  it('원장에 있으면 **치워도 되는** 잔재다', () => {
    expect(classifyOrphanFiles([A, B], [A, B], none)).toEqual({ leftover: [A, B], restoring: [], unexplained: [] });
  });

  it('원장에 없으면 **지우면 안 된다** — 그 파일이 마지막 사본일 수 있다', () => {
    expect(classifyOrphanFiles([C], [A, B], none)).toEqual({ leftover: [], restoring: [], unexplained: [C] });
  });

  it('섞여 있으면 갈라서 담는다', () => {
    const r = classifyOrphanFiles([A, C], [A, B], none);
    expect(r.leftover).toEqual([A]);
    expect(r.unexplained).toEqual([C]);
  });

  it('고아가 없으면 전부 비어 있다', () => {
    expect(classifyOrphanFiles([], [A], none)).toEqual({ leftover: [], restoring: [], unexplained: [] });
  });

  it('원장이 비면 **아무것도 치울 수 없다**(모르는 것을 지워도 되는 것으로 반올림하지 않는다)', () => {
    expect(classifyOrphanFiles([A, B, C], [], none)).toEqual({
      leftover: [],
      restoring: [],
      unexplained: [A, B, C],
    });
  });

  // 2026-07-26 그날의 두 번째 사고: R2에 남아 있던 파일 10개는 잔재가 아니라 **방금 복원한
  // 사진들**이었는데, 화면은 그걸 「치워도 되는 것」으로 분류하고 정리 버튼까지 내어 줬다.
  it('되살리는 중이면 원장에 있어도 **치울 대상이 아니다** — 그게 되살아날 사진의 바이트다', () => {
    const r = classifyOrphanFiles([A, B], [A, B], new Set([A]));
    expect(r.leftover).toEqual([B]);
    expect(r.restoring).toEqual([A]);
    expect(r.unexplained).toEqual([]);
  });

  it('되살리는 중인 id가 원장에 없으면 여전히 **설명할 수 없는 파일**이다(보호가 분류를 흐리지 않는다)', () => {
    const r = classifyOrphanFiles([C], [], new Set([C]));
    expect(r.leftover).toEqual([]);
    expect(r.restoring).toEqual([]);
    expect(r.unexplained).toEqual([C]);
  });
});

describe('⑧-b 명시적 복원 대기를 안전한 동기화 경로로 안내한다', () => {
  // 왜 문장을 따로 검사하나(§10 ③): M-0022에서 유닛 15건이 전부 통과했는데 화면 문장은 틀렸다.
  // 숫자는 다 맞았고, **화면에 무엇이 나가는지 검사한 것이 하나도 없었다.**
  it('없으면 침묵한다 — 정상은 화면에서 사라진다(§8)', () => {
    const m = blockedByLedgerMetric(0, 0);
    expect(m.level).toBe('ok');
    expect(m.meaning).toBeUndefined();
  });

  it('있으면 이미 보호된 의사와 공용 동기화 경로를 말한다', () => {
    const m = blockedByLedgerMetric(3, 0);
    expect(m.level).toBe('todo');
    expect(m.actual).toBe('3건');
    expect(m.meaning).toContain('안전하게 남아');
    expect(m.meaning).toContain('지금 동기화');
    expect(m.meaning).not.toContain('복원한 항목 되살리기');
  });

  it('지켜 둔 사진 파일이 있으면 **왜 안 치우는지** 말한다', () => {
    expect(blockedByLedgerMetric(3, 10).meaning).toContain('10개');
  });

  it('지켜 둔 파일이 없으면 그 문장을 붙이지 않는다(0개라고 말하지 않는다)', () => {
    expect(blockedByLedgerMetric(3, 0).meaning).not.toContain('0개');
  });

  it('진단 화면은 관측한 로컬 행으로 server unpurge를 직접 만들지 않는다', () => {
    expect(diagnosticsSource).not.toContain('requestUnpurge');
    expect(diagnosticsSource).not.toContain('data-unpurge-restored');
    expect(diagnosticsSource).not.toContain('복원한 항목 되살리기');
  });
});

describe('⑨ **내 폴더 밖**에 무엇이 있는지 앱이 스스로 안다 (2026-07-26 사용자 요청)', () => {
  // 사용자: *"니가 객체목록을 보게 하려면 내가 어케 해야해?"* — 스크린샷을 수백 장 찍고 있었다.
  // 앱의 목록 조회는 `prefix = 내 사용자 id`로 고정이라 「사진 파일 0개」는 *내 폴더 기준*이고
  // "버킷이 비었다"가 아니다. 그 한정을 화면이 말하지 않아 매번 콘솔을 직접 열어야 했다.
  //
  // 잠그는 것: ① 최상위 폴더 목록을 읽는다 ② **개수만** 센다(키는 담지 않는다)
  //           ③ 내 폴더는 빼고 센다 ④ 다 못 봤으면 0이라고 말하지 않는다(호출부 계약).
  const MINE = 'c9ff5188-51a7-4c01-b653-b6e1d73d0790/';
  const xml = (body: string): string => `<?xml version="1.0"?><ListBucketResult>${body}</ListBucketResult>`;

  it('최상위 폴더(CommonPrefixes)를 읽어낸다', () => {
    const p = parseListXml(xml(`<CommonPrefixes><Prefix>${MINE}</Prefix></CommonPrefixes><CommonPrefixes><Prefix>other/</Prefix></CommonPrefixes>`));
    expect(p.prefixes).toEqual([MINE, 'other/']);
  });

  it('내 폴더는 빼고 센다 — 내 것만 있으면 0이다', () => {
    const p = parseListXml(xml(`<CommonPrefixes><Prefix>${MINE}</Prefix></CommonPrefixes>`));
    expect(countOutside(p, MINE)).toBe(0);
  });

  it('남의 폴더가 있으면 개수로 잡는다', () => {
    const p = parseListXml(xml(`<CommonPrefixes><Prefix>${MINE}</Prefix></CommonPrefixes><CommonPrefixes><Prefix>zzz/</Prefix></CommonPrefixes>`));
    expect(countOutside(p, MINE)).toBe(1);
  });

  it('폴더에 안 든 최상위 파일도 센다(예전 테스트 업로드가 여기 남는다)', () => {
    const p = parseListXml(xml(`<Contents><Key>stray.txt</Key></Contents><CommonPrefixes><Prefix>${MINE}</Prefix></CommonPrefixes>`));
    expect(countOutside(p, MINE)).toBe(1);
  });

  it('둘 다 있으면 더한다', () => {
    const p = parseListXml(xml(`<Contents><Key>a.txt</Key></Contents><Contents><Key>b.txt</Key></Contents><CommonPrefixes><Prefix>zzz/</Prefix></CommonPrefixes>`));
    expect(countOutside(p, MINE)).toBe(3);
  });

  it('아무것도 없으면 0이다', () => {
    expect(countOutside(parseListXml(xml('')), MINE)).toBe(0);
  });

  it('최상위가 잘렸으면 다음 토큰이 남는다 — 호출부는 이때 "확인 불가"로 둔다', () => {
    const p = parseListXml(xml('<IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken>'));
    expect(p.nextToken).toBe('t1');
  });

  it('폴더 목록을 읽어도 **키는 남기지 않는다** — 응답에 담는 것은 숫자뿐이다', () => {
    // countOutside의 반환 타입이 number라는 것 자체가 계약이다(키를 흘릴 자리가 없다).
    const p = parseListXml(xml(`<CommonPrefixes><Prefix>secret-user-id/</Prefix></CommonPrefixes>`));
    expect(typeof countOutside(p, MINE)).toBe('number');
  });
});


describe('🔴 ⑩ 파일이 없는 기록 — **「없다」고 말하기 전에 이 기기를 찾아본다** (M-0046)', () => {
  // 2026-07-28 사용자 실기기: 화면이 「지운 소리의 남은 기록 3개 · 소리 자체는 없습니다」라며
  // 정리를 권했다. **로컬 휴지통에 그대로 있었다.** 그 버튼(purgeServerOnly)은 로컬 행까지
  // 지우므로, 따랐으면 되살릴 수 있던 녹음 20초가 영구히 사라졌다.
  //
  // 가르는 질문은 tombstone 여부가 아니라 **사본이 있는가**다. 그 순서를 여기서 못박는다.
  const A = 'aaaaaaaa-1111-4111-8111-111111111111';
  const B = 'bbbbbbbb-2222-4222-8222-222222222222';
  const C = 'cccccccc-3333-4333-8333-333333333333';
  const none = new Set<string>();

  it('🔴 사본이 있으면 tombstone이어도 **다시 올릴 것**이다(치울 것이 아니다)', () => {
    const r = classifyMissingFiles([A], [A], new Set([A]), 0);
    expect(r.recoverable).toEqual([A]);
    expect(r.clearable).toEqual([]); // ← 예전엔 여기 들어가서 "정리하세요"가 나왔다
  });

  it('사본이 없고 서버에서도 지워졌으면 그때만 **치울 것**이다', () => {
    expect(classifyMissingFiles([A], [A], none, 0)).toEqual({ recoverable: [], clearable: [A], atRisk: [] });
  });

  it('사본도 없는데 살아 있으면 **위험**이다 — 어디에도 없을 수 있다', () => {
    expect(classifyMissingFiles([B], [], none, 0)).toEqual({ recoverable: [], clearable: [], atRisk: [B] });
  });

  it('🔴 사본이 있으면 활성이어도 위험이 아니다 — 앱이 스스로 고칠 수 있다(§12)', () => {
    const r = classifyMissingFiles([B], [], new Set([B]), 0);
    expect(r.atRisk).toEqual([]);
    expect(r.recoverable).toEqual([B]);
  });

  it('셋이 섞여도 갈라 담는다(한 숫자로 합치지 않는다)', () => {
    const r = classifyMissingFiles([A, B, C], [A], new Set([C]), 0);
    expect(r).toEqual({ recoverable: [C], clearable: [A], atRisk: [B] });
  });

  it('빠진 것이 없으면 전부 비어 있다', () => {
    expect(classifyMissingFiles([], [A], new Set([A]), 0)).toEqual({ recoverable: [], clearable: [], atRisk: [] });
  });
});

describe('🔴 ⑪ 화면 문장이 사본 유무를 **정직하게** 말한다 (§10 ③)', () => {
  const A = 'aaaaaaaa-1111-4111-8111-111111111111';
  const audit = (localBytes: Set<string>, tombstoned: string[], otherDevices = 0) =>
    fileAuditMetrics({
      noun: '소리',
      fa: { files: 0, rows: 1, orphans: [], missing: [A], foreign: 0, truncated: false },
      note: null,
      serverPurged: [],
      serverTombstoned: tombstoned,
      restorePending: new Set<string>(),
      localBytes,
      otherDevices,
    });
  const find = (ms: Metric[], label: string): Metric => ms.find((m) => m.label === label)!;

  it('🔴 사본이 있으면 「자료가 없다」고 말하지 않는다 — 그 문장이 거짓말이었다', () => {
    const r = audit(new Set([A]), [A]);
    const dead = find(r.metrics, '지운 소리의 남은 기록');
    expect(dead.actual).toBe('0개');
    expect(dead.level).toBe('ok');
    const safe = find(r.metrics, '서버에 없는 소리');
    expect(safe.actual).toBe('1개');
    expect(safe.meaning).toContain('이 기기에는 그대로 있어요');
    expect(safe.meaning).not.toContain('없습니다');
  });

  it('🔴 정리를 권하는 문장은 **찾아봤다는 사실**을 함께 말한다', () => {
    const dead = find(audit(new Set(), [A]).metrics, '지운 소리의 남은 기록');
    expect(dead.level).toBe('todo');
    expect(dead.meaning).toContain('사본이 어디에도 없습니다');
  });

  // 🔴 M-0048(2026-07-28 사용자 실기기 · 두 기기 스크린샷): **같은 3건이 기기마다 정반대
  // 판정**을 받았다. 사본을 가진 태블릿은 「자료는 안전합니다」, 없는 폴드5는 「치우세요」.
  // 폴드5의 조언을 따랐으면 서버 원장 + 트리거 때문에 **태블릿의 사본까지** 못 되살린다.
  // 「이 기기에 없다」에서 「없다」로 건너뛰지 않는 것을 여기서 못박는다.
  it('🔴 다른 기기가 있으면 「치우세요」라고 하지 않는다 — 거기 사본이 있을 수 있다', () => {
    const r = audit(new Set(), [A], 1);
    expect(r.clearable).toEqual([]); // ← 예전엔 [A]였고 파괴적 버튼이 떴다
    const dead = find(r.metrics, '지운 소리의 남은 기록');
    expect(dead.actual).toBe('0개');
    expect(dead.level).toBe('ok');
  });

  it('🔴 그 대신 **다른 기기를 보라고** 말한다(막다른 문장으로 끝내지 않는다)', () => {
    const risk = find(audit(new Set(), [A], 1).metrics, '소리 파일이 사라진 기록');
    expect(risk.actual).toBe('1개');
    expect(risk.meaning).toContain('다른 기기');
    expect(risk.meaning).toContain('2대');
    expect(risk.meaning).toContain('서버에 없는 자료 다시 올리기');
  });

  it('기기가 이 기기뿐이면 예전대로 치울 수 있다(과보호로 막다른 길을 만들지 않는다)', () => {
    expect(audit(new Set(), [A], 0).clearable).toEqual([A]);
  });

  it('사본이 있으면 다시 올릴 목록에 담긴다(버튼이 그것을 받는다)', () => {
    expect(audit(new Set([A]), [A]).recoverable).toEqual([A]);
    expect(audit(new Set(), [A]).recoverable).toEqual([]);
  });

  it('목록이 잘렸으면 아무것도 단정하지 않는다', () => {
    const r = fileAuditMetrics({
      noun: '소리',
      fa: { files: 0, rows: 1, orphans: [], missing: [A], foreign: 0, truncated: true },
      note: null,
      serverPurged: [],
      serverTombstoned: [A],
      restorePending: new Set<string>(),
      localBytes: new Set([A]),
      otherDevices: 0,
    });
    expect(find(r.metrics, '서버에 없는 소리').actual).toBe('확인 못 함');
    expect(r.recoverable).toEqual([]);
  });
});
