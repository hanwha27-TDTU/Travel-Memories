// gen-platform-map.mjs — "무엇이 어디서 도는가" 표를 **코드에서 실측해** 생성한다(LESSONS §7).
//
// 왜 생겼나(사용자 요청 2026-07-26): 대화에서 만든 표(로그인=Supabase Auth, 사진 바이트=R2 …)를
// 앱 가이드에 넣어 달라 하시며 덧붙이셨다 — *"이 내용을 적을 때 손으로 적지 말고 기계화시켜서
// 작성하게 설계해주세요."*
//
// 옳은 요구다. 이 표는 **가장 빨리 낡는 종류의 문서**다: 오늘 하루만 해도 사진 바이트가
// Supabase Storage → R2로 옮겨졌고(v0.86), 손으로 적었다면 그 순간 거짓이 됐다. 실제로 오늘
// 같은 형태의 사고를 세 번 겪었다 — M-0019(문서가 서술하는 현재 상태를 안 읽음)·M-0021(지표를
// 늘리며 문장을 안 고침)·M-0023(규칙을 바꾸며 옛것을 안 데려옴).
//
// ─────────────────────────────────────────────────────────────────────────────
// 설계: **주장하지 않고 증명한다**
// ─────────────────────────────────────────────────────────────────────────────
// 각 행은 "이렇다"가 아니라 **"이 파일의 이 자국이 있으면 이렇다"**로 쓴다(`evidence`).
// 자국이 사라지면 생성기가 다른 답을 내고, 게이트가 커밋본과 달라 RED가 된다.
// 그래서 코드를 바꾸면 표가 **저절로** 따라오거나, 안 따라오면 빌드가 멈춘다.
//
// 발전원(코드) → src/app/platformMap.gen.ts(파생) → 가이드 화면이 읽음. 손편집 금지.
// 사용: node scripts/gen-platform-map.mjs  (갱신) / --check (표준출력만, 게이트용)

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/app/platformMap.gen.ts');

const read = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '');
/** 주석을 걷어낸 코드 — 주석 속 옛 서술을 "현재 사실"로 읽지 않게(M-0006의 화석 방지). */
const code = (rel) => read(rel).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * 표의 행 정의. **각 행은 자기 답을 코드에서 찾아온다** — 여기에 정답을 적어두지 않는다.
 *
 * `probe()`는 `{ where, note }`를 돌려주거나, 판정할 수 없으면 null을 돌려준다(그 경우 생성기가
 * 멈춘다 — 모르는 것을 아는 척 적느니 빌드를 세우는 게 낫다, 비타협 원칙 #4).
 */
export const ROWS = [
  {
    id: 'auth',
    what: '로그인',
    detail: 'Google 계정 · 초대받은 사람만',
    evidence: 'src/services/auth.ts',
    probe: () => {
      const s = code('src/services/auth.ts');
      if (!/signInWithOAuth/.test(s)) return null;
      return { where: 'Supabase', part: 'Auth' };
    },
  },
  {
    id: 'records',
    what: '기록 전부',
    detail: '여행 · 순간 · 사진 정보 · 비용 · 영구삭제 원장',
    evidence: 'src/services/sync.ts',
    probe: () => {
      const s = code('src/services/sync.ts') + code('src/services/purge.ts') + code('src/services/storeState.ts');
      // `.from('x')` 직접 호출 + `const X = 'x'` 상수 경유 둘 다 센다. 상수를 안 보면
      // `client.from(LEDGER)` 같은 호출을 놓쳐 "기록이 서버에 없다"는 거짓 판정이 난다.
      const direct = [...s.matchAll(/\.from\('(\w+)'\)/g)].map((m) => m[1]);
      const viaConst = [...s.matchAll(/const\s+\w+\s*=\s*'(\w+)'/g)].map((m) => m[1]);
      const tables = new Set([...direct, ...viaConst]);
      const want = ['trips', 'moments', 'media', 'expenses', 'purged_ids'];
      if (!want.every((t) => tables.has(t))) return null;
      return { where: 'Supabase', part: 'Postgres' };
    },
  },
  {
    id: 'rls',
    what: '접근 통제',
    detail: '남이 내 기록을 못 보게',
    evidence: 'supabase/migrations/',
    probe: () => {
      // 정책이 실제로 존재하는가 — 마이그레이션에서 센다(개수는 손으로 적지 않는다).
      const n = migrationText().match(/create policy/gi)?.length ?? 0;
      return n > 0 ? { where: 'Supabase', part: 'RLS', count: n } : null;
    },
  },
  {
    id: 'sign',
    what: '사진 열쇠 발급',
    detail: '사진을 올리고 받을 때 쓰는 5분짜리 서명',
    evidence: 'supabase/functions/media-sign/index.ts',
    probe: () => {
      const fn = code('supabase/functions/media-sign/index.ts');
      const client = code('src/services/r2.ts');
      if (!/AWS4-HMAC-SHA256/.test(fn) || !/functions\.invoke/.test(client)) return null;
      return { where: 'Supabase', part: 'Edge Function' };
    },
  },
  {
    id: 'bytes',
    what: '사진 파일',
    detail: '사진 그 자체(바이트)',
    evidence: 'src/services/sync.ts',
    probe: () => {
      const s = code('src/services/sync.ts');
      // mediaRemote의 바이트 3종이 무엇을 쓰는지 **본다**. 오늘(v0.86) 여기가 바뀌었고,
      // 손으로 적은 표였다면 그 순간 거짓이 됐다.
      const m = s.match(/export function mediaRemote\([\s\S]*?\n\}/);
      if (!m) return null;
      const usesR2 = /r2BlobStore\(/.test(m[0]);
      const usesSupabase = /client\.storage\.from\(/.test(m[0]);
      if (usesR2 && !usesSupabase) return { where: 'Cloudflare', part: 'R2' };
      if (usesSupabase && !usesR2) return { where: 'Supabase', part: 'Storage' };
      return null; // 둘 다거나 둘 다 아니면 판정 불가 → 생성기가 멈춘다
    },
  },
  {
    id: 'local',
    what: '이 기기의 사본',
    detail: '오프라인에서도 열리는 진짜 원본',
    evidence: 'src/offline/db.ts',
    probe: () => (/extends Dexie/.test(code('src/offline/db.ts')) ? { where: '내 기기', part: '브라우저 저장소' } : null),
  },
  {
    id: 'hosting',
    what: '앱 화면',
    detail: '주소창에 치는 그 페이지',
    evidence: '.github/workflows/deploy-pages.yml',
    probe: () => (/actions\/deploy-pages/.test(read('.github/workflows/deploy-pages.yml')) ? { where: 'GitHub', part: 'Pages' } : null),
  },
];

function migrationText() {
  const dir = join(ROOT, 'supabase/migrations');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

export function collect() {
  return ROWS.map((r) => {
    const got = r.probe();
    if (!got) {
      throw new Error(
        `gen-platform-map: '${r.id}' 행을 코드에서 판정하지 못했습니다(${r.evidence}). ` +
          `구조가 바뀌었다면 probe를 고치세요 — 모르는 것을 표에 적지 않습니다.`,
      );
    }
    return { id: r.id, what: r.what, detail: r.detail, evidence: r.evidence, ...got };
  });
}

export function render(rows) {
  const body = rows
    .map(
      (r) =>
        `  {\n    id: '${r.id}',\n    what: '${r.what}',\n    detail: '${r.detail}',\n` +
        `    where: '${r.where}',\n    part: '${r.part}',\n    evidence: '${r.evidence}',\n  },`,
    )
    .join('\n');
  return `// app/platformMap.gen.ts — **자동 생성 파일. 손으로 고치지 마세요.**
//
// 생성: node scripts/gen-platform-map.mjs
// 게이트: check-platform-map (커밋본 == 재생성본을 강제)
//
// 각 행은 주장이 아니라 **코드에서 실측한 결과**다. 예컨대 '사진 파일'의 답은
// \`mediaRemote\`가 실제로 무엇을 쓰는지 읽어서 나온다 — 저장소를 바꾸면 표가 저절로
// 따라오고, 안 따라오면 게이트가 RED를 낸다.

export interface PlatformRow {
  id: string;
  /** 하는 일. */
  what: string;
  /** 한 줄 설명. */
  detail: string;
  /** 어느 서비스. */
  where: string;
  /** 그 서비스의 어느 부분. */
  part: string;
  /** 이 판정의 근거가 된 파일. */
  evidence: string;
}

export const PLATFORM_MAP: PlatformRow[] = [
${body}
];
`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const out = render(collect());
  if (process.argv.includes('--check')) process.stdout.write(out);
  else {
    writeFileSync(OUT, out);
    console.log('gen-platform-map: src/app/platformMap.gen.ts 갱신됨.');
  }
}
