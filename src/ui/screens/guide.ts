// ui/screens/guide.ts — '가이드' 모달. 이 앱이 어떻게 연결·설계·검증되는지 사용자에게
// 별도 창으로 보여준다(현재 화면은 유지). 두 묶음: [연결·설정] / [개발·설계].
//
// 정직성(§4·CLAUDE.md): 여기 적힌 사실은 "이 저장소에서 실제로 동작·게이트되는 것"만이다.
// 카운트·게이트 목록은 손으로 세지 않고 src/app/registry.gen.ts(자동 생성·check-registry-gen 게이트)에서
// 읽는다 — SSOT는 scripts/harness.mjs·.claude/agents/. 드리프트는 게이트가 RED로 잡는다(§7).
// 모든 자유 텍스트는 textContent로만 넣는다(innerHTML 금지 — dom.ts 규칙·CSP 게이트).

import { el } from '../dom';
import { APK_LATEST_URL, APK_INSTALL_STEPS, APK_FACTS } from '../../app/apk';
import { EVAL_ITEMS, summarize, gradeOf, CRITICAL_CAP } from '../../app/selfEval';
import { openDiagnosticsHub } from './diagnosticsHub';
import { REGISTRY } from '../../app/registry.gen';
import { GATE_DESC } from '../../app/gates';
import { openMechChecks } from './mechChecks';
import { PLATFORM_MAP, type PlatformRow } from '../../app/platformMap.gen';

// ── 상세 패널 조립 헬퍼 ──────────────────────────────────────────────
function h(text: string): HTMLElement {
  return el('h3', 'guide-h', text);
}
function p(text: string): HTMLElement {
  return el('p', 'guide-p', text);
}
function bullets(items: string[]): HTMLElement {
  const ul = el('ul', 'guide-ul');
  for (const it of items) ul.appendChild(el('li', undefined, it));
  return ul;
}
/** 좌:라벨 / 우:값 정의행 목록. */
function defs(rows: [string, string][]): HTMLElement {
  const box = el('div', 'guide-defs');
  for (const [k, v] of rows) {
    const row = el('div', 'guide-def');
    row.append(el('span', 'guide-def-k', k), el('span', 'guide-def-v', v));
    box.appendChild(row);
  }
  return box;
}
/** 번호 붙은 흐름 단계(설계개요도·검증 흐름용). */
function steps(items: [string, string][]): HTMLElement {
  const box = el('div', 'guide-steps');
  items.forEach(([title, desc], i) => {
    const step = el('div', 'guide-step');
    step.appendChild(el('span', 'guide-step-n', String(i + 1)));
    const body = el('div', 'guide-step-body');
    body.append(el('b', undefined, title), el('span', 'guide-step-desc', desc));
    step.appendChild(body);
    box.appendChild(step);
  });
  return box;
}
function note(text: string): HTMLElement {
  return el('p', 'guide-note', text);
}
function panel(children: HTMLElement[]): HTMLElement {
  const wrap = el('div', 'guide-detail-body');
  for (const c of children) wrap.appendChild(c);
  return wrap;
}

/**
 * **무엇이 어디서 도는가** 표 — `platformMap.gen.ts`에서 읽는다.
 *
 * 🔒 이 표의 내용을 여기에 **손으로 적지 않는다**(사용자 요청 2026-07-26:
 * *"이 내용을 적을 때 손으로 적지 말고 기계화시켜서 작성하게 설계해주세요"*).
 * 각 행은 `scripts/gen-platform-map.mjs`가 **코드를 읽어** 판정한 결과이고,
 * `check-platform-map` 게이트가 커밋본과 코드가 어긋나면 RED를 낸다.
 *
 * 그래서 저장소를 옮기거나 구조를 바꾸면 이 화면이 **저절로 따라오거나, 빌드가 멈춘다.**
 * 실제로 오늘 사진 바이트가 Supabase Storage → R2로 옮겨졌다(v0.86) — 손으로 적었다면
 * 그 순간부터 거짓말을 했을 것이고 아무도 몰랐을 것이다.
 */
function platformTable(): HTMLElement {
  const box = el('div', 'guide-plat');
  // 서비스별로 묶는다 — "Supabase가 이렇게 많은 일을 한다"가 한눈에 보여야 하기 때문이다.
  const order: string[] = [];
  const byWhere = new Map<string, PlatformRow[]>();
  for (const r of PLATFORM_MAP) {
    if (!byWhere.has(r.where)) {
      byWhere.set(r.where, []);
      order.push(r.where);
    }
    byWhere.get(r.where)?.push(r);
  }

  for (const where of order) {
    const rows = byWhere.get(where) ?? [];
    const group = el('div', 'guide-plat-group');
    const head = el('div', 'guide-plat-head');
    head.append(
      el('span', 'guide-plat-where', where),
      el('span', 'guide-plat-count', `${rows.length}가지`),
    );
    group.appendChild(head);

    for (const r of rows) {
      const row = el('div', 'guide-plat-row');
      const left = el('div', 'guide-plat-left');
      left.append(el('b', 'guide-plat-what', r.what), el('small', 'guide-plat-detail', r.detail));
      row.append(left, el('span', 'guide-plat-part', r.part));
      group.appendChild(row);
    }
    box.appendChild(group);
  }
  return box;
}

// ── 카드/그룹 레지스트리 ─────────────────────────────────────────────
interface GuideCard {
  icon: string;
  label: string;
  hint: string;
  /** 이 모달 안에서 펼칠 내용. 별도 창을 여는 카드는 null. */
  render: (() => HTMLElement) | null;
  /** 별도 모달을 여는 카드(진단 도구 등) — 가이드를 닫고 그 창을 연다. */
  open?: () => void;
}
interface GuideGroup {
  icon: string;
  title: string;
  hint: string;
  cards: GuideCard[];
}

const CONNECT_GROUP: GuideGroup = {
  icon: '🔌',
  title: '연결 · 설정 가이드',
  hint: '저장·사진·개발 도구를 앱에 연결하는 방법',
  cards: [
    {
      icon: '📱',
      label: '안드로이드 앱 설치',
      hint: '갤러리 사진 위치가 살아 있는 유일한 길',
      render: () => {
        // 🔒 순서·문장·주소를 여기 손으로 적지 않는다 — 전부 src/app/apk.ts(SSOT)에서 읽고,
        // check-apk-release-link 게이트가 워크플로 ↔ 상수 ↔ 이 화면의 계약 일치를 강제한다.
        const dl = el('a', 'guide-open-dashboard guide-apk-dl', '⬇️ 최신 앱(APK) 내려받기') as HTMLAnchorElement;
        dl.href = APK_LATEST_URL;
        dl.target = '_blank';
        dl.rel = 'noopener';
        const body = panel([
          h('왜 앱이 따로 있나요'),
          p(
            '휴대폰(안드로이드)은 사진을 브라우저에 줄 때 위치를 지워서 줘요. 그래서 웹으로 쓰면 사진 위치가 안 들어와요. 이 앱만 위치가 살아 있는 원본 그대로 받을 수 있어요.',
          ),
          h('설치 순서 (한 번만 하면 돼요)'),
          steps(APK_INSTALL_STEPS.map((s) => [s.title, s.desc] as [string, string])),
        ]);
        // 버튼은 단계 목록 **바로 아래**에 둔다 — 1단계가 "아래 버튼"이라고 말하므로(§7 화면 대칭).
        body.appendChild(dl);
        body.appendChild(h('알아두면 좋은 것'));
        body.appendChild(bullets([...APK_FACTS]));
        return body;
      },
    },
    {
      icon: '🗺',
      label: '무엇이 어디서 도나',
      hint: '앱의 각 부분이 사는 곳',
      render: () =>
        panel([
          h('한눈에 보기'),
          p('이 앱은 한 곳에서 다 돌지 않습니다. 부분마다 사는 곳이 다르고, 그래서 한 곳이 멈춰도 나머지는 삽니다.'),
          platformTable(),
          h('꼭 아셔야 할 것'),
          bullets([
            '기록의 진짜 원본은 **이 기기**에 있습니다. 인터넷이 없어도 앱은 그대로 열리고 저장됩니다.',
            '서버는 **기기 사이를 잇는 다리**입니다 — 원본이 아니라 사본을 주고받는 곳이에요.',
            '사진 파일만 다른 회사(Cloudflare R2)에 둡니다. 용량이 크고 오가는 양이 많아서예요.',
            '**사진을 R2에 두어도 Supabase가 필요합니다** — 사진을 여닫는 열쇠(서명)를 거기서 발급하거든요.',
          ]),
          note('이 표는 손으로 적은 것이 아니라 앱 코드를 읽어 만들어집니다. 저장소나 구조가 바뀌면 표가 저절로 따라오고, 안 따라오면 배포가 멈춥니다.'),
        ]),
    },
    {
      icon: '🗄',
      label: 'Supabase 연결',
      hint: '데이터 저장·동기화 설정',
      render: () =>
        panel([
          h('무엇을 하나'),
          p('로그인(Google)과 기기 간 동기화를 켭니다. 설정이 없으면 앱은 “📴 로컬 모드”로 동작하며, 모든 기록은 여전히 이 기기에 안전하게 저장됩니다.'),
          h('필요한 값'),
          defs([
            ['VITE_SUPABASE_URL', '프로젝트 URL'],
            ['VITE_SUPABASE_ANON_KEY', '공개(anon) 키만 — service_role 키는 절대 금지(§0)'],
          ]),
          h('안전 규칙'),
          bullets([
            '클라이언트에는 anon/publishable 키만 넣습니다. 관리자 키·DB 비밀번호는 번들·저장소·로그 어디에도 넣지 않습니다.',
            '모든 테이블은 소유자 범위 RLS로 보호되어 남의 데이터에 접근할 수 없습니다.',
            '원본 사진은 기본적으로 서버에 올리지 않습니다(절약 모드 기본).',
          ]),
          note('상세: docs/SECURITY.md · docs/SYNC_PROTOCOL.md · docs/DEPLOYMENT.md'),
        ]),
    },
    {
      icon: '🖼',
      label: '사진 저장 방식',
      hint: '원본은 기기, 파생본은 WebP',
      render: () =>
        panel([
          h('이 앱은 사진을 어떻게 다루나'),
          p('외부 이미지 서비스를 쓰지 않습니다. 사진은 이 기기에서 처리되어 로컬(IndexedDB)에 보관됩니다.'),
          h('처리 순서'),
          steps([
            ['EXIF 먼저', '압축 전에 촬영시각·GPS를 먼저 읽어 따로 저장합니다(§0 — 압축이 메타데이터를 잃지 않도록).'],
            ['원본 보존', '원본 Blob은 그대로 보관하고 절대 수정·삭제하지 않습니다.'],
            ['파생 생성', '표시본(≤1600 WebP)·썸네일(≤320 WebP)만 별도로 만듭니다.'],
          ]),
          h('프라이버시'),
          bullets([
            'GPS 등 위치정보는 기본 비공개입니다.',
            '사진 삭제는 tombstone(원본 보존)이라 실행취소로 완전 복원됩니다.',
          ]),
          note('상세: docs/MEDIA_PIPELINE.md · docs/PRIVACY.md'),
        ]),
    },
    {
      icon: '🤖',
      label: 'Claude · 에이전트 개발 연결',
      hint: '이 앱을 만든 개발 도구',
      render: () =>
        panel([
          h('사용자 기능이 아니라 개발 방식'),
          p('이 앱 자체에 AI가 탑재된 것은 아닙니다. 개발은 Claude Code와 역할별 서브에이전트로 진행하며, Orchestrator가 변경 유형에 필요한 검토 역할만 골라 켭니다.'),
          h('규율'),
          bullets([
            'AI 생성물과 사용자 기록을 섞지 않습니다(§2). AI 출력은 사용자 필드가 아니라 별도 저장소에만 둡니다.',
            '자동 검사를 통과하지 않은 변경을 “완료”로 표시하지 않습니다.',
          ]),
          note('상세: AGENTS.md · CLAUDE.md · docs/AGENT_REGISTRY.md'),
        ]),
    },
    {
      icon: '⚙️',
      label: '설정 · 배포 전체',
      hint: '처음부터 끝까지 한 번에',
      render: () =>
        panel([
          h('배포 계약'),
          p('정적 사이트(Vite 빌드)로 GitHub Pages에 배포됩니다. 하위경로(base)를 인식하고, 없는 경로는 빈 화면 대신 홈으로 안전 폴백합니다.'),
          h('릴리스 전 관문'),
          bullets([
            'npm run harness — Required 게이트 전체(typecheck·시크릿·배선·CSP·일관성·유닛).',
            'npm run build — 타입검사 + 프로덕션 빌드.',
          ]),
          note('상세: docs/DEPLOYMENT.md · scripts/harness.mjs'),
        ]),
    },
  ],
};

const DEV_GROUP: GuideGroup = {
  icon: '🛠',
  title: '개발 · 설계',
  hint: '이 앱이 만들어진 구조·규율·검증',
  cards: [
    {
      icon: '🗺',
      label: '설계개요도',
      hint: '데이터가 화면까지 닿는 큰 그림',
      render: () =>
        panel([
          h('도메인 — 순간(Moment) 중심'),
          p('여행을 긴 글 하나로 저장하지 않습니다. 사진·장소·비용·감정을 “순간” 단위로 연결해, 나중에 그 기억을 다시 찾아줍니다.'),
          defs([['계층', 'Trip → TripDay → Moment → Media / Place / Expense / Companion / Reflection']]),
          h('저장 → 동기화 흐름'),
          steps([
            ['로컬 우선 커밋', '저장은 항상 이 기기(Dexie)에 먼저. entity+operation을 원자적으로 쓰고 같은 키를 되읽어(read-back) 확인한 뒤에만 “완료”.'],
            ['대기열 적재', '변경은 sync 큐에 쌓입니다. 로그인 전에도 유실되지 않습니다.'],
            ['서버 병합', '로그인·온라인 시 push(멱등 upsert+read-back) 후 pull(교체가 아니라 병합).'],
            ['화면 렌더', '타임라인·지도·통계는 활성(tombstone 제외) 데이터에서 다시 그립니다.'],
          ]),
          note('상세: docs/ARCHITECTURE.md · docs/DATA_MODEL.md'),
        ]),
    },
    {
      icon: '🧪',
      label: '기계화검증 흐름도',
      hint: '잘못된 변경은 자동으로 막힙니다',
      render: () => {
        const body = panel([
          h(`의도가 아니라 현실로 검증 — Required 게이트 ${REGISTRY.gateCount}가지`),
          p('“통과했다”고 말하려면 자동 게이트가 실제로 통과해야 합니다. 아래 목록·개수는 손으로 세지 않고 scripts/harness.mjs에서 자동 집계합니다(registry.gen.ts).'),
          defs(REGISTRY.gates.map((g) => [g, GATE_DESC[g] ?? '(설명 미등록)'])),
          h('게이트를 비공허하게'),
          p('알려진 실패를 일부러 주입해 RED로 잡히는지 확인한 뒤에만 게이트를 신뢰합니다. 셀렉터 불일치로 조용히 통과하지 않는지 검사합니다.'),
          note('이 목록은 자동 생성입니다 — scripts/harness.mjs가 정본, check-registry-gen이 일치를 강제.'),
        ]);
        const open = el('button', 'guide-open-dashboard', '🛡️ 기계화 검증 흐름도 대시보드 열기') as HTMLButtonElement;
        open.type = 'button';
        open.addEventListener('click', openMechChecks);
        body.appendChild(open);
        return body;
      },
    },
    {
      icon: '📋',
      label: '개발 규율 모음',
      hint: '검증된 작업 원칙',
      render: () =>
        panel([
          h('작업 규율 (모델 이식 가능)'),
          p('품질은 모델이 아니라 규율에서 나옵니다.'),
          bullets([
            '행동 전 정독, 추측 금지 — SSOT 문서를 먼저 로드한다.',
            '단일 진실원(SSOT) — 사실이 2곳 이상이면 레지스트리 하나에서 파생·재생성. 손편집 중복 자체가 결함.',
            '의도가 아니라 현실로 검증 — 정적 게이트가 못 보는 것은 실제 DOM 이벤트로 확인.',
            '게이트는 비공허하게 — 실패를 주입해 RED로 잡힌 뒤에만 신뢰.',
            '정직한 완료 보고 — 통과/스킵/실패를 구분. 라이브 렌더 없이 “UI 확인함” 금지.',
            '결함 → 결함군 승격 — 근본형을 한 문장으로 추상화해 형제 위치를 모두 쓸고 게이트 추가.',
          ]),
          note('상세: CLAUDE.md · docs/LESSONS.md'),
        ]),
    },
    {
      icon: '🧩',
      label: '개발 에이전트 목록',
      hint: '어떤 검토 역할이 언제 켜지나',
      render: () =>
        panel([
          h(`139개 논리 역할 → .claude/agents/에 ${REGISTRY.agentCount}개 구현`),
          p('동시에 다 돌리지 않고, Orchestrator가 변경 유형에 필요한 역할만 호출합니다. (개수는 자동 집계 — registry.gen.ts)'),
          h('통합(구현·검증)'),
          bullets([
            'orchestrator — 분해·라우팅·게이트 선택',
            'frontend — 화면·상태·Supabase 배선',
            'offline-sync — Dexie·오프라인 대기열·LWW/tombstone',
            'media-pipeline — EXIF·압축·썸네일·업로드',
            'supabase — 스키마·RLS·마이그레이션',
            'travel-domain — Trip/Moment/Place/통계 규칙',
            'security-privacy — 시크릿·RLS 침투·EXIF/PII',
            'qa — 유닛·통합·E2E·성능(읽기전용)',
            'reviewer-release — 리뷰·릴리스·롤백 조율',
            'product-ux — 범위·흐름·토큰·접근성',
          ]),
          h('디자인(감성·실용 균형)'),
          bullets([
            'travel-experience-director — 디자인 결과 통합·승인',
            'memory-centered-ux · mobile-capture-ux · photo-storytelling-designer',
            'timeline-interaction-designer · map-experience-designer · travel-design-system',
            'emotional-visual-director · motion-interaction-designer · empty-state-designer',
            '감사: accessibility · adversarial-visual · design-consistency · mobile-device',
            '동기화: design-token-sync · figma-handoff',
          ]),
          note('정본: .claude/agents/ · docs/AGENT_REGISTRY.md'),
        ]),
    },
    {
      icon: '📊',
      label: '자기점검평가',
      hint: '가중치·증거수준 기반 100점 척도',
      render: () => selfEvalPanel(),
    },
    {
      icon: '🩺',
      label: '진단 도구',
      hint: '동기화·무결성·저장소·환경·오류',
      render: null,
      open: () => openDiagnosticsHub(),
    },
    {
      icon: '📜',
      label: 'AI 개발 거버넌스',
      hint: '함께 지키는 규칙 문서 모음',
      render: () =>
        panel([
          h('비타협 원칙 (목적의 일부)'),
          bullets([
            '① 사용자의 기억을 잃지 않는다 — 로컬 내구성 커밋 이후 앱 원인 유실 0.',
            '② 사용자 기록과 AI 생성물을 섞지 않는다.',
            '③ 개인자료는 기본 비공개 — 승인 없는 공유 없음.',
            '④ 정직한 완료 — 자동 검증층이 통과한 것만 통과.',
            '⑤ 복구 가능성 우선 — 위험 작업은 사전검증·되돌리기·결과확인을 갖춘다.',
          ]),
          h('절대 위반 금지 (§0)'),
          bullets([
            '사용자 원본 자료를 임의로 삭제·덮어쓰지 않는다.',
            'service_role 키·DB 비밀번호·관리자 JWT를 프론트·번들·저장소·로그에 넣지 않는다.',
            'RLS 검증 없이 테이블을 배포하지 않는다.',
            '사진 압축 전에 EXIF(촬영시각·위치)를 먼저 읽어 저장한다.',
          ]),
          h('문서 지도(SSOT)'),
          p('충돌하면 공유 문서(PROJECT_SPEC)가 이깁니다. 특정 AI 대화가 아니라 저장소 문서가 기준입니다.'),
          note('정본: CLAUDE.md · AGENTS.md · docs/ (SPEC·SECURITY·SYNC_PROTOCOL·DECISIONS …)'),
        ]),
    },
  ],
};

const GROUPS: GuideGroup[] = [CONNECT_GROUP, DEV_GROUP];

// ── 모달 렌더 ────────────────────────────────────────────────────────

/**
 * 자기점검평가 — **가중치 × 점수 × 증거수준**으로 100점 척도를 만든다.
 *
 * 점수 자체가 목적이 아니다. 가중치가 큰데 점수·증거가 낮은 항목이 곧 **다음에 할 일**이다.
 * 조작 방지는 `check-self-eval` 게이트가 맡는다(가중치 합 100 · 증거별 점수 상한 · gap 필수 ·
 * 6하원칙 6필드 필수). 화면은 그 결과를 숨김 없이 보여준다.
 */
function selfEvalPanel(): HTMLElement {
  const sum = summarize();
  const wrap = panel([]);

  const head = el('div', 'se-head');
  const score = el('div', 'se-score');
  score.append(el('strong', 'se-score-n', String(sum.total)), el('span', 'se-score-d', '/ 100'));
  const meta = el('div', 'se-head-meta');
  meta.append(
    el('p', 'se-head-title', `종합 자기평가 · ${sum.grade}`),
    el('p', 'se-head-sub', `${EVAL_ITEMS.length}개 항목 · 가중치 합 ${sum.weightSum} · 평균 증거수준 Lv ${sum.evidenceAvg}`),
  );
  head.append(score, meta);
  wrap.appendChild(head);

  wrap.appendChild(
    el('p', 'se-legend', '등급 세계적 95+ · 우수 85+ · 양호 70+ · 보통 50+ · 취약 <50   |   증거 Lv0 미확인 · Lv2 코드 존재 · Lv3 작동 확인 · Lv4 자동검증+실패주입 · Lv5 반복·기록·복구 입증'),
  );
  if (sum.capped) {
    wrap.appendChild(el('p', 'se-cap', `⚠️ 미해결 치명결함이 있어 종합점수에 상한(${CRITICAL_CAP})이 걸렸습니다. 원점수 ${sum.raw}.`));
  }

  for (const it of EVAL_ITEMS) {
    const card = el('div', 'se-item');
    const top = el('div', 'se-item-top');
    top.append(
      el('span', 'se-item-title', `${it.n}. ${it.title}`),
      el('span', 'se-item-score', `${it.score}`),
      el('span', `se-badge se-${gradeOf(it.score) === '세계적' ? 'world' : gradeOf(it.score) === '우수' ? 'good' : gradeOf(it.score) === '양호' ? 'ok' : 'weak'}`, gradeOf(it.score)),
    );
    const bar = el('div', 'se-bar');
    const fill = el('div', 'se-bar-fill');
    fill.style.width = `${it.score}%`;
    bar.appendChild(fill);
    const sub = el('p', 'se-item-sub', `가중치 ${it.weight} · 증거 Lv${it.evidence}`);
    const basis = el('p', 'se-basis', it.basis);
    const gap = el('p', 'se-gap', `아직 못 한 것 — ${it.gap}`);

    // 6하원칙은 기본 접힘: 필요한 사람만 펼쳐 본다(화면을 어지럽히지 않으면서 규율은 지킨다).
    const det = el('details', 'se-w');
    const sm = el('summary', 'se-w-sum', '육하원칙으로 보기');
    det.appendChild(sm);
    const dl = el('div', 'r2-table');
    for (const [k, label] of [['why', '왜'], ['what', '무엇을'], ['where', '어디서'], ['when', '언제'], ['who', '누가'], ['how', '어떻게']] as [keyof typeof it.w, string][]) {
      const r = el('div', 'r2-row');
      r.append(el('code', 'r2-key', label), el('span', 'r2-val', it.w[k]));
      dl.appendChild(r);
    }
    det.appendChild(dl);

    card.append(top, bar, sub, basis, gap, det);
    wrap.appendChild(card);
  }

  wrap.appendChild(
    note(
      '이 점수의 한계(정직): 자동 검증층(harness·유닛·라이브 렌더)이 통과한 것만 "검증됨"으로 칩니다. 실기기 터치·명암비 실측·다기기 네트워크 왕복·대량 사진 성능은 코딩 밖 전제이며 증거수준에 반영돼 있습니다. 가중치·점수·증거수준의 구조는 check-self-eval 게이트가 잠급니다 — 근거 없이 점수만 올릴 수 없습니다.',
    ),
  );
  return wrap;
}

function buildCardButton(card: GuideCard, onOpen: (card: GuideCard) => void): HTMLElement {
  const btn = el('button', 'guide-card') as HTMLButtonElement;
  btn.type = 'button';
  const ic = el('span', 'guide-card-ic', card.icon);
  ic.setAttribute('aria-hidden', 'true');
  const mid = el('span', 'guide-card-mid');
  mid.append(el('b', 'guide-card-label', card.label), el('small', 'guide-card-hint', card.hint));
  const chev = el('span', 'guide-card-chev', '›');
  chev.setAttribute('aria-hidden', 'true');
  btn.append(ic, mid, chev);
  btn.addEventListener('click', () => onOpen(card));
  return btn;
}

function buildGroup(group: GuideGroup, onOpen: (card: GuideCard) => void): HTMLElement {
  const box = el('section', 'guide-group');
  box.append(
    el('div', 'guide-group-title', `${group.icon} ${group.title}`),
    el('div', 'guide-group-hint', group.hint),
  );
  const grid = el('div', 'guide-card-grid');
  for (const c of group.cards) grid.appendChild(buildCardButton(c, onOpen));
  box.appendChild(grid);
  return box;
}

/** '가이드' 모달을 연다. 현재 화면은 유지하고 위에 오버레이로 뜬다. */
export function openGuide(): void {
  const prevFocus = document.activeElement as HTMLElement | null;

  const overlay = el('div', 'overlay-base guide-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '가이드');

  const modal = el('div', 'modal-base guide-modal');

  // 헤더
  const header = el('div', 'guide-header');
  const titleWrap = el('div', 'guide-title-wrap');
  titleWrap.append(
    el('h2', 'guide-title', '가이드'),
    el('p', 'guide-sub', '현재 화면은 유지한 채 별도 창으로 확인합니다.'),
  );
  const closeBtn = el('button', 'guide-close', '✕') as HTMLButtonElement;
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '가이드 닫기');
  header.append(titleWrap, closeBtn);

  const bodyEl = el('div', 'guide-body');
  modal.append(header, bodyEl);
  overlay.appendChild(modal);

  // 홈(카드 그리드) ↔ 상세 전환. 상세를 닫으면 그리드로 복귀(대시보드로 튀지 않음).
  const showHome = (): void => {
    bodyEl.innerHTML = '';
    const grid = el('div', 'guide-groups');
    for (const g of GROUPS) grid.appendChild(buildGroup(g, showDetail));
    bodyEl.appendChild(grid);
    closeBtn.focus();
  };
  const showDetail = (card: GuideCard): void => {
    // 별도 창을 여는 카드(진단 도구)는 가이드를 닫고 그쪽으로 넘긴다 — 모달 중첩을 만들지 않는다.
    if (!card.render && card.open) {
      close();
      card.open();
      return;
    }
    bodyEl.innerHTML = '';
    const bar = el('div', 'guide-detail-bar');
    const back = el('button', 'guide-back', '‹ 가이드') as HTMLButtonElement;
    back.type = 'button';
    back.addEventListener('click', showHome);
    bar.append(back, el('span', 'guide-detail-title', `${card.icon} ${card.label}`));
    bodyEl.append(bar, card.render!());
    bodyEl.scrollTop = 0;
    back.focus();
  };

  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus();
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close(); // 배경 탭으로 닫기
  });
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
  showHome();
}
