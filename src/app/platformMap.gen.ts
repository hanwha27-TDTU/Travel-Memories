// app/platformMap.gen.ts — **자동 생성 파일. 손으로 고치지 마세요.**
//
// 생성: node scripts/gen-platform-map.mjs
// 게이트: check-platform-map (커밋본 == 재생성본을 강제)
//
// 각 행은 주장이 아니라 **코드에서 실측한 결과**다. 예컨대 '사진 파일'의 답은
// `mediaRemote`가 실제로 무엇을 쓰는지 읽어서 나온다 — 저장소를 바꾸면 표가 저절로
// 따라오고, 안 따라오면 게이트가 RED를 낸다.

export interface PlatformRow {
  id: string;
  /** 하는 일. */
  what: string;
  /** 한 줄 설명. */
  detail: string;
  /** 어느 서비스. */
  where: string;
  /** 그 서비스의 어느 부분. */
  part: string;
  /** 이 판정의 근거가 된 파일. */
  evidence: string;
}

export const PLATFORM_MAP: PlatformRow[] = [
  {
    id: 'auth',
    what: '로그인',
    detail: 'Google 계정 · 초대받은 사람만',
    where: 'Supabase',
    part: 'Auth',
    evidence: 'src/services/auth.ts',
  },
  {
    id: 'records',
    what: '기록 전부',
    detail: '여행 · 순간 · 사진 정보 · 비용 · 영구삭제 원장',
    where: 'Supabase',
    part: 'Postgres',
    evidence: 'src/services/sync.ts',
  },
  {
    id: 'rls',
    what: '접근 통제',
    detail: '남이 내 기록을 못 보게',
    where: 'Supabase',
    part: 'RLS',
    evidence: 'supabase/migrations/',
  },
  {
    id: 'sign',
    what: '사진 열쇠 발급',
    detail: '사진을 올리고 받을 때 쓰는 5분짜리 서명',
    where: 'Supabase',
    part: 'Edge Function',
    evidence: 'supabase/functions/media-sign/index.ts',
  },
  {
    id: 'bytes',
    what: '사진 파일',
    detail: '사진 그 자체(바이트)',
    where: 'Cloudflare',
    part: 'R2',
    evidence: 'src/services/sync.ts',
  },
  {
    id: 'local',
    what: '이 기기의 사본',
    detail: '오프라인에서도 열리는 진짜 원본',
    where: '내 기기',
    part: '브라우저 저장소',
    evidence: 'src/offline/db.ts',
  },
  {
    id: 'hosting',
    what: '앱 화면',
    detail: '주소창에 치는 그 페이지',
    where: 'GitHub',
    part: 'Pages',
    evidence: '.github/workflows/deploy-pages.yml',
  },
];
