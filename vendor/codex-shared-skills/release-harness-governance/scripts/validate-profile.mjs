import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const 문자열 = (v) => typeof v === 'string' && v.trim().length > 0;
const 배열 = (v) => Array.isArray(v) && v.length > 0;

// HRL-17 — 릴리스 노드의 역할 원장. `artifact`는 굽는 순간 입력을 굳히는 불변 산출물이고,
// `input-closeout`은 그 앞에 서는 읽기 전용 고정점이다.
const NODE_KINDS = Object.freeze(['integration', 'verification', 'input-closeout', 'artifact', 'deployment']);

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

  // HRL-19·20 — 전체 하네스 면제와 브라우저 실패 격리는 명시적으로 선택한 프로젝트만 쓴다.
  // 선언이 없으면 기존의 전부 차단 정책을 유지해 하위 호환한다.
  const verification = profile?.verificationPolicy;
  if (verification != null) {
    if (verification?.mode !== 'risk-triggered') errors.push('verificationPolicy.mode는 risk-triggered여야 한다');
    if (!문자열(verification?.classifier)) errors.push('verificationPolicy.classifier가 비었다');
    if (verification?.unknown !== 'full-required') errors.push('verificationPolicy.unknown은 full-required여야 한다');
    if (!배열(verification?.fullHarnessClasses)) errors.push('verificationPolicy.fullHarnessClasses가 비었다');
    if (!배열(verification?.exemptClasses)) errors.push('verificationPolicy.exemptClasses가 비었다');
    if (!배열(verification?.exemptEvidence)) errors.push('verificationPolicy.exemptEvidence가 비었다');
    const fullClasses = new Set(verification?.fullHarnessClasses || []);
    const exemptClasses = new Set(verification?.exemptClasses || []);
    for (const id of fullClasses) if (!문자열(id)) errors.push('verificationPolicy.fullHarnessClasses에 빈 값이 있다');
    for (const id of exemptClasses) {
      if (!문자열(id)) errors.push('verificationPolicy.exemptClasses에 빈 값이 있다');
      if (fullClasses.has(id)) errors.push(`verificationPolicy 분류가 전체·면제에 함께 있다: ${id}`);
    }
    const browser = verification?.browserRoundtrip || {};
    if (!문자열(browser.group)) errors.push('verificationPolicy.browserRoundtrip.group이 비었다');
    else if (!groupIds.has(browser.group)) errors.push(`verificationPolicy.browserRoundtrip.group이 groups에 없다: ${browser.group}`);
    if (!문자열(browser.workflow)) errors.push('verificationPolicy.browserRoundtrip.workflow가 비었다');
    if (browser.blocking !== false) errors.push('verificationPolicy.browserRoundtrip.blocking은 false여야 한다');
    if (browser.verdict !== 'quarantined-failure') errors.push('verificationPolicy.browserRoundtrip.verdict는 quarantined-failure여야 한다');
    if (browser.nextSessionPriority !== true) errors.push('verificationPolicy.browserRoundtrip.nextSessionPriority는 true여야 한다');
    const requiredFields = browser.requiredFields || [];
    const mandatory = ['sha', 'runId', 'gate', 'exitCode', 'cause', 'impact', 'reproduce', 'nextAction'];
    if (!Array.isArray(requiredFields)) errors.push('verificationPolicy.browserRoundtrip.requiredFields가 배열이 아니다');
    else for (const field of mandatory) if (!requiredFields.includes(field)) errors.push(`브라우저 격리 필수 필드 누락: ${field}`);
  }
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
    if (!NODE_KINDS.includes(node?.kind)) errors.push(`${node?.id || '(노드)'} kind가 ${NODE_KINDS.join('·')} 중 하나가 아니다`);
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

  // HRL-17 — 산출물 노드로 들어오는 모든 경로가 입력 마감을 지나는지 그래프에서 판정한다.
  // 선행 노드가 아예 없는 산출물(자기가 뿌리인 경우)도 마감을 안 지났으므로 위반이다.
  const kindOf = new Map(nodes.filter((n) => 문자열(n?.id)).map((n) => [n.id, n.kind]));
  const closeoutIds = [...kindOf].filter(([, kind]) => kind === 'input-closeout').map(([id]) => id);
  const artifactIds = [...kindOf].filter(([, kind]) => kind === 'artifact').map(([id]) => id);
  const incoming = new Map([...nodeIds].map((id) => [id, []]));
  for (const edge of edges) if (nodeIds.has(edge?.from) && nodeIds.has(edge?.to)) incoming.get(edge.to).push(edge.from);
  const closedOff = (id, seen = new Set()) => {
    if (kindOf.get(id) === 'input-closeout') return true;
    if (seen.has(id)) return false;
    const preds = incoming.get(id) || [];
    if (!preds.length) return false;
    const next = new Set(seen).add(id);
    return preds.every((pred) => closedOff(pred, next));
  };
  if (artifactIds.length && !closeoutIds.length) errors.push('artifact 노드가 있는데 릴리스 입력 마감(input-closeout) 노드가 없다');
  for (const id of artifactIds) {
    if (!closedOff(id)) errors.push(`릴리스 입력 마감 뒤에 오지 않는 산출물 노드다: ${id}`);
  }

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
  return {
    errors,
    counts: {
      groups: groups.length, nodes: nodes.length, edges: edges.length,
      writers: writers.length, surfaces: surfaces.length,
      closeouts: closeoutIds.length, artifacts: artifactIds.length,
      conditionalVerification: verification == null ? 0 : 1,
    },
  };
}

function selfTest() {
  const base = {
    schemaVersion: 1, project: 'sample',
    sharedLaw: { source: 'https://example.test/shared', commit: 'a'.repeat(40), contentSha256: 'b'.repeat(64), vendoredPath: 'vendor/law' },
    gateRegistry: 'scripts/gates.mjs', groups: [{ id: 'static', command: 'node check.mjs', coverage: ['source'] }],
    fullRequired: { command: 'node harness.mjs', evidence: 'ci', latestRevision: true },
    verificationPolicy: {
      mode: 'risk-triggered', classifier: 'scripts/classify.mjs', unknown: 'full-required',
      fullHarnessClasses: ['runtime', 'toolchain'], exemptClasses: ['docs'],
      exemptEvidence: ['classifier', 'affected-gates'],
      browserRoundtrip: {
        group: 'static', workflow: '.github/workflows/browser.yml', blocking: false,
        verdict: 'quarantined-failure', nextSessionPriority: true,
        requiredFields: ['sha', 'runId', 'gate', 'exitCode', 'cause', 'impact', 'reproduce', 'nextAction'],
      },
    },
    versioning: { trigger: 'app.html', baseline: 'origin/main', writer: 'node bump.mjs', history: 'app.html#history' },
    releaseNodes: [
      { id: 'closeout', kind: 'input-closeout', verdict: 'exit-code', writes: [] },
      { id: 'build', kind: 'artifact', verdict: 'exit-code', writes: ['artifact'] },
      { id: 'deploy', kind: 'deployment', verdict: 'live-readback', writes: ['live'] },
    ],
    releaseEdges: [
      { from: 'closeout', to: 'build', reason: '입력 마감 뒤에만 굽는다' },
      { from: 'build', to: 'deploy', reason: '배포 입력' },
    ],
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
    ['가변 커밋', (p) => { p.sharedLaw.commit = 'main'; }, '40자리'],
    ['노드 kind 누락', (p) => { delete p.releaseNodes[1].kind; }, 'kind가'],
    ['마감 노드 없음', (p) => { p.releaseNodes[0].kind = 'verification'; }, '입력 마감(input-closeout) 노드가 없다'],
    ['산출물이 마감보다 앞', (p) => { p.releaseEdges = [{ from: 'build', to: 'closeout', reason: '뒤집힌 순서' }, { from: 'closeout', to: 'deploy', reason: '배포 입력' }]; }, '입력 마감 뒤에 오지 않는'],
    ['마감을 우회하는 곁길', (p) => { p.releaseNodes.push({ id: 'hotfix', kind: 'integration', verdict: 'exit-code', writes: [] }); p.releaseEdges.push({ from: 'hotfix', to: 'build', reason: '마감을 건너뛴 곁길' }); }, '입력 마감 뒤에 오지 않는'],
    ['모르는 변경 면제', (p) => { p.verificationPolicy.unknown = 'exempt'; }, 'unknown은 full-required'],
    ['전체·면제 분류 중복', (p) => { p.verificationPolicy.exemptClasses.push('runtime'); }, '전체·면제에 함께'],
    ['브라우저 실패를 PASS로 세탁', (p) => { p.verificationPolicy.browserRoundtrip.verdict = 'passed'; }, 'quarantined-failure'],
    ['브라우저 격리 기록 누락', (p) => { p.verificationPolicy.browserRoundtrip.requiredFields = ['sha']; }, '필수 필드 누락'],
    ['다음 세션 우선순위 해제', (p) => { p.verificationPolicy.browserRoundtrip.nextSessionPriority = false; }, 'nextSessionPriority'],
    ['없는 브라우저 그룹', (p) => { p.verificationPolicy.browserRoundtrip.group = 'browser'; }, 'groups에 없다']
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
  console.log(`✅ 릴리스 프로필 통과 — 그룹 ${result.counts.groups} · 노드 ${result.counts.nodes}(입력 마감 ${result.counts.closeouts} · 산출물 ${result.counts.artifacts}) · 간선 ${result.counts.edges} · 러너 ${result.counts.writers} · 배포 표면 ${result.counts.surfaces}.`);
}
