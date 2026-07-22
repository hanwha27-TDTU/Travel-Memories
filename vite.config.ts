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
    // 소스맵 공개는 의도된 선택: 공개 저장소라 감출 소스가 없고, 실기기
    // 오류 제보의 스택 해석(디버깅 가능성)을 우선한다.
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
});
