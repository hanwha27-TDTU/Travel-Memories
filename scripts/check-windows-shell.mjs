// check-windows-shell — Windows 셸의 영속 오리진·로컬 번들·최소 권한 계약.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const OAUTH_URL = 'https://ihxiywffzmvrwmqvatzt.supabase.co/auth/v1/authorize*';

export function auditWindowsShell({ pkg, config, capability, cargo, rust, androidManifest }) {
  const problems = [];
  if (pkg.scripts?.['windows:web'] !== 'tsc --noEmit && vite build --base ./ --outDir windows-dist') problems.push('windows:web은 상대 base의 windows-dist를 만들어야 한다');
  if (pkg.scripts?.['windows:build'] !== 'node scripts/build-windows.mjs') problems.push('windows:build는 changelog 버전을 주입하는 전용 빌더를 써야 한다');
  if (config.version !== '0.0.0') problems.push('tauri.conf 버전은 배포판처럼 보이지 않는 0.0.0 자리표시자여야 한다');
  if (config.identifier !== 'app.bugeon.journey') problems.push('identifier가 고정값과 다르다');
  if (config.app?.windows?.[0]?.label !== 'main') problems.push('권한 대상 main 창이 없다');
  if (config.app?.windows?.[0]?.useHttpsScheme !== true) problems.push('useHttpsScheme가 true가 아니다 — 저장소 오리진이 바뀐다');
  if (config.build?.frontendDist !== '../windows-dist') problems.push('운영 셸이 로컬 windows-dist를 싣지 않는다');
  if (config.bundle?.targets?.length !== 1 || config.bundle.targets[0] !== 'nsis') problems.push('설치 형식이 NSIS로 고정되지 않았다');
  if (capability.windows?.length !== 1 || capability.windows[0] !== 'main') problems.push('capability가 main 창 하나에만 묶이지 않았다');
  const permissions = capability.permissions ?? [];
  const textPermissions = permissions.filter((p) => typeof p === 'string');
  const opener = permissions.find((p) => typeof p === 'object' && p?.identifier === 'opener:allow-open-url');
  if (textPermissions.length !== 2 || !textPermissions.includes('core:default') || !textPermissions.includes('deep-link:default')) {
    problems.push('Windows OAuth는 core:default와 deep-link:default만 문자열 권한으로 가져야 한다');
  }
  if (permissions.length !== 3 || opener?.allow?.length !== 1 || opener.allow[0]?.url !== OAUTH_URL) {
    problems.push('opener는 이 앱의 Supabase authorize URL 하나에만 제한해야 한다');
  }
  if (permissions.some((p) => typeof p === 'string' && p.startsWith('opener:'))) problems.push('광범위한 opener 문자열 권한을 허용하면 안 된다');
  const schemes = config.plugins?.['deep-link']?.desktop?.schemes;
  if (schemes?.length !== 1 || schemes[0] !== 'app.bugeon.journey') problems.push('Windows 딥링크 스킴이 앱 식별자 하나로 고정되지 않았다');
  for (const plugin of ['deep-link = "=2.4.9"', 'opener = "=2.5.4"', 'single-instance = { version = "=2.4.3", features = ["deep-link"] }']) {
    if (!cargo.includes(`tauri-plugin-${plugin}`)) problems.push(`Cargo 플러그인 고정 누락: tauri-plugin-${plugin}`);
  }
  const singleAt = rust.indexOf('tauri_plugin_single_instance::init');
  const deepAt = rust.indexOf('tauri_plugin_deep_link::init');
  if (singleAt < 0 || deepAt < 0 || singleAt > deepAt) problems.push('single-instance를 deep-link보다 먼저 등록해야 한다');
  if (!rust.includes('tauri_plugin_opener::init')) problems.push('opener Rust 플러그인이 등록되지 않았다');
  if (!androidManifest.includes('<data android:scheme="app.bugeon.journey" android:host="auth-callback" />')) {
    problems.push('Android OAuth intent-filter도 같은 host까지 제한해야 한다');
  }
  if (/tauri-plugin-(?:shell|fs|http|process)/.test(cargo)) problems.push('넓은 native 플러그인이 들어왔다');
  return problems;
}

function fixtures() {
  return {
    pkg: { scripts: { 'windows:web': 'tsc --noEmit && vite build --base ./ --outDir windows-dist', 'windows:build': 'node scripts/build-windows.mjs' } },
    config: { version: '0.0.0', identifier: 'app.bugeon.journey', app: { windows: [{ label: 'main', useHttpsScheme: true }] }, build: { frontendDist: '../windows-dist' }, bundle: { targets: ['nsis'] }, plugins: { 'deep-link': { desktop: { schemes: ['app.bugeon.journey'] } } } },
    capability: { windows: ['main'], permissions: ['core:default', 'deep-link:default', { identifier: 'opener:allow-open-url', allow: [{ url: OAUTH_URL }] }] },
    cargo: 'tauri = { version = "2.11.5" }\ntauri-plugin-deep-link = "=2.4.9"\ntauri-plugin-opener = "=2.5.4"\ntauri-plugin-single-instance = { version = "=2.4.3", features = ["deep-link"] }',
    rust: 'tauri_plugin_single_instance::init(); tauri_plugin_deep_link::init(); tauri_plugin_opener::init();',
    androidManifest: '<data android:scheme="app.bugeon.journey" android:host="auth-callback" />',
  };
}

export function runSelfTest() {
  const clean = fixtures();
  const insecure = structuredClone(clean);
  insecure.config.app.windows[0].useHttpsScheme = false;
  const broad = structuredClone(clean);
  broad.capability.permissions.push('shell:default');
  const wrongHost = structuredClone(clean);
  wrongHost.androidManifest = '<data android:scheme="app.bugeon.journey" />';
  const wrongOrder = structuredClone(clean);
  wrongOrder.rust = 'tauri_plugin_deep_link::init(); tauri_plugin_single_instance::init(); tauri_plugin_opener::init();';
  return auditWindowsShell(clean).length === 0
    && auditWindowsShell(insecure).length > 0
    && auditWindowsShell(broad).length > 0
    && auditWindowsShell(wrongHost).length > 0
    && auditWindowsShell(wrongOrder).length > 0;
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
  rust: readFileSync(join(ROOT, 'src-tauri/src/lib.rs'), 'utf8'),
  androidManifest: readFileSync(join(ROOT, 'android-shell/android/app/src/main/AndroidManifest.xml'), 'utf8'),
};
const problems = auditWindowsShell(input);
if (problems.length) {
  console.error(`check-windows-shell: Windows 셸 계약 위반 ${problems.length}건\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('check-windows-shell: OK — 로컬 번들·HTTPS 오리진·scoped OAuth 딥링크·단일 인스턴스·NSIS 계약을 지킨다.');
