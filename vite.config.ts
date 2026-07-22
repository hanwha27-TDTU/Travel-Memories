import { defineConfig } from 'vite';

// GitHub Pages 프로젝트 사이트는 /Travel-Memories/ 하위경로로 서빙된다(ADR-0010).
// base를 여기서 고정하고, 라우터·SW·manifest 모두 이 값을 기준으로 한다.
export const BASE = '/Travel-Memories/';

export default defineConfig({
  base: BASE,
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
});
