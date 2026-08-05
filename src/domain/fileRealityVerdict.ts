// domain/fileRealityVerdict.ts — 「🖼️ 파일 실물」 판정(순수 함수).
//
// ─────────────────────────────────────────────────────────────────────────────
// 이 도구가 묻는 것 — 한 문장으로
// ─────────────────────────────────────────────────────────────────────────────
// **기록이 가리키는 사진·소리 바이트가 실제로 있고, 실제로 열리는가.**
//
// 경로축의 🖼️ `files` 단계는 v1.76에 이름만 생기고 **도구가 하나도 없었다.** 허브가 그 자리에
// 「아직 이 단계를 보는 도구가 없어요」를 띄우고 있었고(§8 — 빈 자리를 조용히 지우지 않는다),
// 사각지대 등록부가 그 이유를 들고 있었다(T-010·T-011). 이 파일이 그 자리를 채운다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 왜 「있다」와 「열린다」를 나누는가
// ─────────────────────────────────────────────────────────────────────────────
// 둘은 다른 질문이다. 바이트가 **있는데 깨져 있을 수 있다** — 저장 중 잘린 blob, 옛 브라우저가
// 남긴 반쪽 WebP, 디스크 오류. 크기만 보면 멀쩡해 보인다. 사용자가 그걸 알게 되는 순간은
// **여행 사진을 열었을 때**이고, 그때는 이미 늦다.
//
// 그래서 존재는 **싸게 전수**로(크기만 본다), 열림은 **실제 디코드**로 잰다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 왜 디코드가 지표가 아니라 **행동** 뒤에 있는가
// ─────────────────────────────────────────────────────────────────────────────
// 허브를 열면 `rollup()`이 **모든 도구의 probe를 돈다.** 전수 디코드를 probe에 넣으면 허브를
// 열 때마다 사진 수백 장을 디코드하게 되고, 그러면 진단 도구가 **자기 자신을 느리게 만든다.**
//
// 그래서 디코드는 [열어 보기] 행동이 하고, **결과를 기억한다**(`services/fileReality.ts`).
// 이건 `syncParity`가 서버 대조를 캐시하는 것과 **같은 규율**이다(§7) — 비싼 관측은 계기가
// 있을 때만 재고, 잰 시각을 함께 들고 다니며, 낡으면 「모름」으로 만료시킨다.
//
// 🔴 **안 해 본 것을 정상으로 반올림하지 않는다.** 한 번도 안 열어 봤으면 `todo`다 —
// 「모른다」가 아니라 **「안 해 봤다」**이고, 사용자가 한 번 누르면 해소된다(§8 · M-0035:
// 과도한 `unknown`은 정상 화면을 이상하게 보이게 만든다).

/** 한 종류(사진·소리)의 로컬 바이트 실측. */
export interface KindTally {
  /** 이 기기에 기록이 있는 것 전부(휴지통 포함 — 되살릴 수 있어야 하므로 바이트도 성해야 한다). */
  rows: number;
  /** 바이트가 아예 없거나 0바이트인 기록. */
  empty: number;
  /**
   * **서버에 바이트가 없다고 확인된** 기록(`bytesMissing`). 이건 결함이 아니라 **아는 사실**이다 —
   * 이 도구가 「없다」고 또 세면 같은 사실을 앱이 두 번 말하는 셈이라, 맥락으로 내린다.
   */
  serverMissing: number;
}

/** [열어 보기]가 실제로 디코드해 본 결과. 한 번도 안 했으면 `null`. */
export interface OpenSweep {
  /** 언제 쟀나(ISO). 낡은 초록을 믿지 않게 화면이 이걸 쓴다. */
  at: string;
  /** 열어 본 개수. */
  checked: number;
  /** 열리지 않은 것들의 id 앞 8자(개인정보 규율 — 제목·바이트는 담지 않는다). */
  failed: string[];
  /** 쟀을 때의 대상 수. 지금 `rows` 합과 다르면 그 사이 자료가 늘었다는 뜻이다. */
  totalAtRun: number;
}

export interface FileRealityInput {
  photo: KindTally;
  audio: KindTally;
  sweep: OpenSweep | null;
}

export type FileLevel = 'ok' | 'todo' | 'problem' | 'unknown';

export interface FileMetric {
  label: string;
  actual: string;
  expected: string;
  level: FileLevel;
  meaning?: string;
}

const KO = { photo: '사진', audio: '소리' } as const;

/** 「N개」 — 숫자 0도 값이다(금액·개수에서 0을 falsy로 뭉개지 않는다). */
const n = (v: number): string => `${v}개`;

/** 한 종류의 「바이트가 비어 있는 기록」 지표. */
function emptyMetric(kind: 'photo' | 'audio', t: KindTally): FileMetric {
  const bad = t.empty > 0;
  return {
    label: `바이트가 비어 있는 ${KO[kind]} 기록`,
    actual: n(t.empty),
    expected: '0개',
    level: bad ? 'problem' : 'ok',
    ...(bad
      ? {
          meaning:
            `기록은 있는데 ${KO[kind]} 자체가 비어 있어요. 다른 기기에 사본이 남아 있을 수 있으니 ` +
            `여기서 지우지 마시고, 다른 기기에서 [앱 상태 확인]을 열어 보세요.`,
        }
      : {}),
  };
}

/**
 * 「열어 봤는가 · 열렸는가」 지표.
 *
 * 세 상태를 가른다 — **안 해 봤다 / 열어 봤고 다 열렸다 / 안 열리는 것이 있다.**
 * 첫째를 `ok`로 반올림하면 그게 거짓말이고, `unknown`으로 두면 정상 화면이 매번 이상해 보인다
 * (M-0035). 사용자가 **한 번 누르면 해소되는 일**이므로 `todo`가 정확하다.
 */
function openMetric(sweep: OpenSweep | null, totalNow: number): FileMetric {
  if (!sweep) {
    return {
      label: '열리지 않는 파일',
      actual: '아직 안 열어 봤어요',
      expected: '0개',
      level: 'todo',
      meaning: '아래 [사진·소리 실제로 열어 보기]를 누르면 이 기기의 파일을 하나씩 실제로 열어 확인해요.',
    };
  }
  if (sweep.failed.length > 0) {
    return {
      label: '열리지 않는 파일',
      actual: n(sweep.failed.length),
      expected: '0개',
      level: 'problem',
      meaning:
        '바이트는 있는데 열리지 않아요(파일이 깨졌을 수 있습니다). ' +
        '다른 기기에 성한 사본이 있을 수 있으니 여기서 지우지 마세요.',
    };
  }
  // 잰 뒤 자료가 늘었으면 그 초록은 **옛 것**이다 — 낡은 초록은 초록이 아니다(§8).
  if (totalNow > sweep.totalAtRun) {
    return {
      label: '열리지 않는 파일',
      actual: `그때 ${n(sweep.checked)} 모두 열림 · 그 뒤 ${n(totalNow - sweep.totalAtRun)} 늘었어요`,
      expected: '0개',
      level: 'todo',
      meaning: '새로 담긴 파일은 아직 안 열어 봤어요. 다시 눌러 주세요.',
    };
  }
  return { label: '열리지 않는 파일', actual: `0개 (${n(sweep.checked)} 열어 봄)`, expected: '0개', level: 'ok' };
}

/** 심각도 합성 — 손으로 적지 않는다(자기모순 방지). */
export function worstOf(levels: readonly FileLevel[]): FileLevel {
  if (levels.includes('problem')) return 'problem';
  if (levels.includes('unknown')) return 'unknown';
  if (levels.includes('todo')) return 'todo';
  return 'ok';
}

export function fileRealityMetrics(i: FileRealityInput): FileMetric[] {
  const totalNow = i.photo.rows + i.audio.rows;
  return [emptyMetric('photo', i.photo), emptyMetric('audio', i.audio), openMetric(i.sweep, totalNow)];
}

/**
 * 판정 한 문장.
 *
 * 🔴 **문장을 손으로 쓰지 않고 무리별 개수에서 만든다**(§7-C — M-0021이 「엉뚱한 곳을 가리킨」
 * 형태). 그리고 **한정을 생략하지 않는다**: 이 도구가 본 것은 *이 기기에 있는 바이트*뿐이므로
 * 문장이 그 경계를 말한다.
 */
export function fileRealityHeadline(i: FileRealityInput): string {
  const total = i.photo.rows + i.audio.rows;
  if (total === 0) return '이 기기에 사진·소리가 아직 없어요';
  const empty = i.photo.empty + i.audio.empty;
  const broken = i.sweep?.failed.length ?? 0;
  if (empty + broken > 0) {
    const parts: string[] = [];
    if (empty > 0) parts.push(`비어 있는 것 ${n(empty)}`);
    if (broken > 0) parts.push(`열리지 않는 것 ${n(broken)}`);
    return `이 기기의 파일에 확인할 것이 있어요 — ${parts.join(' · ')}`;
  }
  if (!i.sweep) return `이 기기의 사진·소리 ${n(total)}에 빈 파일은 없어요 — 실제로 열리는지는 아직 확인 전`;
  return `이 기기의 사진·소리 ${n(total)}이 모두 성해요`;
}

/**
 * 🔴 **이 도구가 다루지 *않는* 것** — 화면에 반드시 함께 나간다(§7-C).
 *
 * *"이 문장이 다루지 않는 것은 무엇인가?"* 두 가지다:
 *  ① **다른 기기에만 있는 바이트** — 여기선 볼 수 없다(M-0048: 「이 기기에 없다」는 「없다」가 아니다)
 *  ② **서버에 있는 바이트** — 전수로 내려받아 열어 보면 사진 앱에서 egress가 실제 제약이 된다.
 *     서버와의 개수 대조는 ☁️ 「저장 상태」가 이미 한다 — 같은 사실을 두 도구가 세지 않는다(§7).
 * 🔴 **기기 수를 인자로 받지 않는다**(설계 중 되돌린 자리). 처음엔 M-0048을 따라 「이 계정에
 * 기기가 N대 있어서…」로 쓰려 했는데, 그 숫자는 **서버 조회**로만 알 수 있고 허브는 이미 그
 * 조회를 두 번 한다(`storeStateProbe`·`deviceFleetProbe`). 세 번째를 더하면 진단이 자기
 * 비용으로 사용자 요금을 쓴다. 그리고 이 도구에는 **파괴적 행동이 없으므로** 그 숫자가 판정을
 * 가르지도 않는다 — M-0048의 규율은 *지우라고 권하기 전에* 범위를 물으라는 것이었다.
 * 그래서 **기기 수와 무관하게 언제나 참인 문장**을 쓴다. 모르면서 아는 척하지 않는 쪽이 싸다.
 */
export function fileRealityScopeNote(): string {
  return (
    '이 도구는 이 기기에 내려받은 바이트만 열어 봐요. ' +
    '다른 기기에만 있는 파일은 그 기기에서 확인해 주세요. ' +
    '서버에 있는지는 「저장 상태」 도구가 따로 대조해요.'
  );
}
