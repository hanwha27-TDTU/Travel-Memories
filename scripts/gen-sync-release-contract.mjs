#!/usr/bin/env node
// 앱·Edge Function·배포 검사가 공유하는 동기화 릴리스 계약을 한 정본에서 생성한다.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  edgeSourceSha256,
  normalizeLf,
  renderClientContract,
  renderEdgeContractBlock,
  replaceEdgeContractBlock,
} from './sync-release-contract-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_PATH = join(ROOT, 'schemas/sync-release-contract.json');
const EDGE_PATH = join(ROOT, 'supabase/functions/media-sign/index.ts');
const CLIENT_PATH = join(ROOT, 'src/app/syncReleaseContract.gen.ts');

const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
const edgeSource = readFileSync(EDGE_PATH, 'utf8');
contract.mediaSign.sourceSha256 = edgeSourceSha256(edgeSource);

const edgeBlock = renderEdgeContractBlock(contract);
writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
writeFileSync(EDGE_PATH, `${normalizeLf(replaceEdgeContractBlock(edgeSource, edgeBlock)).replace(/\n*$/, '')}\n`, 'utf8');
writeFileSync(CLIENT_PATH, renderClientContract(contract), 'utf8');

console.log(`gen-sync-release-contract: ${contract.mediaSign.sourceSha256}`);
