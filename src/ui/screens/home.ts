// ui/screens/home.ts — 홈(빈 상태) 화면. Phase 0B 골격: 실제 데이터/기능 없음.
// empty-state-designer 원칙: 첫 여행 만들기를 안내한다.

import { isConfigured } from '../../services/supabase/client';

export function renderHome(mount: HTMLElement): void {
  const synced = isConfigured();
  mount.innerHTML = '';

  const wrap = document.createElement('main');
  wrap.className = 'screen screen-home';
  wrap.innerHTML = `
    <header class="app-header">
      <h1 class="app-title">🧳 Journey Archive</h1>
    </header>
    <section class="empty-state" role="status">
      <p class="empty-emoji" aria-hidden="true">✈️</p>
      <h2>첫 여행을 기록해보세요</h2>
      <p class="muted">사진 한 장과 한 줄이면 충분해요. 장소·시간은 자동으로 채워집니다.</p>
      <button class="btn-primary" type="button" disabled>새 여행 (준비 중)</button>
      <p class="sync-note muted">${synced ? '☁️ 클라우드 동기화 설정됨' : '📴 로컬 저장 모드 (동기화 미설정)'}</p>
    </section>
  `;
  mount.appendChild(wrap);
}
