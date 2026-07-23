// app/hashchain.ts — SHA-256 해시체인(append-only) 계산·검증.
//
// 목적(정직성·§4): "법적 보증"이 아니라 특허 검토용 구조화 증거 로그다. 각 항목을 이전 항목의
// 해시에 묶어 체인을 만들면, 마지막 앵커 해시를 외부에 기록해 둔 뒤 이후 위·변조를 감지할 수 있다.
// 데이터 자체는 코드(SSOT)이고, 해시는 런타임에 Web Crypto(crypto.subtle)로 계산한다.
// crypto.subtle은 보안 컨텍스트(HTTPS·localhost)에서만 동작한다 — 미지원 시 우아하게 안내.

/** 체인 시작 앵커(제네시스). */
export const GENESIS = '0'.repeat(64);

export interface ChainInput {
  seq: number;
  date: string;
  topic: string;
  human: string;
  ai: string;
  decision: string;
}

export interface ChainLink {
  input: ChainInput;
  prevHash: string;
  hash: string;
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 결정론적 직렬화(키 순서 고정) — 해시 재현성을 위해 필드 순서를 명시한다. */
function canonical(input: ChainInput): string {
  return JSON.stringify([input.seq, input.date, input.topic, input.human, input.ai, input.decision]);
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return toHex(buf);
}

/** 지원 여부(보안 컨텍스트 + subtle 존재). */
export function hashchainSupported(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle && typeof crypto.subtle.digest === 'function';
}

/** 입력들을 순서대로 해시체인으로 묶는다(각 hash = SHA256(prevHash | canonical)). */
export async function buildChain(inputs: ChainInput[]): Promise<ChainLink[]> {
  const links: ChainLink[] = [];
  let prev = GENESIS;
  for (const input of inputs) {
    const hash = await sha256Hex(`${prev}|${canonical(input)}`);
    links.push({ input, prevHash: prev, hash });
    prev = hash;
  }
  return links;
}

/** 체인 내부 정합성 검증: 각 링크가 prevHash와 자기 입력으로 재계산한 해시와 일치하고,
 *  링크 간 prevHash 연결이 끊기지 않았는지 확인. 하나라도 어긋나면 false. */
export async function verifyChain(links: ChainLink[]): Promise<boolean> {
  let prev = GENESIS;
  for (const link of links) {
    if (link.prevHash !== prev) return false;
    const expected = await sha256Hex(`${prev}|${canonical(link.input)}`);
    if (expected !== link.hash) return false;
    prev = link.hash;
  }
  return true;
}

/** 마지막 앵커 해시(체인 전체를 대표). 빈 체인이면 GENESIS. */
export function anchorHash(links: ChainLink[]): string {
  return links.length > 0 ? links[links.length - 1]!.hash : GENESIS;
}
