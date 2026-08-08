#!/usr/bin/env node
// 운영 media-sign이 이번 앱이 기대하는 정확한 계약을 되돌려 주는지 읽기 전용으로 확인한다.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function liveContractProblems(contract, capability) {
  const problems = [];
  const expected = contract.mediaSign;
  if (!Number.isFinite(capability?.version) || capability.version < expected.protocolVersion) {
    problems.push(`함수 규약이 낡았습니다(운영 ${String(capability?.version ?? '없음')} / 기대 ${expected.protocolVersion}).`);
  }
  const ops = Array.isArray(capability?.ops) ? capability.ops : [];
  const missing = expected.requiredOps.filter((op) => !ops.includes(op));
  if (missing.length) problems.push(`필수 연산이 빠졌습니다: ${missing.join(', ')}.`);
  if (capability?.sourceSha256 !== expected.sourceSha256) {
    problems.push(`배포 소스가 다릅니다(운영 ${String(capability?.sourceSha256 ?? '없음').slice(0, 12)} / 기대 ${expected.sourceSha256.slice(0, 12)}).`);
  }
  if (capability?.secretsOk !== true) problems.push('운영 Edge Function의 R2 시크릿이 완전하지 않습니다.');
  return problems;
}

// SELF-TEST: 옛 함수·연산 누락·다른 소스·시크릿 누락을 각각 RED로 잡고 정상은 통과한다.
(() => {
  const contract = {
    mediaSign: { protocolVersion: 6, requiredOps: ['probe', 'get'], sourceSha256: 'a'.repeat(64) },
  };
  const good = { version: 6, ops: ['probe', 'get', 'future'], sourceSha256: 'a'.repeat(64), secretsOk: true };
  if (liveContractProblems(contract, good).length) throw new Error('SELF-TEST 실패: 정상 운영 계약을 오탐합니다.');
  for (const bad of [
    { ...good, version: 5 },
    { ...good, ops: ['probe'] },
    { ...good, sourceSha256: 'b'.repeat(64) },
    { ...good, secretsOk: false },
  ]) {
    if (liveContractProblems(contract, bad).length === 0) throw new Error('SELF-TEST 실패: 운영 계약 누락을 통과시킵니다.');
  }
})();

const url = (process.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '';
if (!url || !key) {
  console.error('verify-sync-release-live: VITE_SUPABASE_URL/PUBLISHABLE_KEY가 없어 운영 Edge를 대조할 수 없습니다.');
  process.exit(1);
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 20_000);
let response;
try {
  response = await fetch(`${url}/functions/v1/media-sign`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ op: 'capabilities' }),
    signal: controller.signal,
  });
} catch (error) {
  console.error(`verify-sync-release-live: 운영 Edge 요청 실패 — ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  clearTimeout(timer);
}

if (!response.ok) {
  console.error(`verify-sync-release-live: 운영 Edge가 HTTP ${response.status}를 돌려줬습니다.`);
  process.exit(1);
}

let capability;
try {
  capability = await response.json();
} catch {
  console.error('verify-sync-release-live: 운영 Edge 응답이 JSON이 아닙니다.');
  process.exit(1);
}

const contract = JSON.parse(readFileSync(join(ROOT, 'schemas/sync-release-contract.json'), 'utf8'));
const problems = liveContractProblems(contract, capability);
if (problems.length) {
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error('verify-sync-release-live: Edge Function을 먼저 배포·되읽은 뒤 앱 릴리스를 진행하세요.');
  process.exit(1);
}
console.log(`verify-sync-release-live: OK (운영 media-sign v${capability.version} · 소스 ${capability.sourceSha256.slice(0, 12)} · 필수 연산·시크릿 확인)`);
