#!/usr/bin/env node
// changelog의 앱 버전을 Tauri 빌드에 직접 주입한다. tauri.conf의 0.0.0은
// 배포 버전이 아니라 로컬 자리표시자이며, 사람이 두 군데 버전을 맞추지 않는다.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const raw = readFileSync('src/app/changelog.ts', 'utf8').match(/version: '([\d.]+)'/)?.[1];
if (!raw) {
  console.error('build-windows: changelog에서 앱 버전을 읽지 못했습니다.');
  process.exit(2);
}
const parts = raw.split('.');
const version = parts.length === 2 ? `${raw}.0` : raw;
console.log(`build-windows: changelog v${raw} → Tauri ${version}`);
const result = spawnSync(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--bundles', 'nsis', '--config', JSON.stringify({ version })], {
  stdio: 'inherit',
  shell: false,
});
if (result.error) {
  console.error(`build-windows: ${String(result.error)}`);
  process.exit(2);
}
process.exit(result.status ?? 2);
