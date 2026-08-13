// 대용량 ZIP 복원의 메모리 증폭을 production 경로로 재는 재현 스크립트 (T-030).
//
// 각 표본은 별도 프로세스에서 생성하고 다시 별도 프로세스에서 읽는다. 생성 때 잡은
// ArrayBuffer가 import baseline에 섞이지 않게 하기 위해서다. 측정 프로세스는 실제 UI와 같이
// 파일 전체를 ArrayBuffer로 만든 뒤 importBackupAuto()를 호출하고, 동기 ZIP 해제가 끝나
// Promise가 반환된 바로 그 지점과 Dexie 병합 뒤의 RSS/ArrayBuffer를 기록한다.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { createServer } from 'vite';

const DISPLAY_BYTES = 660 * 1024; // media/compress.ts의 12MP 실측 표시본(~0.66MB)
const THUMB_BYTES = 32 * 1024; // 320px WebP를 보수적으로 둔 재현 fixture
const DEFAULT_COUNTS = [50, 200, 500];

function mib(bytes) {
  return Math.round((bytes / 1024 ** 2) * 10) / 10;
}

function snapshot(stage) {
  const m = process.memoryUsage();
  return {
    stage,
    rssMiB: mib(m.rss),
    heapUsedMiB: mib(m.heapUsed),
    externalMiB: mib(m.external),
    arrayBuffersMiB: mib(m.arrayBuffers),
    maxRssMiB: mib(process.resourceUsage().maxRSS * 1024),
  };
}

function forceGc() {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    globalThis.gc();
  }
}

function seededBytes(length, seed) {
  const bytes = new Uint8Array(length);
  let value = seed | 0;
  for (let i = 0; i < length; i += 1) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    bytes[i] = value & 0xff;
  }
  return bytes;
}

async function loadBackupModule() {
  const vite = await createServer({
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true },
  });
  try {
    return { vite, backup: await vite.ssrLoadModule('/src/services/backup.ts') };
  } catch (error) {
    await vite.close();
    throw error;
  }
}

function fixtureRows(count) {
  const at = '2026-08-13T00:00:00.000Z';
  const trip = {
    id: 'memory-trip', title: `메모리 표본 ${count}장`, startDate: '2026-08-13', endDate: '2026-08-13',
    status: 'completed', createdAt: at, updatedAt: at, version: 1, deletedAt: null,
  };
  const moment = {
    id: 'memory-moment', tripId: trip.id, occurredAt: at, title: '메모리 표본', note: '', emotion: '',
    placeName: '', placeLat: null, placeLng: null, createdAt: at, updatedAt: at, version: 1, deletedAt: null,
  };
  const media = Array.from({ length: count }, (_, index) => ({
    // ZIP 이름은 id 앞 8자를 쓰므로 그 안에서 반드시 유일해야 한다.
    id: `p${String(index).padStart(7, '0')}-memory-photo`,
    momentId: moment.id,
    tripId: trip.id,
    mime: 'image/webp',
    // 사진마다 다른 고엔트로피 바이트를 써 OS 메모리 압축/중복제거가 물리 RSS를
    // 낙관적으로 보이게 하지 않는다. ZIP은 store라 논리 크기는 내용과 무관하다.
    displayBlob: new Blob([seededBytes(DISPLAY_BYTES, index + 1)], { type: 'image/webp' }),
    thumbBlob: new Blob([seededBytes(THUMB_BYTES, index + 100_001)], { type: 'image/webp' }),
    width: 1600,
    height: 1200,
    takenAt: at,
    gpsLat: null,
    gpsLng: null,
    sortOrder: index,
    bytesOriginal: DISPLAY_BYTES,
    bytesDisplay: DISPLAY_BYTES,
    version: 1,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    clientOperationId: `memory-op-${index}`,
  }));
  return { trips: [trip], moments: [moment], media, expenses: [], audio: [], videos: [], places: [] };
}

async function generate(count, output) {
  const { vite, backup } = await loadBackupModule();
  try {
    const blob = await backup.serializeZip(fixtureRows(count), false);
    await writeFile(output, new Uint8Array(await blob.arrayBuffer()));
    process.stdout.write(`${JSON.stringify({ state: 'generated', count, zipMiB: mib(blob.size) })}\n`);
  } finally {
    await vite.close();
  }
}

async function measure(count, inputPath) {
  await import('fake-indexeddb/auto');
  const { vite, backup } = await loadBackupModule();
  try {
    forceGc();
    const stages = [snapshot('clean')];

    let diskBytes = await readFile(inputPath);
    const input = diskBytes.byteOffset === 0 && diskBytes.byteLength === diskBytes.buffer.byteLength
      ? diskBytes.buffer
      : diskBytes.buffer.slice(diskBytes.byteOffset, diskBytes.byteOffset + diskBytes.byteLength);
    diskBytes = null;
    forceGc();
    stages.push(snapshot('file-array-buffer'));

    // importBackupAuto는 ZIP 파싱을 첫 await 전에 동기로 끝낸다. Promise를 받은 직후가
    // 원본 ArrayBuffer + view 복사 + 엔트리 복사 + 재구성 Blob이 함께 살아 있는 지점이다.
    const pending = backup.importBackupAuto(input);
    stages.push(snapshot('zip-deserialized'));
    const result = await pending;
    stages.push(snapshot('dexie-merged'));

    process.stdout.write(`${JSON.stringify({
      state: 'measured',
      count,
      zipMiB: mib(input.byteLength),
      stages,
      result,
    })}\n`);
  } finally {
    await vite.close();
  }
}

function runChild(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--expose-gc', process.argv[1], ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`child ${args.join(' ')} exited ${code}`));
      else resolve(stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)));
    });
  });
}

async function main() {
  const [mode, value, file] = process.argv.slice(2);
  if (mode === '--generate') return generate(Number(value), file);
  if (mode === '--measure') return measure(Number(value), file);

  const counts = process.argv.slice(2).length > 0
    ? process.argv.slice(2).map(Number)
    : DEFAULT_COUNTS;
  if (counts.some((count) => !Number.isInteger(count) || count <= 0)) {
    throw new Error('사진 개수는 양의 정수여야 합니다.');
  }

  const dir = await mkdtemp(join(tmpdir(), 'bugeon-backup-memory-'));
  const results = [];
  try {
    for (const count of counts) {
      const path = join(dir, `${count}.zip`);
      const generated = await runChild(['--generate', String(count), path]);
      const measured = await runChild(['--measure', String(count), path]);
      results.push(...generated, ...measured);
      process.stdout.write(`${JSON.stringify(results.at(-1), null, 2)}\n`);
      await rm(path, { force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await main();
