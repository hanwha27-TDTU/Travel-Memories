import { describe, it, expect } from 'vitest';
import { buildChain, verifyChain, anchorHash, GENESIS, type ChainInput } from '../../src/app/hashchain';
import { RESEARCH_LOG } from '../../src/app/researchLog';

const sample: ChainInput[] = [
  { seq: 1, date: '2026-07-23', topic: 'a', human: 'h1', ai: 'a1', decision: 'd1' },
  { seq: 2, date: '2026-07-23', topic: 'b', human: 'h2', ai: 'a2', decision: 'd2' },
];

describe('hashchain', () => {
  it('첫 링크는 GENESIS를 prevHash로 갖고 이후는 앞 해시로 연결된다', async () => {
    const links = await buildChain(sample);
    expect(links[0]!.prevHash).toBe(GENESIS);
    expect(links[1]!.prevHash).toBe(links[0]!.hash);
    expect(links[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('빌드한 체인은 검증을 통과한다', async () => {
    const links = await buildChain(sample);
    expect(await verifyChain(links)).toBe(true);
  });

  it('항목 내용을 변조하면 검증이 실패한다(비공허)', async () => {
    const links = await buildChain(sample);
    links[0]!.input.decision = '변조됨';
    expect(await verifyChain(links)).toBe(false);
  });

  it('해시를 바꾸면 다음 링크 연결이 끊겨 실패한다', async () => {
    const links = await buildChain(sample);
    links[0]!.hash = 'f'.repeat(64);
    expect(await verifyChain(links)).toBe(false);
  });

  it('앵커 해시는 마지막 링크 해시다', async () => {
    const links = await buildChain(sample);
    expect(anchorHash(links)).toBe(links[links.length - 1]!.hash);
  });

  it('실제 연구노트 로그는 seq가 1부터 연속이고 체인이 유효하다', async () => {
    RESEARCH_LOG.forEach((e, i) => expect(e.seq).toBe(i + 1));
    const links = await buildChain(RESEARCH_LOG);
    expect(await verifyChain(links)).toBe(true);
  }, 15_000); // build+verify는 체인 정의상 순차 SHA-256이므로 로그 규모에 맞는 상한을 둔다.
});
