// ui/screens/r2Setup.ts — 'R2 사진 저장소 설정 가이드' 모달.
//
// 왜 앱 안에 두나: 이 절차는 **외부 콘솔(Cloudflare·Supabase)에서 손으로 하는 일**이라 코드로 검증할 수
// 없다. 기계가 못 보는 단계일수록 기록이 정확해야 다음 사람(또는 6개월 뒤의 나)이 같은 함정을 피한다.
// 내용의 근거: Medical-Note 앱이 2026-07-25에 동일 이관을 끝까지 수행하고 넘긴 인수인계 문서(실측).
//
// 스크린샷: 각 단계의 `shot`에 `public/setup/r2/<파일>`을 지정하면 그림이 함께 뜬다(없으면 글만).
// 🔴 토큰 발급 결과 화면은 **캡처 금지**(Secret이 한 번만 평문으로 보인다) — 그 단계엔 shot을 두지 않는다.

import { el, setNote } from '../dom';
import { supabase } from '../../services/supabase/client';
import { r2Probe } from '../../services/r2';

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

// ── 쉬운 설명(맨 앞) — 전문용어 없이, 무엇을 왜 하는지부터 ──
const PLAIN: [string, string][] = [
  [
    '지금은 어떻게 되어 있나요?',
    '사진은 두 군데에 있어요. ① 내 휴대폰·태블릿 안(원본 그대로) ② 인터넷 창고(Supabase)에 "보여주기용 작은 사본". ②는 다른 기기에서도 같은 사진을 보려고 두는 거예요. 원본은 절대 인터넷에 올리지 않습니다.',
  ],
  [
    '왜 창고를 옮기나요?',
    '지금 창고는 여행앱·회계앱·메디컬앱이 **같이** 쓰고 있어요. 좁아지는 것도 문제지만, 진짜 문제는 한 앱을 예전 상태로 되돌리면 **다른 앱까지 같이 되돌아간다**는 점입니다. 앱마다 창고를 따로 쓰면 이 위험이 사라져요.',
  ],
  [
    '무엇을 만드나요? (비유)',
    '새 창고(Cloudflare R2)에 **우리 앱 전용 방**을 하나 빌립니다. 그 방 열쇠는 **관리인**(Supabase의 작은 프로그램)만 가지고 있어요. 우리 앱은 열쇠를 아예 못 봅니다.',
  ],
  [
    '그럼 사진은 어떻게 올리나요?',
    '앱이 관리인에게 "사진 하나 넣을게요"라고 말하면, 관리인이 **5분만 쓸 수 있는 임시 출입증**을 줍니다. 앱은 그 출입증으로 창고에 직접 사진을 넣어요. 5분이 지나면 출입증은 못 씁니다.',
  ],
  [
    '왜 열쇠를 앱에 안 주나요?',
    '앱은 여러분 휴대폰에서 도는 프로그램이라, 마음먹으면 안을 들여다볼 수 있어요. 거기에 진짜 열쇠를 두면 누구나 창고를 열 수 있게 됩니다. 그래서 열쇠는 관리인에게만 두고, 앱에는 매번 짧은 출입증만 줍니다.',
  ],
  [
    '옆집(메디컬 앱) 방은 못 열게 되나요?',
    '네. 우리 열쇠는 **우리 방 하나만** 열도록 만들어집니다. 프로그램에 실수가 있어도 옆집 방은 열 수 없어요 — "안 열도록 코드를 짰다"가 아니라 **열쇠 자체가 안 맞습니다.**',
  ],
  [
    '내 사진을 남이 볼 수 있나요?',
    '아니요. 창고를 **잠긴 상태로** 둡니다. 사진을 볼 때도 관리인에게 5분짜리 출입증을 받아야 해요. 주소만 알면 누구나 열리는 "공개 주소"는 **켜지 않습니다**. 이 앱은 개인 사진이 주인공이라 그 편법을 쓰지 않기로 했어요(2026-07-25 결정).',
  ],
  [
    '그러면 사진 보는 게 느려지지 않나요?',
    '거의 그대로예요. 이 앱은 화면에 그릴 때 **기기 안 사본**을 쓰기 때문입니다. 출입증이 필요한 순간은 "새 기기에서 그 사진을 처음 받아올 때" 딱 한 번뿐이에요.',
  ],
  [
    '사진 저장·삭제가 지금처럼 잘 되나요?',
    '네. 올리는 것도 지우는 것도 지금처럼 됩니다. 지우는 것은 앱이 직접 하지 않고 **관리인에게 부탁**하는 방식이라 오히려 더 안전해요. 그리고 화면에 사진을 그릴 때는 **원래부터 기기 안 사본**을 쓰기 때문에, 창고가 바뀌어도 보는 속도는 그대로입니다.',
  ],
  [
    '인터넷이 없으면요?',
    '아무 문제 없어요. 이 앱은 원래 기기에 먼저 저장하고 나중에 창고와 맞추는 방식입니다. 창고가 바뀌어도 그 성질은 그대로예요.',
  ],
  [
    '제가 할 일은 뭔가요?',
    '아래 단계를 순서대로 따라 하시면 됩니다. 대부분 홈페이지에서 버튼 몇 개 누르는 일이고, 마지막에 값 4개를 옮겨 적으면 끝나요. 위험한 곳은 빨간 표시로 미리 알려드립니다.',
  ],
];

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
    title: '🔒 공개 URL은 켜지 않는다 (읽기 정책 B)',
    body: '여기서는 아무것도 하지 않는다. "공개 액세스: 사용 안 함" 상태를 눈으로 확인만 하고 지나간다. 읽기도 함수가 5분 서명 URL을 발급하므로 공개 개발 URL이 필요 없다.',
    notes: [
      { tone: 'danger', text: '켜면 URL을 아는 사람은 인증 없이 사진을 열람할 수 있다 — 비타협 원칙 #3(개인자료 기본 비공개) 위반이다. 메디컬 앱은 A(공개 URL)를 쓰지만 우리는 개인 사진이 주인공이라 같은 절충을 받지 않는다(사용자 결정 2026-07-25, ADR-0024).' },
      { tone: 'warn', text: '따라서 R2_PUBLIC_BASE 시크릿도 등록하지 않는다 — 확보할 값은 5개가 아니라 4개다.' },
      { tone: 'tip', text: '오역 주의: 꺼진 상태 문구가 "공개 개발 URL을 비활성화할 수 없습니다"로 나오는데 실제 의미는 "아직 켜지지 않았다"이다 — 우리에겐 이게 정상 상태다.' },
    ],
  },
  {
    n: '5',
    where: '버킷 › 설정 › CORS 정책 › 편집',
    title: 'CORS 정책 — 빠뜨리면 마지막에만 실패한다',
    body: 'AllowedOrigins에 앱 origin, AllowedMethods에 PUT/GET/HEAD, AllowedHeaders에 content-type, ExposeHeaders에 ETag.',
    notes: [
      { tone: 'warn', text: '읽기 정책 B에서는 GET도 브라우저가 R2에 직접 보낸다 — PUT만 넣고 GET을 빼면 업로드는 되는데 새 기기에서 사진을 못 받는다(증상이 나중에, 다른 기기에서 나타난다).' },
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
    title: '시크릿 4개 등록',
    body: 'R2_ACCOUNT_ID · R2_BUCKET · R2_ACCESS_KEY_ID · R2_SECRET_ACCESS_KEY (R2_PUBLIC_BASE는 등록하지 않는다 — 읽기 정책 B)',
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
    body: '함수 이름은 media-sign. 소스는 우리 저장소의 supabase/functions/media-sign/index.ts 한 파일을 통째로 붙여넣는다.',
    notes: [
      { tone: 'warn', text: '메디컬 앱의 소스를 그대로 쓰지 않는다 — 우리 것은 읽기 서명(op:"get")이 있고 공개 URL을 쓰지 않으며, 객체 키를 검증된 로그인 정보에서 만든다.' },
      { tone: 'tip', text: '이름 입력칸은 편집기 하단(Deploy function 버튼 옆)에 있다 — 상단이 아니다.' },
      { tone: 'warn', text: '편집기가 Deno 전역을 몰라 빨간 타입 경고가 뜨지만 배포·실행에 무해하다. 여기서 멈추지 말 것.' },
      { tone: 'tip', text: '붙여넣기 무결성 확인: 마지막 줄이 "if (DENO) DENO.serve(handler);"로 끝나야 온전히 들어간 것이다(모바일 붙여넣기 잘림은 눈으로 못 잡는다).' },
    ],
  },
];

// ── 확보할 값 체크리스트 (읽기 정책 B — R2_PUBLIC_BASE 없음) ──
const VALUES: [string, string][] = [
  ['R2_ACCOUNT_ID', '대시보드 주소창 32자리 (1단계)'],
  ['R2_BUCKET', '버킷 이름 travel-log-media (3단계)'],
  ['R2_ACCESS_KEY_ID', '토큰 발급 결과 — "토큰 값" 아님 (6단계)'],
  ['R2_SECRET_ACCESS_KEY', '토큰 발급 결과 — 한 번만 보임 (6단계)'],
];

// ── 실패 진단표 ──
const TROUBLE: [string, string][] = [
  ['CORS / Failed to fetch', 'origin 불일치 — 앱 주소창 값과 AllowedOrigins를 글자 대조(끝 슬래시·경로)'],
  ['SignatureDoesNotMatch', '시크릿 앞뒤 공백, 또는 "토큰 값"을 Access Key ID로 오입력'],
  ['403 AccessDenied', '토큰 권한이 읽기 전용이거나 버킷 범위 밖'],
  ['서명 URL 만료(403)', '5분 초과 — 재시도하거나 기기 시계 확인(서명은 기기 시각이 아니라 함수 시각 기준이지만 재시도가 가장 빠른 해법)'],
  ['업로드는 되는데 새 기기에서 사진이 안 옴', 'CORS AllowedMethods에 GET/HEAD 누락 — 읽기 정책 B는 GET도 브라우저→R2 직접 (5단계)'],
  ['R2 environment variables are missing', '시크릿 이름 오타/누락 — 어떤 값이 비었는지는 응답에 안 담기니 함수 로그 확인'],
  ['삭제가 전부 실패', '버킷 잠금 규칙이 켜졌을 가능성 (5b단계)'],
];

// ── 검증 사다리 ──
const LADDER: [string, string, string][] = [
  ['1', '대시보드 함수 Test {"op":"probe"} → 200', '시크릿이 함수에 도달함 — 앱 경로는 증명 못 함(Test는 다른 권한으로 호출)'],
  ['2', '앱의 연결 확인 버튼', 'anon 경로로 함수 호출 성공 — R2로의 실제 업로드(CORS)는 증명 못 함'],
  ['3', '앱에서 사진 업로드', 'presign → 브라우저→R2 직접 전송 → 표시까지 전 경로 (결정적 검증)'],
  ['4', '새 기기(또는 시크릿 창)에서 그 사진 보기', '읽기 presign(op:get) + 키 파리티까지 — 정책 B에서만 필요한 단계'],
];

/**
 * 실측 기록 — 이 절차를 따라 실제로 성공한 날의 증거(추정이 아니라 관측).
 * 다음 사람(또는 6개월 뒤의 나)이 "이 문서가 실제로 통하는가"를 의심할 때 이 줄이 답이다.
 */
const PROVEN: [string, string][] = [
  ['적용일', '2026-07-25 (Bugeon Journey v0.57)'],
  ['사다리 3번', '통과 — 앱 저장 → R2에 image/webp 53.99 kB 객체 생성 확인'],
  ['키 파리티', '통과 — DB storage_path와 R2 객체 키가 완전히 일치({uid}/{mediaId}.webp)'],
  ['저장 클래스', '표준 확인(과금 함정 회피)'],
  ['삭제 경로', '함수 서명 삭제 200 확인'],
  ['사다리 4번', '미확인 — 새 기기에서 받아볼 때 증명된다'],
];

/**
 * 검증 사다리 2번 — 앱의 로그인 경로로 함수·시크릿까지 닿는지 확인.
 * **증명하지 못하는 것**: R2로의 실제 업로드(CORS). 그건 3번(사진 저장)에서만 드러난다.
 */
function probePanel(): HTMLElement {
  const wrap = el('div', 'r2-probe');
  const btn = el('button', 'btn-ghost', '연결 확인 (사다리 2번)') as HTMLButtonElement;
  btn.type = 'button';
  btn.setAttribute('data-probe-r2', '');
  const note = el('p', 'r2-probe-note');
  note.hidden = true;
  btn.addEventListener('click', () => {
    const client = supabase();
    if (!client) {
      // 이 화면이 곧 조치 화면이다 — 갈 곳을 만들면 자기 자신을 가리킨다(§7 제외 이유).
      setNote(note, '아직 Supabase 연결이 설정되지 않았습니다(로컬 전용 모드).', 'info', null);
      return;
    }
    btn.disabled = true;
    setNote(note, '확인 중…', 'info', null);
    void r2Probe(client)
      .then((r) => setNote(note, r.detail, r.ok ? 'ok' : 'error', null))
      .catch((e: Error) => setNote(note, `확인 실패: ${e.message}`, 'error', null))
      .finally(() => {
        btn.disabled = false;
      });
  });
  wrap.append(btn, note);
  return wrap;
}

export function openR2Setup(): void {
  const prevFocus = document.activeElement as HTMLElement | null;
  const overlay = el('div', 'overlay-base guide-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'R2 사진 저장소 설정 가이드');
  const modal = el('div', 'modal-base guide-modal');

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

  // 쉬운 설명(맨 앞) — 접었다 펼 수 있게. 처음 보는 사람은 여기부터.
  const plainBox = el('details', 'r2-plain') as HTMLDetailsElement;
  plainBox.open = true;
  const sum = el('summary', 'r2-plain-sum', '📖 먼저 쉬운 설명부터 (전문용어 없이)');
  plainBox.appendChild(sum);
  for (const [q, a] of PLAIN) {
    const qa = el('div', 'r2-qa');
    qa.append(el('b', 'r2-q', q), el('p', 'r2-a', a));
    plainBox.appendChild(qa);
  }
  body.appendChild(plainBox);

  body.appendChild(probePanel());

  body.appendChild(el('h3', 'guide-h', '설정 절차'));

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
  body.appendChild(el('h3', 'guide-h', `확보해야 할 값 ${VALUES.length}개`));
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

  body.appendChild(el('h3', 'guide-h', '실측 기록 — 이 절차는 실제로 통했다'));
  const pv = el('div', 'r2-table');
  for (const [k, v] of PROVEN) {
    const row = el('div', 'r2-row');
    row.append(el('code', 'r2-key r2-key-wide', k), el('span', 'r2-val', v));
    pv.appendChild(row);
  }
  body.appendChild(pv);

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
