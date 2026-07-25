// ui/screens/r2Setup.ts — 'R2 사진 저장소 설정 가이드' 모달.
//
// 왜 앱 안에 두나: 이 절차는 **외부 콘솔(Cloudflare·Supabase)에서 손으로 하는 일**이라 코드로 검증할 수
// 없다. 기계가 못 보는 단계일수록 기록이 정확해야 다음 사람(또는 6개월 뒤의 나)이 같은 함정을 피한다.
// 내용의 근거: Medical-Note 앱이 2026-07-25에 동일 이관을 끝까지 수행하고 넘긴 인수인계 문서(실측).
//
// 스크린샷: 각 단계의 `shot`에 `public/setup/r2/<파일>`을 지정하면 그림이 함께 뜬다(없으면 글만).
// 🔴 토큰 발급 결과 화면은 **캡처 금지**(Secret이 한 번만 평문으로 보인다) — 그 단계엔 shot을 두지 않는다.

import { el } from '../dom';

type Tone = 'danger' | 'warn' | 'tip';

interface Note {
  tone: Tone;
  text: string;
}

interface Step {
  n: string;
  where: string; // 어느 화면에서 하는가(경로)
  title: string;
  body: string;
  notes?: Note[];
  /** public/ 기준 경로. 사용자가 캡처를 주면 채운다. */
  shot?: string;
  shotCaption?: string;
}

const TONE_LABEL: Record<Tone, string> = {
  danger: '🚨 위험',
  warn: '⚠️ 함정',
  tip: '🟢 요령',
};

// ── 절차 (Medical-Note 실측 기준) ──
const STEPS: Step[] = [
  {
    n: '1',
    where: 'Cloudflare 대시보드 주소창',
    title: '계정 ID 확보',
    body: '로그인 직후 주소창의 32자리가 곧 R2_ACCOUNT_ID다. 사이드바를 뒤지는 것보다 확실하다. (dash.cloudflare.com/<32자리>/home)',
    notes: [{ tone: 'tip', text: '버킷 설정 › 일반 › S3 API 줄에서도 같은 값을 확인할 수 있다 — 함수가 만드는 엔드포인트와 같은 형태라 자가확인 지점이 된다.' }],
  },
  {
    n: '2',
    where: '빌드 › 스토리지 및 데이터베이스 › R2 객체 스토리지 › 개요',
    title: 'R2 진입',
    body: '2단 중첩이라 한 번에 못 찾는다. 위 경로를 그대로 따라간다.',
    notes: [
      { tone: 'warn', text: '왼쪽 최상위에 "R2"가 없다. 그리고 "R2 객체 스토리지"를 눌러도 하위만 펼쳐지고 화면은 안 바뀐다 — "개요"를 한 번 더 눌러야 진입한다.' },
      { tone: 'warn', text: '혼동 금지: R2 Data Catalog(다른 기능) · Secrets Store(Cloudflare 것 — 우리 시크릿은 Supabase에 넣는다)는 우리가 쓰는 게 아니다.' },
    ],
  },
  {
    n: '3',
    where: 'R2 › 버킷 만들기',
    title: '버킷 생성 — travel-log-media',
    body: '이름은 travel-log-media, 위치는 자동, 저장 클래스는 표준(Standard) 유지.',
    notes: [
      { tone: 'danger', text: '금전 함정: Infrequent Access가 싸 보이지만 무료 10GB는 Standard에만 적용된다. 싸 보이는 쪽을 고르면 오히려 과금된다.' },
      { tone: 'warn', text: '버킷 이름은 영구적이라 나중에 못 바꾼다. 메디컬 버킷과 절대 공유하지 않는다.' },
      { tone: 'tip', text: '생성 직후 상태 표시줄을 검증 체크리스트로 쓴다 — 저장 클래스=표준 / 공개 액세스=사용 안 함 / 크기 0B.' },
    ],
  },
  {
    n: '4',
    where: '버킷 › 설정 › 공개 개발 URL',
    title: '공개 URL 활성 → R2_PUBLIC_BASE',
    body: '얻은 https://pub-xxxxxxxx.r2.dev 가 R2_PUBLIC_BASE다. 끝의 / 는 빼고 저장한다.',
    notes: [
      { tone: 'warn', text: '오역 주의: 꺼진 상태 문구가 "공개 개발 URL을 비활성화할 수 없습니다"로 나오는데, 실제 의미는 "아직 켜지지 않았다"이다.' },
      { tone: 'danger', text: '이 URL을 아는 사람은 인증 없이 사진을 열람할 수 있다. 우리 앱은 개인 사진이 주인공이라 이 절충을 그대로 받을지 별도 결정이 필요하다(docs/STORAGE_R2_PROPOSAL.md §8).' },
    ],
  },
  {
    n: '5',
    where: '버킷 › 설정 › CORS 정책 › 편집',
    title: 'CORS 정책 — 빠뜨리면 마지막에만 실패한다',
    body: 'AllowedOrigins에 앱 origin, AllowedMethods에 PUT/GET/HEAD, AllowedHeaders에 content-type, ExposeHeaders에 ETag.',
    notes: [
      { tone: 'danger', text: 'Medical-Note가 실제로 겪은 사고: 이 단계가 빠져 있어 버킷·주소·토큰·시크릿·배포가 전부 맞는데도 마지막 업로드에서만 실패했다. 실패 지점과 원인 지점이 멀어 진단이 매우 어렵다.' },
      { tone: 'warn', text: 'origin은 추정하지 말고 앱 주소창에서 직접 복사한다 — GitHub Pages는 대문자를 소문자로 바꾼다. 경로는 빼고 도메인까지만, 끝 슬래시 없이.' },
      { tone: 'warn', text: 'content-type 허용이 필요한 이유: 업로드가 Content-Type 헤더를 보내 프리플라이트가 발생한다. 이 한 줄이 없으면 다른 게 다 맞아도 업로드만 실패한다.' },
      { tone: 'tip', text: '왼쪽 목차의 "CORS 정책" 클릭은 스크롤만 시킨다. 실제 편집은 섹션 제목 우측 버튼을 눌러야 한다.' },
    ],
  },
  {
    n: '5b',
    where: '버킷 › 설정 › 버킷 잠금 규칙',
    title: '🚨 절대 켜지 말 것',
    body: 'CORS 바로 아래 인접한 「버킷 잠금 규칙」은 열자마자 토글 ON·보존 기간 무기한이 채워져 있다. 이 패널이 뜨면 취소를 누른다.',
    notes: [
      { tone: 'danger', text: '저장하면 버킷 객체가 영구 삭제 불가 상태가 된다 → 앱의 사진 삭제가 전부 실패한다. compliance 기능이라 의도적으로 되돌리기 어렵게 설계돼 있다.' },
    ],
  },
  {
    n: '6',
    where: 'R2 › API 토큰 관리',
    title: '버킷 전용 토큰 발급',
    body: '계정 API 토큰(사용자 토큰 아님) · 권한 "개체 읽기 및 쓰기" · 특정 버킷 하나만 · TTL 계속 · IP 필터링 비움.',
    notes: [
      { tone: 'warn', text: '사용자 API 토큰을 쓰면 계정 상태가 바뀔 때 업로드가 어느 날 조용히 죽는다. 서버 자격증명이므로 계정 토큰이 맞다.' },
      { tone: 'warn', text: '"계정 API 토큰"을 "전체 계정 접근"으로 오독하지 말 것 — 유형(귀속 주체)과 범위(접근 리소스)는 별개다. 계정 토큰 + 버킷 1개 스코프가 정답.' },
      { tone: 'danger', text: '"이 계정의 모든 버킷에 적용 (새로 생성된 버킷 포함)"을 고르면 앞으로 만들 모든 앱의 버킷까지 자동 포함된다 — 격리가 무효가 된다.' },
      { tone: 'danger', text: 'IP 필터링을 비우는 이유: Supabase Edge Function은 실행 IP가 고정이 아니다. 적으면 업로드가 무작위로 실패하고 원인을 찾기 극히 어렵다.' },
      { tone: 'danger', text: '발급 결과에 값이 3개 나온다. 맨 위 "토큰 값"은 우리가 쓰지 않는다 — Access Key ID / Secret Access Key 두 개만 쓴다. 오입력 증상은 진단이 어려운 SignatureDoesNotMatch다.' },
      { tone: 'danger', text: '🔴 이 화면은 캡처 금지. Secret이 한 번만 평문으로 보인다. 전 과정에서 화면 공유 금지 구간은 여기 하나다.' },
    ],
  },
  {
    n: '7',
    where: 'Supabase › 프로젝트 › Edge Functions › MANAGE › Secrets',
    title: '시크릿 5개 등록',
    body: 'R2_ACCOUNT_ID · R2_BUCKET · R2_ACCESS_KEY_ID · R2_SECRET_ACCESS_KEY · R2_PUBLIC_BASE',
    notes: [
      { tone: 'warn', text: 'Edge Functions 목록 화면에는 Secrets 탭이 없다. 좌측 MANAGE › Secrets이며 URL 직행이 가장 확실하다(/functions/secrets).' },
      { tone: 'danger', text: '실패 원인 1위는 앞뒤 공백·줄바꿈 혼입이다. 모바일에서 길게 눌러 복사하면 섞이기 쉽다. 증상은 SignatureDoesNotMatch.' },
      { tone: 'tip', text: 'KEY=VALUE 여러 줄을 한 번에 붙여넣으면 자동 분리된다(= 좌우 공백 금지).' },
      { tone: 'tip', text: 'SUPABASE_URL 등 플랫폼 예약값은 등록하지 않는다 — 자동 제공된다. Secrets 목록 화면은 값이 다이제스트로만 보여 캡처해도 안전하다.' },
    ],
  },
  {
    n: '8',
    where: 'Supabase › Edge Functions › Deploy a new function › Via Editor',
    title: 'media-sign 함수 배포',
    body: '함수 이름은 media-sign. 소스는 앱 독립적이라 수정 없이 그대로 붙여넣는다.',
    notes: [
      { tone: 'tip', text: '이름 입력칸은 편집기 하단(Deploy function 버튼 옆)에 있다 — 상단이 아니다.' },
      { tone: 'warn', text: '편집기가 Deno 전역을 몰라 빨간 타입 경고가 뜨지만 배포·실행에 무해하다. 여기서 멈추지 말 것.' },
      { tone: 'tip', text: '붙여넣기 무결성 확인: 마지막 줄 번호가 326이면 온전히 들어간 것이다(모바일 붙여넣기 잘림은 눈으로 못 잡는다).' },
    ],
  },
];

// ── 확보할 값 체크리스트 ──
const VALUES: [string, string][] = [
  ['R2_ACCOUNT_ID', '대시보드 주소창 32자리 (1단계)'],
  ['R2_BUCKET', '버킷 이름 travel-log-media (3단계)'],
  ['R2_PUBLIC_BASE', '공개 개발 URL, 끝 / 제외 (4단계)'],
  ['R2_ACCESS_KEY_ID', '토큰 발급 결과 — "토큰 값" 아님 (6단계)'],
  ['R2_SECRET_ACCESS_KEY', '토큰 발급 결과 — 한 번만 보임 (6단계)'],
];

// ── 실패 진단표 ──
const TROUBLE: [string, string][] = [
  ['CORS / Failed to fetch', 'origin 불일치 — 앱 주소창 값과 AllowedOrigins를 글자 대조(끝 슬래시·경로)'],
  ['SignatureDoesNotMatch', '시크릿 앞뒤 공백, 또는 "토큰 값"을 Access Key ID로 오입력'],
  ['403 AccessDenied', '토큰 권한이 읽기 전용이거나 버킷 범위 밖'],
  ['서명 URL 만료(403)', '5분 초과 — 재시도하거나 기기 시계 확인'],
  ['주소는 생기는데 사진이 안 보임', '공개 개발 URL 미활성 또는 R2_PUBLIC_BASE 불일치'],
  ['R2 environment variables are missing', '시크릿 이름 오타/누락 — 어떤 값이 비었는지는 응답에 안 담기니 함수 로그 확인'],
  ['삭제가 전부 실패', '버킷 잠금 규칙이 켜졌을 가능성 (5b단계)'],
];

// ── 검증 사다리 ──
const LADDER: [string, string, string][] = [
  ['1', '대시보드 함수 Test {"op":"probe"} → 200', '시크릿이 함수에 도달함 — 앱 경로는 증명 못 함(Test는 다른 권한으로 호출)'],
  ['2', '앱의 연결 확인 버튼', 'anon 경로로 함수 호출 성공 — R2로의 실제 업로드(CORS)는 증명 못 함'],
  ['3', '앱에서 사진 업로드', 'presign → 브라우저→R2 직접 전송 → 표시까지 전 경로 (결정적 검증)'],
  ['4', '저장 후 재열기', 'DB 왕복 + 재파싱까지'],
];

export function openR2Setup(): void {
  const prevFocus = document.activeElement as HTMLElement | null;
  const overlay = el('div', 'guide-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'R2 사진 저장소 설정 가이드');
  const modal = el('div', 'guide-modal');

  const header = el('div', 'guide-header');
  const tw = el('div', 'guide-title-wrap');
  tw.append(
    el('h2', 'guide-title', '☁️ R2 사진 저장소 설정 가이드'),
    el('p', 'guide-sub', '외부 콘솔에서 손으로 하는 절차라 코드로 검증할 수 없다 — 그래서 더 정확히 기록한다.'),
  );
  const closeBtn = el('button', 'guide-close', '✕') as HTMLButtonElement;
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '닫기');
  header.append(tw, closeBtn);
  const body = el('div', 'guide-body');
  modal.append(header, body);
  overlay.appendChild(modal);

  body.appendChild(
    el(
      'p',
      'guide-note',
      '근거: Medical-Note 앱이 2026-07-25에 같은 이관을 처음부터 끝까지 수행하고 넘긴 인수인계 기록(추정이 아니라 실측이며, 틀렸던 것도 틀렸다고 적혀 있다). 아직 우리 앱에는 적용 전이며 설계는 docs/STORAGE_R2_PROPOSAL.md에 있다.',
    ),
  );

  // 단계
  for (const s of STEPS) {
    const card = el('div', 'r2-step');
    const head = el('div', 'r2-step-head');
    head.append(el('span', 'r2-step-n', s.n), el('b', 'r2-step-title', s.title));
    card.appendChild(head);
    card.appendChild(el('div', 'r2-step-where', `📍 ${s.where}`));
    card.appendChild(el('p', 'r2-step-body', s.body));
    for (const note of s.notes ?? []) {
      const nEl = el('div', `r2-note r2-note-${note.tone}`);
      nEl.append(el('b', 'r2-note-tag', TONE_LABEL[note.tone]), el('span', undefined, note.text));
      card.appendChild(nEl);
    }
    if (s.shot) {
      const fig = el('figure', 'r2-shot');
      const img = el('img') as HTMLImageElement;
      img.src = `${import.meta.env.BASE_URL}${s.shot}`;
      img.alt = `${s.title} 화면`;
      img.loading = 'lazy';
      fig.appendChild(img);
      if (s.shotCaption) fig.appendChild(el('figcaption', 'r2-shot-cap', s.shotCaption));
      card.appendChild(fig);
    }
    body.appendChild(card);
  }

  // 확보할 값
  body.appendChild(el('h3', 'guide-h', '확보해야 할 값 5개'));
  const vals = el('div', 'r2-table');
  for (const [k, where] of VALUES) {
    const row = el('div', 'r2-row');
    row.append(el('code', 'r2-key', k), el('span', 'r2-val muted small', where));
    vals.appendChild(row);
  }
  body.appendChild(vals);

  // 검증 사다리
  body.appendChild(el('h3', 'guide-h', '검증 사다리 — 앞 단계가 뒤를 보장하지 않는다'));
  const lad = el('div', 'r2-table');
  for (const [n, what, proves] of LADDER) {
    const row = el('div', 'r2-row');
    row.append(el('code', 'r2-key', n), el('b', 'r2-val', what), el('span', 'r2-val muted small', proves));
    lad.appendChild(row);
  }
  body.appendChild(lad);
  body.appendChild(
    el('p', 'guide-note', '1번이 200이어도 앱에서는 실패할 수 있다(호출 주체가 다르다). CORS 문제는 3번에서만 드러난다 — Medical-Note가 정확히 여기서 걸렸다. 그래서 3번은 자동화로 대체할 수 없고 릴리스 체크리스트에 사람 단계로 남긴다.'),
  );

  // 실패 진단
  body.appendChild(el('h3', 'guide-h', '증상 → 1순위 원인'));
  const tr = el('div', 'r2-table');
  for (const [sym, cause] of TROUBLE) {
    const row = el('div', 'r2-row');
    row.append(el('b', 'r2-key r2-key-wide', sym), el('span', 'r2-val muted small', cause));
    tr.appendChild(row);
  }
  body.appendChild(tr);

  body.appendChild(
    el(
      'p',
      'guide-note',
      '보안: R2 자격증명은 Supabase 함수 시크릿에만 둔다(저장소·브라우저·로그·문서 금지). 화면 공유 시 Secrets 목록은 안전(다이제스트만)하지만 토큰 발급 결과 화면은 캡처 금지다. 실수로 비밀값이 찍힌 이미지를 공유했다면 그 자격증명을 즉시 폐기·재발급한다 — 자동 스캐너는 텍스트만 보고 이미지는 못 잡는다.',
    ),
  );

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
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  closeBtn.focus();
}
