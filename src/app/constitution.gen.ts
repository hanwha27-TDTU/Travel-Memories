// GENERATED — 손으로 편집하지 마세요. 재생성: node scripts/gen-constitution.mjs
// SSOT: docs/CONSTITUTION.md (비타협 원칙 · 실행 규율 · §0 절대 위반 금지)
// check-constitution-gen 게이트가 이 파일이 헌법과 일치하는지(커밋본==재생성본) 검사합니다.

export interface ConstitutionItem {
  title: string;
  body: string;
}

/** 비타협 원칙 — 목적의 일부이지, 목적과 맞바꿀 대상이 아니다. */
export const PRINCIPLES: readonly ConstitutionItem[] = [
  { title: '사용자의 기억을 잃지 않는다.', body: '내구성 로컬 커밋(Dexie entity+operation atomic commit) 이후 앱 원인 유실은 0이다(브라우저 축출·사용자의 사이트데이터 삭제는 앱 통제 밖 → 백업·persist()·경고로 완화, docs/SYNC_PROTOCOL.md). 원본 사진은 사용자 기기에서 변경/삭제하지 않는다.' },
  { title: '사용자 기록과 AI 생성물을 섞지 않는다.', body: 'AI 출력은 사용자 필드가 아니라 ai_artifacts 테이블(Phase 7)에만 저장하고, AI 결과를 사용자 작성글처럼 표시하지 않는다.' },
  { title: '개인자료는 기본 비공개.', body: '여행·사진·GPS·동행인·비용·회고 모두 비공개가 기본. 승인 없는 공유/소셜 기능 없음.' },
  { title: '정직한 완료.', body: '자동 검증층이 통과한 것만 "통과"라 말한다. 시각·픽셀·실기기 상호작용은 "라이브 렌더 미실행 / 사용자 확인 권장"으로 분리 표기한다.' },
  { title: '복구 가능성 우선.', body: '위험한 작업은 사전검증·작업기록·실패복구·재시도·되돌리기·결과확인을 갖춘다.' },
];

/** 실행 규율 — 품질은 모델이 아니라 규율에서 나온다. */
export const DISCIPLINE: readonly ConstitutionItem[] = [
  { title: '행동 전 정독, 추측 금지.', body: 'SSOT 문서(docs/)를 먼저 로드한다.' },
  { title: '단일 진실원(SSOT).', body: '어떤 사실이 2곳 이상에 나오면 하나의 레지스트리를 두고, 파생물은 스크립트로 재생성한다. 손편집 중복 자체가 결함이다.' },
  { title: '의도가 아니라 현실로 검증.', body: '정적 게이트가 못 보는 것은 헤드리스 브라우저/실제 DOM 이벤트로 확인한다.' },
  { title: '게이트는 비공허하게.', body: '알려진 실패를 주입해 RED로 잡히는지 확인한 뒤에만 게이트를 신뢰한다. 셀렉터 불일치로 조용히 통과하지 않는지 검사한다.' },
  { title: '정직한 완료 보고.', body: '통과/스킵/실패를 구분해 보고한다. "UI 확인함"을 라이브 렌더 없이 말하지 않는다.' },
  { title: '결함 → 결함군 승격.', body: '버그를 단건으로 고치지 않고 근본형을 한 문장으로 추상화해 모든 형제 위치를 쓸고 게이트를 추가한다.' },
];

/** 절대 위반 금지 (§0). */
export const NEVER_DO: readonly string[] = [
  '사용자 원본 자료를 임의로 삭제/덮어쓰지 않는다.',
  'Supabase service_role 키/DB 비밀번호/관리자 JWT를 프론트엔드·번들·저장소·로그·리포트에 넣지 않는다. 클라이언트는 anon/publishable 키만.',
  'RLS 검증 없이 테이블을 배포하지 않는다.',
  '원본 사진을 기본적으로 Supabase에 저장하지 않는다(절약 모드 기본).',
  '사진 압축 전에 촬영시각·위치정보(EXIF)를 먼저 읽어 별도 저장한다.',
  '전체 코드베이스를 이유 없이 재작성하지 않는다.',
  '다른 에이전트가 작업 중인 파일을 동시에 수정하지 않는다.',
  '자동검사를 통과하지 않은 변경을 완료로 표시하지 않는다.',
  '사용자 승인 없이 소셜/공개 공유 기능을 추가하지 않는다.',
];
