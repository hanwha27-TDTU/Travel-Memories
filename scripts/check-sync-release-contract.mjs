#!/usr/bin/env node
// 동기화 릴리스 계약의 정본·앱 생성물·Edge 소스 식별자가 갈라지는 것을 막는다.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSelfTest } from './gate-selftest-lib.mjs';
import {
  edgeSourceSha256,
  normalizeLf,
  renderClientContract,
  renderEdgeContractBlock,
} from './sync-release-contract-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function auditArtifacts({ contract, edgeSource, clientSource }) {
  const problems = [];
  const actualDigest = edgeSourceSha256(edgeSource);
  if (contract.mediaSign.sourceSha256 !== actualDigest) {
    problems.push('media-sign 소스 해시가 정본과 다릅니다 — node scripts/gen-sync-release-contract.mjs를 실행하세요.');
  }
  const block = renderEdgeContractBlock(contract);
  if (!normalizeLf(edgeSource).includes(block)) {
    problems.push('media-sign의 생성 계약 블록이 정본과 다릅니다 — 생성기를 실행하세요.');
  }
  if (normalizeLf(clientSource) !== normalizeLf(renderClientContract(contract))) {
    problems.push('앱의 동기화 릴리스 계약 생성물이 정본과 다릅니다 — 생성기를 실행하세요.');
  }
  if (!/sourceSha256:\s*FN_SOURCE_SHA256/.test(edgeSource)) {
    problems.push('capabilities 응답이 FN_SOURCE_SHA256를 내보내지 않습니다 — 운영 배포 소스를 대조할 수 없습니다.');
  }
  if (!Number.isInteger(contract.runtime.stallAfterMs) || contract.runtime.stallAfterMs <= 0) {
    problems.push('runtime.stallAfterMs는 양의 정수여야 합니다.');
  }
  return problems;
}

// SELF-TEST: 줄바꿈만 다른 대조군은 같고, 실제 문자 변조와 생성물 드리프트는 반드시 RED다.
runSelfTest('check-sync-release-contract', () => {
  const edge = `head\n// SYNC_RELEASE_CONTRACT:BEGIN\nold\n// SYNC_RELEASE_CONTRACT:END\nsourceSha256: FN_SOURCE_SHA256\ntail\n`;
  if (edgeSourceSha256(edge) !== edgeSourceSha256(edge.replace(/\n/g, '\r\n'))) {
    throw new Error('SELF-TEST 실패: LF/CRLF만 다른 논리 소스를 다르게 해시합니다.');
  }
  if (edgeSourceSha256(edge) === edgeSourceSha256(edge.replace('tail', 'changed'))) {
    throw new Error('SELF-TEST 실패: 실제 Edge 소스 변조를 잡지 못합니다.');
  }
  const contract = {
    schemaVersion: 1,
    mediaSign: { protocolVersion: 6, requiredOps: ['probe'], sourceSha256: edgeSourceSha256(edge) },
    runtime: { stallAfterMs: 1 },
  };
  const withBlock = edge.replace(
    /\/\/ SYNC_RELEASE_CONTRACT:BEGIN[\s\S]*?\/\/ SYNC_RELEASE_CONTRACT:END/,
    renderEdgeContractBlock(contract),
  );
  const good = { contract, edgeSource: withBlock, clientSource: renderClientContract(contract) };
  if (auditArtifacts(good).length !== 0) throw new Error('SELF-TEST 실패: 정상 계약을 오탐합니다.');
  if (auditArtifacts({ ...good, clientSource: `${good.clientSource}// stale` }).length === 0) {
    throw new Error('SELF-TEST 실패: 낡은 앱 생성물을 통과시킵니다.');
  }
  if (auditArtifacts({ ...good, edgeSource: withBlock.replace('tail', 'changed') }).length === 0) {
    throw new Error('SELF-TEST 실패: Edge 실제 소스 변조를 통과시킵니다.');
  }
});

const contract = JSON.parse(readFileSync(join(ROOT, 'schemas/sync-release-contract.json'), 'utf8'));
const problems = auditArtifacts({
  contract,
  edgeSource: readFileSync(join(ROOT, 'supabase/functions/media-sign/index.ts'), 'utf8'),
  clientSource: readFileSync(join(ROOT, 'src/app/syncReleaseContract.gen.ts'), 'utf8'),
});

if (problems.length) {
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error('check-sync-release-contract: 동기화 릴리스 계약이 갈라졌습니다.');
  process.exit(1);
}
console.log('check-sync-release-contract: OK (정본 ↔ 앱 ↔ Edge 소스 해시 · LF/CRLF 대조군 · capabilities 배선)');
