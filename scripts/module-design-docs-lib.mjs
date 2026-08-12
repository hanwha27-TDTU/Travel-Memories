// module-design-docs-lib.mjs — 실행 코드에서 모듈별 설계서를 재생성하는 단일 정본.
//
// 설계서에 사람이 구조를 옮겨 적지 않는다. 이 파일은 모듈 **소유 경계**만 선언하고,
// 파일·심볼·시그니처·호출·의존성·I/O 경계·테스트 연결·내용 해시는 실제 저장소에서 뽑는다.
// 새 실행 파일이 어느 모듈에도 속하지 않으면 생성 자체가 실패한다. 문서가 조용히 낡는 대신
// 새 형제의 소유자를 먼저 결정하게 만드는 구조다(헌법 §2·§7).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT_DIR = join(ROOT, 'docs', '모듈별 설계서');
export const GENERATOR_VERSION = 1;

const MODULES = [
  {
    id: 'app-shell',
    file: '01-앱-셸과-라우팅.md',
    title: '앱 셸과 라우팅',
    boundary: '부팅, 화면 라우팅, 앱 공통 등록부·자가평가·변경이력과 최상위 조립을 소유한다.',
  },
  {
    id: 'travel-core',
    file: '02-여행-순간-핵심도메인.md',
    title: '여행·순간 핵심 도메인',
    boundary: 'Trip→TripDay→Moment의 시간 구조와 여행·순간 CRUD, 홈 집계 규칙을 소유한다.',
  },
  {
    id: 'offline-db',
    file: '03-오프라인-데이터베이스.md',
    title: '오프라인 데이터베이스와 Row Map',
    boundary: 'Dexie 스키마와 로컬 행·서버 행 변환 경계를 소유한다.',
  },
  {
    id: 'sync-canonical',
    file: '04-동기화와-정본전환.md',
    title: '오프라인 동기화와 정본 전환',
    boundary: 'operation 큐, pull/push, OCC, tombstone, canonical exact-set과 자동 동기화를 소유한다.',
  },
  {
    id: 'photo-storage',
    file: '05-사진-수집과-저장.md',
    title: '사진 수집·파생본·저장',
    boundary: '사진 입력, EXIF 선읽기, 파생본 생성, 앱 보관본 표시·저장과 R2 바이트 경계를 소유한다.',
  },
  {
    id: 'photo-editor',
    file: '06-사진편집기.md',
    title: '사진편집기',
    boundary: '비파괴 편집 상태, 픽셀 연산, 브러시·필터 UI와 편집 결과 렌더를 소유한다.',
  },
  {
    id: 'video-pipeline',
    file: '07-영상-처리-파이프라인.md',
    title: '영상 처리 파이프라인',
    boundary: '영상 파생본·포스터 생성, 저장·재생·다운로드와 서버 왕복을 소유한다. 독립 타임라인 편집기는 현재 코드에 없다.',
  },
  {
    id: 'audio-notes',
    file: '08-오디오-노트.md',
    title: '오디오 노트',
    boundary: '녹음·재생·저장과 오디오 행/바이트 생명주기를 소유한다.',
  },
  {
    id: 'backup-restore',
    file: '09-백업과-복원.md',
    title: '백업·복원·ZIP 무결성',
    boundary: '전체 백업 직렬화, ZIP/암호화, 형식 검증, 복원 병합과 왕복 진단을 소유한다.',
  },
  {
    id: 'trash-purge',
    file: '10-휴지통과-영구삭제.md',
    title: '휴지통·복원·영구삭제',
    boundary: 'soft delete, restore, purge, 연쇄 삭제와 잔재 판정을 소유한다.',
  },
  {
    id: 'diagnostics',
    file: '11-진단과-판정.md',
    title: '진단·무결성·사용자 판정',
    boundary: '진단 자료 수집, 정상/할 일/문제/확인 불가 판정, 보고서와 진단 화면을 소유한다.',
  },
  {
    id: 'map-place',
    file: '12-지도와-장소.md',
    title: '지도·장소·지오코딩',
    boundary: '좌표 유효성, 장소 레지스트리, 지도 표시, 외부 지도와 지오코더 경계를 소유한다.',
  },
  {
    id: 'expense-fx',
    file: '13-비용과-환율.md',
    title: '비용·통화·환율',
    boundary: '비용 행, 금액 표시, 기준통화 환산과 환율 공급 경계를 소유한다.',
  },
  {
    id: 'auth-security',
    file: '14-인증과-동의.md',
    title: '인증·Supabase 클라이언트·동의',
    boundary: '사용자 세션, 인증 게이트, Supabase 클라이언트와 개인정보·외부 전송 동의를 소유한다.',
  },
  {
    id: 'platform-runtime',
    file: '15-플랫폼과-파일저장.md',
    title: '플랫폼 런타임·파일 저장·업데이트',
    boundary: '브라우저/Capacitor 차이, 파일 저장 read-back, 앱·셸 업데이트와 기기 경계를 소유한다.',
  },
  {
    id: 'ui-shell',
    file: '16-화면과-상호작용.md',
    title: '화면·오버레이·상호작용',
    boundary: '공통 DOM, 화면·패널, 디자인 토큰, 토스트와 앱 전역 상호작용을 소유한다.',
  },
  {
    id: 'supabase-backend',
    file: '17-Supabase-백엔드.md',
    title: 'Supabase 스키마·RLS·Edge Function',
    boundary: '서버 스키마, migration, RLS/grant와 독립 배포 Edge Function을 소유한다.',
  },
  {
    id: 'quality-release',
    file: '18-검증과-릴리스-시스템.md',
    title: '검증 게이트·생성기·릴리스 시스템',
    boundary: '게이트 원장, 생성물, CI, 배포 워크플로, 릴리스 프로필과 공급망 검증을 소유한다.',
  },
];

export const MODULE_CATALOG = Object.freeze(MODULES.map((m) => Object.freeze({ ...m })));

const CODE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const INCLUDED_EXTENSIONS = new Set([
  ...CODE_EXTENSIONS,
  '.css',
  '.sql',
  '.json',
  '.yml',
  '.yaml',
  '.html',
  '.md',
]);

function slash(path) {
  return path.replaceAll('\\', '/');
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function isSourceInput(path) {
  const p = slash(relative(ROOT, path));
  if (p.startsWith('src/')) return INCLUDED_EXTENSIONS.has(extname(p));
  if (p.startsWith('supabase/')) return ['.ts', '.sql', '.json'].includes(extname(p));
  if (p.startsWith('scripts/')) return ['.mjs', '.js', '.py'].includes(extname(p));
  if (p.startsWith('.github/workflows/')) return ['.yml', '.yaml'].includes(extname(p));
  if (p.startsWith('.githooks/')) return true;
  if (p.startsWith('schemas/')) return extname(p) === '.json';
  return [
    'package.json',
    'package-lock.json',
    'vite.config.ts',
    'tsconfig.json',
    'index.html',
    '.nvmrc',
    'public/sw.js',
    'public/manifest.webmanifest',
  ].includes(p);
}

export function sourceInputs(root = ROOT) {
  const roots = ['src', 'supabase', 'scripts', '.github/workflows', '.githooks', 'schemas', 'public'];
  const files = roots.flatMap((dir) => walk(join(root, dir)));
  for (const name of ['package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'index.html', '.nvmrc']) {
    const full = join(root, name);
    if (existsSync(full)) files.push(full);
  }
  return [...new Set(files.filter(isSourceInput))].sort((a, b) => slash(relative(root, a)).localeCompare(slash(relative(root, b)), 'ko'));
}

/**
 * 파일의 단일 소유자. 경로 이름은 기능의 증거가 아니라 **소유 경계**다. 실제 동작은 아래 AST·
 * I/O 추출이 재며, 새 파일이 어느 경계에도 없으면 null로 닫힌다.
 */
export function moduleIdOf(input) {
  const p = slash(typeof input === 'string' && input.startsWith(ROOT) ? relative(ROOT, input) : input);
  if (/^(scripts|\.github\/workflows|\.githooks|schemas)\//.test(p) || /^(package(?:-lock)?\.json|vite\.config\.ts|tsconfig\.json|index\.html|\.nvmrc|public\/(?:sw\.js|manifest\.webmanifest))$/.test(p)) return 'quality-release';
  if (p.startsWith('supabase/')) return 'supabase-backend';
  if (p === 'src/main.ts' || p.startsWith('src/app/')) return 'app-shell';
  if (p.startsWith('src/offline/') || /\/rowmap\.ts$/.test(p)) return 'offline-db';
  if (p.startsWith('src/sync/') || /^src\/services\/(?:sync|syncParity|syncPlan|canonicalSync|autoSync)\.ts$/.test(p) || /^src\/domain\/(?:deviceFleetVerdict|sync[^/]*)\.ts$/.test(p)) return 'sync-canonical';
  if (/^src\/(?:media\/(?:editor-core|pixelops)|ui\/photoEditor)\.ts$/.test(p)) return 'photo-editor';
  if (/^src\/(?:media\/video|services\/(?:videos|videoRoundTrip)|ui\/videoViewer|domain\/(?:video\/.*|videoRoundTripVerdict))\.ts$/.test(p)) return 'video-pipeline';
  if (/^src\/(?:services\/audio|ui\/audioNote|domain\/audio\/.*)\.ts$/.test(p)) return 'audio-notes';
  if (/^src\/services\/(?:backup|backupCrypto|backupMeta|backupRoundTrip|zip)\.ts$/.test(p)) return 'backup-restore';
  if (/^src\/(?:services\/(?:trash|trashState|purge)|domain\/trashVerdict)\.ts$/.test(p)) return 'trash-purge';
  if (/^src\/(?:services\/(?:diagnostics|envReport|fileReality|roundTrip|serverContract|sessionState|syncReleaseDiagnostics|placeZombieAudit)|domain\/(?:diagGroups|diagnosticReport|fileRealityVerdict|integrity|gateControlView|placeProviderVerdict|placeZombieVerdict|roundTripVerdict|serverContractVerdict|sessionVerdict|syncReleaseVerdict|syncStatusVerdict|syncTombstoneVerdict)|ui\/(?:panels\/.*|screens\/(?:diagnosticsHub|mechChecks)))\.ts$/.test(p)) return 'diagnostics';
  if (/^src\/(?:services\/(?:places|geocode|here|externalMapConsent)|domain\/place\/.*|ui\/(?:externalMapRow|screens\/(?:mapView|placeRegistry)))\.ts$/.test(p)) return 'map-place';
  if (/^src\/(?:services\/(?:expenses|fx)|domain\/expense\/.*)\.ts$/.test(p)) return 'expense-fx';
  if (/^src\/(?:services\/(?:auth|consent)|services\/supabase\/client|domain\/authGate)\.ts$/.test(p)) return 'auth-security';
  if (/^src\/services\/(?:capacitorShell|fileSave|shellUpdate|appUpdate|nativePhotos)\.ts$/.test(p)) return 'platform-runtime';
  if (/^src\/(?:media\/(?:compress|exif)|services\/(?:media|r2|storage)|domain\/media\/.*|ui\/(?:mediaSave|photoViewer|pickOriginal))\.ts$/.test(p)) return 'photo-storage';
  if (/^src\/(?:services\/(?:trips|moments|homeZone)|domain\/(?:moment\/.*|trip\/.*|registry|time))\.ts$/.test(p)) return 'travel-core';
  if (p.startsWith('src/ui/') || p === 'src/services/storeState.ts' || p === 'src/domain/persistAdvice.ts') return 'ui-shell';
  return null;
}

function logical(text) {
  return text.replaceAll('\r\n', '\n');
}

function hashFiles(files) {
  const hash = createHash('sha256');
  for (const f of files) {
    hash.update(slash(relative(ROOT, f)));
    hash.update('\0');
    hash.update(logical(readFileSync(f, 'utf8')));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function scriptKind(path) {
  const ext = extname(path);
  if (['.js', '.mjs', '.cjs'].includes(ext)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function oneLine(text, max = 220) {
  const clean = text.replace(/\s+/g, ' ').replaceAll('|', '\\|').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function hasExport(node) {
  return Boolean(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

function docOf(node, sf) {
  const docs = ts.getJSDocCommentsAndTags(node).map((d) => d.getText(sf)).join(' ');
  return oneLine(docs.replace(/^\/\*\*?|\*\/$/g, '').replace(/\s*\*\s*/g, ' '), 180);
}

function callsOf(node, sf) {
  const calls = new Set();
  function visit(child) {
    if (ts.isCallExpression(child)) calls.add(oneLine(child.expression.getText(sf), 60));
    ts.forEachChild(child, visit);
  }
  ts.forEachChild(node, visit);
  return [...calls].slice(0, 10);
}

function declarationsOf(sf) {
  const out = [];
  for (const node of sf.statements) {
    const visibility = hasExport(node) ? 'export' : 'internal';
    if (ts.isFunctionDeclaration(node) && node.name) {
      const params = node.parameters.map((p) => oneLine(p.getText(sf), 80)).join(', ');
      out.push({
        visibility,
        kind: node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async function' : 'function',
        name: node.name.text,
        signature: `${node.name.text}(${params})${node.type ? `: ${oneLine(node.type.getText(sf), 100)}` : ''}`,
        calls: callsOf(node, sf),
        doc: docOf(node, sf),
      });
    } else if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      if (!node.name) continue;
      out.push({ visibility, kind: ts.SyntaxKind[node.kind].replace('Declaration', '').toLowerCase(), name: node.name.text, signature: node.name.text, calls: callsOf(node, sf), doc: docOf(node, sf) });
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        const name = oneLine(decl.name.getText(sf), 80);
        const callable = decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));
        const params = callable ? decl.initializer.parameters.map((p) => oneLine(p.getText(sf), 80)).join(', ') : '';
        out.push({
          visibility,
          kind: callable ? 'function const' : 'const',
          name,
          signature: callable ? `${name}(${params})${decl.type ? `: ${oneLine(decl.type.getText(sf), 100)}` : ''}` : `${name}${decl.type ? `: ${oneLine(decl.type.getText(sf), 120)}` : ''}`,
          calls: callable ? callsOf(decl.initializer, sf) : [],
          doc: docOf(node, sf),
        });
      }
    }
  }
  return out;
}

function importsOf(sf) {
  const imports = [];
  for (const node of sf.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
  }
  return [...new Set(imports)];
}

function resolveImport(fromFile, specifier, allPaths) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, ...['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'].map((ext) => `${base}${ext}`), ...['index.ts', 'index.js', 'index.mjs'].map((name) => join(base, name))];
  return candidates.find((p) => allPaths.has(resolve(p))) ?? null;
}

function matches(text, regex) {
  return [...text.matchAll(regex)].map((m) => m[1]).filter(Boolean);
}

function signalsOf(path, text) {
  const signals = [];
  const localTables = [...new Set([
    ...matches(text, /\b(?:db\(\)|d)\.(local[A-Z][A-Za-z0-9_]*)/g),
    ...matches(text, /\b(local[A-Z][A-Za-z0-9_]*)\.(?:add|put|update|delete|bulkPut|bulkAdd|bulkDelete)\s*\(/g),
  ])].sort();
  const serverTables = [...new Set(matches(text, /\.from\(\s*['"]([^'"]+)['"]\s*\)/g))].sort();
  const sqlTables = [...new Set(matches(text, /\b(?:create\s+table(?:\s+if\s+not\s+exists)?|alter\s+table)\s+(?:["\w]+\.)?["']?([\w]+)["']?/gi))].sort();
  const sqlFunctions = [...new Set(matches(text, /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:["\w]+\.)?["']?([\w]+)["']?/gi))].sort();
  if (localTables.length) signals.push(`Dexie: ${localTables.join(', ')}`);
  if (serverTables.length) signals.push(`Supabase table: ${serverTables.join(', ')}`);
  if (sqlTables.length) signals.push(`SQL table: ${sqlTables.join(', ')}`);
  if (sqlFunctions.length) signals.push(`SQL function: ${sqlFunctions.join(', ')}`);
  const flags = [
    [/\bfetch\s*\(/, 'network fetch'],
    [/\.invoke\s*\(/, 'Edge Function invoke'],
    [/\b(?:Blob|File|FileReader|FileSystemFileHandle)\b/, 'file/blob bytes'],
    [/\b(?:crypto\.subtle|createHash|SHA-?256|CRC32)\b/i, 'integrity/crypto'],
    [/\b(?:indexedDB|Dexie|transaction\s*\()\b/, 'transactional persistence'],
    [/\b(?:delete|purge|tombstone|deletedAt|deleted_at)\b/i, 'deletion lifecycle'],
    [/\b(?:Worker|OffscreenCanvas|CanvasRenderingContext2D|VideoEncoder|AudioEncoder|MediaRecorder)\b/, 'browser media worker/codec'],
    [/\b(?:document\.|querySelector|addEventListener|HTMLElement)\b/, 'DOM interaction'],
    [/\b(?:Capacitor|Android|Filesystem|native)\b/i, 'platform bridge'],
    [/\b(?:localStorage|sessionStorage)\b/, 'browser key/value storage'],
  ];
  for (const [pattern, label] of flags) if (pattern.test(text)) signals.push(label);
  if (path.endsWith('.yml') || path.endsWith('.yaml')) {
    const jobs = [...new Set(matches(text, /^\s{2}([A-Za-z0-9_-]+):\s*$/gm))];
    if (jobs.length) signals.push(`workflow jobs: ${jobs.join(', ')}`);
  }
  return signals;
}

function analyzeFile(full, allPaths) {
  const path = slash(relative(ROOT, full));
  const text = logical(readFileSync(full, 'utf8'));
  const lines = text.split('\n').length;
  const code = CODE_EXTENSIONS.has(extname(path));
  let declarations = [];
  let imports = [];
  if (code) {
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
    declarations = declarationsOf(sf);
    imports = importsOf(sf);
  }
  const localImports = imports.map((specifier) => ({ specifier, resolved: resolveImport(full, specifier, allPaths) })).filter((x) => x.resolved);
  const externalImports = imports.filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:'));
  return { full, path, text, lines, declarations, localImports, externalImports, signals: signalsOf(path, text) };
}

function collectTestEvidence(allPaths, moduleOfPath) {
  const tests = walk(join(ROOT, 'tests')).filter((f) => CODE_EXTENSIONS.has(extname(f)));
  const evidence = new Map(MODULE_CATALOG.map((module) => [module.id, new Set()]));
  for (const test of tests) {
    const text = logical(readFileSync(test, 'utf8'));
    const sf = ts.createSourceFile(test, text, ts.ScriptTarget.Latest, true, scriptKind(test));
    for (const specifier of importsOf(sf)) {
      const resolved = resolveImport(test, specifier, allPaths);
      const owner = resolved ? moduleOfPath.get(resolve(resolved)) : null;
      if (owner) evidence.get(owner)?.add(slash(relative(ROOT, test)));
    }
  }
  return evidence;
}

export function collectModuleDesigns() {
  const inputs = sourceInputs();
  if (inputs.length === 0) throw new Error('module-design: 입력 모집단이 0개입니다(공허 생성 차단).');
  const unknown = inputs.filter((file) => !moduleIdOf(file));
  if (unknown.length) throw new Error(`module-design: 소유 모듈이 없는 실행 파일 ${unknown.length}개:\n${unknown.map((f) => `  - ${slash(relative(ROOT, f))}`).join('\n')}`);
  const allPaths = new Set(inputs.map((file) => resolve(file)));
  const analyses = inputs.map((file) => analyzeFile(file, allPaths));
  const moduleOfPath = new Map(analyses.map((file) => [resolve(file.full), moduleIdOf(file.full)]));
  const testsByModule = collectTestEvidence(allPaths, moduleOfPath);
  const incoming = new Map(analyses.map((file) => [resolve(file.full), 0]));
  for (const file of analyses) for (const dep of file.localImports) incoming.set(resolve(dep.resolved), (incoming.get(resolve(dep.resolved)) ?? 0) + 1);

  const modules = MODULE_CATALOG.map((definition) => {
    const files = analyses.filter((file) => moduleIdOf(file.full) === definition.id);
    if (files.length === 0) throw new Error(`module-design: '${definition.id}' 모듈 모집단이 0개입니다.`);
    const edges = new Map();
    for (const file of files) {
      for (const dep of file.localImports) {
        const target = moduleOfPath.get(resolve(dep.resolved));
        if (target && target !== definition.id) edges.set(target, (edges.get(target) ?? 0) + 1);
      }
    }
    const entryPoints = files.filter((file) => (incoming.get(resolve(file.full)) ?? 0) === 0).map((file) => file.path);
    return {
      ...definition,
      files,
      hash: hashFiles(files.map((f) => f.full)),
      lines: files.reduce((sum, file) => sum + file.lines, 0),
      declarations: files.reduce((sum, file) => sum + file.declarations.length, 0),
      exports: files.reduce((sum, file) => sum + file.declarations.filter((d) => d.visibility === 'export').length, 0),
      externalImports: [...new Set(files.flatMap((file) => file.externalImports))].sort(),
      edges: [...edges.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      entryPoints: entryPoints.length ? entryPoints : files.slice(0, 1).map((f) => f.path),
      tests: [...(testsByModule.get(definition.id) ?? [])].sort(),
    };
  });
  return { inputs, modules };
}

function md(value) {
  return value ? value.replaceAll('|', '\\|') : '—';
}

function renderFileInventory(module) {
  return module.files
    .map((file) => {
      const publicCount = file.declarations.filter((d) => d.visibility === 'export').length;
      const deps = file.localImports.map((d) => slash(relative(ROOT, d.resolved))).join('<br>');
      return `| \`${file.path}\` | ${file.lines} | ${publicCount}/${file.declarations.length} | ${md(deps)} | ${md(file.signals.join('; '))} |`;
    })
    .join('\n');
}

function renderDeclarations(module) {
  const rows = [];
  for (const file of module.files) {
    for (const item of file.declarations) {
      rows.push(`| \`${file.path}\` | ${item.visibility} | ${item.kind} | \`${md(item.signature)}\` | ${md(item.calls.join(', '))} | ${md(item.doc)} |`);
    }
  }
  return rows.length ? rows.join('\n') : '| — | — | — | 선언 추출 대상 없음 | — | CSS·SQL·JSON·워크플로는 파일/경계 표에서 추적 |';
}

export function renderModuleDoc(module, catalog = MODULE_CATALOG) {
  const titleOf = new Map(catalog.map((m) => [m.id, m.title]));
  const hotspots = [...module.files].sort((a, b) => b.lines - a.lines).slice(0, 10);
  return `---
shape: prose
shape_reason: 책임→흐름→파일→API→검증→한계가 복구 순서로 이어지는 생성 기술서라 순서 자체가 내용이다.
---
<!-- GENERATED by scripts/gen-module-design-docs.mjs. DO NOT EDIT. -->
# ${module.title} 설계서

> **생성물 · 손편집 금지.** 정본은 아래에 열거된 실행 코드다. 코드 변경 뒤 \`npm run gen:module-designs\`를 실행한다. \`check-module-design-docs\`가 커밋본과 재생성본을 글자 단위로 대조한다.

## 1. 책임과 현재 경계

${module.boundary}

- 모듈 ID: \`${module.id}\`
- 관측 파일: ${module.files.length}개 · 논리 줄: ${module.lines} · 최상위 선언: ${module.declarations}개(외부 공개 ${module.exports}개)
- 코드 내용 SHA-256: \`${module.hash}\`
- 생성기 스키마: ${GENERATOR_VERSION}

## 2. 진입점과 모듈 간 흐름

### 관측된 진입점

${module.entryPoints.map((p) => `- \`${p}\``).join('\n')}

### 다른 모듈로 나가는 정적 의존

${module.edges.length ? module.edges.map(([id, count]) => `- ${titleOf.get(id) ?? id}(\`${id}\`): import/re-export ${count}건`).join('\n') : '- 다른 소유 모듈로 나가는 정적 import가 관측되지 않았다.'}

### 외부 패키지/런타임 의존

${module.externalImports.length ? module.externalImports.map((p) => `- \`${p}\``).join('\n') : '- Node 내장 또는 저장소 내부 모듈만 정적으로 import한다.'}

## 3. 파일·저장소·외부 경계

| 파일 | 줄 | export/선언 | 저장소 내부 의존 | 코드에서 관측한 I/O·생명주기 신호 |
|---|---:|---:|---|---|
${renderFileInventory(module)}

## 4. 최상위 API와 내부 조립점

| 파일 | 공개성 | 종류 | 시그니처 | 본문에서 관측한 호출(최대 10) | 코드 주석/JSDoc |
|---|---|---|---|---|---|
${renderDeclarations(module)}

## 5. 자동 검증 연결

${module.tests.length ? module.tests.map((p) => `- \`${p}\``).join('\n') : '- 이 모듈 파일을 정적으로 import하는 유닛 테스트가 관측되지 않았다. 이는 미검증 판정이 아니라 **직접 import 증거 없음**이다.'}

## 6. 복구 시 먼저 볼 큰 파일

${hotspots.map((f) => `- \`${f.path}\` — ${f.lines}줄`).join('\n')}

## 7. 이 설계서가 증명하는 것과 못 하는 것

- 증명: 생성 당시 파일 모집단, 내용 해시, 최상위 선언·시그니처, 정적 import, 코드에 나타난 저장소/네트워크/파일/삭제 경계, 직접 import 테스트 연결.
- 확인 불가: 런타임 호출 순서, 동적 문자열 import, 운영 Supabase/R2의 현재 상태, 브라우저·실기기 렌더 품질, 사용자 데이터의 실제 분포.
- 함수 본문이 바뀌어 추출 표가 같아도 **내용 해시가 달라져** 재생성을 강제한다. 그러나 해시 변화가 설계 의미를 설명해 주지는 않으므로, 중요한 의도·불변식은 코드 타입·이름·JSDoc·테스트로 먼저 표현해야 한다.
`;
}

export function renderIndex(collected) {
  const totalLines = collected.modules.reduce((sum, m) => sum + m.lines, 0);
  const graph = collected.modules.flatMap((m) => m.edges.map(([target, count]) => `- \`${m.id}\` → \`${target}\`: ${count}건`));
  return `---
shape: prose
shape_reason: 생성 계약→모듈 색인→의존 그래프→한계 순으로 읽는 복구 진입점이라 순서 자체가 내용이다.
---
<!-- GENERATED by scripts/gen-module-design-docs.mjs. DO NOT EDIT. -->
# 모듈별 설계서

이 폴더는 비상 복구·재현·이식 시 **현재 코드가 실제로 어떤 구조인지** 되살리기 위한 생성 문서다. 사람이 구현을 요약해 옮겨 적는 문서가 아니다.

## 생성 계약

1. \`scripts/module-design-docs-lib.mjs\`가 실행 파일 모집단과 단일 소유 모듈을 정한다.
2. \`npm run gen:module-designs\`가 파일·심볼·시그니처·호출·의존성·I/O 신호·테스트 연결·내용 해시를 추출한다.
3. \`node scripts/check-module-design-docs.mjs\`가 커밋본과 재생성본을 글자 단위로 비교한다.
4. 새 실행 파일이 미분류되거나 모듈이 비면 생성과 검사가 실패한다.
5. 생성 writer/check 쌍은 릴리스 입력 마감 원장에 들어가므로, 설계서를 갱신하지 않은 코드 후보는 릴리스 경계를 통과할 수 없다.

현재 모집단은 ${collected.inputs.length}개 파일, ${collected.modules.length}개 모듈, ${totalLines}개 논리 줄이다. 이 숫자는 생성기가 매번 다시 센다.

## 설계서 목록

| 순서 | 모듈 | 파일 | 관측 파일 | 논리 줄 | 내용 SHA-256 |
|---:|---|---|---:|---:|---|
${collected.modules.map((m, index) => `| ${index + 1} | ${m.title} | [${m.file}](./${encodeURI(m.file)}) | ${m.files.length} | ${m.lines} | \`${m.hash.slice(0, 16)}…\` |`).join('\n')}

## 모듈 의존 그래프(정적 import/re-export)

${graph.length ? graph.join('\n') : '- 모듈 간 정적 의존이 관측되지 않았다.'}

## 정직한 한계

이 문서는 **코드의 정적 구조와 내용 동일성**을 재현한다. 운영 데이터·배포 상태·런타임 순서·실기기 화면을 확인한 증거는 아니다. 그런 사실은 진단 도구, 왕복검사, 라이브 브라우저, 배포 read-back이 각각 맡는다.
`;
}

export function expectedDocuments(collected = collectModuleDesigns()) {
  const documents = new Map([['README.md', renderIndex(collected)]]);
  for (const module of collected.modules) documents.set(module.file, renderModuleDoc(module));
  return documents;
}
