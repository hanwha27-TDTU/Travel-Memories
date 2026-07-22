// check-secret-leak.mjs — 자격증명 형태 스캔 (docs/SECURITY.md)
// 키워드가 아니라 형태로 탐지: service_role JWT, postgres:// URL, secret 키 접두어.
// 소스 트리와 (있으면) 빌드 산출물(dist)을 스캔. 발견 시 비영 종료.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['src', 'index.html', 'public', 'dist'].filter(existsSync);
const SKIP = new Set(['node_modules', '.git', 'docs']);
const EXT = /\.(ts|tsx|js|mjs|cjs|json|html|css|webmanifest|map)$/;

const PATTERNS = [
  { name: 'postgres 연결 URL', re: /postgres(?:ql)?:\/\/[^\s"']+/ },
  { name: 'Supabase secret 키', re: /\bsb_secret_[A-Za-z0-9]/ },
  { name: 'service_role JWT', re: /"role"\s*:\s*"service_role"/ },
  // base64url JWT payload에 service_role이 들어간 경우까지 디코드 검사
  { name: 'service_role JWT(base64)', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/ },
];

let hits = 0;
function scanFile(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return; }
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (!m) continue;
    if (p.name.includes('base64')) {
      // JWT 후보 → payload 디코드해 service_role만 차단(anon/publishable은 허용)
      try {
        const payload = JSON.parse(Buffer.from(m[0].split('.')[1], 'base64url').toString('utf8'));
        if (payload.role !== 'service_role') continue;
      } catch { continue; }
    }
    console.error(`  ✗ [${p.name}] ${path}`);
    hits++;
  }
}
function walk(path) {
  const st = statSync(path);
  if (st.isDirectory()) {
    if (SKIP.has(path.split('/').pop())) return;
    for (const e of readdirSync(path)) walk(join(path, e));
  } else if (EXT.test(path)) {
    scanFile(path);
  }
}

for (const r of ROOTS) walk(r);
if (hits > 0) {
  console.error(`check-secret-leak: ${hits}건의 시크릿 형태 발견 — 배포 차단.`);
  process.exit(1);
}
console.log('check-secret-leak: OK (시크릿 형태 없음)');
