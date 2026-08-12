// ui/screens/dataManager.ts — '데이터 관리' 허브. 백업·복원·휴지통·가이드를 한 곳에.
// 비타협 원칙 #1(기억을 잃지 않는다)의 사용자 도구. 가이드 모달과 같은 시각 시스템(.guide-*) 재사용.
// 모든 자유 텍스트는 textContent로만(innerHTML 금지 — CSP·XSS 게이트).

import { el, setNote } from '../dom';
import type { LocalTrip } from '../../offline/db';
import { openDiagnosticsHub } from './diagnosticsHub';
import { openGuide } from './guide';
import {
  listTrashedChildren,
  listTrashedChildrenFromServer,
  purgeTrashedBatch,
  purgeChildPermanently,
  restoreTrashedChild,
  prepareChildForAction,
  CHILD_LABEL,
  type TrashPurgeEntry,
  type TrashedChild,
} from '../../services/trash';
import { assertBackupImportSize, backupFilename, exportBackup, exportBackupZip, importBackupAuto, type BackupStats } from '../../services/backup';
import { backupSaveMessage, saveBackupBlob, saveBackupBlobToChosenFolder } from '../../services/fileSave';
import { backupFileWriter } from '../../services/capacitorShell';
import { recordBackupNow, getLastBackupAt, backupFreshness } from '../../services/backupMeta';
import {
  listDeletedTrips, listDeletedTripsFromServer, restoreTripFromTrash, purgeTripPermanently, prepareTripForAction,
} from '../../services/trips';
import { requestSync } from '../../services/autoSync';
import { purgeRemote, verifyPurgeReceipt } from '../../services/sync';
import { computeStorageUsage, formatBytes } from '../../services/storage';
import { fxBase, setFxBase } from '../../services/fx';
import { openR2Setup } from './r2Setup';
import { placeRegistryPanel } from './placeRegistry';
import { CURRENCIES, currencyLabel } from '../../domain/expense/format';
import { publishDeviceAsCanonical } from '../../services/canonicalSync';
import { currentUser } from '../../services/auth';
import { supabase, isConfigured } from '../../services/supabase/client';
import { canRunLocalDataAction, type LocalDataAction } from '../../domain/authGate';
import type { TripNavigationTarget } from '../../app/router';

interface DataManagerOpts {
  /** 데이터가 바뀌면 호출(홈 목록·통계 갱신). */
  onChanged: () => void;
  /** 여행으로 이동 — 위치관리대장이 「이 장소를 쓰는 순간」에서 그 여행을 연다. */
  goToTrip: (tripId: string, target?: TripNavigationTarget) => void;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type DataManagerIcon =
  | 'storage'
  | 'photo'
  | 'audio'
  | 'record'
  | 'folder'
  | 'currency'
  | 'cloud'
  | 'backup'
  | 'restore'
  | 'canonical'
  | 'diagnostics'
  | 'location'
  | 'trash'
  | 'guide';

/** 데이터 관리 화면의 장식 아이콘 SSOT — 플랫폼마다 달라지는 컬러 이모지를 쓰지 않는다. */
const DATA_MANAGER_ICON_PATHS: Record<DataManagerIcon, readonly string[]> = {
  storage: ['M4 6c0-2 16-2 16 0s-16 2-16 0', 'M4 6v6c0 2 16 2 16 0V6', 'M4 12v6c0 2 16 2 16 0v-6'],
  photo: ['M3 5h18v14H3z', 'm3 16 5-5 4 4 3-3 6 6', 'M8 8h.01'],
  audio: ['M11 5 6 9H2v6h4l5 4z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M19 5a10 10 0 0 1 0 14'],
  record: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M8 13h8', 'M8 17h6'],
  folder: ['M3 5h6l2 2h10v12H3z'],
  currency: ['M7 7h11l-3-3', 'm17 17H6l3 3'],
  cloud: ['M17.5 19H7a5 5 0 1 1 1.3-9.8A7 7 0 0 1 21 13a4 4 0 0 1-3.5 6z'],
  backup: ['M12 3v12', 'm7 10 5 5 5-5', 'M5 21h14'],
  restore: ['M12 21V9', 'm7 14 5-5 5 5', 'M5 3h14'],
  canonical: ['M12 3 20 7v5c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V7z', 'm9 12 2 2 4-4'],
  diagnostics: ['M3 12h4l2-5 4 10 2-5h6'],
  location: ['M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0z', 'M12 10h.01'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 15h10l1-15', 'M10 10v7', 'M14 10v7'],
  guide: ['M4 5a3 3 0 0 1 3-2h5v17H7a3 3 0 0 0-3 2z', 'M20 5a3 3 0 0 0-3-2h-5v17h5a3 3 0 0 1 3 2z'],
};

function dataManagerIcon(name: DataManagerIcon, className: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add(className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of DATA_MANAGER_ICON_PATHS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/** 저장 용량 요약 카드 — 사진(blob) vs 텍스트(기록)로 나눠 보여준다. 비동기로 채운다. */
function buildUsageCard(): HTMLElement {
  const card = el('div', 'dm-usage');
  const title = el('div', 'dm-usage-title');
  title.append(dataManagerIcon('storage', 'dm-title-icon'), document.createTextNode('저장 용량'));
  card.append(title);
  const rows = el('div', 'dm-usage-rows');
  const loading = el('div', 'dm-usage-loading muted small', '계산 중…');
  rows.appendChild(loading);
  card.appendChild(rows);

  const line = (icon: DataManagerIcon, label: string, value: string, sub?: string): HTMLElement => {
    const r = el('div', 'dm-usage-line');
    const left = el('div', 'dm-usage-label');
    const name = el('span', 'dm-usage-name');
    name.append(dataManagerIcon(icon, 'dm-usage-ic'), document.createTextNode(label));
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
      const known = u.photoBytes + u.audioBytes + u.textBytes;
      rows.append(
        line(
          'photo',
          '사진',
          formatBytes(u.photoBytes),
          u.photoCount > 0
            ? `${u.photoCount}장 · 클라우드 정본용 표시본+썸네일${u.stagedOriginalCount ? ` · 전송 확인 전 원본 ${u.stagedOriginalCount}장(${formatBytes(u.stagedOriginalBytes)})` : ''}`
            : '아직 없음',
        ),
        // 소리는 **사진과 같은 자리에 같은 어휘**로 선다(§7 사용자 대면 대칭). 0이어도 줄을
        // 없애지 않는다 — 줄이 사라지면 "이 앱이 소리를 세고 있다"는 사실 자체가 안 보인다.
        line('audio', '소리', formatBytes(u.audioBytes), u.audioCount > 0 ? `${u.audioCount}개 · 녹음 원본` : '아직 없음'),
        line('record', '기록', formatBytes(u.textBytes), '여행·순간·비용·메모'),
      );
      const total = el('div', 'dm-usage-line dm-usage-total');
      total.append(el('span', 'dm-usage-label', '합계'), el('span', 'dm-usage-val', formatBytes(known)));
      rows.appendChild(total);
      if (u.estimate && u.estimate.quota > 0) {
        // 정확한 앱 데이터(사진+텍스트)를 브라우저 저장 한도에 견준다(estimate.usage는 프라이버시
        // 반올림으로 부정확할 수 있어 막대엔 쓰지 않는다). 한도는 실제 estimate.quota.
        const ratio = known / u.estimate.quota;
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

// ── 상세 패널: 백업(내보내기) ────────────────────────────────────────
function backupPanel(): HTMLElement {
  const box = el('div', 'guide-detail-body');
  box.append(
    el('h3', 'guide-h', '완전 백업 파일 만들기'),
    el('p', 'guide-p', '여행·순간·장소·감정·비용과 사진·소리·영상 파일을 하나의 ZIP으로 저장합니다. Android 앱에서는 기본 Download 폴더에 바로 저장하거나 다른 폴더를 직접 고를 수 있고, 저장 뒤 파일을 다시 읽어 확인합니다.'),
  );
  const status = el('p', 'dm-status');
  status.setAttribute('role', 'status');

  // 마지막 백업 신선도(관측 가능화) — 오래됐거나 없으면 부드럽게 권고.
  const fresh = el('p', 'dm-fresh');
  const renderFresh = () => {
    const f = backupFreshness(getLastBackupAt());
    fresh.textContent = f.never ? `${f.text} — 지금 한 번 내려받아 두는 걸 권해요.` : `${f.text}${f.stale ? ' — 오래됐어요. 새로 백업해 두세요.' : ''}`;
    fresh.classList.toggle('dm-fresh-warn', f.stale);
  };
  renderFresh();

  const runExport = (
    btn: HTMLButtonElement,
    // 통계는 **`BackupStats`를 통째로** 받는다. 예전엔 여기 네 필드를 손으로 다시 적어서,
    // 백업이 소리를 담기 시작한 뒤에도 **화면 문장만 그 사실을 몰랐다** — 사용자가
    // "백업에 오디오도 들어 있나?"를 물어야 했던 이유다(§12). 필드가 늘면 여기도 따라온다.
    make: () => Promise<{ blob: Blob; stats: BackupStats }>,
    filename: (now: Date) => string,
    save = saveBackupBlob,
  ) => {
    btn.disabled = true;
    status.textContent = '백업 만드는 중…';
    void (async () => {
      try {
        const { blob, stats } = await make();
        const now = new Date();
        const receipt = await save(blob, filename(now));
        if (receipt.state === 'verified' && stats.missingFiles === 0) {
          recordBackupNow();
          renderFresh();
        }
        const counts = `여행 ${stats.trips} · 순간 ${stats.moments} · 사진 ${stats.media} · 비용 ${stats.expenses} · 소리 ${stats.audio} · 영상 ${stats.videos} · ${fmtBytes(blob.size)}`;
        const missing = stats.missingFiles > 0 ? ` · 주의: 이 기기에 실물 파일이 없는 항목 ${stats.missingFiles}개는 메타만 포함` : '';
        status.textContent = receipt.state === 'cancelled' ? backupSaveMessage(receipt) : `${backupSaveMessage(receipt)} · ${counts}${missing}`;
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

  // 동기화 전 임시 원본 포함 토글. 클라우드 확인이 끝난 사진에는 별도 원본이 없고 표시본이 정본이다.
  const incOrig = el('input') as HTMLInputElement;
  incOrig.type = 'checkbox';
  incOrig.checked = true;
  incOrig.id = 'dm-inc-orig';
  const incOrigLabel = el('label', 'dm-check');
  incOrigLabel.htmlFor = 'dm-inc-orig';
  incOrigLabel.append(incOrig, document.createTextNode(' 아직 전송 확인 전인 사진의 임시 원본도 포함'));

  const btnZip = el('button', 'btn-primary dm-wide', '여행별 폴더 백업 (ZIP)') as HTMLButtonElement;
  btnZip.type = 'button';
  btnZip.addEventListener('click', () => {
    const p = pass();
    if (!confirmPlaintext(p)) return;
    const withOrig = incOrig.checked;
    runExport(
      btnZip,
      () => exportBackupZip(withOrig, p),
      (now) => backupFilename(now, 'zip', withOrig ? { encrypted: !!p } : { encrypted: !!p, suffix: '표시본만' }),
    );
  });
  // 새 APK는 취소될 수 있는 선택기를 기본 경로에서 제거한다. 그래도 사용자가 Drive나 다른
  // 폴더를 원하면 같은 ZIP 생성기와 검증 경계를 통과하는 명시적 보조 문을 제공한다(§7).
  const btnZipPicker = el('button', 'btn-ghost dm-wide', '📁 다른 폴더 선택 백업 (ZIP)') as HTMLButtonElement;
  btnZipPicker.type = 'button';
  btnZipPicker.addEventListener('click', () => {
    const p = pass();
    if (!confirmPlaintext(p)) return;
    const withOrig = incOrig.checked;
    runExport(
      btnZipPicker,
      () => exportBackupZip(withOrig, p),
      (now) => backupFilename(now, 'zip', withOrig ? { encrypted: !!p } : { encrypted: !!p, suffix: '표시본만' }),
      saveBackupBlobToChosenFolder,
    );
  });

  const btnJson = el('button', 'btn-ghost dm-wide', '단일 파일 백업 (JSON)') as HTMLButtonElement;
  btnJson.type = 'button';
  btnJson.addEventListener('click', () => {
    const p = pass();
    if (!confirmPlaintext(p)) return;
    runExport(btnJson, () => exportBackup(true, p), (now) => backupFilename(now, 'json', { encrypted: !!p }));
  });

  box.append(
    el('p', 'guide-p', 'ZIP은 여행마다 폴더로 나뉘고 사진 표시본·썸네일, 소리, 영상 본체·포스터가 실제 파일로 들어갑니다. Android 앱의 기본 저장 위치는 기기 내 저장공간/Download/Bugeon Journey입니다. 아직 전송 확인 전인 사진의 임시 원본도 기본으로 함께 담습니다. JSON도 같은 데이터를 담는 호환 형식이며 둘 다 자동 복원할 수 있어요.'),
    fresh,
    passInput,
    incOrigLabel,
    btnZip,
    ...(backupFileWriter() ? [btnZipPicker] : []),
    btnJson,
    status,
    el('p', 'guide-note', '클라우드 저장이 확인된 사진은 태블릿 감상용 표시본이 정본이며, 큰 입력 원본 복사본은 기기에서 자동 정리됩니다. 암호를 입력하면 백업 파일을 열 때 그 암호가 필요합니다 — 분실하면 복원할 수 없으니 암호도 안전하게 보관하세요.'),
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
  label.append(document.createTextNode('백업 파일 선택'), fileInput);
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    status.textContent = '복원 중…';
    void (async () => {
      try {
        assertBackupImportSize(file.size);
        const buf = await file.arrayBuffer();
        const r = await importBackupAuto(buf, passInput.value.trim() || undefined);
        if (r.needsPassphrase) {
          status.textContent = '암호화된 백업이에요. 위에 암호를 입력하고 파일을 다시 선택하세요.';
        } else if (r.skippedEmptyGuard) {
          status.textContent = '백업이 비어 있어 건너뛰었어요(현재 데이터 보존).';
        } else {
          // 영구삭제했던 것을 되살렸으면 **그렇게 말한다.** 2026-07-26에 이 문장이 없어서,
          // 복원이 서버 원장에 막혀 통째로 무효화되는 동안 사용자는 「✅ 복원됨」만 봤다.
          const back = r.unpurged ? ` · 영구삭제했던 ${r.unpurged}건을 되살립니다` : '';
          status.textContent = `복원 확인 · 여행 ${r.trips} · 순간 ${r.moments} · 사진 ${r.media} · 비용 ${r.expenses} · 소리 ${r.audio} · 영상 ${r.videos} 반영${back}`;
          onChanged();
          // 복원한 기억이 이 기기에만 갇히지 않게 곧바로 올린다(기기 분실 후 복구가 이 경로다).
          void requestSync('백업 복원');
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
/**
 * 🔴 휴지통 목록의 원천(2026-08-05 · 사용자 결정): **온라인이면 서버가 정본**이다 — 로그인된
 * 모든 기기가 항상 같은 것을 봐야 한다("절대절대절대 기기끼리 내용이 다르면 안 됩니다"). 서버
 * 조회가 실패(오프라인 등)할 때만 이 기기의 로컬 기록으로 내려가고, 그 사실을 화면에 밝힌다 —
 * "로컬 기준"과 "서버 기준"을 같은 문구로 보여주면 §8이 금지하는 「모르는 걸 아는 척」이 된다.
 */
async function fetchTrashLists(): Promise<{ trips: LocalTrip[]; kids: TrashedChild[]; fromServer: boolean }> {
  const client = supabase();
  if (client) {
    const [serverTrips, serverKids] = await Promise.all([
      listDeletedTripsFromServer(client),
      listTrashedChildrenFromServer(client),
    ]);
    if (serverTrips !== null && serverKids !== null) return { trips: serverTrips, kids: serverKids, fromServer: true };
  }
  const [trips, kids] = await Promise.all([listDeletedTrips(), listTrashedChildren()]);
  return { trips, kids, fromServer: false };
}

/** 여행/자식 줄이 공유하는 동작 컨텍스트 — trashPanel의 클로저를 top-level 행 함수로 넘긴다. */
interface TrashRowCtx {
  purgeNote: HTMLElement;
  toSync: { go: () => void; label: string };
  onChanged: () => void;
  render: () => void;
}

/** 여행 한 줄 — 자식 줄과 **같은 자리·같은 어휘**(§7 사용자 대면 대칭). */
function tripRow(t: LocalTrip, ctx: TrashRowCtx): HTMLElement {
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
        // 서버 조회로만 알던 여행이면(다른 기기가 지운 것) 먼저 이 기기에 채운다 —
        // 「보인다」와 「행동할 수 있다」를 같은 말로 만든다(사용자 결정 2026-08-05).
        const client = supabase();
        if (client) await prepareTripForAction(t.id, client);
        await restoreTripFromTrash(t.id);
        void requestSync('휴지통 복원');
        ctx.onChanged();
        ctx.render();
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
        const client = supabase();
        if (client) await prepareTripForAction(t.id, client);
        await purgeTripPermanently(t.id);
        // 영구삭제 전파(ADR-0027)를 **즉시** 올린다. 이게 없으면 표식이 큐에 앉아만 있고
        // 다른 기기는 영영 모른다 — 실제로 그 상태였다(2026-07-26).
        void requestSync('영구삭제');
        setNote(ctx.purgeNote, '', 'ok', null); // 빈 문자열 = 숨김. 보여줄 것도 갈 곳도 없다.
        ctx.onChanged();
        ctx.render();
      } catch (e) {
        // 조용히 삼키지 않는다 — 특히 "먼저 동기화" 같은 **행동 가능한** 이유는 반드시 보여준다.
        setNote(ctx.purgeNote, (e as Error).message || '영구삭제에 실패했어요.', 'error', ctx.toSync);
        confirmBtn.disabled = false;
      }
    })();
  });
  actions.append(restore, purge, confirmBtn);
  row.append(info, actions);
  return row;
}

/** 자식 한 줄 — 여행 줄과 **같은 자리·같은 어휘**(§7 사용자 대면 대칭). */
function childRow(c: TrashedChild, ctx: TrashRowCtx): HTMLElement {
  const row = el('div', 'dm-trash-row');
  const info = el('div', 'dm-trash-info');
  info.append(
    el('b', undefined, `${CHILD_LABEL[c.domain]} · ${c.label}`),
    el('span', 'dm-trash-meta', `삭제 ${fmtDate(c.deletedAt)}`),
  );
  const actions = el('div', 'dm-trash-actions');

  const restore = el('button', 'btn-ghost', '↩ 복원') as HTMLButtonElement;
  restore.type = 'button';
  restore.addEventListener('click', () => {
    restore.disabled = true;
    void (async () => {
      try {
        // 서버 조회로만 알던 항목이면(다른 기기가 지운 것) 먼저 이 기기에 채운다 — 여행과
        // 같은 규율(사용자 결정 2026-08-05).
        const client = supabase();
        if (client) await prepareChildForAction(c.domain, c.id, client);
        // 도메인 분기와 **딸린 것 모으기는 서비스가 한다** — 화면이 목록을 만지면
        // 언젠가 하나를 빠뜨린다(M-0007이 정확히 그 형태였다).
        await restoreTrashedChild(c.domain, c.id);
        void requestSync('휴지통 복원');
        ctx.onChanged();
        ctx.render();
      } catch (e) {
        setNote(ctx.purgeNote, (e as Error).message || '복원에 실패했어요.', 'error', ctx.toSync);
        restore.disabled = false;
      }
    })();
  });

  // 영구삭제: 여행과 **같은 2단계 확인**. 규율이 화면마다 다르면 사용자가 매번 배워야 한다.
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
        const client = supabase();
        if (client) await prepareChildForAction(c.domain, c.id, client);
        await purgeChildPermanently(c.domain, c.id);
        void requestSync('영구삭제');
        setNote(ctx.purgeNote, '', 'ok', null); // 빈 문자열 = 숨김. 보여줄 것도 갈 곳도 없다.
        ctx.onChanged();
        ctx.render();
      } catch (e) {
        setNote(ctx.purgeNote, (e as Error).message || '영구삭제에 실패했어요.', 'error', ctx.toSync);
        confirmBtn.disabled = false;
      }
    })();
  });

  actions.append(restore, purge, confirmBtn);
  row.append(info, actions);
  return row;
}

/** 휴지통 일괄 영구삭제의 2단계 확인·준비·단일 commit을 화면 본체에서 분리한다. */
function buildBulkTrashControls(args: {
  purgeNote: HTMLElement;
  toSync: TrashRowCtx['toSync'];
  onChanged: () => void;
  onCommitted: () => void;
}): { el: HTMLElement; setEntries: (entries: TrashPurgeEntry[]) => void } {
  const elBulk = el('div', 'dm-trash-bulk');
  const summary = el('p', 'dm-trash-bulk-summary muted small');
  const actions = el('div', 'dm-trash-actions');
  const begin = el('button', 'btn-danger', '휴지통 모두 영구삭제') as HTMLButtonElement;
  const confirm = el('button', 'btn-danger', '정말 모두 지움') as HTMLButtonElement;
  const cancel = el('button', 'btn-ghost', '취소') as HTMLButtonElement;
  for (const button of [begin, confirm, cancel]) button.type = 'button';
  confirm.hidden = true; cancel.hidden = true;
  actions.append(begin, confirm, cancel); elBulk.append(summary, actions);
  let visible: TrashPurgeEntry[] = [];
  let selected: TrashPurgeEntry[] | null = null;
  const reset = () => {
    selected = null; begin.hidden = visible.length === 0; confirm.hidden = true; cancel.hidden = true;
    confirm.disabled = false; cancel.disabled = false;
  };
  begin.addEventListener('click', () => {
    if (!visible.length) return;
    selected = [...visible]; begin.hidden = true; confirm.hidden = false; cancel.hidden = false;
    confirm.textContent = `정말 ${selected.length}개 모두 지움`;
  });
  cancel.addEventListener('click', reset);
  confirm.addEventListener('click', () => {
    const entries = selected;
    if (!entries?.length) return;
    confirm.disabled = true; cancel.disabled = true;
    void (async () => {
      let committed = false;
      try {
        const client = supabase();
        if (client) {
          // 독립 tombstone은 병렬 준비한다. 완료 개수는 실제로 끝난 준비만 세어 진행률에 반영한다.
          let preparedCount = 0;
          setNote(args.purgeNote, `영구삭제 준비 중 0/${entries.length}`, 'info', null, 0, '영구삭제 진행률');
          const prepared = await Promise.all(entries.map(async (entry) => {
            const ready = await (entry.domain === 'trip'
              ? prepareTripForAction(entry.id, client)
              : prepareChildForAction(entry.domain, entry.id, client));
            preparedCount += 1;
            setNote(
              args.purgeNote,
              `영구삭제 준비 중 ${preparedCount}/${entries.length}`,
              'info',
              null,
              (preparedCount / entries.length) * 35,
              '영구삭제 진행률',
            );
            return ready;
          }));
          if (prepared.some((ok) => !ok)) throw new Error('현재 휴지통 항목을 이 기기에 준비하지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.');
        }
        setNote(args.purgeNote, '이 기기에서 영구삭제를 확정하는 중…', 'info', null, 45, '영구삭제 진행률');
        const result = await purgeTrashedBatch(entries);
        committed = true;
        args.onChanged();
        setNote(args.purgeNote, `이 기기 확정 완료 · 선택 ${result.selected}개, 연결된 항목 포함 ${result.targets}개를 서버에 반영 중…`, 'info', null, 55, '영구삭제 진행률');
        await requestSync('휴지통 일괄 영구삭제');
        setNote(args.purgeNote, `서버 삭제 결과를 확인 중… (${result.targets}개)`, 'info', null, 80, '영구삭제 진행률');
        if (!client) {
          setNote(args.purgeNote, `이 기기 영구삭제 확정 · 선택 ${result.selected}개, 연결된 항목 포함 ${result.targets}개. 로그인 후 서버 확인이 필요해요.`, 'info', args.toSync);
        } else {
          const receipt = await verifyPurgeReceipt(purgeRemote(client), result.targetRefs, (completed, total) => {
            setNote(
              args.purgeNote,
              `서버 삭제 결과를 확인 중… (${completed}/${total})`,
              'info',
              null,
              80 + (completed / total) * 20,
              '영구삭제 진행률',
            );
          });
          if (receipt.fullyConfirmed === receipt.targets) {
            setNote(args.purgeNote, `영구삭제 완료 · 선택 ${result.selected}개, 연결된 항목 포함 ${result.targets}개. 서버 행 삭제 ${receipt.rowsAbsent}/${receipt.targets}, 좀비 차단 원장 ${receipt.ledgerConfirmed}/${receipt.targets} 확인.`, 'ok', null);
          } else {
            setNote(
              args.purgeNote,
              `이 기기 확정 완료 · 서버 확인 완료 ${receipt.fullyConfirmed}/${receipt.targets} (행 삭제 ${receipt.rowsAbsent}/${receipt.targets}, 차단 원장 ${receipt.ledgerConfirmed}/${receipt.targets}, 확인 불가 ${receipt.unverified}개).`,
              'error',
              args.toSync,
            );
          }
        }
        reset(); args.onCommitted();
      } catch (e) {
        setNote(args.purgeNote, (e as Error).message || '일괄 영구삭제에 실패했어요.', 'error', args.toSync);
        if (committed) {
          reset(); args.onCommitted();
        } else {
          confirm.disabled = false; cancel.disabled = false;
        }
      }
    })();
  });
  return {
    el: elBulk,
    setEntries: (entries) => {
      visible = entries;
      summary.textContent = visible.length ? `현재 보이는 휴지통 ${visible.length}개를 한 번에 비울 수 있어요. 영구삭제는 되돌릴 수 없습니다.` : '';
      reset();
    },
  };
}

function trashPanel(onChanged: () => void, closeHub: () => void): HTMLElement {
  const box = el('div', 'guide-detail-body');
  // 제목은 바로 위 상세 바가 이미 말하므로 반복하지 않는다.
  box.append(el('p', 'guide-p', '삭제한 항목을 되살리거나, 영구히 지워 저장공간을 비울 수 있어요.'));
  const list = el('div', 'dm-trash-list');
  box.appendChild(list);
  // 상태 줄은 세로 패널용 공용 `sync-note`이며, 라이브 셀렉터 때문에 sourceNote보다 앞에 둔다.
  const purgeNote = el('p', 'sync-note');
  purgeNote.setAttribute('role', 'status');
  purgeNote.hidden = true;
  box.appendChild(purgeNote);

  // 서버 조회로 못 내려가 로컬 기록으로 대신 보여줄 때만 뜬다(§8 — 침묵이 정상, 모르는 걸
  // 아는 척하지 않는다). purgeNote **다음**에 둔다 — 위 주석 참조.
  const sourceNote = el('p', 'sync-note');
  sourceNote.setAttribute('role', 'status');
  sourceNote.hidden = true;
  box.appendChild(sourceNote);

  /** 실패 사유는 대개 "먼저 동기화"다 — 말만 하지 말고 **거기로 데려간다**(사용자 요청 2026-07-26). */
  const toSync = { go: (): void => { closeHub(); openDiagnosticsHub('sync'); }, label: '동기화 상태 열기' };
  const bulk = buildBulkTrashControls({ purgeNote, toSync, onChanged, onCommitted: () => render() });
  box.insertBefore(bulk.el, list);

  const render = (): void => {
    void (async () => {
      const { trips, kids, fromServer } = await fetchTrashLists();
      if (fromServer) setNote(sourceNote, '', 'ok', null);
      else setNote(sourceNote, '📴 오프라인 — 이 기기의 기록 기준(다른 기기와 다를 수 있어요)', 'info', null);
      list.innerHTML = '';
      bulk.setEntries([
        ...trips.map((trip) => ({ domain: 'trip' as const, id: trip.id })),
        ...kids.map((child) => ({ domain: child.domain, id: child.id })),
      ]);
      // **둘 다 없어야 비었다.** 여행만 보고 "비어 있어요"라고 말하던 것이 2026-07-26에
      // 사용자를 헷갈리게 했다 — 서버엔 지운 것이 있는데 화면은 비었다고 했다.
      if (trips.length === 0 && kids.length === 0) {
        list.appendChild(el('p', 'guide-note', '휴지통이 비어 있어요.'));
        return;
      }
      if (trips.length) list.appendChild(el('h4', 'dm-trash-subhead', `삭제한 여행 ${trips.length}개`));
      for (const t of trips) list.appendChild(tripRow(t, ctx));

      // ── 여행이 아닌 것들(순간·사진·비용·소리·영상) ───────────────────
      // 부모가 살아 있는데 혼자 지워진 것들. **여기 말고는 어디에도 안 보인다** — 실행취소
      // 토스트가 사라지면 복구 경로가 통째로 없었다(F5). 2026-07-26에 그게 실제 문제가 됐다:
      // 진단이 「파일이 없는 사진 기록 2건」을 가리키는데 사용자가 손댈 곳이 없었다.
      // 🔴 위에서 이미 받아 온 `kids`를 쓴다 — 다시 `listTrashedChildren()`을 부르면 여기만
      // 로컬 기준으로 되돌아가 trips와 다른 정본을 보여주는 결함이 된다(§7 — 이 기능이 막으려던 형태).
      if (kids.length) {
        list.appendChild(el('h4', 'dm-trash-subhead', `개별로 지운 항목 ${kids.length}개`));
        for (const c of kids) list.appendChild(childRow(c, ctx));
      }
    })();
  };

  const ctx: TrashRowCtx = { purgeNote, toSync, onChanged, render: () => render() };

  render();
  box.appendChild(
    el(
      'p',
      'guide-note',
      '영구삭제는 되돌릴 수 없어요. 이 기기의 저장공간을 비우고, **다음 동기화에서 다른 기기에도 반영됩니다.** 아직 서버에 반영되지 않은 삭제가 있으면 먼저 동기화를 요청합니다 — 그래야 지운 것이 되살아나지 않습니다.',
    ),
  );
  return box;
}

// ── 허브 카드 정의 ───────────────────────────────────────────────────
interface HubCard {
  hook?: string;
  icon: DataManagerIcon;
  label: string;
  hint: string;
  /**
   * 이 카드가 로컬 기억 자료에 하는 동작. **필수 필드다** — 새 카드를 만들면서 빠뜨리면
   * 컴파일이 실패한다(§7 2층). 산문 규칙이었다면 다음 카드가 또 조용히 빠졌을 것이다.
   *
   * `null`은 「이 카드는 기억 자료를 건드리지 않는다」가 아니라 **「이번 결정(ADR-0063)의
   * 범위 밖이다」**라는 뜻이다. 그 경계는 `docs/HANDOFF.md`에 그대로 적혀 있다 —
   * 위치관리대장·진단 복구 액션은 아직 심사하지 않았고, 심사 전에 여기서 몰래 잠그지 않는다.
   */
  needs: LocalDataAction | null;
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

/**
 * 일반 병합과 다른 명시적 위험 작업. 첫 클릭은 설명만 펼치고, 두 번째 버튼만 실제 게시를 한다.
 * 브라우저 confirm을 쓰지 않아 경고 문장과 영향 범위가 화면에 계속 남게 한다.
 */
function canonicalPanel(onChanged: () => void): HTMLElement {
  const wrap = el('div', 'guide-detail-body');
  wrap.append(
    el('h3', 'guide-h', '이 기기를 클라우드 최종본으로'),
    el('p', 'guide-p', '현재 이 기기에 저장된 여행·장소·순간·사진·비용·소리·영상과 영구삭제 원장을 클라우드의 정확한 최종본으로 지정합니다.'),
    el('p', 'guide-note', '주의: 일반 동기화와 다릅니다. 클라우드에만 있던 항목은 최종본에서 빠지고, 다른 기기는 다음 동기화 때 자기 로컬 전용 항목을 보존하지 않고 이 최종본에 맞춥니다. 먼저 완전백업을 내려받는 것을 권합니다.'),
  );
  const status = el('p', 'dm-status');
  status.setAttribute('role', 'status');
  const begin = el('button', 'btn-danger dm-wide', '이 기기를 최종본으로 지정') as HTMLButtonElement;
  begin.type = 'button';
  const confirm = el('button', 'btn-danger dm-wide', '정말 이 기기 기준으로 클라우드 교체') as HTMLButtonElement;
  confirm.type = 'button';
  confirm.hidden = true;
  const cancel = el('button', 'btn-ghost dm-wide', '취소') as HTMLButtonElement;
  cancel.type = 'button';
  cancel.hidden = true;

  begin.addEventListener('click', () => {
    begin.hidden = true;
    confirm.hidden = false;
    cancel.hidden = false;
    status.textContent = '마지막 확인: 이 기기에 없는 클라우드 항목은 최종본에서 제거됩니다.';
    confirm.focus();
  });
  cancel.addEventListener('click', () => {
    begin.hidden = false;
    confirm.hidden = true;
    cancel.hidden = true;
    status.textContent = '';
    begin.focus();
  });
  confirm.addEventListener('click', () => {
    confirm.disabled = true;
    cancel.disabled = true;
    status.textContent = '최종본 스냅샷 고정 → 사진·소리·영상 업로드 → 서버 원자 교체 → 되읽기 확인 중…';
    void (async () => {
      try {
        const client = supabase();
        const user = await currentUser();
        if (!client || !user) throw new Error('로그인과 Supabase 연결이 필요합니다.');
        const result = await publishDeviceAsCanonical(client, user.id);
        status.textContent = `최종본 교체 확인 · 기록 ${result.rows}건 · 영구삭제 표식 ${result.purgedIds}건. 다른 기기는 다음 동기화 때 이 기준을 받습니다.`;
        confirm.hidden = true;
        cancel.hidden = true;
        onChanged();
      } catch (e) {
        status.textContent = `최종본 교체 실패: ${e instanceof Error ? e.message : String(e)} 로컬 기록은 지우지 않았습니다. 응답이 유실됐을 수도 있으므로 같은 버튼으로 재개하면 서버 operation을 되읽어 확인합니다.`;
        confirm.disabled = false;
        cancel.disabled = false;
      }
    })();
  });
  wrap.append(begin, confirm, cancel, status);
  return wrap;
}


function cards(
  onChanged: () => void,
  goToTrip: (tripId: string, target?: TripNavigationTarget) => void,
  reopen: () => HTMLElement | void,
): HubCard[] {
  return [
    { icon: 'currency', needs: null, label: '환율 기준통화', hint: '비용 옆에 환산값 표시', open: (h) => h.detail('환율 기준통화', currencyPanel()) },
    { icon: 'cloud', needs: null, label: 'R2 저장소 설정', hint: '사진 저장소 설정 절차·함정 기록', open: (h) => { h.close(); openR2Setup(); } },
    { icon: 'backup', needs: 'export', label: '백업 (내보내기)', hint: '기억을 파일로 저장', open: (h) => h.detail('백업 (내보내기)', backupPanel()) },
    { icon: 'restore', needs: 'restore', label: '복원 (가져오기)', hint: '백업 파일에서 병합 복원', open: (h) => h.detail('복원 (가져오기)', restorePanel(onChanged)) },
    { icon: 'canonical', needs: 'purge', label: '이 기기를 클라우드 최종본으로', hint: '일반 병합이 아닌 명시적 전체 교체', open: (h) => h.detail('클라우드 최종본 지정', canonicalPanel(onChanged)) },
    { hook: 'diagnostics', icon: 'diagnostics', needs: null, label: '진단 도구', hint: '동기화·무결성·저장소·환경·오류 한 곳에', open: (h) => { h.close(); openDiagnosticsHub(undefined, { onClose: reopen }); } },
    { icon: 'location', needs: null, label: '위치관리대장', hint: '등록한 장소를 찾고 좌표·주소 고치기', open: (h) => h.detail('위치관리대장', placeRegistryPanel(onChanged, (id, target) => { h.close(); goToTrip(id, target); })) },
    { icon: 'trash', needs: 'purge', label: '휴지통', hint: '삭제한 여행 복원·영구삭제', open: (h) => h.detail('휴지통', trashPanel(onChanged, h.close)) },
    { icon: 'guide', needs: null, label: '가이드', hint: '연결·설정과 개발·설계 안내', open: (h) => { h.close(); openGuide(); } },
  ];
}

/** '데이터 관리' 허브를 연다. 현재 화면 위에 오버레이로 뜬다. */
export function openDataManager(opts: DataManagerOpts): void {
  const prevFocus = document.activeElement as HTMLElement | null;
  // 아래 `currentUser()`가 답하기 전까지의 값. **모름은 잠김 쪽으로 접는다**(fail-closed).
  let signedIn = false;

  const overlay = el('div', 'overlay-base guide-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '데이터 관리');

  const modal = el('div', 'modal-base guide-modal');
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
    const group = el('section', 'guide-group dm-tool-group');
    const groupTitle = el('div', 'guide-group-title dm-group-title');
    groupTitle.append(dataManagerIcon('folder', 'dm-group-icon'), document.createTextNode('데이터 관리'));
    group.append(groupTitle, el('div', 'guide-group-hint', '기억을 지키고 되살리는 도구'));
    const grid = el('div', 'guide-card-grid');
    // 🔴 진단 허브가 닫힐 때 **이 화면으로 돌아온다** — 자기를 닫고 열기 때문에, 돌아갈 길을
    // 넘기지 않으면 첫 화면이 나온다(사용자 지적 2026-08-06).
    for (const c of cards(opts.onChanged, opts.goToTrip, () => {
      openDataManager(opts);
      return document.querySelector<HTMLElement>('[data-hub-card="diagnostics"]') ?? undefined;
    })) {
      const btn = el('button', 'guide-card') as HTMLButtonElement;
      btn.type = 'button';
      if (c.hook) btn.setAttribute('data-hub-card', c.hook);
      const ic = el('span', 'guide-card-ic');
      ic.appendChild(dataManagerIcon(c.icon, 'dm-card-icon'));
      const mid = el('span', 'guide-card-mid');
      mid.append(el('span', 'guide-card-label', c.label), el('small', 'guide-card-hint', c.hint));
      const chev = el('span', 'guide-card-chev', '›');
      chev.setAttribute('aria-hidden', 'true');
      btn.append(ic, mid, chev);
      // 🔴 잠금은 **여는 순간** 건다. 눌러서 화면이 열린 뒤 막으면 그 사이에 이미 보인다.
      //    판정은 손으로 쓰지 않고 `domain/authGate.ts` 한 곳이 한다(§7 2층 — M-0102가
      //    두 곳에 손으로 있어 한쪽이 우회로가 됐던 그 자리).
      const blocked = c.needs !== null && !canRunLocalDataAction(c.needs, isConfigured(), signedIn);
      if (blocked) {
        btn.disabled = true;
        btn.classList.add('is-locked');
        // 하나는 판정, 하나는 다음 행동. 「왜 막혔는지」만 적고 「어떻게 푸는지」를 빼면
        // 사용자는 앱이 고장 났다고 읽는다(§12).
        mid.replaceChildren(
          el('span', 'guide-card-label', c.label),
          el('small', 'guide-card-hint', '🔒 로그인해야 쓸 수 있어요 — 백업(내보내기)은 로그인 없이도 됩니다'),
        );
        btn.setAttribute('aria-label', `${c.label} — 로그인해야 쓸 수 있어요`);
      } else {
        btn.addEventListener('click', () => c.open({ detail: showDetail, close }));
      }
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

  // 🔴 **기본값은 잠김이다.** `currentUser()`는 비동기라 첫 그리기 때 답이 없는데, 모르는
  //    상태를 「열림」으로 반올림하면 그 사이가 곧 우회로다(§8 — 모르는 것을 정상으로
  //    반올림하지 않는다). 로그인이 확인되면 그때 다시 그려 연다.
  void currentUser()
    .then((u) => {
      const next = Boolean(u);
      if (next === signedIn) return;
      signedIn = next;
      if (bodyEl.querySelector('.dm-tool-group')) showHome(); // 첫 화면일 때만 — 상세를 열어 뒀으면 건드리지 않는다
    })
    .catch(() => {
      // 조회 실패는 「로그인됨」의 근거가 아니다. 잠긴 채로 둔다.
    });
}
