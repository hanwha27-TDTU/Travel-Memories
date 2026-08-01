#!/usr/bin/env node
// check-real-coord — 「진짜 좌표인가」 판정을 손으로 두 번 쓰지 않는가.
//
// H-3(2026-08-01 감사·확정): 같은 판정(유한·범위·**0,0 아님**)이 여덟 곳에 손으로 있었고 이미
// 세 강도로 **갈라져 있었다** — 어떤 곳은 NaN을 막고 어떤 곳은 안 막아 `NaN, NaN`이 화면에
// 그려지고 "장소 있음"으로 통과했다. 헌법 M-0060: *"같은 판정을 두 번 쓰지 마라 — 갈라진다."*
//
// 이제 판정은 `src/domain/place/coordInput.ts`의 `isRealCoord` 하나다. 이 게이트는 그 함수 밖에서
// **좌표 0,0 리터럴 검사**(`…lat/lng… === 0 && …lat/lng… === 0`)가 다시 나타나는 것을 RED로
// 잡는다. 좌표가 아닌 0 검사(비네팅·밝기·개수)는 대상이 아니다 — 두 피연산자가 **좌표 이름**
// (lat/lng, 대소문자 무관)을 담을 때만 잡는다.
//
// §4: 셀프테스트가 주입한 실패로 RED를 먼저 확인한 뒤에만 실제 검사를 돈다.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const HOME_FILE = 'src/domain/place/coordInput.ts'; // isRealCoord가 사는 곳 — 여기만 리터럴 허용

// `<이름>Lat/lat ... === 0 && ... <이름>Lng/lng ... === 0` (혹은 lng가 먼저) — 좌표 0,0 검사.
// 두 피연산자 이름에 lat/lng가 들어가야 잡는다(비-좌표 0검사와 구분).
// `[\w.]*`로 멤버 접근(`m.gpsLng`)까지 피연산자에 포함한다 — 그 `.`이 없으면 두 번째 항을 놓친다.
const COORD_ZERO = /([\w.]*(?:lat|lng)\w*)\s*===\s*0\s*&&\s*([\w.]*(?:lat|lng)\w*)\s*===\s*0/i;

/** 한 소스에서 좌표 0,0 리터럴을 쓰는 줄들을 찾는다(주석 줄은 제외). */
export function coordZeroLines(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue; // 주석은 규칙을 설명할 수 있다
    const m = COORD_ZERO.exec(line);
    if (m && /lat/i.test(m[1] + m[2]) && /lng/i.test(m[1] + m[2])) out.push({ n: i + 1, text: line.trim() });
  }
  return out;
}

function selfTest() {
  const cases = [
    ['좌표 0,0 검사를 잡는다', () => coordZeroLines('const r = !(m.gpsLat === 0 && m.gpsLng === 0);').length === 1],
    ['placeLat/placeLng도 잡는다', () => coordZeroLines('x = placeLat === 0 && placeLng === 0;').length === 1],
    ['lat/lng 평문도 잡는다', () => coordZeroLines('if (lat === 0 && lng === 0) return;').length === 1],
    ['비네팅 0검사는 안 잡는다(오탐)', () => coordZeroLines('s.vignette === 0 && s.grainAmt === 0').length === 0],
    ['개수 0검사는 안 잡는다(오탐)', () => coordZeroLines('trips.length === 0 && kids.length === 0').length === 0],
    ['밝기·대비 0검사는 안 잡는다(오탐)', () => coordZeroLines('a.brightness === 0 && a.contrast === 0').length === 0],
    ['주석 줄은 안 잡는다', () => coordZeroLines('// lat === 0 && lng === 0 을 설명').length === 0],
    ['isRealCoord 본문(둘 다 lat/lng 아님)은 잡되 홈파일에서만 허용됨을 상위가 처리', () => coordZeroLines('return !(lat === 0 && lng === 0);').length === 1],
  ];
  const failed = cases.filter(([, fn]) => !fn());
  if (failed.length) {
    console.error('check-real-coord: 셀프테스트 실패 — 게이트가 공허하다(§4).');
    for (const [name] of failed) console.error(`  ✗ ${name}`);
    process.exit(2);
  }
}

selfTest();
if (process.argv.includes('--selftest')) {
  console.log('check-real-coord: 셀프테스트 통과');
  process.exit(0);
}

// src/의 모든 .ts를 훑되, isRealCoord가 사는 홈파일과 테스트는 제외한다.
const files = execSync('git ls-files "src/**/*.ts"', { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && f !== HOME_FILE && !f.endsWith('.test.ts'));

const problems = [];
for (const f of files) {
  for (const hit of coordZeroLines(readFileSync(f, 'utf8'))) {
    problems.push(`${f}:${hit.n}  ${hit.text}`);
  }
}

if (problems.length) {
  console.error('check-real-coord: 좌표 0,0 판정이 isRealCoord 밖에서 손으로 쓰였다(H-3 · M-0060).');
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(`  → ${HOME_FILE}의 isRealCoord(lat, lng)를 쓰세요 — 판정이 한 곳에만 있어야 갈라지지 않습니다.`);
  process.exit(1);
}
console.log(`check-real-coord: OK — 좌표 판정이 isRealCoord 한 곳에만 있습니다(${files.length}개 파일 확인).`);
