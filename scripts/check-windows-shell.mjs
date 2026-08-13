// check-windows-shell — Windows 셸의 영속 오리진·로컬 번들·최소 권한 계약.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function auditWindowsShell({ pkg, config, capability, cargo }) {
  const problems = [];
  if (pkg.scripts?.['windows:web'] !== 'tsc --noEmit && vite build --base ./ --outDir windows-dist') problems.push('windows:web은 상대 base의 windows-dist를 만들어야 한다');
  if (pkg.scripts?.['windows:build'] !== 'tauri build --bundles nsis') problems.push('windows:build는 NSIS만 명시적으로 만들어야 한다');
  if (config.identifier !== 'app.bugeon.journey') problems.push('identifier가 고정값과 다르다');
  if (config.app?.windows?.[0]?.label !== 'main') problems.push('권한 대상 main 창이 없다');
  if (config.app?.windows?.[0]?.useHttpsScheme !== true) problems.push('useHttpsScheme가 true가 아니다 — 저장소 오리진이 바뀐다');
  if (config.build?.frontendDist !== '../windows-dist') problems.push('운영 셸이 로컬 windows-dist를 싣지 않는다');
  if (config.bundle?.targets?.length !== 1 || config.bundle.targets[0] !== 'nsis') problems.push('설치 형식이 NSIS로 고정되지 않았다');
  if (capability.windows?.length !== 1 || capability.windows[0] !== 'main') problems.push('capability가 main 창 하나에만 묶이지 않았다');
  const permissions = capability.permissions ?? [];
  if (permissions.length !== 1 || permissions[0] !== 'core:default') problems.push('Phase 1 capability는 core:default 하나여야 한다');
  if (/tauri-plugin-(?:shell|fs|http|process)/.test(cargo)) problems.push('넓은 native 플러그인이 들어왔다');
  return problems;
}

function fixtures() {
  return {
    pkg: { scripts: { 'windows:web': 'tsc --noEmit && vite build --base ./ --outDir windows-dist', 'windows:build': 'tauri build --bundles nsis' } },
    config: { identifier: 'app.bugeon.journey', app: { windows: [{ label: 'main', useHttpsScheme: true }] }, build: { frontendDist: '../windows-dist' }, bundle: { targets: ['nsis'] } },
    capability: { windows: ['main'], permissions: ['core:default'] },
    cargo: 'tauri = { version = "2.11.5" }',
  };
}

export function runSelfTest() {
  const clean = fixtures();
  const insecure = structuredClone(clean);
  insecure.config.app.windows[0].useHttpsScheme = false;
  const broad = structuredClone(clean);
  broad.capability.permissions.push('shell:default');
  return auditWindowsShell(clean).length === 0 && auditWindowsShell(insecure).length > 0 && auditWindowsShell(broad).length > 0;
}

if (!runSelfTest()) {
  console.error('check-windows-shell: 셀프테스트 실패 — 대조군을 잡지 못한다.');
  process.exit(2);
}

const input = {
  pkg: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')),
  config: JSON.parse(readFileSync(join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8')),
  capability: JSON.parse(readFileSync(join(ROOT, 'src-tauri/capabilities/main.json'), 'utf8')),
  cargo: readFileSync(join(ROOT, 'src-tauri/Cargo.toml'), 'utf8'),
};
const problems = auditWindowsShell(input);
if (problems.length) {
  console.error(`check-windows-shell: Windows 셸 계약 위반 ${problems.length}건\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('check-windows-shell: OK — 로컬 번들·고정 HTTPS 오리진·main 최소 권한·NSIS 계약을 지킨다.');
