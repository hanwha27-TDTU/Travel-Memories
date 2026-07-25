// app/errorLog.ts — 런타임 오류를 앱이 **스스로 기억한다**.
//
// 연역: 개발자(나)가 볼 수 없는 것 중 가장 흔한 것이 **사용자 기기에서 실제로 터진 오류**다.
// 브라우저 콘솔은 사용자가 열 줄 모르고, 열어도 캡처로 전달하면 글자가 잘린다. 그래서 앱이
// 스스로 최근 오류를 모아 두고, 사용자가 **텍스트로 복사**해 전달할 수 있게 한다.
//
// 설계 제약:
//  - **링버퍼**(최근 N건). 무한히 쌓으면 그 자체가 저장소를 먹는다.
//  - **메모리에만** 둔다. Dexie에 쓰면 오류가 저장소를 오염시키고, 백업 대상 판단도 흐려진다.
//    새로고침하면 사라지는 게 맞다 — 진단은 "지금 이 세션"이 대상이다.
//  - **개인정보 금지**: 메시지·스택만. 사용자가 적은 글·사진 내용은 오류 문자열에 실리지 않는다.
//    (다만 스택에 파일 경로가 들어가므로 복사 전 그 사실을 화면에 알린다.)

export interface AppError {
  at: string;
  kind: 'error' | 'unhandledrejection' | 'console';
  message: string;
  /** 스택 첫 줄들만(전체는 너무 길고 대개 첫 3줄이면 충분). */
  where: string;
}

const MAX = 30;
const buf: AppError[] = [];
let installed = false;

function push(kind: AppError['kind'], message: string, stack?: string): void {
  const where = (stack ?? '')
    .split('\n')
    .slice(1, 4)
    .map((l) => l.trim())
    .join(' ← ');
  buf.push({ at: new Date().toISOString(), kind, message: String(message).slice(0, 300), where: where.slice(0, 300) });
  if (buf.length > MAX) buf.shift();
}

/** 앱 시작 시 1회. 기존 콘솔 동작을 막지 않는다(가로채되 그대로 통과시킨다). */
export function installErrorLog(): void {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (e) => {
    push('error', e.message || '알 수 없는 오류', e.error instanceof Error ? e.error.stack : undefined);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r: unknown = e.reason;
    push('unhandledrejection', r instanceof Error ? r.message : String(r), r instanceof Error ? r.stack : undefined);
  });

  // console.error도 모은다 — 우리 코드가 catch 후 로그만 남기는 경로가 많아
  // window.onerror만으로는 그것들이 보이지 않는다.
  const orig = console.error.bind(console);
  console.error = (...args: unknown[]): void => {
    push('console', args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    orig(...args);
  };
}

export function recentErrors(): AppError[] {
  return [...buf].reverse(); // 최신이 위
}

export function errorCount(): number {
  return buf.length;
}

export function clearErrors(): void {
  buf.length = 0;
}
