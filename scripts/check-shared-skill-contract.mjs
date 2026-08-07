// check-shared-skill-contract.mjs — 공통 스킬 정본과 이 프로젝트의 고정 스냅샷·릴리스 프로필·설치본을 대조한다.
// 공통 법을 프로젝트에 복사하지 않고, 프로젝트 고유 사실만 schemas/release-profile.json에 둔다.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProfile } from '../vendor/codex-shared-skills/release-harness-governance/scripts/validate-profile.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SOURCE = 'https://github.com/hanwha27-TDTU/Codex-Shared-Skills';
const APPROVED_COMMIT = '268126d44103df9ca709e7b8eec49d8e679437c2';
const EXPECTED_SKILLS = ['bg-codex-autorouter', 'release-harness-governance'];

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

function contentHash(dir) {
  const hash = createHash('sha256');
  for (const file of filesUnder(dir)) {
    hash.update(relative(dir, file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function markedBlock(text, start, end) {
  const begin = text.indexOf(start);
  const finish = text.indexOf(end, begin + start.length);
  return begin >= 0 && finish >= 0 ? text.slice(begin, finish + end.length) : null;
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
  if (lock?.schemaVersion !== 1 || lock?.policyApi !== 1) errors.push('공통 스킬 lock의 schemaVersion·policyApi가 1이 아님');
  if (lock?.source !== SOURCE) errors.push('공통 정본 GitHub 주소가 승인값과 다름');
  if (lock?.commit !== APPROVED_COMMIT) errors.push('공통 정본 커밋이 승인된 고정 커밋과 다름');
  if (!/^[a-f0-9]{64}$/.test(String(lock?.manifestSha256 || ''))) errors.push('공통 manifest 해시가 비었거나 형식이 틀림');

  const entries = Array.isArray(lock?.skills) ? lock.skills : [];
  const names = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_SKILLS)) errors.push('공통 스킬 목록이 승인된 두 스킬과 다름');
  for (const entry of entries) {
    if (vendorHashes?.[entry.name] !== entry.contentSha256) errors.push(`${entry.name} 프로젝트 스냅샷 해시가 lock과 다름`);
    if (installedHashes && installedHashes[entry.name] !== entry.contentSha256) errors.push(`${entry.name} Codex 전역 설치본 해시가 lock과 다름`);
    if (claudeHashes && claudeHashes[entry.name] !== entry.contentSha256) errors.push(`${entry.name} Claude 전역 설치본 해시가 lock과 다름`);
  }

  const adapter = lock?.adapter || {};
  if (!markedBlock(adapterText || '', adapter.start, adapter.end)) errors.push('프로젝트 어댑터 스냅샷의 마커가 없음');
  if (globalBlock !== null && globalBlock !== adapterText) errors.push('전역 Codex AutoRouter 어댑터가 프로젝트 스냅샷과 다름');
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
  const surfaceIds = (profile?.deploymentSurfaces || []).map((surface) => surface.id).sort();
  const expectedSurfaces = ['android-apk-latest', 'github-pages', 'supabase-migrations', ...workflows.functionNames.map((name) => `supabase-${name}`)].sort();
  if (JSON.stringify(surfaceIds) !== JSON.stringify(expectedSurfaces)) errors.push('릴리스 프로필의 배포 표면 목록이 실제 저장소와 다름');
  for (const [name, version] of Object.entries(workflows.functionVersions)) {
    const surface = profile?.deploymentSurfaces?.find((entry) => entry.id === `supabase-${name}`);
    if (!surface?.affectedBy?.includes(`supabase/functions/${name}/**`) || !surface?.readback?.includes(`FN_VERSION=${version}`)) errors.push(`${name} 함수 표면의 경로·버전 read-back이 실제 소스와 다름`);
  }
  errors.push(...workflowProblems(workflows));

  return { errors, counts: profileResult.counts, skillCount: entries.length };
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
    ['Codex 설치본 드리프트 주입', (x) => { x.installedHashes = Object.fromEntries(x.lock.skills.map((s) => [s.name, s.contentSha256])); x.installedHashes[EXPECTED_SKILLS[0]] = '1'.repeat(64); }, 'Codex 전역 설치본'],
    ['Claude 설치본 드리프트 주입', (x) => { x.claudeHashes = Object.fromEntries(x.lock.skills.map((s) => [s.name, s.contentSha256])); x.claudeHashes[EXPECTED_SKILLS[1]] = '2'.repeat(64); }, 'Claude 전역 설치본'],
    ['전역 어댑터 드리프트 주입', (x) => { x.globalBlock = `${x.adapterText}\n변조`; }, '전역 Codex AutoRouter'],
    ['공통 법 복사 주입', (x) => { x.commonLawCopies = 1; }, '공통 HRL 조문'],
    ['CI 그룹 드리프트 주입', (x) => { x.workflows.ci = x.workflows.ci.replace('npm run live', 'npm run missing'); }, 'CI live-render'],
    ['배포 표면 드리프트 주입', (x) => { x.workflows.apk = x.workflows.apk.replaceAll('--clobber', '--skip'); }, 'Android apk-latest'],
  ];
  for (const [name, mutate, expected] of cases) {
    const sample = structuredClone(base);
    mutate(sample);
    if (!validateContract(sample).errors.some((error) => error.includes(expected))) throw new Error(`셀프테스트 실패: ${name} 결함을 못 잡음`);
  }
  console.log(`주입증명 ${cases.length + 1}축: 정상 1 · 결함 ${cases.length} 모두 판별.`);
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

selfTest(lock, profile, vendorHashes, adapterText, workflows);

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
