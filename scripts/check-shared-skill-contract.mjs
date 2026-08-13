// check-shared-skill-contract.mjs — 공통 스킬 정본과 이 프로젝트의 고정 스냅샷·릴리스 프로필·설치본을 대조한다.
// 공통 법을 프로젝트에 복사하지 않고, 프로젝트 고유 사실만 schemas/release-profile.json에 둔다.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestDirectory as contentHash, digestFile as fileHash } from '../vendor/codex-shared-skills/release-harness-governance/scripts/content-digest.mjs';
import { validateProfile } from '../vendor/codex-shared-skills/release-harness-governance/scripts/validate-profile.mjs';
import { runSelfTest } from './gate-selftest-lib.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SOURCE = 'https://github.com/hanwha27-TDTU/Codex-Shared-Skills';
// 🔴 HRL-18~20, Windows 공급망 경계, 데이터 안전 스킬 3종과 소비 앱 호환성 원장까지
// 검증된 공통 정본 커밋이다.
// 각 앱의 lock이 커밋을 고정하므로 다른 앱은 자기 승인 커밋에 계속 머문다.
const APPROVED_COMMIT = 'd7adbed143e50c234bf42c2f1336d48c78e5392b';
const EXPECTED_SKILLS = [
  'backup-recovery-governance',
  'bg-codex-autorouter',
  'diagnostic-verdict-governance',
  'offline-sync-governance',
  'release-harness-governance',
  'shared-skill-governance',
];

function markedBlock(text, start, end) {
  const begin = text.indexOf(start);
  const finish = text.indexOf(end, begin + start.length);
  return begin >= 0 && finish >= 0 ? text.slice(begin, finish + end.length) : null;
}

// 내용 계약은 checkout·전역 설치본의 CRLF/LF 차이를 변조로 세지 않는다(M-0121).
// 실제 문장 차이는 그대로 남아 self-test의 드리프트 주입이 계속 RED다.
function normalizedText(text) {
  return String(text || '').replaceAll('\r\n', '\n').trim();
}

function jobBlock(workflow, id) {
  workflow = workflow.replaceAll('\r', '');
  const startToken = `\n  ${id}:\n`;
  const start = workflow.indexOf(startToken);
  if (start < 0) return '';
  const rest = workflow.slice(start + startToken.length);
  const next = rest.search(/\n  [a-zA-Z0-9_-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

function requiredJobIds(workflow) {
  const normalized = workflow.replaceAll('\r', '');
  const ids = [...normalized.matchAll(/^  ([a-zA-Z0-9_-]+):\n/gm)].map((match) => match[1]);
  return ids.filter((id) => jobBlock(normalized, id).includes('github.event.pull_request.draft == false')).sort();
}

function commandParts(command) {
  return String(command || '').split('&&').map((part) => part.trim()).filter(Boolean);
}

export function workflowProblems(workflows) {
  const problems = [];
  const fast = jobBlock(workflows.ci, 'fast-gates');
  const harness = jobBlock(workflows.ci, 'harness');
  const live = jobBlock(workflows.ci, 'live-render');
  if (!fast || !fast.includes('npm audit --audit-level=high') || !fast.includes('npm run gates')) problems.push('CI fast-gates 실제 명령이 프로필과 다름');
  if (!harness || !harness.includes('npm audit --audit-level=high') || !harness.includes('npm run build') || !harness.includes('npm run harness')) problems.push('CI harness 실제 명령이 프로필과 다름');
  if (!live || !live.includes('playwright install --with-deps chromium') || !live.includes('npm run build') || !live.includes('npm run live')) problems.push('CI live-render 실제 명령이 프로필과 다름');
  if (!workflows.pages.includes("branches: ['main']") || !workflows.pages.includes('npm run build') || !workflows.pages.includes('actions/deploy-pages@')) problems.push('GitHub Pages 배포 표면 계약이 달라짐');
  if (!workflows.apk.includes("- 'android-shell/**'") || !workflows.apk.includes('gh release upload apk-latest') || !workflows.apk.includes('--clobber') || !workflows.apk.includes('group: android-apk-${{ github.ref }}') || !workflows.apk.includes('cancel-in-progress: false')) problems.push('Android apk-latest 배포 표면 계약이 달라짐');
  if (!workflows.windows.includes("- 'src-tauri/**'") || !workflows.windows.includes("$tag = 'windows-latest'") || !workflows.windows.includes('gh release upload $tag $exe $sha --clobber') || !workflows.windows.includes('gh release download $tag') || !workflows.windows.includes('group: windows-installer-${{ github.ref }}') || !workflows.windows.includes('cancel-in-progress: false')) problems.push('Windows windows-latest 배포·read-back 표면 계약이 달라짐');
  if (!workflows.supabaseGuide.includes('npx supabase functions deploy media-sign --project-ref ihxiywffzmvrwmqvatzt')) problems.push('Supabase Edge Function 배포 명령 근거가 달라짐');
  return problems;
}

export function validateContract({
  lock,
  profile,
  vendorHashes,
  adapterText,
  workflows,
  installedHashes = null,
  claudeHashes = null,
  globalBlock = null,
  installState = null,
  commonLawCopies = 0,
}) {
  const errors = [];
  const unknowns = [];
  if (lock?.schemaVersion !== 1 || lock?.policyApi !== 1) errors.push('공통 스킬 lock의 schemaVersion·policyApi가 1이 아님');
  if (lock?.source !== SOURCE) errors.push('공통 정본 GitHub 주소가 승인값과 다름');
  if (lock?.commit !== APPROVED_COMMIT) errors.push('공통 정본 커밋이 승인된 고정 커밋과 다름');
  if (!/^[a-f0-9]{64}$/.test(String(lock?.manifestSha256 || ''))) errors.push('공통 manifest 해시가 비었거나 형식이 틀림');

  const entries = Array.isArray(lock?.skills) ? lock.skills : [];
  const names = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_SKILLS)) errors.push('공통 스킬 목록이 승인된 스킬 모집단과 다름');
  for (const entry of entries) {
    if (vendorHashes?.[entry.name] !== entry.contentSha256) errors.push(`${entry.name} 프로젝트 스냅샷 해시가 lock과 다름`);
    auditInstalled('Codex', entry, installedHashes, errors, unknowns);
    auditInstalled('Claude', entry, claudeHashes, errors, unknowns);
  }

  const adapter = lock?.adapter || {};
  if (!markedBlock(adapterText || '', adapter.start, adapter.end)) errors.push('프로젝트 어댑터 스냅샷의 마커가 없음');
  if (globalBlock !== null && normalizedText(globalBlock) !== normalizedText(adapterText)) errors.push('전역 Codex AutoRouter 어댑터가 프로젝트 스냅샷과 다름');
  if (installState !== null) {
    if (installState?.source !== SOURCE || installState?.commit !== APPROVED_COMMIT) errors.push('전역 설치 상태의 출처·커밋이 승인값과 다름');
    if (installState?.policyApi !== lock?.policyApi || installState?.manifestSha256 !== lock?.manifestSha256) errors.push('전역 설치 상태의 정책 API·manifest 해시가 lock과 다름');
  }
  if (commonLawCopies !== 0) errors.push(`프로젝트 현재 규칙에 공통 HRL 조문 복사본이 ${commonLawCopies}개 있음`);

  const profileResult = validateProfile(profile);
  errors.push(...profileResult.errors.map((error) => `릴리스 프로필: ${error}`));
  const releaseEntry = entries.find((entry) => entry.name === 'release-harness-governance');
  if (profile?.project !== 'bugeon-journey') errors.push('릴리스 프로필 project가 bugeon-journey가 아님');
  if (profile?.sharedLaw?.source !== SOURCE || profile?.sharedLaw?.commit !== APPROVED_COMMIT) errors.push('릴리스 프로필의 공통 정본 주소·커밋이 승인값과 다름');
  if (profile?.sharedLaw?.contentSha256 !== releaseEntry?.contentSha256 || profile?.sharedLaw?.vendoredPath !== releaseEntry?.path) errors.push('릴리스 프로필의 공통 법 해시·경로가 lock과 다름');
  if (profile?.gateRegistry !== 'scripts/harness.mjs') errors.push('릴리스 프로필의 게이트 원장이 scripts/harness.mjs가 아님');

  const profileGroups = Object.fromEntries((profile?.groups || []).map((group) => [group.id, group.command]));
  const requiredIds = requiredJobIds(workflows.ci);
  if (JSON.stringify(Object.keys(profileGroups).sort()) !== JSON.stringify(requiredIds)) errors.push('릴리스 프로필 그룹이 Ready PR의 Required CI 작업과 다름');
  for (const [id, command] of Object.entries(profileGroups)) {
    const block = jobBlock(workflows.ci, id);
    if (commandParts(command).some((part) => !block.includes(part))) errors.push(`${id} 프로필 명령이 실제 CI 작업과 다름`);
  }
  if (profile?.fullRequired?.command !== 'npm run build && npm run harness && npm run live') errors.push('전체 Required 명령이 프로젝트 헌법과 다름');
  if (profile?.versioning?.baseline !== 'origin/main' || profile?.versioning?.history !== 'src/app/changelog.ts' || !profile?.versioning?.writer?.includes('+0.01')) errors.push('버전 기준선·이력·+0.01 증가 방식이 저장소 계약과 다름');
  const releaseNodeIds = new Set((profile?.releaseNodes || []).map((node) => node.id));
  for (const id of ['provider-predeploy', 'provider-live-readback']) {
    if (!releaseNodeIds.has(id)) errors.push(`media-sign 제공자 선배포 노드가 없음: ${id}`);
  }
  const releaseEdgeIds = new Set((profile?.releaseEdges || []).map((edge) => `${edge.from}->${edge.to}`));
  for (const edge of ['commit-push->provider-predeploy', 'provider-predeploy->provider-live-readback', 'provider-live-readback->required-ci']) {
    if (!releaseEdgeIds.has(edge)) errors.push(`media-sign 제공자 선배포 간선이 없음: ${edge}`);
  }
  const surfaceIds = (profile?.deploymentSurfaces || []).map((surface) => surface.id).sort();
  const expectedSurfaces = ['android-apk-latest', 'windows-installer-latest', 'github-pages', 'supabase-migrations', ...workflows.functionNames.map((name) => `supabase-${name}`)].sort();
  if (JSON.stringify(surfaceIds) !== JSON.stringify(expectedSurfaces)) errors.push('릴리스 프로필의 배포 표면 목록이 실제 저장소와 다름');
  for (const [name, version] of Object.entries(workflows.functionVersions)) {
    const surface = profile?.deploymentSurfaces?.find((entry) => entry.id === `supabase-${name}`);
    if (!surface?.affectedBy?.includes(`supabase/functions/${name}/**`) || !surface?.readback?.includes(`FN_VERSION=${version}`)) errors.push(`${name} 함수 표면의 경로·버전 read-back이 실제 소스와 다름`);
  }
  const mediaSignSurface = profile?.deploymentSurfaces?.find((entry) => entry.id === 'supabase-media-sign');
  if (!mediaSignSurface?.affectedBy?.includes('schemas/sync-release-contract.json')) errors.push('media-sign 표면이 동기화 릴리스 계약 변경을 영향 조건으로 보지 않음');
  if (!['sourceSha256', '필수 ops', 'secretsOk'].every((part) => mediaSignSurface?.readback?.includes(part))) errors.push('media-sign 표면의 정확한 운영 정체성 read-back이 불완전함');
  errors.push(...workflowProblems(workflows));

  return { errors, unknowns, counts: profileResult.counts, skillCount: entries.length };
}

/**
 * 전역 설치본 한 건을 판정한다.
 *
 * 🔴 **미설치와 변조는 다른 사실이다**(2026-08-09 · §8 「모르는 것은 확인 불가다」).
 * 예전 판은 `null !== 해시`가 참이라는 이유만으로 **설치되지 않은 것을 「해시가 lock과 다름」**
 * 이라고 보고했다. 그 문장을 읽은 사람은 변조를 의심하며 해시를 뒤지지, **설치를 하지 않는다**
 * — 판정 문장이 엉뚱한 곳을 가리키는 M-0021형이다.
 *
 * 게다가 판정이 **무관한 조건에 달려 있었다**: 스킬 디렉터리가 아예 없으면 경고만 내고
 * 통과하는데(일반 GitHub 러너), 디렉터리는 있고 우리 스킬만 없으면 실패였다(Claude Code
 * 컨테이너는 기본 스킬을 깔아 둔다). **같은 「미설치」가 환경에 따라 반대 판정을 냈다** — §7이
 * 금지하는 비대칭이고, 그래서 이 저장소 상태와 무관하게 빨간불이 켜져 있었다.
 *
 * 이제 갈래는 셋이다: 설치 경로 없음(호출부가 경고) · **미설치(확인 불가)** · 설치됐는데 다름(결함).
 */
function auditInstalled(tool, entry, hashes, errors, unknowns) {
  if (!hashes) return; // 설치 경로 자체가 없다 — 호출부가 이미 경고했다
  const actual = hashes[entry.name];
  if (actual === null || actual === undefined) {
    unknowns.push(`${entry.name} ${tool} 전역 설치본이 없습니다 — 이 실행은 그 설치본을 **재지 않았습니다**(확인 불가)`);
  } else if (actual !== entry.contentSha256) {
    errors.push(`${entry.name} ${tool} 전역 설치본 해시가 lock과 다름`);
  }
}

function selfTest(lock, profile, vendorHashes, adapterText, workflows) {
  const base = { lock, profile, vendorHashes, adapterText, workflows };
  const normalErrors = validateContract(base).errors;
  if (normalErrors.length) throw new Error(`셀프테스트 실패: 정상 계약을 통과시키지 못함 — ${normalErrors.join(' / ')}`);
  const cases = [
    ['스냅샷 변조 주입', (x) => { x.vendorHashes[EXPECTED_SKILLS[0]] = '0'.repeat(64); }, '스냅샷 해시'],
    ['스킬 누락 주입', (x) => { x.lock.skills.pop(); }, '스킬 목록'],
    ['어댑터 마커 누락 주입', (x) => { x.adapterText = ''; }, '마커'],
    ['프로필 그룹 누락 주입', (x) => { x.profile.groups.pop(); }, '프로필 그룹'],
    ['승인 커밋 드리프트 주입', (x) => { x.lock.commit = 'f'.repeat(40); }, '승인된 고정 커밋'],
    ['전역 어댑터 드리프트 주입', (x) => { x.globalBlock = `${x.adapterText}\n변조`; }, '전역 Codex AutoRouter'],
    ['공통 법 복사 주입', (x) => { x.commonLawCopies = 1; }, '공통 HRL 조문'],
    ['CI 그룹 드리프트 주입', (x) => { x.workflows.ci = x.workflows.ci.replace('npm run live', 'npm run missing'); }, 'CI live-render'],
    ['배포 표면 드리프트 주입', (x) => { x.workflows.apk = x.workflows.apk.replaceAll('--clobber', '--skip'); }, 'Android apk-latest'],
    ['Windows read-back 드리프트 주입', (x) => { x.workflows.windows = x.workflows.windows.replace('gh release download $tag', 'download removed'); }, 'Windows windows-latest'],
    ['제공자 선배포 노드 누락 주입', (x) => { x.profile.releaseNodes = x.profile.releaseNodes.filter((node) => node.id !== 'provider-predeploy'); x.profile.releaseEdges = x.profile.releaseEdges.filter((edge) => edge.from !== 'provider-predeploy' && edge.to !== 'provider-predeploy'); }, '제공자 선배포 노드'],
    ['제공자 운영 대조 간선 누락 주입', (x) => { x.profile.releaseEdges = x.profile.releaseEdges.filter((edge) => !(edge.from === 'provider-live-readback' && edge.to === 'required-ci')); }, '제공자 선배포 간선'],
    ['동기화 계약 영향 조건 누락 주입', (x) => { const surface = x.profile.deploymentSurfaces.find((entry) => entry.id === 'supabase-media-sign'); surface.affectedBy = surface.affectedBy.filter((path) => path !== 'schemas/sync-release-contract.json'); }, '동기화 릴리스 계약 변경'],
    ['정확한 운영 정체성 누락 주입', (x) => { const surface = x.profile.deploymentSurfaces.find((entry) => entry.id === 'supabase-media-sign'); surface.readback = 'FN_VERSION=6'; }, '운영 정체성 read-back'],
  ];
  // 새 전역 스킬은 Codex·Claude 설치 경계 **양쪽**의 변조 대조군을 자동 상속한다.
  // 두 대표만 손으로 고르면 다음 스킬이 설치 검증 셀프테스트에서 조용히 빠진다.
  for (const [field, tool, marker] of [
    ['installedHashes', 'Codex', '1'],
    ['claudeHashes', 'Claude', '2'],
  ]) {
    for (const skill of EXPECTED_SKILLS) {
      cases.push([
        `${skill} ${tool} 설치본 드리프트 주입`,
        (x) => {
          x[field] = Object.fromEntries(x.lock.skills.map((entry) => [entry.name, entry.contentSha256]));
          x[field][skill] = marker.repeat(64);
        },
        `${skill} ${tool} 전역 설치본`,
      ]);
    }
  }
  for (const [name, mutate, expected] of cases) {
    const sample = structuredClone(base);
    mutate(sample);
    if (!validateContract(sample).errors.some((error) => error.includes(expected))) throw new Error(`셀프테스트 실패: ${name} 결함을 못 잡음`);
  }
  // 🔴 **미설치는 결함이 아니라 확인 불가다**(§8). 위 드리프트 두 축과 **짝으로** 둔다 —
  // 짝이 없으면 다음 사람이 「엄격하게」 고치는 순간 미설치가 다시 결함으로 돌아온다.
  const absent = structuredClone(base);
  absent.claudeHashes = Object.fromEntries(absent.lock.skills.map((skill) => [skill.name, null]));
  const absentResult = validateContract(absent);
  if (absentResult.errors.some((error) => error.includes('전역 설치본 해시가 lock과 다름'))) throw new Error('셀프테스트 실패: 미설치를 변조로 보고함');
  if (absentResult.unknowns.length !== absent.lock.skills.length) throw new Error('셀프테스트 실패: 미설치를 확인 불가로 세지 않음');
  console.log(`주입증명 ${cases.length + 2}축: 정상 1 · 결함 ${cases.length} 모두 판별 · 미설치 1은 확인 불가로 갈림.`);
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const lock = readJson(join(ROOT, 'schemas', 'codex-shared-skills-lock.json'));
const profile = readJson(join(ROOT, 'schemas', 'release-profile.json'));
const vendorHashes = Object.fromEntries(lock.skills.map((entry) => {
  const path = join(ROOT, ...entry.path.split('/'));
  if (!existsSync(path)) throw new Error(`프로젝트 스냅샷이 없음: ${entry.path}`);
  return [entry.name, contentHash(path)];
}));
const adapterPath = join(ROOT, ...lock.adapter.path.split('/'));
if (!existsSync(adapterPath)) throw new Error(`프로젝트 어댑터 스냅샷이 없음: ${lock.adapter.path}`);
const adapterText = readFileSync(adapterPath, 'utf8').trim();
if (fileHash(adapterPath) !== lock.adapter.contentSha256) throw new Error('프로젝트 어댑터 스냅샷 해시가 lock과 다름');
const workflows = {
  ci: readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
  pages: readFileSync(join(ROOT, '.github', 'workflows', 'deploy-pages.yml'), 'utf8'),
  apk: readFileSync(join(ROOT, '.github', 'workflows', 'android-apk.yml'), 'utf8'),
  windows: readFileSync(join(ROOT, '.github', 'workflows', 'windows-installer.yml'), 'utf8'),
  supabaseGuide: readFileSync(join(ROOT, 'docs', 'HANDOFF_CODEX.md'), 'utf8'),
};
workflows.functionNames = readdirSync(join(ROOT, 'supabase', 'functions'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
workflows.functionVersions = Object.fromEntries(workflows.functionNames.map((name) => {
  const source = readFileSync(join(ROOT, 'supabase', 'functions', name, 'index.ts'), 'utf8');
  const version = source.match(/export const FN_VERSION = (\d+);/)?.[1];
  if (!version) throw new Error(`${name} 함수에서 FN_VERSION을 찾지 못했습니다.`);
  return [name, version];
}));

runSelfTest('check-shared-skill-contract', () =>
  selfTest(lock, profile, vendorHashes, adapterText, workflows));

function installedHashesAt(root) {
  return Object.fromEntries(lock.skills.map((entry) => {
    const path = join(root, entry.name);
    return [entry.name, existsSync(path) ? contentHash(path) : null];
  }));
}

let installedHashes = null;
const codexSkills = join(homedir(), '.agents', 'skills');
if (existsSync(codexSkills)) installedHashes = installedHashesAt(codexSkills);
else console.warn('주의: Codex 전역 설치 경로가 없어 프로젝트 스냅샷만 검증했습니다.');

let claudeHashes = null;
const claudeSkills = join(homedir(), '.claude', 'skills');
if (existsSync(claudeSkills)) claudeHashes = installedHashesAt(claudeSkills);
else console.warn('주의: Claude 전역 설치 경로가 없어 프로젝트 스냅샷만 검증했습니다.');

let globalBlock = null;
const globalAgents = join(homedir(), '.codex', 'AGENTS.md');
if (existsSync(globalAgents)) globalBlock = markedBlock(readFileSync(globalAgents, 'utf8'), lock.adapter.start, lock.adapter.end)?.trim() || '';
else console.warn('주의: 전역 Codex 어댑터가 없어 프로젝트 어댑터 스냅샷만 검증했습니다.');

const statePath = join(homedir(), '.codex-shared-skills-state.json');
const installState = existsSync(statePath) ? readJson(statePath) : null;
if (!installState && (installedHashes || claudeHashes)) console.warn('주의: 전역 설치 상태 파일이 없어 설치본의 출처 커밋은 검증하지 못했습니다.');

const currentLawHosts = ['docs/CONSTITUTION.md', 'AGENTS.md', 'CLAUDE.md', '.claude/skills/gates-mechanization-dev/SKILL.md', '.claude/skills/android-apk-dev/SKILL.md'];
let commonLawCopies = 0;
for (const rel of currentLawHosts) {
  const path = join(ROOT, ...rel.split('/'));
  if (existsSync(path)) commonLawCopies += (readFileSync(path, 'utf8').match(/^#{1,4}\s+HRL-\d+\b/gm) || []).length;
}

const result = validateContract({ lock, profile, vendorHashes, adapterText, workflows, installedHashes, claudeHashes, globalBlock, installState, commonLawCopies });
if (result.errors.length) {
  for (const error of result.errors) console.error(`FAIL: ${error}`);
  process.exit(1);
}
console.log(`공통 스킬 계약 OK — 스킬 ${result.skillCount} · CI 그룹 ${result.counts.groups} · 릴리스 노드 ${result.counts.nodes} · 배포 표면 ${result.counts.surfaces} · 커밋 ${lock.commit.slice(0, 8)}.`);
// 🔴 **못 잰 것은 통과가 아니다**(HRL-2 · §15). 확인 불가를 초록 뒤에 숨기지 않고 이름까지 말한다.
for (const unknown of result.unknowns) console.warn(`  ⚠️ 확인 불가: ${unknown}`);
