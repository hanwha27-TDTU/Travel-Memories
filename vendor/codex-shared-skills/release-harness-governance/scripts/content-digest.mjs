import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const TEXT_EXTENSIONS = new Set([
  '.bat', '.cmd', '.css', '.html', '.ini', '.js', '.json', '.jsx', '.md', '.mjs',
  '.ps1', '.sh', '.svg', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
]);

export function canonicalBytes(path, bytes = readFileSync(path)) {
  if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase())) return bytes;
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return bytes;
  return Buffer.from(text.replaceAll('\r\n', '\n'), 'utf8');
}

function filesUnder(base, current = base) {
  const out = [];
  for (const name of readdirSync(current).sort()) {
    const path = join(current, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(base, path));
    else out.push(path);
  }
  return out;
}

export function digestDirectory(path) {
  const hash = createHash('sha256');
  for (const file of filesUnder(path)) {
    hash.update(relative(path, file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(canonicalBytes(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function digestFile(path) {
  return createHash('sha256').update(canonicalBytes(path)).digest('hex');
}

function digestBytes(path, textOrBytes) {
  return createHash('sha256').update(canonicalBytes(path, Buffer.from(textOrBytes))).digest('hex');
}

function selfTest() {
  const lf = digestBytes('contract.md', '한 줄\n두 줄\n');
  const crlf = digestBytes('contract.md', '한 줄\r\n두 줄\r\n');
  if (lf !== crlf) throw new Error('줄바꿈 대조군 실패: LF와 CRLF가 다른 내용 해시다');
  if (lf === digestBytes('contract.md', '한 줄\n다른 내용\n')) throw new Error('문자 변조 대조군 실패: 실제 내용 변경이 같은 해시다');
  const binaryA = digestBytes('asset.bin', Buffer.from([0, 13, 10, 255]));
  const binaryB = digestBytes('asset.bin', Buffer.from([0, 10, 255]));
  if (binaryA === binaryB) throw new Error('바이너리 대조군 실패: 원바이트 변조가 같은 해시다');
  console.log('✅ 내용 해시 주입증명 3축 — LF/CRLF 동일 · 문자 변조 적색 · 바이너리 변조 적색.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--self-test') selfTest();
