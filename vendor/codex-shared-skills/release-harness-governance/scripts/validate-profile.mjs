import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const 문자열 = (v) => typeof v === 'string' && v.trim().length > 0;
const 배열 = (v) => Array.isArray(v) && v.length > 0;

export function validateProfile(profile) {
  const errors = [];
  if (profile?.schemaVersion !== 1) errors.push('schemaVersion은 1이어야 한다');
  if (!문자열(profile?.project)) errors.push('project가 비었다');
  const law = profile?.sharedLaw || {};
  if (!/^https:\/\//.test(String(law.source || ''))) errors.push('sharedLaw.source는 HTTPS여야 한다');
  if (!/^[a-f0-9]{40}$/.test(String(law.commit || ''))) errors.push('sharedLaw.commit은 40자리 커밋이어야 한다');
  if (!/^[a-f0-9]{64}$/.test(String(law.contentSha256 || ''))) errors.push('sharedLaw.contentSha256은 64자리 해시여야 한다');
  if (!문자열(law.vendoredPath)) errors.push('sharedLaw.vendoredPath가 비었다');
  if (!문자열(profile?.gateRegistry)) errors.push('gateRegistry가 비었다');

  const groups = Array.isArray(profile?.groups) ? profile.groups : [];
  if (!groups.length) errors.push('groups 모집단이 비었다');
  const groupIds = new Set();
  for (const group of groups) {
    if (!문자열(group?.id) || groupIds.has(group.id)) errors.push(`그룹 id 누락·중복: ${group?.id || '(없음)'}`);
    groupIds.add(group?.id);
    if (!문자열(group?.command)) errors.push(`${group?.id || '(그룹)'} command가 비었다`);
    if (!배열(group?.coverage)) errors.push(`${group?.id || '(그룹)'} coverage가 비었다`);
  }

  const full = profile?.fullRequired || {};
  if (!문자열(full.command)) errors.push('fullRequired.command가 비었다');
  if (full.evidence !== 'ci') errors.push('fullRequired.evidence는 ci여야 한다');
  if (full.latestRevision !== true) errors.push('fullRequired.latestRevision은 true여야 한다');
  const versioning = profile?.versioning || {};
  for (const key of ['trigger', 'baseline', 'writer', 'history']) if (!문자열(versioning[key])) errors.push(`versioning.${key}가 비었다`);

  const nodes = Array.isArray(profile?.releaseNodes) ? profile.releaseNodes : [];
  if (!nodes.length) errors.push('releaseNodes 모집단이 비었다');
  const nodeIds = new Set();
  for (const node of nodes) {
    if (!문자열(node?.id) || nodeIds.has(node.id)) errors.push(`릴리스 노드 id 누락·중복: ${node?.id || '(없음)'}`);
    nodeIds.add(node?.id);
    if (!문자열(node?.verdict)) errors.push(`${node?.id || '(노드)'} verdict가 비었다`);
    if (!Array.isArray(node?.writes)) errors.push(`${node?.id || '(노드)'} writes가 배열이 아니다`);
  }

  const edges = Array.isArray(profile?.releaseEdges) ? profile.releaseEdges : [];
  const graph = new Map([...nodeIds].map((id) => [id, []]));
  for (const edge of edges) {
    if (!nodeIds.has(edge?.from) || !nodeIds.has(edge?.to)) errors.push(`릴리스 간선 끝점이 없다: ${edge?.from} → ${edge?.to}`);
    if (!문자열(edge?.reason)) errors.push(`릴리스 간선 사유가 비었다: ${edge?.from} → ${edge?.to}`);
    if (graph.has(edge?.from) && nodeIds.has(edge?.to)) graph.get(edge.from).push(edge.to);
  }
  const visiting = new Set(), visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of graph.get(id) || []) if (visit(next)) return true;
    visiting.delete(id); visited.add(id); return false;
  };
  if ([...nodeIds].some(visit)) errors.push('releaseEdges에 순환이 있다');

  const writers = Array.isArray(profile?.runnerWriters) ? profile.runnerWriters : [];
  for (const writer of writers) {
    if (!문자열(writer?.id) || !배열(writer?.writes)) errors.push('runnerWriter의 id 또는 writes가 비었다');
    if (writer?.branchExclusive !== true) errors.push(`${writer?.id || '(러너)'} branchExclusive가 true가 아니다`);
  }

  const surfaces = Array.isArray(profile?.deploymentSurfaces) ? profile.deploymentSurfaces : [];
  if (!surfaces.length) errors.push('deploymentSurfaces 모집단이 비었다');
  const surfaceIds = new Set();
  for (const surface of surfaces) {
    if (!문자열(surface?.id) || surfaceIds.has(surface.id)) errors.push(`배포 표면 id 누락·중복: ${surface?.id || '(없음)'}`);
    surfaceIds.add(surface?.id);
    if (!배열(surface?.affectedBy)) errors.push(`${surface?.id || '(표면)'} affectedBy가 비었다`);
    if (!문자열(surface?.deploy)) errors.push(`${surface?.id || '(표면)'} deploy가 비었다`);
    if (!문자열(surface?.readback)) errors.push(`${surface?.id || '(표면)'} readback이 비었다`);
  }
  if (!Array.isArray(profile?.exceptions)) errors.push('exceptions가 배열이 아니다');
  return { errors, counts: { groups: groups.length, nodes: nodes.length, edges: edges.length, writers: writers.length, surfaces: surfaces.length } };
}

function selfTest() {
  const base = {
    schemaVersion: 1, project: 'sample',
    sharedLaw: { source: 'https://example.test/shared', commit: 'a'.repeat(40), contentSha256: 'b'.repeat(64), vendoredPath: 'vendor/law' },
    gateRegistry: 'scripts/gates.mjs', groups: [{ id: 'static', command: 'node check.mjs', coverage: ['source'] }],
    fullRequired: { command: 'node harness.mjs', evidence: 'ci', latestRevision: true },
    versioning: { trigger: 'app.html', baseline: 'origin/main', writer: 'node bump.mjs', history: 'app.html#history' },
    releaseNodes: [{ id: 'build', verdict: 'exit-code', writes: ['artifact'] }, { id: 'deploy', verdict: 'live-readback', writes: ['live'] }],
    releaseEdges: [{ from: 'build', to: 'deploy', reason: '배포 입력' }],
    runnerWriters: [{ id: 'builder', writes: ['artifact'], branchExclusive: true }],
    deploymentSurfaces: [{ id: 'web', affectedBy: ['app.html'], deploy: 'deploy', readback: 'readback' }], exceptions: []
  };
  if (validateProfile(base).errors.length) throw new Error('대조군 정상 프로필이 실패했다');
  const cases = [
    ['빈 그룹', (p) => { p.groups = []; }, 'groups 모집단'], ['빈 커버리지', (p) => { p.groups[0].coverage = []; }, 'coverage'],
    ['옛 개정 허용', (p) => { p.fullRequired.latestRevision = false; }, 'latestRevision'],
    ['없는 간선 끝점', (p) => { p.releaseEdges[0].to = 'missing'; }, '간선 끝점'],
    ['순환', (p) => { p.releaseEdges.push({ from: 'deploy', to: 'build', reason: '잘못된 순환' }); }, '순환'],
    ['러너 비독점', (p) => { p.runnerWriters[0].branchExclusive = false; }, 'branchExclusive'],
    ['배포 되읽기 없음', (p) => { p.deploymentSurfaces[0].readback = ''; }, 'readback'],
    ['가변 커밋', (p) => { p.sharedLaw.commit = 'main'; }, '40자리']
  ];
  for (const [name, mutate, expected] of cases) {
    const sample = structuredClone(base); mutate(sample);
    if (!validateProfile(sample).errors.some((e) => e.includes(expected))) throw new Error(`주입증명 실패: ${name}`);
  }
  console.log(`✅ 주입증명 ${cases.length + 1}축 — 정상 프로필은 통과하고 공통 불변식 위반 ${cases.length}형태는 적색으로 갈렸다.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  selfTest();
  const path = process.argv[2];
  if (!path || path === '--self-test') process.exit(0);
  const result = validateProfile(JSON.parse(readFileSync(path, 'utf8')));
  if (result.errors.length) {
    for (const error of result.errors) console.error(`❌ ${error}`);
    process.exit(1);
  }
  console.log(`✅ 릴리스 프로필 통과 — 그룹 ${result.counts.groups} · 노드 ${result.counts.nodes} · 간선 ${result.counts.edges} · 러너 ${result.counts.writers} · 배포 표면 ${result.counts.surfaces}.`);
}
