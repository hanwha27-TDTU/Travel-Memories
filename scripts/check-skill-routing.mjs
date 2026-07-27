// check-skill-routing.mjs — **모든 코드 영역이 "먼저 읽을 문서"를 갖는가.**
//
// 왜(사용자 제안 2026-07-26): "적어놓고 어기는 이유는 읽지 않기 때문이죠. 그래서 아예 모든
// 코딩 시작 전 스킬문서부터 정독하고…" — 그런데 *어느* 문서를 읽을지 고르는 일을 기억에 맡기면
// 그 자체가 또 하나의 "형제 중 하나만 조용히 빠짐"이 된다. 그래서 경로→문서 라우팅 표를
// SSOT로 두고(`scripts/brief.mjs`의 SKILL_ROUTES), 이 게이트가 세 가지를 강제한다:
//
//  A) 라우팅 표가 가리키는 스킬 문서가 **실제로 존재**한다(오타·이름 변경으로 죽은 링크 금지).
//  B) `src/`의 모든 파일이 라우팅에 걸리거나, **이유가 적힌 제외 목록**에 있다.
//     (NO_SKILL_REQUIRED — 이유 없는 제외는 결함, §7)
//  C) 존재하는 스킬 문서 중 **아무 경로도 가리키지 않는 고아 문서**가 없다(문서가 코드와 떨어짐).
//
// 정직한 한계: 이 게이트는 "읽을 문서가 정해져 있는가"까지만 본다. **실제로 읽었는지**도,
// 문서 내용이 옳은지도 못 본다. 후자는 정독 단계에서 사람이 하고, 발견한 구멍은 그 자리에서
// 메운다(오늘 ui-responsive-dev에 vh/dvh 규칙이 아예 없던 것이 그 예다).

import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_ROUTES, NO_SKILL_REQUIRED } from './brief.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, ext, out = []) {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (ext.test(f)) out.push(relative(ROOT, p));
  }
  return out;
}

/**
 * 훑는 영역. **`src/`만 보던 것을 넓혔다**(2026-07-27 배포 중 실물로 드러남).
 *
 * `.github/workflows/`를 고치는데 `npm run brief`가 **"먼저 정독할 스킬 문서"를 하나도
 * 주지 않았다.** 라우팅 표에 그 경로가 없었고, 이 게이트는 `src/`만 훑었으므로 **누락이
 * 조용히 통과**했다 — 게이트 B조항("모든 파일이 라우팅에 걸린다")이 자기가 안 보는 영역에
 * 대해서는 공허했던 셈이다. 배포 경로는 틀리면 **전부가 막히는** 자리인데(M-0031) 정독
 * 문서가 없던 것이다.
 *
 * 새 영역을 넣을 때는 **그 영역의 파일 하나로 주입해 RED를 확인**한다(§2-B ① — 넓히기는
 * 새 게이트를 만드는 것과 같다).
 */
const SCAN = [
  { dir: 'src', ext: /\.(ts|css)$/ },
  { dir: '.github/workflows', ext: /\.ya?ml$/ },
];

export function unrouted(paths, routes, excluded) {
  return paths.filter((p) => !excluded.has(p) && !routes.some((r) => r.match.test(p)));
}

export function orphanSkills(routes, available) {
  const used = new Set(routes.map((r) => r.skill));
  return available.filter((s) => !used.has(s));
}

export function deadLinks(routes, available) {
  const have = new Set(available);
  return [...new Set(routes.map((r) => r.skill))].filter((s) => !have.has(s));
}

// ── 셀프테스트: 알려진 실패가 RED로 잡히는지(CLAUDE.md §4) ──
let selfTestCount = 0;
{
  const R = [{ match: /^src\/a\//, skill: 'alpha' }];
  const cases = [
    { name: '전부 라우팅됨', fn: () => unrouted(['src/a/x.ts'], R, new Map()), clean: true },
    { name: '라우팅 안 된 파일 검출', fn: () => unrouted(['src/b/y.ts'], R, new Map()), clean: false },
    { name: '이유 있는 제외는 통과', fn: () => unrouted(['src/b/y.ts'], R, new Map([['src/b/y.ts', '이유']])), clean: true },
    { name: '죽은 링크 검출(문서 없음)', fn: () => deadLinks(R, []), clean: false },
    { name: '살아 있는 링크 통과', fn: () => deadLinks(R, ['alpha']), clean: true },
    { name: '고아 문서 검출(아무도 안 가리킴)', fn: () => orphanSkills(R, ['alpha', 'beta']), clean: false },
    { name: '고아 없음 통과', fn: () => orphanSkills(R, ['alpha']), clean: true },
  ];
  const broken = cases.filter((c) => (c.fn().length === 0) !== c.clean);
  if (broken.length) {
    console.error(`check-skill-routing: 셀프테스트 실패 — 게이트가 공허함: ${broken.map((c) => c.name).join(', ')}`);
    process.exit(2);
  }
  // 성공 로그의 개수는 **배열에서 파생**한다. 여기 `7`이 손으로 박혀 있었다 — 케이스를
  // 늘려도 계속 7이라 말했을 것이고, 그건 이 저장소가 다른 게이트에서 이미 한 번 겪은
  // 결함이다("게이트 자신이 '숫자를 손으로 세지 않는다'를 어기고 있었다").
  selfTestCount = cases.length;
}

// ── 실제 검사 ──
const skillsDir = join(ROOT, '.claude/skills');
const available = existsSync(skillsDir)
  ? readdirSync(skillsDir).filter((d) => existsSync(join(skillsDir, d, 'SKILL.md')))
  : [];

const problems = [];
for (const s of deadLinks(SKILL_ROUTES, available)) {
  problems.push(`라우팅이 가리키는 문서가 없음: .claude/skills/${s}/SKILL.md`);
}
for (const s of orphanSkills(SKILL_ROUTES, available)) {
  problems.push(`고아 스킬 문서(아무 경로도 가리키지 않음): ${s} — 라우팅에 넣거나 문서를 정리할 것`);
}
const files = SCAN.flatMap((s) => walk(join(ROOT, s.dir), s.ext));
for (const p of unrouted(files, SKILL_ROUTES, NO_SKILL_REQUIRED)) {
  problems.push(`먼저 읽을 문서가 정해지지 않은 파일: ${p} — SKILL_ROUTES에 넣거나 NO_SKILL_REQUIRED에 **이유와 함께** 등록`);
}

if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('check-skill-routing: 착수 전 정독 라우팅이 불완전하다.');
  process.exit(1);
}
console.log(
  `check-skill-routing: OK (셀프테스트 ${selfTestCount}건 · 스킬 문서 ${available.length}개 전부 연결 · ${SCAN.map((s) => s.dir).join('+')} ${files.length}개 파일 라우팅 완료 · 이유 있는 제외 ${NO_SKILL_REQUIRED.size}개)`,
);
