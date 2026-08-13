// ui/screens/guide.ts — '가이드' 모달. 이 앱이 어떻게 연결·설계·검증되는지 사용자에게
// 별도 창으로 보여준다(현재 화면은 유지). 두 묶음: [연결·설정] / [개발·설계].
//
// 정직성(§4·CLAUDE.md): 여기 적힌 사실은 "이 저장소에서 실제로 동작·게이트되는 것"만이다.
// 카운트·게이트 목록은 손으로 세지 않고 src/app/registry.gen.ts(자동 생성·check-registry-gen 게이트)에서
// 읽는다 — SSOT는 scripts/harness.mjs·.claude/agents/. 드리프트는 게이트가 RED로 잡는다(§7).
// 모든 자유 텍스트는 textContent로만 넣는다(innerHTML 금지 — dom.ts 규칙·CSP 게이트).

import { el } from '../dom';
import { APP_ICONS } from '../../app/apk';
import { orderedInstallerGuides, type InstallerGuide } from '../../app/installers';
import { buildPlaybookHtml, buildPlaybookMarkdown, playbookFilename, PLAYBOOK_VERSION } from '../../app/playbook';
import { iconSwitcher } from '../../services/capacitorShell';
import { EVAL_ITEMS, summarize, gradeOf, gradeClass, gradeLegend, CRITICAL_CAP } from '../../app/selfEval';
import { openDiagnosticsHub } from './diagnosticsHub';
import { REGISTRY } from '../../app/registry.gen';
import {
  AGENT_CATEGORY,
  AGENT_CATEGORY_LABEL,
  AGENT_DESC,
  type AgentCategory,
} from '../../app/agents';

import { GATE_DESC } from '../../app/gates';
import { DISPLAY_MAX, THUMB_MAX } from '../../media/compress';
import { PRINCIPLES, DISCIPLINE, NEVER_DO } from '../../app/constitution.gen';
import { openMechChecks } from './mechChecks';
import { PLATFORM_MAP, type PlatformRow } from '../../app/platformMap.gen';
/** 가이드에서 에이전트를 묶어 보여줄 순서(분류 자체는 agents.ts가 정본). */
const AGENT_CATEGORY_ORDER: readonly AgentCategory[] = ['core', 'design', 'audit'];

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

/**
 * 📄 설치 가이드(플레이북) 내려받기 — 화면 가이드와 **같은 SSOT**(apk.ts·changelog)에서
 * 실행 시점에 조립해 파일로 저장한다(app/playbook.ts). 버전은 앱 버전과 통일되고, 앱이
 * 업데이트되면 이 문서도 자동으로 따라온다. HTML(예쁘게 읽힘)·Markdown(이식) 둘 다 준다.
 */
function playbookDownloads(): HTMLElement {
  const box = el('div', 'guide-playbook');
  const save = (content: string, ext: 'html' | 'md', mime: string) => {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = el('a') as HTMLAnchorElement;
    a.href = url;
    a.download = playbookFilename(ext);
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 즉시 revoke하면 일부 브라우저가 저장을 취소한다 — 다음 틱에 정리한다.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const html = el('button', 'guide-open-dashboard guide-pb-btn', '📄 HTML로 저장') as HTMLButtonElement;
  html.type = 'button';
  html.addEventListener('click', () => save(buildPlaybookHtml(), 'html', 'text/html'));
  const md = el('button', 'guide-open-dashboard guide-pb-btn', '📝 Markdown으로 저장') as HTMLButtonElement;
  md.type = 'button';
  md.addEventListener('click', () => save(buildPlaybookMarkdown(), 'md', 'text/markdown'));
  const row = el('div', 'guide-pb-row');
  row.append(html, md);
  box.append(row, note(`이 가이드를 파일로 저장해 두거나 다른 사람에게 보낼 수 있어요. 문서 버전은 앱 버전과 같아요(지금 v${PLAYBOOK_VERSION}) — 앱이 업데이트되면 이 문서도 같이 최신이 돼요.`));
  return box;
}
function panel(children: HTMLElement[]): HTMLElement {
  const wrap = el('div', 'guide-detail-body');
  for (const c of children) wrap.appendChild(c);
  return wrap;
}

function installerSection(guide: InstallerGuide, preferred: boolean): HTMLElement {
  const section = el('section', 'guide-installer');
  const title = el('div', 'guide-installer-title');
  title.append(el('span', undefined, `${guide.icon} ${guide.name}`));
  if (preferred) title.append(el('span', 'guide-installer-badge', '이 기기에 추천'));
  const meta = el('p', 'guide-installer-meta', guide.meta);
  const download = el('a', 'guide-open-dashboard guide-apk-dl', `⬇️ ${guide.button}`) as HTMLAnchorElement;
  download.href = guide.url;
  download.target = '_blank';
  download.rel = 'noopener noreferrer';
  section.append(
    title,
    meta,
    steps(guide.steps.map((s) => [s.title, s.desc] as [string, string])),
    download,
    h('알아두면 좋은 것'),
    bullets([...guide.facts]),
  );
  return section;
}

/**
 * 🎨 앱 아이콘 선택 (ADR-0038). **셸(APK)에서만** 실제로 바꿀 수 있다 — 웹/PWA는 설치 시
 * 아이콘이 고정된다(§5: 안 되는 버튼을 보여주지 않는다 → 크롬에서는 「앱에서만」 안내만).
 * 라벨·순서·키는 `APP_ICONS`(SSOT)에서, 전환은 `iconSwitcher()`(네이티브) 한 곳으로만.
 */
function renderIconPicker(): HTMLElement {
  const sw = iconSwitcher();
  if (!sw) {
    return panel([
      h('앱에서만 바꿀 수 있어요'),
      p(`홈 화면 아이콘 바꾸기는 설치한 안드로이드 앱(APK)에서만 돼요. 웹/브라우저는 설치할 때 아이콘이 정해져서 나중에 못 바꿔요. 위 「설치파일 다운로드」에서 안드로이드 앱을 설치하면 여기서 ${APP_ICONS.length}가지 중 골라 바꿀 수 있어요.`),
    ]);
  }
  const box = panel([h('홈 화면 아이콘'), p('원하는 아이콘을 누르면 홈 화면 아이콘이 바뀌어요.')]);
  const grid = el('div', 'icon-grid');
  const note = el('p', 'muted small icon-grid-note', '');
  const tiles = new Map<string, HTMLButtonElement>();
  const mark = (cur: string): void => {
    for (const [key, t] of tiles) t.setAttribute('aria-pressed', String(key === cur));
  };
  const choose = async (key: string): Promise<void> => {
    note.textContent = '바꾸는 중…';
    try {
      const r = await sw.setIcon({ key });
      mark(r.current);
      // 🔴 런처 반영 지연을 정직하게 알린다 — 즉시 안 바뀌는 건 안드로이드 특성이지 실패가 아니다.
      note.textContent = '아이콘을 바꿨어요. 홈 화면에 바로 안 보이면 잠시 뒤(또는 홈을 나갔다 다시 오면) 반영돼요.';
    } catch (e) {
      note.textContent = `바꾸지 못했어요: ${String(e)}`;
    }
  };
  for (const { key, label } of APP_ICONS) {
    const t = el('button', 'icon-tile') as HTMLButtonElement;
    t.type = 'button';
    t.setAttribute('aria-pressed', 'false');
    const img = el('img', 'icon-tile-img') as HTMLImageElement;
    img.src = `${import.meta.env.BASE_URL}icons/app-icons/${key}.png`;
    img.alt = label;
    img.loading = 'lazy';
    t.append(img, el('span', 'icon-tile-label', label));
    t.addEventListener('click', () => void choose(key));
    tiles.set(key, t);
    grid.appendChild(t);
  }
  box.append(grid, note);
  // 현재 선택 표시(실패해도 기본은 여권).
  sw.available()
    .then((r) => mark(r.current))
    .catch(() => mark('passport'));
  return box;
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
      icon: '📦',
      label: '설치파일 다운로드',
      hint: '안드로이드와 Windows 설치파일을 한곳에서 받아요',
      render: () => {
        const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
        const guides = orderedInstallerGuides(userAgent);
        const body = panel([
          h('내 기기에 맞는 앱을 골라요'),
          p('지금 쓰는 기기에 맞는 버튼을 맨 위에 보여 드려요. 다른 기기용 버튼도 바로 아래에 있으니 가족이나 다른 기기에 보낼 때 쓸 수 있어요.'),
        ]);
        guides.forEach((guide, index) => body.appendChild(installerSection(guide, index === 0)));
        body.appendChild(h('이 설치 가이드를 파일로 저장'));
        body.appendChild(playbookDownloads());
        return body;
      },
    },
    {
      icon: '🪟',
      label: 'Windows 앱 로그인 설정',
      hint: '브라우저 로그인이 끝나면 앱으로 돌아오게 해요',
      render: () => {
        const body = panel([
          h('어려운 키 설정이 아니에요'),
          p('Supabase에게 “로그인이 끝나면 Bugeon Journey 앱으로 돌아가도 돼요”라고 주소 한 줄을 알려주는 일입니다.'),
          h('따라 하기'),
          steps([
            ['Supabase 설정 열기', '아래의 Supabase 로그인 주소 설정 열기 버튼을 누릅니다.'],
            ['Redirect URLs 찾기', '화면에서 Redirect URLs 또는 Redirect URL Allow List를 찾고 Add URL을 누릅니다.'],
            ['주소 한 줄 붙여넣기', 'app.bugeon.journey://auth-callback 을 그대로 붙여넣습니다. 별표(*)나 공백은 넣지 않습니다.'],
            ['저장하기', 'Save를 누릅니다. API 키를 새로 만들거나 바꾸지 않습니다.'],
            ['앱에서 확인하기', '새 Windows 설치본을 열고 Google 로그인을 누릅니다. 브라우저 로그인이 끝난 뒤 앱 창이 앞으로 오고 이메일이 보이면 성공입니다.'],
          ]),
          h('Windows 지도 주소도 함께 넣기'),
          bullets([
            'Kakao JavaScript SDK 도메인: https://tauri.localhost',
            'TomTom Domain whitelist: tauri.localhost',
            '키 값은 그대로 두고 허용 주소만 한 줄씩 더합니다.',
          ]),
          note('로그인 복귀가 실패하면 앱 아래 알림이 이유를 말합니다. 엉뚱한 host나 path는 세션으로 바꾸지 않습니다.'),
        ]);
        const links = el('div', 'guide-pb-row');
        const dashboard = el('a', 'guide-open-dashboard', 'Supabase 로그인 주소 설정 열기') as HTMLAnchorElement;
        dashboard.href = 'https://supabase.com/dashboard/project/ihxiywffzmvrwmqvatzt/auth/url-configuration';
        dashboard.target = '_blank';
        dashboard.rel = 'noopener noreferrer';
        const docs = el('a', 'guide-open-dashboard', 'Supabase 공식 설명 보기') as HTMLAnchorElement;
        docs.href = 'https://supabase.com/docs/guides/auth/redirect-urls';
        docs.target = '_blank';
        docs.rel = 'noopener noreferrer';
        links.append(dashboard, docs);
        body.appendChild(links);
        return body;
      },
    },
    {
      icon: '🎨',
      label: '앱 아이콘 바꾸기',
      hint: `홈 화면 아이콘을 ${APP_ICONS.length}가지 중에 골라요 (앱 전용)`,
      render: () => renderIconPicker(),
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
            '여행 기록과 사진의 최종본은 **클라우드**입니다. 오프라인에서 만든 것은 이 기기에 안전하게 대기했다가 연결되면 올라갑니다.',
            '사진은 태블릿 감상용 WebP가 클라우드 정본입니다. 업로드한 바이트를 다시 확인한 뒤 큰 입력 원본 복사본은 기기에서 정리합니다.',
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
            '입력 파일 그대로가 아니라 EXIF를 제거한 태블릿 감상용 WebP를 비공개 클라우드 정본으로 올립니다.',
          ]),
          note('상세: docs/SECURITY.md · docs/SYNC_PROTOCOL.md · docs/DEPLOYMENT.md'),
        ]),
    },
    {
      icon: '🗺️',
      label: '한국·중앙아시아 지도 설정',
      hint: '한국 Kakao→정부지도 · UZ/KZ/KG TomTom · 나머지 기존 지도',
      render: () => {
        const body = panel([
          h('어느 지도가 열리나요'),
          bullets([
            '한국: 카카오맵. 카카오맵을 못 불러오고 정부지도 키가 있으면 행정안전부 지도로 자동 전환',
            '우즈베키스탄·카자흐스탄·키르기스스탄: TomTom',
            '그 밖의 나라 또는 지역 확인 실패: 기존 OpenStreetMap',
          ]),
          h('지금 승인된 도로명주소 검색 연결 — 아주 쉽게'),
          steps([
            ['승인 건 확인하기', 'API 인증키 관리에서 이름이 「도로명주소 검색 API」이고 상태가 「승인」인지 확인합니다. 지도제공·좌표제공 키와는 서로 다른 열쇠입니다.'],
            ['Supabase 비밀 보관함 열기', '아래 「Supabase 비밀키 넣는 곳」 버튼을 누르고 Add new secret을 누릅니다.'],
            ['이름과 값 넣기', 'Name에는 JUSO_ROAD_KEY를 정확히 적고, Value에는 도로명주소 검색 API 승인키를 붙여넣습니다. Save를 누릅니다. VITE_JUSO_MAP_KEY라고 적으면 안 됩니다.'],
            ['끝 확인하기', '목록에 JUSO_ROAD_KEY라는 이름만 보이면 끝입니다. 키 값은 채팅이나 스크린샷으로 확인하지 않습니다. 앱은 카카오 검색 뒤 정부 공식 도로명주소를 찾고, 좌표는 승인 전까지 기존 카카오 REST 검색으로 안전하게 붙입니다.'],
          ]),
          h('정부지도 승인 뒤 할 일 — 아주 쉽게'),
          steps([
            ['맞는 승인 건 확인하기', 'API 인증키 관리에서 이름이 꼭 「지도제공 검색 API」이고 상태가 「승인」인지 봅니다. 도로명주소 검색 키는 지도 키가 아닙니다.'],
            ['승인키 복사하기', '승인된 지도제공 검색 API 항목을 열어 승인키를 복사합니다. 키 값은 채팅이나 스크린샷에 보이지 않게 합니다.'],
            ['GitHub 변수 만들기', '저장소 Settings → Secrets and variables → Actions → Variables → New repository variable을 누릅니다. 이름은 VITE_JUSO_MAP_KEY, 값은 방금 복사한 승인키입니다.'],
            ['새 배포 기다리기', '변수를 저장한 뒤 새 배포가 끝나면 한국에서 카카오맵 실패 시 정부지도가 두 번째로 열립니다. 키가 없거나 승인 전이면 기존 지도만 사용하므로 앱은 멈추지 않습니다.'],
          ]),
          h('지금 보이는 TomTom 화면에서 할 일'),
          steps([
            ['새 키를 만들지 않기', '이미 My First API key가 있으므로 그대로 사용합니다. 화면에 보이는 ID는 실제 API 키가 아닙니다.'],
            ['편집 화면 열기', 'My First API key 카드 오른쪽 끝의 … 버튼을 누르고 Edit를 누릅니다. 안 보이면 화면을 오른쪽으로 스크롤합니다.'],
            ['지도 제품은 그대로 두기', '사진의 Products 목록에 Map Display API가 이미 보이므로 이 부분은 손대지 않습니다.'],
            ['도메인 자물쇠 켜기', 'Security의 Domain whitelist를 Off에서 On으로 바꿉니다. 주소 입력칸에 hanwha27-tdtu.github.io를 적고 +, localhost를 적고 +, 127.0.0.1을 적고 +를 누릅니다. https://, 포트, /Travel-Memories/는 적지 않습니다.'],
            ['저장하고 키 복사하기', '세 주소 옆이 모두 휴지통 모양인지 확인한 뒤 화면 아래 Edit key를 누릅니다. 카드로 돌아와 Domain whitelist: On인지 확인하고, 가려진 실제 Key나 복사 버튼을 눌러 복사합니다. ID를 복사하면 안 됩니다.'],
            ['GitHub에 넣기', '저장소 Settings → Secrets and variables → Actions → Variables → New repository variable에서 이름을 VITE_TOMTOM_API_KEY로 만들고 실제 Key를 값에 붙여넣습니다.'],
            ['등록 완료라고만 알려주기', '키 값은 채팅에 보내지 말고 “TomTom 변수 등록 완료”라고만 알려주세요. 그다음 새 배포와 실제 지도 확인을 진행합니다.'],
          ]),
          h('끝났는지 확인하는 세 가지'),
          bullets([
            'TomTom 카드에 Domain whitelist: On이 보입니다.',
            'GitHub Variables 목록에 VITE_TOMTOM_API_KEY라는 이름이 보입니다.',
            'Supabase에는 TomTom 키를 넣지 않습니다. 로그인 Redirect URI도 만들지 않습니다.',
          ]),
          h('중요한 안전 규칙'),
          bullets([
            '키 값은 채팅·문서·스크린샷에 쓰지 않습니다. 웹 키는 숨기는 대신 TomTom의 도메인 제한으로 보호합니다.',
            '현재 위치는 처음 보이는 지도 중심만 맞춥니다. 지도를 직접 누르기 전에는 위치로 저장하지 않습니다.',
            'TomTom이나 Kakao를 못 불러오면 기존 지도로 자동으로 돌아갑니다.',
          ]),
          note('더 자세한 최종 순서표: docs/DEPLOYMENT.md의 「카카오맵 설정」·「정부 도로명주소 검색 설정」·「정부지도 예비 설정」·「TomTom 지도 설정」'),
        ]);
        const links = el('div', 'guide-pb-row');
        const jusoRoad = el('a', 'guide-open-dashboard', '도로명주소 API 신청·관리 열기') as HTMLAnchorElement;
        jusoRoad.href = 'https://business.juso.go.kr/jsm/jsmApiList';
        jusoRoad.target = '_blank';
        jusoRoad.rel = 'noopener noreferrer';
        const supabaseSecrets = el('a', 'guide-open-dashboard', 'Supabase 비밀키 넣는 곳') as HTMLAnchorElement;
        supabaseSecrets.href = 'https://supabase.com/dashboard/project/ihxiywffzmvrwmqvatzt/functions/secrets';
        supabaseSecrets.target = '_blank';
        supabaseSecrets.rel = 'noopener noreferrer';
        const juso = el('a', 'guide-open-dashboard', '정부지도 API 신청·관리 열기') as HTMLAnchorElement;
        juso.href = 'https://business.juso.go.kr/jst/jstMapApiSearch';
        juso.target = '_blank';
        juso.rel = 'noopener noreferrer';
        const tomtom = el('a', 'guide-open-dashboard', 'TomTom 개발자 사이트 열기') as HTMLAnchorElement;
        tomtom.href = 'https://developer.tomtom.com/user/me/apps';
        tomtom.target = '_blank';
        tomtom.rel = 'noopener noreferrer';
        const tomtomKeys = el('a', 'guide-open-dashboard', 'TomTom 키 공식 설명') as HTMLAnchorElement;
        tomtomKeys.href = 'https://developer.tomtom.com/platform/documentation/my-tomtom/api-key-management';
        tomtomKeys.target = '_blank';
        tomtomKeys.rel = 'noopener noreferrer';
        const tomtomSafety = el('a', 'guide-open-dashboard', 'TomTom 도메인 보호 설명') as HTMLAnchorElement;
        tomtomSafety.href = 'https://developer.tomtom.com/knowledgebase/platform/articles/api-key-management-best-practices/';
        tomtomSafety.target = '_blank';
        tomtomSafety.rel = 'noopener noreferrer';
        const kakao = el('a', 'guide-open-dashboard', 'Kakao Developers 열기') as HTMLAnchorElement;
        kakao.href = 'https://developers.kakao.com/console/app';
        kakao.target = '_blank';
        kakao.rel = 'noopener noreferrer';
        links.append(jusoRoad, supabaseSecrets, juso, tomtom, tomtomKeys, tomtomSafety, kakao);
        body.appendChild(links);
        return body;
      },
    },
    {
      icon: '🖼',
      label: '사진 저장 방식',
      hint: '클라우드 WebP가 사진 정본',
      render: () =>
        panel([
          h('이 앱은 사진을 어떻게 다루나'),
          p('사진은 이 기기에서 처리한 뒤 비공개 R2에 태블릿 감상용 WebP로 저장합니다. IndexedDB는 오프라인 대기와 빠른 표시를 위한 캐시입니다.'),
          h('처리 순서'),
          steps([
            ['EXIF 먼저', '압축 전에 촬영시각·GPS를 먼저 읽어 따로 저장합니다(§0 — 압축이 메타데이터를 잃지 않도록).'],
            ['안전한 임시 보관', '클라우드 저장을 확인하기 전까지 입력 원본 복사본을 IndexedDB에 보관합니다.'],
            // 크기는 compress.ts(정본)에서 읽는다 — 여기 손으로 적으면 값이 바뀔 때 조용히 거짓이 된다.
            ['파생 생성', `표시본(≤${DISPLAY_MAX} WebP)·썸네일(≤${THUMB_MAX} WebP)만 별도로 만듭니다.`],
            ['클라우드 확인', 'R2에서 같은 표시본 바이트를 다시 내려받아 확인한 뒤 입력 원본 복사본을 자동 정리합니다.'],
          ]),
          h('프라이버시'),
          bullets([
            'GPS 등 위치정보는 기본 비공개입니다.',
            '사진 삭제는 tombstone이라 실행취소하면 클라우드 정본 표시본으로 복원됩니다.',
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
          h(`작업 규율 (모델 이식 가능) — ${DISCIPLINE.length}가지`),
          p('품질은 모델이 아니라 규율에서 나옵니다.'),
          // 🔴 여기 문장을 손으로 옮겨 적지 않는다. 바로 이 목록의 2번이 *"손편집 중복 자체가
          // 결함"*이라고 말하는데, 정작 이 화면이 헌법을 베껴 두고 있었다(2026-08-03 전수 감사).
          // 이제 docs/CONSTITUTION.md에서 파생하고 `check-constitution-gen`이 드리프트를 RED로 잡는다.
          defs(DISCIPLINE.map((d) => [d.title, d.body])),
          note('정본: docs/CONSTITUTION.md(→ CLAUDE.md·AGENTS.md) · 상세: docs/LESSONS.md'),
        ]),
    },
    {
      icon: '🧩',
      label: '개발 에이전트 목록',
      hint: '어떤 검토 역할이 언제 켜지나',
      render: () =>
        panel([
          h(`${REGISTRY.logicalRoleCount}개 논리 역할 → .claude/agents/에 ${REGISTRY.agentCount}개 구현`),
          p('동시에 다 돌리지 않고, Orchestrator가 변경 유형에 필요한 역할만 호출합니다. (목록·개수는 자동 집계 — registry.gen.ts)'),
          // 🔴 목록을 손으로 나열하지 않는다. 예전엔 여기에 이름을 적어 뒀는데, 새 에이전트가
          // 생기거나 지워져도 화면은 옛 목록을 보여줬다(게이트에서 이미 겪은 결함군 · §7).
          // 이름은 `.claude/agents/`에서 파생하고 설명만 사람이 쓴다 —
          // `check-registry-gen`이 둘의 어긋남을 **양방향**으로 RED로 잡는다.
          ...AGENT_CATEGORY_ORDER.flatMap((cat) => {
            const names = REGISTRY.agents.filter((a) => AGENT_CATEGORY[a] === cat);
            if (names.length === 0) return [];
            return [
              h(`${AGENT_CATEGORY_LABEL[cat]} — ${names.length}개`),
              defs(names.map((a) => [a, AGENT_DESC[a] ?? '(설명 미등록)'])),
            ];
          }),
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
          // 🔴 아래 두 목록도 헌법에서 파생한다(손으로 옮겨 적으면 조용히 낡는다).
          // 특히 §0은 예전에 9개 중 **4개만** 옮겨 적혀 있었는데, 화면은 그게 전부인 것처럼
          // 보였다 — 「발췌」라고 말하지 않은 발췌는 사용자에게 거짓이다(§8 확인 불가 규율).
          h(`비타협 원칙 (목적의 일부) — ${PRINCIPLES.length}가지`),
          defs(PRINCIPLES.map((it) => [it.title, it.body])),
          h(`절대 위반 금지 (§0) — ${NEVER_DO.length}가지`),
          bullets([...NEVER_DO]),
          h('문서 지도(SSOT)'),
          p('충돌하면 공유 문서(PROJECT_SPEC)가 이깁니다. 특정 AI 대화가 아니라 저장소 문서가 기준입니다.'),
          note('정본: docs/CONSTITUTION.md → CLAUDE.md·AGENTS.md(자동 생성) · docs/ (SPEC·SECURITY·SYNC_PROTOCOL·DECISIONS …)'),
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
    // 등급 경계는 selfEval.ts의 GRADE_BANDS에서 조립한다 — 경계를 옮기면 이 문장이 따라온다.
    el('p', 'se-legend', `등급 ${gradeLegend()}   |   증거 Lv0 미확인 · Lv2 코드 존재 · Lv3 작동 확인 · Lv4 자동검증+실패주입 · Lv5 반복·기록·복구 입증`),
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
      el('span', `se-badge se-${gradeClass(it.score)}`, gradeOf(it.score)),
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
