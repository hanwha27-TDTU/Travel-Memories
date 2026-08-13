import { readFileSync } from 'node:fs';

/** changelog 맨 앞 항목에서 앱 버전을 읽는다. 모든 배포 표면이 이 파서를 공유한다. */
export function parseAppVersion(source) {
  return source.match(/version: '([\d.]+)'/)?.[1] ?? null;
}

export function readAppVersion(path = 'src/app/changelog.ts') {
  const version = parseAppVersion(readFileSync(path, 'utf8'));
  if (!version) throw new Error(`${path}에서 앱 버전을 읽지 못했습니다.`);
  return version;
}
