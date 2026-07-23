// ui/screens/dataManager.ts — '데이터 관리' 허브. 백업·복원·휴지통·가이드를 한 곳에.
// 비타협 원칙 #1(기억을 잃지 않는다)의 사용자 도구. 가이드 모달과 같은 시각 시스템(.guide-*) 재사용.
// 모든 자유 텍스트는 textContent로만(innerHTML 금지 — CSP·XSS 게이트).

import { el } from '../dom';
import { openGuide } from './guide';
import { exportBackup, importBackup } from '../../services/backup';
import { listDeletedTrips, restoreTripFromTrash, purgeTripPermanently } from '../../services/trips';

interface DataManagerOpts {
  /** 데이터가 바뀌면 호출(홈 목록·통계 갱신). */
  onChanged: () => void;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = el('a') as HTMLAnchorElement;
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── 상세 패널: 백업(내보내기) ────────────────────────────────────────
function backupPanel(): HTMLElement {
  const box = el('div', 'guide-detail-body');
  box.append(
    el('h3', 'guide-h', '완전 백업 파일 만들기'),
    el('p', 'guide-p', '여행·순간·장소·감정과 사진(원본·표시본)을 하나의 JSON 파일로 내려받습니다. 다른 기기로 옮기거나, 브라우저 데이터가 지워져도 이 파일로 되살릴 수 있어요.'),
  );
  const status = el('p', 'dm-status');
  status.setAttribute('role', 'status');
  const btn = el('button', 'btn-primary dm-wide', '💾 백업 파일 내보내기') as HTMLButtonElement;
  btn.type = 'button';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    status.textContent = '백업 만드는 중…';
    void (async () => {
      try {
        const { blob, stats } = await exportBackup(true);
        const stamp = fmtDate(new Date().toISOString()).replace(/\./g, '');
        downloadBlob(blob, `bugeon-journey-backup-${stamp}.json`);
        status.textContent = `✅ 내보냄 · 여행 ${stats.trips} · 순간 ${stats.moments} · 사진 ${stats.media} · ${fmtBytes(blob.size)}`;
      } catch (err) {
        status.textContent = `내보내기 실패: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        btn.disabled = false;
      }
    })();
  });
  box.append(btn, status, el('p', 'guide-note', '사진을 포함하므로 사진이 많으면 파일이 커질 수 있어요(수 MB~). 안전한 곳에 보관하세요.'));
  return box;
}

// ── 상세 패널: 복원(가져오기) ────────────────────────────────────────
function restorePanel(onChanged: () => void): HTMLElement {
  const box = el('div', 'guide-detail-body');
  box.append(
    el('h3', 'guide-h', '백업 파일에서 복원'),
    el('p', 'guide-p', '내보낸 JSON 백업을 불러와 병합합니다. 덮어쓰기가 아니라 병합이에요 — 최신 기록이 우선(LWW)이고, 백업이 비어 있으면 현재 데이터를 지우지 않습니다.'),
  );
  const status = el('p', 'dm-status');
  status.setAttribute('role', 'status');
  const fileInput = el('input', 'dm-file') as HTMLInputElement;
  fileInput.type = 'file';
  fileInput.accept = 'application/json,.json';
  const label = el('label', 'btn-primary dm-wide');
  label.append(document.createTextNode('📥 백업 파일 선택'), fileInput);
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    status.textContent = '복원 중…';
    void (async () => {
      try {
        const text = await file.text();
        const r = await importBackup(text);
        if (r.skippedEmptyGuard) {
          status.textContent = '⚠️ 백업이 비어 있어 건너뛰었어요(현재 데이터 보존).';
        } else {
          status.textContent = `✅ 복원됨 · 여행 ${r.trips} · 순간 ${r.moments} · 사진 ${r.media} 반영`;
          onChanged();
        }
      } catch (err) {
        status.textContent = `복원 실패: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        fileInput.value = '';
      }
    })();
  });
  box.append(label, status, el('p', 'guide-note', '같은 기록은 최신본만 반영되고, 삭제(tombstone)도 함께 복원됩니다.'));
  return box;
}

// ── 상세 패널: 휴지통 ────────────────────────────────────────────────
function trashPanel(onChanged: () => void): HTMLElement {
  const box = el('div', 'guide-detail-body');
  box.append(
    el('h3', 'guide-h', '삭제한 여행'),
    el('p', 'guide-p', '삭제한 여행을 되살리거나, 이 기기에서 영구히 지워 저장공간을 비울 수 있어요.'),
  );
  const list = el('div', 'dm-trash-list');
  box.appendChild(list);

  const render = (): void => {
    void (async () => {
      const trips = await listDeletedTrips();
      list.innerHTML = '';
      if (trips.length === 0) {
        list.appendChild(el('p', 'guide-note', '휴지통이 비어 있어요.'));
        return;
      }
      for (const t of trips) {
        const row = el('div', 'dm-trash-row');
        const info = el('div', 'dm-trash-info');
        info.append(
          el('b', undefined, t.title),
          el('span', 'dm-trash-meta', t.deletedAt ? `삭제 ${fmtDate(t.deletedAt)}` : ''),
        );
        const actions = el('div', 'dm-trash-actions');
        const restore = el('button', 'btn-ghost', '↩ 복원') as HTMLButtonElement;
        restore.type = 'button';
        restore.addEventListener('click', () => {
          restore.disabled = true;
          void (async () => {
            try {
              await restoreTripFromTrash(t.id);
              onChanged();
              render();
            } catch {
              restore.disabled = false;
            }
          })();
        });
        // 영구삭제: 2단계 확인(실수 방지).
        const purge = el('button', 'btn-danger', '영구삭제') as HTMLButtonElement;
        purge.type = 'button';
        const confirmBtn = el('button', 'btn-danger', '정말 지움') as HTMLButtonElement;
        confirmBtn.type = 'button';
        confirmBtn.hidden = true;
        purge.addEventListener('click', () => {
          purge.hidden = true;
          confirmBtn.hidden = false;
        });
        confirmBtn.addEventListener('click', () => {
          confirmBtn.disabled = true;
          void (async () => {
            try {
              await purgeTripPermanently(t.id);
              onChanged();
              render();
            } catch {
              confirmBtn.disabled = false;
            }
          })();
        });
        actions.append(restore, purge, confirmBtn);
        row.append(info, actions);
        list.appendChild(row);
      }
    })();
  };
  render();
  box.appendChild(el('p', 'guide-note', '영구삭제는 되돌릴 수 없어요. 동기화를 쓰면 다른 기기에 남은 기록이 되살아날 수 있습니다.'));
  return box;
}

// ── 허브 카드 정의 ───────────────────────────────────────────────────
interface HubCard {
  icon: string;
  label: string;
  hint: string;
  open: (host: {
    detail: (title: string, node: HTMLElement) => void;
    close: () => void;
  }) => void;
}

function cards(onChanged: () => void): HubCard[] {
  return [
    { icon: '💾', label: '백업 (내보내기)', hint: '기억을 파일로 저장', open: (h) => h.detail('💾 백업 (내보내기)', backupPanel()) },
    { icon: '📥', label: '복원 (가져오기)', hint: '백업 파일에서 병합 복원', open: (h) => h.detail('📥 복원 (가져오기)', restorePanel(onChanged)) },
    { icon: '🗑', label: '휴지통', hint: '삭제한 여행 복원·영구삭제', open: (h) => h.detail('🗑 휴지통', trashPanel(onChanged)) },
    { icon: '📖', label: '가이드', hint: '연결·설정과 개발·설계 안내', open: (h) => { h.close(); openGuide(); } },
  ];
}

/** '데이터 관리' 허브를 연다. 현재 화면 위에 오버레이로 뜬다. */
export function openDataManager(opts: DataManagerOpts): void {
  const prevFocus = document.activeElement as HTMLElement | null;

  const overlay = el('div', 'guide-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '데이터 관리');

  const modal = el('div', 'guide-modal');
  const header = el('div', 'guide-header');
  const titleWrap = el('div', 'guide-title-wrap');
  titleWrap.append(
    el('h2', 'guide-title', '데이터 관리'),
    el('p', 'guide-sub', '백업·복원·삭제 관리를 한 곳에서.'),
  );
  const closeBtn = el('button', 'guide-close', '✕') as HTMLButtonElement;
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '데이터 관리 닫기');
  header.append(titleWrap, closeBtn);

  const bodyEl = el('div', 'guide-body');
  modal.append(header, bodyEl);
  overlay.appendChild(modal);

  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus();
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }

  const showHome = (): void => {
    bodyEl.innerHTML = '';
    const group = el('section', 'guide-group');
    group.append(
      el('div', 'guide-group-title', '🗂 데이터 관리'),
      el('div', 'guide-group-hint', '기억을 지키고 되살리는 도구'),
    );
    const grid = el('div', 'guide-card-grid');
    for (const c of cards(opts.onChanged)) {
      const btn = el('button', 'guide-card') as HTMLButtonElement;
      btn.type = 'button';
      const ic = el('span', 'guide-card-ic', c.icon);
      ic.setAttribute('aria-hidden', 'true');
      const mid = el('span', 'guide-card-mid');
      mid.append(el('b', 'guide-card-label', c.label), el('small', 'guide-card-hint', c.hint));
      const chev = el('span', 'guide-card-chev', '›');
      chev.setAttribute('aria-hidden', 'true');
      btn.append(ic, mid, chev);
      btn.addEventListener('click', () => c.open({ detail: showDetail, close }));
      grid.appendChild(btn);
    }
    group.appendChild(grid);
    bodyEl.appendChild(group);
    closeBtn.focus();
  };
  const showDetail = (title: string, node: HTMLElement): void => {
    bodyEl.innerHTML = '';
    const bar = el('div', 'guide-detail-bar');
    const back = el('button', 'guide-back', '‹ 데이터 관리') as HTMLButtonElement;
    back.type = 'button';
    back.addEventListener('click', showHome);
    bar.append(back, el('span', 'guide-detail-title', title));
    bodyEl.append(bar, node);
    bodyEl.scrollTop = 0;
    back.focus();
  };

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
  showHome();
}
