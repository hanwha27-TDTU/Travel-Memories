// app/selfEval.ts — 앱이 **스스로 매기는 100점 척도 자기평가**의 단일 진실원(SSOT).
//
// 왜 점수인가: 예전 자기점검은 ✅/⚠️ 여섯 줄이었다. 정직하긴 했지만 **어디가 약한지, 얼마나
// 약한지**를 말하지 못해 개선 우선순위를 못 준다. 점수는 그 자체가 목적이 아니라 **가중치 × 증거**로
// "무엇부터 고칠지"를 드러내는 장치다.
//
// 조작 방지 3장치(이게 없으면 자기평가는 자기위안이다):
//  1) **가중치 합 = 100 고정.** 한 항목을 올리려면 다른 항목을 내려야 한다(`check-self-eval` 게이트).
//  2) **증거수준(Lv 0~5)을 점수와 함께 표기.** 근거 없는 고득점은 화면에서 바로 드러난다.
//     Lv0=미확인 · Lv1=주장만 · Lv2=코드 존재 · Lv3=정상작동 확인 · Lv4=자동검증+실패주입 · Lv5=반복·기록·복구 입증
//  3) **치명결함 상한.** 미해결 critical이 있으면 종합점수에 상한을 강제한다 — 한 곳이 무너지면
//     나머지가 아무리 좋아도 높은 점수를 말할 수 없다.
//
// 6하원칙(사용자 요구): 각 항목은 **왜/무엇을/어디서/언제/누가/어떻게**를 답할 수 있어야 한다.
// 답이 막히는 지점이 곧 위험이므로, 막히면 점수를 낮추고 `gap`에 그 사실을 적는다.

import { REGISTRY } from './registry.gen';

export type Grade = '세계적' | '우수' | '양호' | '보통' | '취약';

export interface FiveW1H {
  why: string;
  what: string;
  where: string;
  when: string;
  who: string;
  how: string;
}

export interface EvalItem {
  n: number;
  title: string;
  /** 가중치(합 100). 기억 손실에 가까울수록 높다. */
  weight: number;
  /** 0~100. 근거 없이 올리지 않는다. */
  score: number;
  /** 증거수준 0~5. 점수와 함께 보여 "근거 없는 고득점"을 드러낸다. */
  evidence: number;
  /** 근거 한 줄 — 무엇이 이 점수를 지탱하는가. */
  basis: string;
  /** 아직 못 한 것 — 정직의 핵심. 비어 있으면 그 자체가 의심스럽다. */
  gap: string;
  w: FiveW1H;
}

/**
 * 평가 항목. **손으로 적되 근거를 함께 적는다.**
 * 자동 집계 가능한 부분(게이트 수 등)은 `REGISTRY`에서 파생해 드리프트를 막는다.
 */
export const EVAL_ITEMS: EvalItem[] = [
  {
    n: 1,
    title: '데이터 안전 · 기억 보존',
    weight: 14,
    score: 88,
    evidence: 4,
    basis: `내구성 로컬 커밋(entity+op 원자) + read-back 확인, tombstone 전용, 빈-클라우드 가드, 좀비 차단(version 우위). 유닛·트랜잭션 검사로 잠금.`,
    gap: '실제 2기기 동시 편집 경합은 이 환경에서 재현 불가 — 사용자 기기 몫.',
    w: {
      why: '앱의 존재 이유가 기억 보존이라 여기 실패는 회복이 불가능하다.',
      what: '로컬 커밋 이후 앱 원인 유실 0. 원본 사진은 기기에서 변경·삭제하지 않는다.',
      where: 'offline/db.ts · services/sync.ts · sync/merge.ts',
      when: '모든 쓰기 시점 + 매 동기화(push/pull)',
      who: '데이터 소유자는 사용자. RLS 소유자 범위가 서버 경계.',
      how: '원자 커밋 → read-back → LWW·tombstone 우위 병합. 실패 시 대기열 보존.',
    },
  },
  {
    n: 2,
    title: '삭제 전파 · 좀비 방지',
    weight: 10,
    score: 82,
    evidence: 4,
    basis:
      'cascade 전 종류 op 생성(정적+실행 이중 게이트), pull에서 서버 대조 상시 재큐잉, 서버 기준 고아 스윕, 영구삭제 표식(ADR-0025).',
    gap: '깨끗한 상태에서의 전체 사이클(올리기→지우기→바이트 반영)이 아직 미검증. 오늘 수정 대부분은 이미 꼬인 상태를 되돌리는 경로였다.',
    w: {
      why: '지운 것이 되살아나면 사용자는 앱을 신뢰할 수 없다(2026-07-25 실제 사고, M-0006).',
      what: '로컬에서 tombstone/복원한 엔티티는 종류 무관 큐 op를 갖는다.',
      where: 'services/{trips,moments,media,expenses}.ts · sync.ts',
      when: '삭제·복원 즉시(op) + 매 pull(서버 대조)',
      who: '앱이 만든 tombstone만. 서버 행 하드 삭제는 하지 않는다(다른 기기 좀비 방지).',
      how: 'check-domain-symmetry(정적) + cascadeOps.test.ts(실행) 두 층.',
    },
  },
  {
    n: 3,
    title: '보안 · 개인정보',
    weight: 11,
    score: 86,
    evidence: 4,
    basis:
      '클라이언트 publishable 키만, 시크릿 스캔 게이트(비공허 실증), 소유자 범위 RLS + 초대제, R2 자격증명은 함수 시크릿에만, 객체 키를 서버가 생성, 읽기도 서명(공개 URL 미사용).',
    gap: 'RLS 침투 검사는 트랜잭션 롤백 기준 — 실제 다중 사용자 동시 접근은 미검증.',
    w: {
      why: '개인 사진·GPS·비용은 유출 시 회복이 불가능하다(비타협 원칙 #3).',
      what: '개인자료 기본 비공개. 승인 없는 공유·소셜 없음.',
      where: 'SECURITY.md · supabase/migrations · functions/media-sign · services/r2.ts',
      when: '모든 요청. 서명 URL 수명 300초.',
      who: 'auth.uid() 소유자 + 초대 허용목록.',
      how: 'DB는 RLS, 바이트는 토큰 스코프 + Edge Function(RLS가 없는 곳의 벽).',
    },
  },
  {
    n: 4,
    title: '테스트 · 검증 체계',
    weight: 10,
    score: 90,
    evidence: 5,
    // 라이브 검사 **개수는 적지 않는다.** 여기 「77검사」가 박혀 있었고 실제는 그 두 배가 되도록
    // 아무도 못 봤다 — `check-hand-counts`는 '게이트' 개수만 보므로 이 자리는 게이트 밖이었다.
    // 손으로 셀 수 없게 만드는 대신 **셀 것을 없앴다**(개수는 `npm run harness`가 말한다).
    basis: `harness ${REGISTRY.gateCount}게이트(전부 셀프테스트 내장 — 알려진 실패를 주입해 RED 확인 후에만 신뢰), 유닛 + 실제 브라우저 라이브 렌더, 결함 재주입으로 비공허 실증을 반복 수행.`,
    gap: '실기기 터치·픽셀·다기기 네트워크는 자동 검증 밖. "라이브 렌더 미실행"으로 분리 표기한다.',
    w: {
      why: '게이트가 공허하면 통과는 거짓 안심이다.',
      what: '통과라고 말할 수 있는 것과 없는 것의 경계를 코드로 고정.',
      where: 'scripts/harness.mjs · scripts/check-*.mjs · tests/unit · verify-editor-live.mjs',
      when: '매 커밋 전 + CI 배포 전',
      who: '구현자 자기인증 금지 — 게이트가 판정한다.',
      how: '셀프테스트 내장 → 결함 주입 RED 확인 → 그 뒤에만 게이트를 신뢰.',
    },
  },
  {
    n: 5,
    title: '관측 가능성 · 진단',
    weight: 8,
    score: 72,
    evidence: 3,
    basis: '동기화 진단 화면(대기열 상태별·tombstone·op 없는 항목·표식·항목 id 목록), ID 무결성 점검, R2 연결 확인.',
    gap: '가장 최근에 생긴 축이라 성숙도가 낮다. 서버·바이트 저장소 상태는 앱에서 못 본다(콘솔 필요). 자동 경보 없음.',
    w: {
      why: '창이 없으면 추측하게 된다 — 실제로 같은 문제를 4회 오진했다(M-0008).',
      what: '로컬 상태를 사실 그대로 노출. 단정하지 않는다.',
      where: 'services/diagnostics.ts · domain/integrity.ts · ui/screens/dataManager.ts',
      when: '사용자가 열 때(수동). 자동 알림은 없음.',
      who: '읽기 전용 — 아무것도 고치지 않는다.',
      how: '개수 + 항목 id를 함께. 해석은 근거가 있을 때만 붙인다.',
    },
  },
  {
    n: 6,
    title: '백업 · 재해 복구',
    weight: 9,
    score: 84,
    evidence: 4,
    basis:
      '단일 JSON + 여행별 ZIP, AES-GCM 암호화, 병합 복원(교체 아님)·빈-데이터 가드, 왕복 드릴 유닛, 신선도 표시, 복원이 서버로도 전파(op 생성).',
    gap: '자동 스케줄·오프사이트 사본은 설계상 사용자 책임(비공개 기본). 대용량 복원 실측 미수행.',
    w: {
      why: '기기 분실 시 원본 사진은 백업이 유일 원천이다(절약 모드의 귀결).',
      what: '복원은 병합이며 어떤 형식이든 공통 코어를 거친다.',
      where: 'services/backup.ts · backupCrypto.ts · zip.ts',
      when: '사용자 실행 시. 14일 이상이면 신선도 경고.',
      who: '사용자 기기. 암호구절은 앱이 저장하지 않는다.',
      how: 'exportCollectRows/importMergeRows 단일 코어 + check-backup-coverage 게이트.',
    },
  },
  {
    n: 7,
    title: 'SSOT · 문서 기계화',
    weight: 8,
    score: 91,
    evidence: 5,
    basis: `registry.gen.ts 자동 집계(게이트·에이전트·스킬·화면·마이그레이션·이력 수), 문서 카운트 마커 대조, 배선맵·스키마 파리티·환경변수 배선 게이트로 손편집 중복 차단.`,
    gap: '산문 속 서술형 사실(숫자가 아닌 것)은 여전히 손편집 — 게이트가 못 본다.',
    w: {
      why: '같은 사실이 두 곳에 있으면 반드시 어긋난다(M-0001).',
      what: '열거 가능한 사실은 생성하고, 손으로 적지 않는다.',
      where: 'scripts/gen-registry.mjs · src/app/registry.gen.ts · docs/*',
      when: '변경 시 재생성, 커밋본==생성본을 게이트가 검사.',
      who: '스크립트가 유일한 작성자.',
      how: 'SSOT → 생성 → 게이트 대조 3단.',
    },
  },
  {
    n: 8,
    title: '실수 기록 · 재발 방지',
    weight: 7,
    score: 88,
    evidence: 5,
    basis:
      '실수 원장(증상/원인/수정/예방) 9건, LESSONS 근본형 접목, 결함을 단건이 아니라 결함군으로 승격해 게이트 추가(M-utc-slice·cascade op·VITE 배선·도메인 대칭).',
    gap: '판단·프로세스 실수(관측 없이 추측 등)는 게이트로 기계화하기 어렵다 — 규율 문서에만 존재.',
    w: {
      why: '기록 없이 고친 실수는 기억에서 시작하는 다음 세션에 재발한다.',
      what: '체크포인트를 넘었거나 재발한 실수는 수정과 같은 변경에서 기록.',
      where: 'docs/records/coding-mistakes.md · docs/LESSONS.md',
      when: '수정과 동시(나중에가 아니라).',
      who: '실수한 주체가 직접 기록.',
      how: '기록 + 기계화(게이트)를 한 쌍으로.',
    },
  },
  {
    n: 9,
    title: '오프라인 우선 · 동기화 견고성',
    weight: 8,
    score: 83,
    evidence: 4,
    basis: '로컬 우선 저장 → 대기열 → 멱등 upsert + read-back, 실패 상태 분류·재시도, 부모 우선 push 순서(복합 FK).',
    gap: '실제 다기기 왕복·네트워크 단절 중 부분 실패는 사용자 환경에서만 검증 가능.',
    w: {
      why: '여행 중에는 인터넷이 없는 순간이 많다.',
      what: '오프라인에서도 기록이 완결되고, 연결되면 스스로 맞춘다.',
      where: 'offline/db.ts · services/sync.ts',
      when: '기록 즉시 로컬 확정, 동기화는 나중에.',
      who: '기기별 대기열. 서버가 최종 조정자.',
      how: '대기열 + 멱등 + read-back + LWW.',
    },
  },
  {
    n: 10,
    title: 'UI · 반응형 · 접근성',
    weight: 7,
    score: 76,
    evidence: 3,
    basis: '라이브 렌더(경계 폭 12종 가로 넘침 0, 2단 전환, 상태 시각 위계), 토큰 기반 색·간격, 다크/계절 테마.',
    gap: '명암비 실측·화면읽기 실사용·실기기 터치는 미수행. 이 축의 증거수준이 가장 낮다.',
    w: {
      why: '여행 중 한 손으로 10초 안에 기록되지 않으면 기억은 남지 않는다.',
      what: '사진이 주인공이고 UI는 물러선다.',
      where: 'ui/styles/*.css · ui/screens/*',
      when: '모든 화면 변경 시 경계 폭 재측정.',
      who: '구현자 자기인증 금지 — 라이브 렌더가 판정.',
      how: 'DOM 순서=논리 순서, 시각 분기는 CSS로.',
    },
  },
  {
    n: 11,
    title: '비용 · 자원 효율',
    weight: 5,
    score: 85,
    evidence: 4,
    basis: '표시본만 업로드(원본 미업로드), 클라이언트 썸네일, R2 egress 무료, 환율 캐시(과거 확정값 영구), 사진당 읽기 서명 1회.',
    gap: '대량 사진(수백 장) 실측 미수행 — 저메모리 기기 체감은 미검증.',
    w: {
      why: '무료 한도를 넘으면 개인 프로젝트가 지속 불가능해진다.',
      what: '바이트는 최소로, 재취득 가능한 것은 캐시.',
      where: 'media/compress.ts · services/{r2,fx}.ts',
      when: '업로드 시 압축, 조회 시 캐시 우선.',
      who: '계정 전체 합산 한도(앱별 아님 — 1판의 오해를 정정).',
      how: '절약 모드 기본 + 파생 캐시는 백업 제외.',
    },
  },
  {
    n: 12,
    title: '정직한 완료 보고',
    weight: 3,
    score: 93,
    evidence: 5,
    basis:
      '자동 검증층이 통과한 것만 "통과". 미검증은 화면·PR·문서에 분리 표기. 설계 예측이 빗나가면 문서에 정정 이력을 남긴다(제안서 §4·§7).',
    gap: '이 항목 자체가 자기평가라 외부 검증이 없다 — 사용자 신고가 유일한 반증 경로.',
    w: {
      why: '거짓 안심은 결함보다 나쁘다.',
      what: '통과/스킵/실패/미검증을 구분해 말한다.',
      where: 'PR 본문 · 화면 하단 주석 · HANDOFF',
      when: '모든 완료 보고 시점.',
      who: '보고 주체가 직접 한계를 적는다.',
      how: '"라이브 렌더 미실행" 등 미검증 축을 명시적으로 분리.',
    },
  },
];

/**
 * 등급 경계 — 화면과 문서가 같은 기준을 쓰도록 **여기서만** 정의한다.
 *
 * 🔴 판정과 **범례**가 같은 표를 읽게 만든 이유: 예전엔 `gradeOf`가 if 사슬이고 가이드 화면의
 * 범례는 「세계적 95+ · 우수 85+ …」를 **손으로 적어** 있었다. 경계를 하나 옮기면 화면이
 * 조용히 거짓말을 한다 — 그리고 그건 게이트가 못 본다(자료구조는 옳고 문장만 틀리는 §10 ③).
 * 등급 배지의 CSS 클래스도 여기 두어, 새 등급이 생기면 화면이 자동으로 따라온다.
 */
export const GRADE_BANDS: readonly { min: number; grade: Grade; cls: string }[] = [
  { min: 95, grade: '세계적', cls: 'world' },
  { min: 85, grade: '우수', cls: 'good' },
  { min: 70, grade: '양호', cls: 'ok' },
  { min: 50, grade: '보통', cls: 'weak' },
  { min: -Infinity, grade: '취약', cls: 'weak' },
];

export function gradeOf(score: number): Grade {
  return (GRADE_BANDS.find((b) => score >= b.min) ?? GRADE_BANDS[GRADE_BANDS.length - 1]).grade;
}

/** 등급 배지 CSS 클래스(화면이 등급→클래스를 손으로 사슬 잇지 않게). */
export function gradeClass(score: number): string {
  return (GRADE_BANDS.find((b) => score >= b.min) ?? GRADE_BANDS[GRADE_BANDS.length - 1]).cls;
}

/** 범례 문장 — 「세계적 95+ · … · 취약 <50」을 표에서 조립한다(손으로 적지 않는다). */
export function gradeLegend(): string {
  return GRADE_BANDS.map((b, i) =>
    Number.isFinite(b.min) ? `${b.grade} ${b.min}+` : `${b.grade} <${GRADE_BANDS[i - 1]?.min ?? 0}`,
  ).join(' · ');
}

/** 미해결 치명결함 — 있으면 종합점수에 상한을 건다. 지금은 없음(있으면 여기 등록). */
export const CRITICAL_OPEN: { code: string; why: string }[] = [];

/** 치명결함이 하나라도 열려 있으면 종합은 이 값을 넘을 수 없다. */
export const CRITICAL_CAP = 59;

export interface EvalSummary {
  total: number;
  raw: number;
  capped: boolean;
  grade: Grade;
  weightSum: number;
  evidenceAvg: number;
}

export function summarize(items: EvalItem[] = EVAL_ITEMS): EvalSummary {
  const weightSum = items.reduce((a, b) => a + b.weight, 0);
  const raw = weightSum === 0 ? 0 : items.reduce((a, b) => a + b.score * b.weight, 0) / weightSum;
  const capped = CRITICAL_OPEN.length > 0;
  const total = Math.round(capped ? Math.min(raw, CRITICAL_CAP) : raw);
  const evidenceAvg = items.length === 0 ? 0 : items.reduce((a, b) => a + b.evidence, 0) / items.length;
  return { total, raw: Math.round(raw * 10) / 10, capped, grade: gradeOf(total), weightSum, evidenceAvg: Math.round(evidenceAvg * 10) / 10 };
}
