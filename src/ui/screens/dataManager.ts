// ui/screens/dataManager.ts — '데이터 관리' 허브. 백업·복원·휴지통·가이드를 한 곳에.
// 비타협 원칙 #1(기억을 잃지 않는다)의 사용자 도구. 가이드 모달과 같은 시각 시스템(.guide-*) 재사용.
// 모든 자유 텍스트는 textContent로만(innerHTML 금지 — CSP·XSS 게이트).

import { el } from '../dom';
import { openGuide } from './guide';
import { exportBackup, exportBackupZip, importBackupAuto } from '../../services/backup';
import { recordBackupNow, getLastBackupAt, backupFreshness } from '../../services/backupMeta';
import { listDeletedTrips, restoreTripFromTrash, purgeTripPermanently } from '../../services/trips';
import { computeStorageUsage, formatBytes } from '../../services/storage';
import { fxBase, setFxBase } from '../../services/fx';
import { CURRENCIES, currencyLabel } from '../../domain/expense/format';

interface DataManagerOpts {
  /** 데이터가 바뀌면 호출(홈 목록·통계 갱신). */
  onChanged: () => void;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 저장 용량 요약 카드 — 사진(blob) vs 텍스트(기록)로 나눠 보여준다. 비동기로 채운다. */
function buildUsageCard(): HTMLElement {
  const card = el('div', 'dm-usage');
  card.append(el('div', 'dm-usage-title', '📦 저장 용량'));
  const rows = el('div', 'dm-usage-rows');
  const loading = el('div', 'dm-usage-loading muted small', '계산 중…');
  rows.appendChild(loading);
  card.appendChild(rows);

  const line = (icon: string, label: string, value: string, sub?: string): HTMLElement => {
    const r = el('div', 'dm-usage-line');
    const left = el('div', 'dm-usage-label');
    const name = el('span', 'dm-usage-name');
    name.append(el('span', 'dm-usage-ic', icon), document.createTextNode(` ${label}`));
    left.appendChild(name);
    if (sub) left.appendChild(el('span', 'dm-usage-sub muted small', sub));
    const right = el('span', 'dm-usage-val');
    right.textContent = value;
    r.append(left, right);
    return r;
  };

  void computeStorageUsage()
    .then((u) => {
      rows.innerHTML = '';
      const known = u.photoBytes + u.textBytes;
      rows.append(
        line('🖼', '사진', formatBytes(u.photoBytes), u.photoCount > 0 ? `${u.photoCount}장 · 원본+표시본+썸네일` : '아직 없음'),
        line('📝', '텍스트(기록)', formatBytes(u.textBytes), '여행·순간·비용·메모'),
      );
      const total = el('div', 'dm-usage-line dm-usage-total');
      total.append(el('span', 'dm-usage-label', '합계'), el('span', 'dm-usage-val', formatBytes(known)));
      rows.appendChild(total);
      if (u.estimate && u.estimate.quota > 0) {
        // 정확한 앱 데이터(사진+텍스트)를 브라우저 저장 한도에 견준다(estimate.usage는 프라이버시
        // 반올림으로 부정확할 수 있어 막대엔 쓰지 않는다). 한도는 실제 estimate.quota.
        const ratio = (u.photoBytes + u.textBytes) / u.estimate.quota;
        const pct = Math.min(100, Math.round(ratio * 100));
        const bar = el('div', 'dm-usage-bar');
        const fill = el('div', 'dm-usage-bar-fill');
        fill.style.width = `${Math.max(ratio > 0 ? 1 : 0, pct)}%`; // 아주 작아도 얇게 보이게
        bar.appendChild(fill);
        rows.appendChild(bar);
        const hint = ratio >= 0.9 ? ' · 곧 가득 참 — 백업 권장' : ratio >= 0.7 ? ' · 절반 이상 사용' : ' · 여유 충분';
        rows.appendChild(
          el('div', 'dm-usage-quota muted small', `이 브라우저 저장 한도 약 ${formatBytes(u.estimate.quota)} 중 ${pct}% 사용${hint}`),
        );
      }
    })
    .catch(() => {
      rows.innerHTML = '';
      rows.appendChild(el('div', 'dm-usage-loading muted small', '저장 용량을 계산할 수 없어요.'));
    });

  return card;
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

  // 마지막 백업 신선도(관측 가능화) — 오래됐거나 없으면 부드럽게 권고.
  const fresh = el('p', 'dm-fresh');
  const renderFresh = () => {
    const f = backupFreshness(getLastBackupAt());
    fresh.textContent = f.never ? `🔔 ${f.text} — 지금 한 번 내려받아 두는 걸 권해요.` : `${f.stale ? '🔔 ' : '🗓️ '}${f.text}${f.stale ? ' — 오래됐어요. 새로 백업해 두세요.' : ''}`;
    fresh.classList.toggle('dm-fresh-warn', f.stale);
  };
  renderFresh();

  const runExport = (
    btn: HTMLButtonElement,
    make: () => Promise<{ blob: Blob; stats: { trips: number; moments: number; media: number; expenses: number } }>,
    filename: (stamp: string) => string,
  ) => {
    btn.disabled = true;
    status.textContent = '백업 만드는 중…';
    void (async () => {
      try {
        const { blob, stats } = await make();
        const now = new Date();
        const p = (n: number) => String(n).padStart(2, '0');
        // 날짜_시간: YYYYMMDD_HHMM (파일명 규칙 '날짜_시간_…'의 상위 형태).
        const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}`;
        downloadBlob(blob, filename(stamp));
        recordBackupNow();
        renderFresh();
        status.textContent = `✅ 내보냄 · 여행 ${stats.trips} · 순간 ${stats.moments} · 사진 ${stats.media} · 비용 ${stats.expenses} · ${fmtBytes(blob.size)}`;
      } catch (err) {
        status.textContent = `내보내기 실패: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        btn.disabled = false;
      }
    })();
  };

  const passInput = el('input', 'dm-pass') as HTMLInputElement;
  passInput.type = 'password';
  passInput.autocomplete = 'new-password';
  passInput.placeholder = '암호 (선택) — 입력하면 파일을 암호화';
  const pass = () => passInput.value.trim() || undefined;

  // 암호 없이 내보낼 때만: 평문 PII 경고 확인(감사관 교정 #2). 암호가 있으면 바로 진행.
  const confirmPlaintext = (p: string | undefined): boolean =>
    !!p ||
    window.confirm(
      '이 백업 파일은 암호화되지 않습니다.\n사진·위치(GPS)·메모·비용이 그대로 담기므로, 파일이 유출되면 누구나 열 수 있어요.\n\n위 칸에 암호를 입력하면 암호화할 수 있습니다.\n암호 없이 이대로 내보낼까요?',
    );

  // 원본 포함 토글(여행별 폴더 ZIP에만 적용). 해제하면 표시본+썸네일만 담아 파일이 훨씬 작다
  // (클라우드에 올라간 것과 사실상 동일 — 원본은 로컬·JSON 완전백업에 보관). 기본 포함.
  const incOrig = el('input') as HTMLInputElement;
  incOrig.type = 'checkbox';
  incOrig.checked = true;
  incOrig.id = 'dm-inc-orig';
  const incOrigLabel = el('label', 'dm-check');
  incOrigLabel.htmlFor = 'dm-inc-orig';
  incOrigLabel.append(incOrig, document.createTextNode(' 원본 사진 포함 (해제하면 표시본만 — 파일이 훨씬 작아요)'));

  const btnZip = el('button', 'btn-primary dm-wide', '🗂️ 여행별 폴더 백업 (ZIP)') as HTMLButtonElement;
  btnZip.type = 'button';
  btnZip.addEventListener('click', () => {
    const p = pass();
    if (!confirmPlaintext(p)) return;
    const withOrig = incOrig.checked;
    runExport(
      btnZip,
      () => exportBackupZip(withOrig, p),
      (s) => `bugeon-journey_${s}${withOrig ? '' : '_표시본만'}${p ? '.zip.enc' : '.zip'}`,
    );
  });

  const btnJson = el('button', 'btn-ghost dm-wide', '💾 단일 파일 백업 (JSON)') as HTMLButtonElement;
  btnJson.type = 'button';
  btnJson.addEventListener('click', () => {
    const p = pass();
    if (!confirmPlaintext(p)) return;
    runExport(btnJson, () => exportBackup(true, p), (s) => `bugeon-journey_${s}${p ? '.json.enc' : '.json'}`);
  });

  box.append(
    el('p', 'guide-p', 'ZIP은 여행마다 폴더로 나뉘고 사진이 실제 이미지 파일로 들어가 탐색기에서 바로 볼 수 있어요. 원본 포함을 해제하면 표시본만 담아 파일이 훨씬 작아집니다(가벼운 백업·다른 기기로 옮기기 좋아요). JSON은 전 여행을 파일 하나에 담는 가장 단순한 완전백업(원본 포함)입니다. 둘 다 되살릴 수 있어요.'),
    fresh,
    passInput,
    incOrigLabel,
    btnZip,
    btnJson,
    status,
    el('p', 'guide-note', '완전백업(원본 포함)은 파일이 커요(수십 MB~). 원본은 각 기기와 완전백업에만 보관되니, 원본 보존이 중요하면 완전백업을 하나 남겨두세요. 암호를 입력하면 파일을 열 때 그 암호가 필요합니다 — 분실하면 복원할 수 없으니 암호도 안전하게 보관하세요.'),
  );
  return box;
}

// ── 상세 패널: 복원(가져오기) ────────────────────────────────────────
function restorePanel(onChanged: () => void): HTMLElement {
  const box = el('div', 'guide-detail-body');
  box.append(
    el('h3', 'guide-h', '백업 파일에서 복원'),
    el('p', 'guide-p', '내보낸 백업(ZIP 또는 JSON)을 불러와 병합합니다. 형식은 자동으로 알아봐요. 덮어쓰기가 아니라 병합이에요 — 최신 기록이 우선(LWW)이고, 백업이 비어 있으면 현재 데이터를 지우지 않습니다.'),
  );
  const status = el('p', 'dm-status');
  status.setAttribute('role', 'status');
  const passInput = el('input', 'dm-pass') as HTMLInputElement;
  passInput.type = 'password';
  passInput.autocomplete = 'current-password';
  passInput.placeholder = '암호 (암호화 백업이면 입력)';
  const fileInput = el('input', 'dm-file') as HTMLInputElement;
  fileInput.type = 'file';
  fileInput.accept = 'application/zip,.zip,application/json,.json,.enc';
  const label = el('label', 'btn-primary dm-wide');
  label.append(document.createTextNode('📥 백업 파일 선택'), fileInput);
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    status.textContent = '복원 중…';
    void (async () => {
      try {
        const buf = await file.arrayBuffer();
        const r = await importBackupAuto(buf, passInput.value.trim() || undefined);
        if (r.needsPassphrase) {
          status.textContent = '🔒 암호화된 백업이에요. 위에 암호를 입력하고 파일을 다시 선택하세요.';
        } else if (r.skippedEmptyGuard) {
          status.textContent = '⚠️ 백업이 비어 있어 건너뛰었어요(현재 데이터 보존).';
        } else {
          status.textContent = `✅ 복원됨 · 여행 ${r.trips} · 순간 ${r.moments} · 사진 ${r.media} · 비용 ${r.expenses} 반영`;
          onChanged();
        }
      } catch (err) {
        status.textContent = `복원 실패: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        fileInput.value = '';
      }
    })();
  });
  box.append(passInput, label, status, el('p', 'guide-note', '같은 기록은 최신본만 반영되고, 삭제(tombstone)도 함께 복원됩니다. 암호화된 백업(.enc)은 만들 때 쓴 암호가 필요합니다.'));
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

/** 환율 기준통화 설정 — 비용 옆에 "≈ 얼마"로 보여줄 통화를 고른다. */
function currencyPanel(): HTMLElement {
  const wrap = el('div', 'dm-panel');
  wrap.append(
    el('h3', 'guide-h', '환율 기준통화'),
    el(
      'p',
      'guide-p',
      '비용을 적은 통화가 이 통화와 다르면, 옆에 "≈ 환산값"을 함께 보여줍니다. 환산은 **비용이 발생한 날짜의 기준환율**로 계산해요.',
    ),
  );

  const row = el('div', 'dm-row');
  const sel = el('select', 'edit-input') as HTMLSelectElement;
  sel.setAttribute('aria-label', '환율 기준통화');
  const cur = fxBase();
  for (const c of CURRENCIES) {
    const opt = el('option', undefined, currencyLabel(c)) as HTMLOptionElement;
    opt.value = c.code;
    if (c.code === cur) opt.selected = true;
    sel.appendChild(opt);
  }
  const saved = el('span', 'muted small', '');
  sel.addEventListener('change', () => {
    setFxBase(sel.value);
    saved.textContent = `✓ ${sel.value}(으)로 저장됨 — 여행 화면을 다시 열면 반영돼요.`;
  });
  row.append(sel, saved);
  wrap.appendChild(row);

  wrap.appendChild(
    el(
      'p',
      'guide-note',
      '정직한 표기: 여기 쓰는 값은 공개된 **기준환율**이지 실시간 시장가나 은행 매매기준율이 아닙니다. 카드 결제·현찰 환전 시 실제 금액은 수수료 때문에 다를 수 있어요. 원래 적은 금액과 통화는 절대 바뀌지 않고 그대로 보존됩니다.',
    ),
  );
  return wrap;
}

function cards(onChanged: () => void): HubCard[] {
  return [
    { icon: '💱', label: '환율 기준통화', hint: '비용 옆에 환산값 표시', open: (h) => h.detail('💱 환율 기준통화', currencyPanel()) },
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
    bodyEl.appendChild(buildUsageCard()); // 저장 용량 요약(사진/텍스트) — 최상단
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
