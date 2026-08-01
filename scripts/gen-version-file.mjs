#!/usr/bin/env node
// gen-version-file — 빌드 산출물에 **최신 버전 신호**(dist/version.json)를 심는다.
//
// 왜(2026-08-01 사용자): 셸·설치형 PWA는 페이지를 다시 로드할 일이 거의 없어(앱이 백그라운드에
// 살아 있다) 새 배포가 **열려 있는 화면에 닿지 않는다** — 배포는 초록인데 사용자 화면은 v1.46.
// 그래서 실행 중인 앱이 「지금 서버의 최신이 몇인가」를 물을 수 있는 파일을 배포에 심는다.
// 묻고 새로고침하는 쪽은 src/services/appUpdate.ts, 셋의 계약 일치는 check-update-signal 게이트.
//
// 버전의 SSOT는 changelog(맨 앞 항목)다 — 여기 다시 적으면 그 순간 두 진실이 생긴다(§7).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const version = readFileSync('src/app/changelog.ts', 'utf8').match(/version: '([\d.]+)'/)?.[1];
if (!version) {
  console.error('gen-version-file: changelog에서 버전을 못 읽었다.');
  process.exit(1);
}
if (!existsSync('dist')) {
  console.error('gen-version-file: dist가 없다 — vite build 다음에 돌아야 한다.');
  process.exit(1);
}
writeFileSync('dist/version.json', JSON.stringify({ version }) + '\n');
console.log(`gen-version-file: dist/version.json = ${version}`);
