// ui/panels/diagnostics.ts — 진단 패널 **한 쌍**(동기화 진단 · ID 무결성 점검).
//
// 왜 공용 모듈인가: 이 둘은 "뭔가 이상한데"를 만난 사용자가 **어느 쪽 문제인지 아직 모르는
// 상태**에서 여는 도구다. 한 쌍이어야 할 것이 두 모달에 흩어져 있으면 판별하려고 두 곳을 다
// 열어야 한다(2026-07-26 사용자 지적). 그래서 여기 한 번 정의하고 [데이터 관리]와 [가이드]
// 양쪽에서 같은 함수를 연다 — 진단 도구는 **찾을 수 있어야** 가치가 있고, 사람마다 먼저 여는
// 문이 다르다. guide ↔ dataManager 직접 import는 순환이 되므로 이 모듈이 그 매듭도 푼다.
//
// 둘 다 **읽기 전용 관측**이 기본이다. 동기화 진단만 수리 버튼(정리 실행·실패 재시도)을 갖는데,
// 그것도 데이터를 지우지 않고 **대기열 상태만** 되돌린다.

import { el, setNote } from '../dom';
import { db } from '../../offline/db';
import { diagnoseSync } from '../../services/diagnostics';
import { forceRepairCascadeOps, retryFailedOps } from '../../services/sync';
import { checkIntegrity, CHECK_COUNT } from '../../domain/integrity';
import { collectEnv, evictionRisk, requestPersist } from '../../services/envReport';
import { recentErrors, clearErrors } from '../../app/errorLog';
import { CHANGELOG } from '../../app/changelog';

/** 화면에 표시할 앱 버전 — changelog가 SSOT(손으로 적지 않는다). */
const APP_VERSION = `v${CHANGELOG[0]?.version ?? '0.00'}`;

function h(text: string): HTMLElement {
  return el('h3', 'guide-h', text);
}
function p(text: string): HTMLElement {
  return el('p', 'guide-p', text);
}
function note(text: string): HTMLElement {
  return el('p', 'guide-note', text);
}
function panel(children: HTMLElement[]): HTMLElement {
  const box = el('div', 'guide-detail-body');
  for (const c of children) box.appendChild(c);
  return box;
}

/**
 * 동기화 진단 — **로컬 상태를 보이게 만든다**(읽기 전용 + 수동 정리).
 *
 * 2026-07-25: "지운 것이 되살아난다"를 여러 번 진단하면서, 서버는 보이는데 기기 안이 안 보여
 * 매번 추측하게 되는 것이 진짜 병목임이 드러났다. 이 패널이 그 창이다.
 */
export function syncDiagnosticsPanel(): HTMLElement {
  const box = el('div', 'guide-detail-body');
  box.append(
    el('h3', 'guide-h', '동기화 진단'),
    el('p', 'guide-p', '이 기기의 동기화 상태를 그대로 보여줍니다. 문제를 추측하지 않고 확인하기 위한 화면이에요.'),
  );
  const table = el('div', 'r2-table');
  box.appendChild(table);
  const note = el('p', 'r2-probe-note');
  note.hidden = true;
  box.appendChild(note);

  const row = (k: string, v: string): HTMLElement => {
    const r = el('div', 'r2-row');
    r.append(el('code', 'r2-key r2-key-wide', k), el('span', 'r2-val', v));
    return r;
  };

  const render = (): void => {
    void (async () => {
      const d = await diagnoseSync();
      table.textContent = '';
      const fmt = (o: Record<string, number>): string =>
        Object.entries(o).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(' · ') || '없음';
      table.append(
        row('사진 저장소', d.mediaStore === 'r2' ? 'Cloudflare R2' : 'Supabase Storage'),
        row('대기 중인 작업', d.queue.total === 0 ? '없음' : `${d.queue.total}건 — ${fmt(d.queue.byState)} / ${fmt(d.queue.byType)}`),
        row('지운 항목(이 기기)', fmt(d.tombstones)),
        row('지움 + 보낼목록 없음', fmt(d.opLessTombstones)),
        row('영구삭제 표식', String(d.purgedMarks)),
      );
      // 개수만으로는 "어느 것"인지 알 수 없어 추측하게 된다 — 사진·비용은 id를 그대로 보여준다.
      for (const it of d.items) {
        table.appendChild(row(`${it.type} ${it.id.slice(0, 8)}`, `${it.deleted ? '🗑 지움' : '● 활성'}${it.queued ? ' · 보낼 목록에 있음' : ''}`));
      }
      const opless = Object.values(d.opLessTombstones).reduce((a: number, b: number) => a + b, 0);
      if (d.queue.total > 0) {
        setNote(note, '보낼 작업이 남아 있어요. 동기화를 한 번 눌러 주세요.', 'info');
      } else if (opless > 0) {
        // 정직: 로컬만 봐서는 "이미 갔는지"를 알 수 없다. 겁주지 않고 사실만 말한다.
        setNote(note, `지웠는데 보낼 목록에 없는 항목이 ${opless}건 있어요. 이미 서버에 반영됐을 수도(정상), 못 갔을 수도 있어요 — 로컬만 봐서는 구분되지 않습니다. 동기화를 누르면 서버와 대조해 자동 처리합니다.`, 'info');
      } else {
        setNote(note, '이 기기에서 서버로 보낼 것이 남아 있지 않습니다.', 'ok');
      }
    })();
  };
  render();

  const actions = el('div', 'r2-probe');
  const repair = el('button', 'btn-ghost', '정리 실행') as HTMLButtonElement;
  repair.type = 'button';
  repair.setAttribute('data-repair-sync', '');
  repair.addEventListener('click', () => {
    repair.disabled = true;
    void forceRepairCascadeOps()
      .then((r) => {
        setNote(note, `사진 ${r.media}건 · 비용 ${r.expenses}건을 다시 보낼 목록에 넣었어요. 이제 동기화를 눌러 주세요.`, 'ok');
        render();
      })
      .catch((e: Error) => setNote(note, `정리 실패: ${e.message}`, 'error'))
      .finally(() => {
        repair.disabled = false;
      });
  });
  const retry = el('button', 'btn-ghost', '실패 재시도') as HTMLButtonElement;
  retry.type = 'button';
  retry.setAttribute('data-retry-failed', '');
  retry.addEventListener('click', () => {
    retry.disabled = true;
    void retryFailedOps()
      .then((n) => {
        setNote(note, n ? `실패로 박혀 있던 작업 ${n}건을 다시 시도하도록 되돌렸어요. 동기화를 눌러 주세요.` : '실패로 박힌 작업이 없어요.', n ? 'ok' : 'info');
        render();
      })
      .catch((e: Error) => setNote(note, `재시도 실패: ${e.message}`, 'error'))
      .finally(() => {
        retry.disabled = false;
      });
  });
  const again = el('button', 'btn-ghost', '다시 확인') as HTMLButtonElement;
  again.type = 'button';
  again.addEventListener('click', render);
  actions.append(repair, retry, again);
  box.appendChild(actions);
  box.appendChild(
    el('p', 'guide-note', '[정리 실행]은 데이터를 지우지 않아요 — 서버로 보내지 못한 삭제를 다시 보낼 목록에 넣을 뿐입니다.'),
  );
  return box;
}


/**
 * ID 무결성 점검 — 저장된 기억이 서로 앞뒤가 맞는지 본다.
 * **읽기 전용**: 자동 수리는 잘못 판단하면 기억을 지우므로 하지 않는다.
 */
export function integrityPanel(): HTMLElement {
  const wrap = panel([h('ID 무결성 점검'), p('읽기 전용입니다 — 아무것도 바꾸지 않아요. 저장된 기록이 서로 앞뒤가 맞는지만 확인합니다.')]);
  const summary = el('p', 'r2-probe-note');
  summary.hidden = true;
  const list = el('div', 'se-findings');
  wrap.append(summary, list);

  const run = (): void => {
    void (async () => {
      const d = db();
      const [trips, moments, media, expenses] = await Promise.all([
        d.localTrips.toArray(),
        d.localMoments.toArray(),
        d.localMedia.toArray(),
        d.localExpenses.toArray(),
      ]);
      const r = checkIntegrity({ trips, moments, media, expenses });
      list.textContent = '';
      setNote(
        summary,
        r.ok
          ? '지금 사용에는 문제 없어요. 아래는 예방·참고 항목입니다.'
          : `지금 확인이 필요한 항목이 ${r.bySeverity.now}건 있어요.`,
        r.ok ? 'ok' : 'error',
      );
      list.appendChild(
        el('p', 'se-legend', `점검 ${CHECK_COUNT}개 분류 · 기록 ${r.checked}건 검사 · 지금 확인 ${r.bySeverity.now} · 예방 주의 ${r.bySeverity.prevent} · 참고 ${r.bySeverity.info}`),
      );
      for (const f of r.findings) {
        const card = el('div', 'se-item');
        const top = el('div', 'se-item-top');
        const tone = f.severity === 'now' ? 'weak' : f.severity === 'prevent' ? 'ok' : 'good';
        top.append(
          el('span', `se-badge se-${tone}`, f.severity === 'now' ? '지금 확인' : f.severity === 'prevent' ? '예방 주의' : '참고'),
          el('span', 'se-item-title', `${f.title} ${f.count}건`),
        );
        card.append(top, el('p', 'se-basis', f.detail), el('p', 'se-gap', `기술: ${f.code} · 예: ${f.samples.join(', ')}`));
        list.appendChild(card);
      }
      if (!r.findings.length) list.appendChild(el('p', 'se-basis', '발견된 항목이 없습니다.'));
    })();
  };
  run();

  const actions = el('div', 'r2-probe');
  const again = el('button', 'btn-ghost', '다시 점검') as HTMLButtonElement;
  again.type = 'button';
  again.setAttribute('data-recheck-integrity', '');
  again.addEventListener('click', run);
  actions.appendChild(again);
  wrap.appendChild(actions);
  wrap.appendChild(note('무결성 점검은 이 기기에 저장된 기록만 봅니다. 서버·사진 저장소 상태는 [데이터 관리 › 동기화 진단]에서 확인하세요.'));
  return wrap;
}


/** 사람이 읽는 바이트. envReport와 storage 양쪽에서 쓰므로 여기 한 번만 정의한다. */
function bytes(n: number | null): string {
  if (n === null) return '알 수 없음';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function row(k: string, v: string): HTMLElement {
  const r = el('div', 'r2-row');
  r.append(el('code', 'r2-key r2-key-wide', k), el('span', 'r2-val', v));
  return r;
}

/**
 * 저장소 안전 — **앱 밖 원인의 유일한 기억 손실 경로**를 관측한다.
 *
 * 비타협 원칙 #1은 "앱 원인 유실 0"이지만 브라우저 축출·사이트데이터 삭제는 앱 통제 밖이다.
 * 그 위험을 숫자로 보여주고, 브라우저에 보호를 요청할 수단을 준다.
 */
export function storagePanel(): HTMLElement {
  const wrap = panel([h('저장소 안전'), p('브라우저가 공간이 부족하면 앱 데이터를 지울 수 있어요. 이 화면은 그 위험을 보여줍니다.')]);
  const table = el('div', 'r2-table');
  const note1 = el('p', 'r2-probe-note');
  note1.hidden = true;
  wrap.append(table, note1);

  const render = (): void => {
    void (async () => {
      const env = await collectEnv(APP_VERSION);
      const risk = evictionRisk(env);
      table.textContent = '';
      table.append(
        row('사용 중', bytes(env.storage.usage)),
        row('허용 한도', bytes(env.storage.quota)),
        row('저장소 보호(persist)', env.storage.persisted === null ? '알 수 없음' : env.storage.persisted ? '적용됨' : '미적용'),
      );
      setNote(note1, risk.text, risk.level);
    })();
  };
  render();

  const actions = el('div', 'r2-probe');
  const ask = el('button', 'btn-ghost', '저장소 보호 요청') as HTMLButtonElement;
  ask.type = 'button';
  ask.setAttribute('data-ask-persist', '');
  ask.addEventListener('click', () => {
    ask.disabled = true;
    void requestPersist()
      .then((ok) => {
        setNote(note1, ok ? '보호가 적용됐어요. 브라우저가 임의로 지우지 않습니다.' : '브라우저가 요청을 받아들이지 않았어요. 백업을 주기적으로 받아두시면 안전합니다.', ok ? 'ok' : 'info');
        if (ok) render();
      })
      .finally(() => {
        ask.disabled = false;
      });
  });
  actions.appendChild(ask);
  wrap.appendChild(actions);
  wrap.appendChild(note('저장소 보호는 브라우저가 결정합니다 — 요청해도 거절될 수 있어요. 가장 확실한 보호는 [데이터 관리 › 백업]입니다.'));
  return wrap;
}

/** 환경·기능 지원 — "왜 안 되지/왜 느리지"의 답이 대개 여기 있다. */
export function environmentPanel(): HTMLElement {
  const wrap = panel([h('환경·기능 지원'), p('이 기기·브라우저가 앱에 필요한 기능을 갖췄는지 봅니다. 없으면 앱은 대체 방식으로 도는데, 느리거나 화질이 달라질 수 있어요.')]);
  const table = el('div', 'r2-table');
  wrap.appendChild(table);
  void (async () => {
    const env = await collectEnv(APP_VERSION);
    table.append(
      row('앱 버전', env.app.version),
      row('사진 저장소', env.app.mediaStore),
      row('화면', `${env.screen.w}×${env.screen.h} · ${env.screen.orientation} · 배율 ${env.screen.dpr}`),
      row('시간대', `${env.clock.tz} (UTC${env.clock.tzOffsetMin >= 0 ? '+' : ''}${env.clock.tzOffsetMin / 60})`),
      row('네트워크', env.device.online ? '온라인' : '오프라인'),
      row('서비스워커', env.sw.supported ? (env.sw.controlled ? '동작 중(캐시 사용)' : '지원하나 미제어') : '미지원'),
    );
    for (const [k, ok] of Object.entries(env.features)) table.appendChild(row(k, ok ? '✅ 지원' : '⚠️ 미지원'));
  })();
  wrap.appendChild(note('“새로고침했는데 화면이 그대로”라면 서비스워커가 옛 화면을 붙잡고 있을 수 있어요. 탭을 완전히 닫았다 다시 열면 해결됩니다.'));
  return wrap;
}

/** 오류 기록 — 사용자가 캡처 대신 텍스트로 줄 수 있게. */
export function errorPanel(): HTMLElement {
  const wrap = panel([h('오류 기록'), p('앱이 도는 동안 생긴 오류를 모아 둡니다. 새로고침하면 사라져요(이 세션만).')]);
  const list = el('div', 'se-findings');
  wrap.appendChild(list);

  const render = (): void => {
    list.textContent = '';
    const errs = recentErrors();
    if (!errs.length) {
      list.appendChild(el('p', 'se-basis', '기록된 오류가 없습니다.'));
      return;
    }
    for (const e of errs) {
      const card = el('div', 'se-item');
      const top = el('div', 'se-item-top');
      top.append(el('span', 'se-badge se-weak', e.kind), el('span', 'se-item-title', e.message));
      card.append(top);
      if (e.where) card.appendChild(el('p', 'se-gap', e.where));
      card.appendChild(el('p', 'se-item-sub', e.at));
      list.appendChild(card);
    }
  };
  render();

  const actions = el('div', 'r2-probe');
  const again = el('button', 'btn-ghost', '다시 보기') as HTMLButtonElement;
  again.type = 'button';
  again.addEventListener('click', render);
  const clear = el('button', 'btn-ghost', '기록 지우기') as HTMLButtonElement;
  clear.type = 'button';
  clear.addEventListener('click', () => {
    clearErrors();
    render();
  });
  actions.append(again, clear);
  wrap.appendChild(actions);
  return wrap;
}

/**
 * 진단 요약 복사 — **개발자와 사용자 사이의 왕복을 한 번으로 줄인다.**
 *
 * 오늘(2026-07-25~26) 같은 문제를 네 번 진단하며 캡처를 여러 장 주고받았다. 텍스트 한 덩어리면
 * 한 번에 끝난다. 개인정보는 담지 않는다 — **개수·상태·환경만**, 기록 내용과 id 전체는 제외.
 */
export function summaryPanel(): HTMLElement {
  const wrap = panel([h('진단 요약 복사'), p('아래 내용을 한 번에 복사해 개발자에게 전달할 수 있어요. 여행 제목·사진·메모 같은 기록 내용은 담기지 않습니다.')]);
  const pre = el('pre', 'diag-pre');
  const note2 = el('p', 'r2-probe-note');
  note2.hidden = true;
  wrap.append(pre, note2);

  let text = '';
  const build = (): void => {
    void (async () => {
      const d = db();
      const [trips, moments, media, expenses] = await Promise.all([
        d.localTrips.toArray(),
        d.localMoments.toArray(),
        d.localMedia.toArray(),
        d.localExpenses.toArray(),
      ]);
      const [env, sync] = await Promise.all([collectEnv(APP_VERSION), diagnoseSync()]);
      const integ = checkIntegrity({ trips, moments, media, expenses });
      const errs = recentErrors();
      const fmt = (o: Record<string, number>): string =>
        Object.entries(o).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ') || '없음';

      text = [
        `[Bugeon Journey 진단 요약] ${env.clock.nowIso}`,
        `앱 ${env.app.version} · base ${env.app.base} · 사진저장소 ${env.app.mediaStore}`,
        `화면 ${env.screen.w}x${env.screen.h}@${env.screen.dpr} ${env.screen.orientation} · ${env.clock.tz}(UTC${env.clock.tzOffsetMin >= 0 ? '+' : ''}${env.clock.tzOffsetMin / 60}) · ${env.device.online ? '온라인' : '오프라인'}`,
        `UA ${env.device.ua}`,
        `저장 ${bytes(env.storage.usage)}/${bytes(env.storage.quota)} · persist=${String(env.storage.persisted)}`,
        `미지원 기능: ${Object.entries(env.features).filter(([, v]) => !v).map(([k]) => k).join(', ') || '없음'}`,
        `SW ${env.sw.supported ? (env.sw.controlled ? '제어중' : '미제어') : '미지원'}`,
        `--- 동기화 ---`,
        `대기 ${sync.queue.total} (${fmt(sync.queue.byState)} / ${fmt(sync.queue.byType)})`,
        `tombstone ${fmt(sync.tombstones)} · op없는tombstone ${fmt(sync.opLessTombstones)} · 영구삭제표식 ${sync.purgedMarks}`,
        `--- 무결성 (${integ.checked}건 검사) ---`,
        `지금확인 ${integ.bySeverity.now} · 예방 ${integ.bySeverity.prevent} · 참고 ${integ.bySeverity.info}`,
        ...integ.findings.map((f) => `  ${f.severity} ${f.code} x${f.count} [${f.samples.join(' ')}]`),
        `--- 오류 ${errs.length}건 ---`,
        ...errs.slice(0, 5).map((e) => `  ${e.kind}: ${e.message}`),
      ].join('\n');
      pre.textContent = text;
    })();
  };
  build();

  const actions = el('div', 'r2-probe');
  const copy = el('button', 'btn-ghost', '복사하기') as HTMLButtonElement;
  copy.type = 'button';
  copy.setAttribute('data-copy-diag', '');
  copy.addEventListener('click', () => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setNote(note2, '복사했어요. 대화창에 붙여넣으시면 됩니다.', 'ok'))
      .catch(() => setNote(note2, '복사가 막혔어요. 위 내용을 길게 눌러 직접 선택·복사해 주세요.', 'info'));
  });
  const again2 = el('button', 'btn-ghost', '다시 만들기') as HTMLButtonElement;
  again2.type = 'button';
  again2.addEventListener('click', build);
  actions.append(copy, again2);
  wrap.appendChild(actions);
  wrap.appendChild(note('담기는 것: 앱·기기·화면·시간대·저장용량·기능지원·동기화 개수·무결성 결과·오류 메시지. 담기지 않는 것: 여행 제목·메모·사진·위치·이메일. 식별번호는 앞 8자리만.'));
  return wrap;
}
