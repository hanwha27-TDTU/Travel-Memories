// gen-module-design-docs.mjs — 실행 코드 → docs/모듈별 설계서/*.md writer.
// 손편집 문서를 보정하지 않고 기대 집합을 정확히 쓴다. 지운 모듈의 화석 문서도 제거한다.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectModuleDesigns, expectedDocuments, OUTPUT_DIR } from './module-design-docs-lib.mjs';

export function writeModuleDesignDocs() {
  const collected = collectModuleDesigns();
  const documents = expectedDocuments(collected);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const existing of readdirSync(OUTPUT_DIR)) {
    if (existing.endsWith('.md') && !documents.has(existing)) rmSync(join(OUTPUT_DIR, existing));
  }
  for (const [name, content] of documents) writeFileSync(join(OUTPUT_DIR, name), content, 'utf8');
  return { documentCount: documents.size, moduleCount: collected.modules.length, sourceCount: collected.inputs.length };
}

if (process.argv[1] && new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1)) === process.argv[1].replaceAll('\\', '/')) {
  const result = writeModuleDesignDocs();
  console.log(`gen-module-design-docs: ${result.moduleCount}개 모듈 · ${result.sourceCount}개 코드 입력 → 문서 ${result.documentCount}개 생성.`);
}
