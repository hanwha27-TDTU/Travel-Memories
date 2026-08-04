import { defineConfig } from 'vite';

// GitHub Pages 프로젝트 사이트는 /Travel-Memories/ 하위경로로 서빙된다(ADR-0010).
// BASE의 SSOT는 이 선언이다. 라우터는 import.meta.env.BASE_URL, index.html은
// %BASE_URL%로 파생되고, 빌드 변환을 못 거치는 manifest.webmanifest의 중복은
// check-base-consistency 게이트가 대조한다(손편집 드리프트 차단).
export const BASE = '/Travel-Memories/';

export default defineConfig({
  base: BASE,
  build: {
    target: 'es2022',
    // 저장소는 비공개이고 GitHub Pages 산출물은 공개다. 운영 소스맵은 원본 TS와
    // 내부 주석을 그대로 공개하므로 만들지 않는다. check-production-artifacts가 회귀를 막는다.
    sourcemap: false,
  },
  server: {
    port: 5173,
  },
});
