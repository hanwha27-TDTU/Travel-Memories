// services/backupCrypto.ts — 백업 파일의 선택적 암호화(WebCrypto, 의존성 0).
//
// 왜: 백업(JSON/ZIP)은 사진·메모 등 개인자료를 평문으로 담는다(§3 비공개 기본). 사용자가 원하면
// 암호구절로 봉투 암호화해, 파일이 새어도 암호구절 없이는 열 수 없게 한다. 키는 저장하지 않는다
// (암호구절은 사용자만 보유 — 분실 시 복원 불가라 UI에서 명확히 경고).
//
// 봉투 형식(바이트): MAGIC(8) || salt(16) || iv(12) || ciphertext(GCM, 인증태그 포함).
//  - MAGIC로 암호화 여부를 자동 감지(ZIP의 PK, JSON의 {와 겹치지 않음).
//  - PBKDF2(SHA-256, 210k) 키유도 + AES-GCM-256. salt·iv는 매 백업 무작위.

const MAGIC = new Uint8Array([0x42, 0x47, 0x4a, 0x45, 0x4e, 0x43, 0x31, 0x0a]); // "BGJENC1\n"
const SALT_LEN = 16;
const IV_LEN = 12;
const PBKDF2_ITERS = 210_000;

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('이 브라우저는 백업 암호화를 지원하지 않습니다(WebCrypto 없음).');
  return c.subtle;
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** 첫 바이트가 암호화 봉투(MAGIC)인지. import 자동 감지용. */
export function isEncryptedEnvelope(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i += 1) if (bytes[i] !== MAGIC[i]) return false;
  return true;
}

/** plaintext 바이트 → 암호화 봉투 바이트. */
export async function encryptBytes(plain: Uint8Array<ArrayBuffer>, passphrase: string): Promise<Uint8Array<ArrayBuffer>> {
  if (!passphrase) throw new Error('암호구절이 비어 있습니다.');
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(passphrase, salt);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, plain));

  const out = new Uint8Array(MAGIC.length + SALT_LEN + IV_LEN + ct.length);
  out.set(MAGIC, 0);
  out.set(salt, MAGIC.length);
  out.set(iv, MAGIC.length + SALT_LEN);
  out.set(ct, MAGIC.length + SALT_LEN + IV_LEN);
  return out;
}

/** 암호화 봉투 바이트 → plaintext 바이트. 암호가 틀리면 throw. */
export async function decryptBytes(envelope: Uint8Array<ArrayBuffer>, passphrase: string): Promise<Uint8Array<ArrayBuffer>> {
  if (!isEncryptedEnvelope(envelope)) throw new Error('암호화된 백업 봉투가 아닙니다.');
  const salt = envelope.slice(MAGIC.length, MAGIC.length + SALT_LEN) as Uint8Array<ArrayBuffer>;
  const iv = envelope.slice(MAGIC.length + SALT_LEN, MAGIC.length + SALT_LEN + IV_LEN);
  const ct = envelope.slice(MAGIC.length + SALT_LEN + IV_LEN);
  const key = await deriveKey(passphrase, salt);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv }, key, ct));
  } catch {
    throw new Error('암호가 올바르지 않거나 파일이 손상되었습니다.');
  }
}
