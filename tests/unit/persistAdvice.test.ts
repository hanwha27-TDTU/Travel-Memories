import { describe, it, expect } from 'vitest';
import {
  persistResultNote,
  persistIsMeaningful,
  surfaceLabel,
  shouldAutoRequestPersist,
  storageHeadline,
  type PersistSurface,
} from '../../src/domain/persistAdvice';

const SURFACES: PersistSurface[] = ['shell', 'installed-pwa', 'browser-tab'];

describe('persistResultNote — 허락된 경우', () => {
  it('표면과 무관하게 같은 말을 한다(설치 여부는 이때 상관없다)', () => {
    for (const surface of SURFACES) {
      expect(persistResultNote({ surface, canPersist: true }, true)).toBe(
        '보호가 적용됐어요. 브라우저가 임의로 지우지 않습니다.',
      );
    }
  });
});

describe('persistResultNote — 거절된 경우', () => {
  // 🔴 M-0048의 형태를 막는 검사: 이미 설치한 사람에게 「설치하세요」라고 말하면 안 된다.
  it('APK 셸에게 「홈 화면에 추가」를 말하지 않는다 — 그 메뉴가 없다', () => {
    const note = persistResultNote({ surface: 'shell', canPersist: true }, false);
    expect(note).not.toContain('홈 화면에 추가');
    expect(note).not.toContain('메뉴(⋮)');
    expect(note).toContain('앱으로 설치해 쓰고 있어요');
  });

  it('이미 설치한 PWA에게도 「설치하세요」로 끝내지 않는다 — 막다른 문장 금지(§7-D)', () => {
    const note = persistResultNote({ surface: 'installed-pwa', canPersist: true }, false);
    expect(note).not.toContain('홈 화면에 추가');
    expect(note).toContain('이미 앱으로 설치돼 있는데도');
    expect(note).toContain('다시 눌러 보면'); // 다음에 할 일이 있다
  });

  it('브라우저 탭에서는 설치를 권한다 — 그 카드가 아직 남아 있다', () => {
    const note = persistResultNote({ surface: 'browser-tab', canPersist: true }, false);
    expect(note).toContain('홈 화면에 추가');
  });

  it('요청 기능이 없는 브라우저에는 없다고 말한다 — 표면과 무관하게', () => {
    for (const surface of SURFACES) {
      const note = persistResultNote({ surface, canPersist: false }, false);
      expect(note).toContain('요청하는 기능이 없어요');
      expect(note).not.toContain('다시 눌러'); // 없는 버튼을 다시 누르라고 하지 않는다
    }
  });

  // §7-D: 거절도 **상태**다. "안 됐다"에서 멈추지 말고 그래서 무엇을 하면 되는지까지.
  it('어떤 갈래에서도 백업 경로로 끝난다 — 막다른 곳이 없다', () => {
    for (const surface of SURFACES) {
      for (const canPersist of [true, false]) {
        expect(persistResultNote({ surface, canPersist }, false)).toContain('데이터 관리 › 백업');
      }
    }
  });

  // 🔴 §8 · M-0056: 관측 창은 원인을 단정하지 않는다. 크롬이 왜 거절했는지는 관측할 수 없다.
  it('거절 원인을 단정하지 않는다', () => {
    for (const surface of SURFACES) {
      const note = persistResultNote({ surface, canPersist: true }, false);
      expect(note).not.toMatch(/때문입니다|때문이에요|원인은/);
    }
  });

  // 🔴 마크다운 금지(진단 헌장 §5-7) — textContent로 그려지므로 별표가 그대로 찍힌다.
  // 옛 문장에 실제로 `**홈 화면에 추가**`가 박혀 있었다.
  it('마크다운 강조를 쓰지 않는다', () => {
    for (const surface of SURFACES) {
      for (const granted of [true, false]) {
        expect(persistResultNote({ surface, canPersist: true }, granted)).not.toContain('**');
      }
    }
  });
});

describe('표면 판정', () => {
  it('셸에서는 「보호가 적용됐는가」가 의미 있는 질문이 아니다 — 재본 적이 없다', () => {
    expect(persistIsMeaningful('shell')).toBe(false);
    expect(persistIsMeaningful('installed-pwa')).toBe(true);
    expect(persistIsMeaningful('browser-tab')).toBe(true);
  });

  it('표면마다 사용자가 알아볼 이름이 있다 — 기술코드를 화면에 내지 않는다(§5-8)', () => {
    expect(surfaceLabel('shell')).toBe('설치된 앱(APK)');
    expect(surfaceLabel('installed-pwa')).toBe('홈 화면에 추가된 앱');
    expect(surfaceLabel('browser-tab')).toBe('브라우저 탭');
    for (const s of SURFACES) expect(surfaceLabel(s)).not.toMatch(/[a-z-]{6,}/); // 슬러그 노출 금지
  });
});

describe('shouldAutoRequestPersist — 앱이 스스로 물을 것인가(§12)', () => {
  const base = { canPersist: true, persisted: false as boolean | null, alreadyTried: false };

  it('설치된 표면에서는 스스로 한 번 요청한다 — 크롬은 프롬프트를 띄우지 않는다', () => {
    expect(shouldAutoRequestPersist({ ...base, surface: 'shell' })).toBe(true);
    expect(shouldAutoRequestPersist({ ...base, surface: 'installed-pwa' })).toBe(true);
  });

  // 🔴 처음 연 사람에게 맥락 없는 권한 팝업을 던지지 않는다(파이어폭스는 여기서 대화상자).
  it('브라우저 탭에서는 하지 않는다 — 사용자가 누를 때만 간다', () => {
    expect(shouldAutoRequestPersist({ ...base, surface: 'browser-tab' })).toBe(false);
  });

  it('이미 보호됐으면 묻지 않는다', () => {
    for (const surface of SURFACES) {
      expect(shouldAutoRequestPersist({ ...base, surface, persisted: true })).toBe(false);
    }
  });

  // 거절이 반복되는 브라우저에서 매 실행마다 대화상자를 띄우면 앱이 사용자를 괴롭히는 것이다.
  it('한 번 시도했으면 다시 하지 않는다 — 이후는 진단 화면의 버튼이 맡는다', () => {
    for (const surface of SURFACES) {
      expect(shouldAutoRequestPersist({ ...base, surface, alreadyTried: true })).toBe(false);
    }
  });

  it('요청 기능이 없는 브라우저에서는 시도조차 하지 않는다', () => {
    for (const surface of SURFACES) {
      expect(shouldAutoRequestPersist({ ...base, surface, canPersist: false })).toBe(false);
    }
  });

  // persisted를 못 읽는 브라우저(null)를 「보호됨」으로 반올림하지 않는다(§8).
  it('보호 여부를 모르면(null) 설치 표면에서는 요청해 본다 — 모름을 ok로 읽지 않는다', () => {
    expect(shouldAutoRequestPersist({ ...base, surface: 'shell', persisted: null })).toBe(true);
  });
});

describe('storageHeadline — unknown은 왜 모르는지 말해야 한다(§7-E · M-0113)', () => {
  // 🔴 사용자 태블릿 실기기가 잡은 것: 판정문이 「용량을 알려주지 않아요」인데
  // 바로 아래 줄은 「사용 0%」였다. 한 화면이 자기와 모순됐다.
  it('용량을 아는데 「용량을 알려주지 않아요」라고 하지 않는다', () => {
    const h = storageHeadline({ level: 'unknown', surface: 'shell', quotaKnown: true });
    expect(h).not.toContain('저장 용량을 알려주지 않아요');
    expect(h).toContain('설치된 앱');
  });

  it('용량을 정말 모를 때는 그렇게 말한다 — 그 갈래가 사라진 게 아니다', () => {
    const h = storageHeadline({ level: 'unknown', surface: 'browser-tab', quotaKnown: false });
    expect(h).toBe('이 브라우저는 저장 용량을 알려주지 않아요');
  });

  // 더 구체적인 이유가 이긴다: 용량도 모르고 셸이기도 하면 용량 쪽을 말한다.
  it('이유가 겹치면 더 구체적인 쪽을 말한다', () => {
    expect(storageHeadline({ level: 'unknown', surface: 'shell', quotaKnown: false })).toContain('저장 용량');
  });

  it('ok · todo · problem 갈래는 그대로다', () => {
    expect(storageHeadline({ level: 'problem', surface: 'browser-tab', quotaKnown: true })).toContain('부족해요');
    expect(storageHeadline({ level: 'todo', surface: 'browser-tab', quotaKnown: true })).toContain('켜면 더 안전');
    expect(storageHeadline({ level: 'ok', surface: 'shell', quotaKnown: true })).toContain('임의로 지우지 않습니다');
  });

  it('어떤 갈래도 빈 문장을 내지 않는다(§4 — 모든 갈래에 값이 있다)', () => {
    for (const level of ['ok', 'todo', 'problem', 'unknown'] as const) {
      for (const surface of SURFACES) {
        for (const quotaKnown of [true, false]) {
          expect(storageHeadline({ level, surface, quotaKnown }).length).toBeGreaterThan(0);
        }
      }
    }
  });
});
