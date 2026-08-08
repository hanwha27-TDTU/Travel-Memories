---
name: sync-runtime-dev
description: Bugeon Journey의 자동 동기화 실행 조건, 병렬 실행 계획, 진행률·완료 상태 표시, 다른 기기 변경 확인 경로를 변경하거나 조사할 때 사용한다. src/services/autoSync.ts·syncPlan.ts·syncParity.ts, src/domain/syncProgress.ts·syncBadgeVerdict.ts, 홈 화면의 동기화 배선을 수정하기 전에 반드시 로드한다.
---

# 동기화 런타임 개발 헌장

`docs/SYNC_PROTOCOL.md`는 데이터 계약의 정본이고, `sync-offline-dev`는
canonical·tombstone·큐·read-back의 정본이다. 이 문서는 **언제 실행할지와 사용자가
무엇을 보게 할지**만 맡는다. 두 계약을 복제하지 말고, 데이터 정합성을 바꾸면 반드시
`sync-offline-dev`도 함께 읽는다.

## 1. 파일 지도

| 파일 | 책임 |
|---|---|
| `src/services/autoSync.ts` | 단일 실행(single-flight), 자동 실행 자격, 상태 발행 |
| `src/services/syncPlan.ts` | 병렬 그룹과 불가피한 직렬 FK 사유 |
| `src/services/syncParity.ts` | 서버/로컬 대조의 만료·갱신 |
| `src/domain/syncProgress.ts` | 측정 가능한 단계·퍼센트 계약 |
| `src/domain/syncBadgeVerdict.ts` | 상태를 사용자 문장·행동으로 판정 |
| `src/ui/screens/home.ts` | 배지·목록을 같은 완료 신호에 반영 |

## 2. 실행 자격

1. 서명된 앱·브라우저 **첫 세션**에는 큐가 비어 있어도 한 번 전체 동기화한다. 새 기기가
   이미 있는 클라우드 기록을 받는 안전 확인이기 때문이다.
2. 그 뒤에는 `local_only`, 재시도 시간이 지난 `retryable_failed`, `pendingCanonical`처럼
   **실제 보류 작업**이 있을 때만 자동 실행한다. `permanent_failed`는 자동으로 되풀이하지
   않는다.
3. `online`과 `visibilitychange`는 복구 신호이지 전체 pull의 허가가 아니다. 완료 후 주기
   타이머·무조건 화면 복귀 pull을 만들지 않는다.
4. 다른 기기 변경을 즉시 감지하려면 Supabase Realtime이라는 별도 서버 계약을 만든다.
   그 계약이 없으면 반복 조회를 “변경 감지”라고 부르지 말고, 안정 상태에서도 사용자가
   배지로 명시 동기화할 수 있게 한다.
5. 사용자 저장 직후의 동기화는 허용하되, 홈·인증·온라인 리스너가 같은 실행을 중복 요청하지
   않게 한다. 요청 합치기는 `autoSync.ts` 한 곳에서만 한다.

## 3. 병렬과 진행률

- pull 여섯 도메인은 결과 의존성이 없으므로 한 병렬 단계에서 `Promise.allSettled`로 전부
  정산한다.
- push는 `[trip ∥ place] → moment → [media ∥ expense ∥ audio]`만 직렬로 둔다. 새 직렬
  간선을 만들면 `syncPlan.ts`에 실제 FK·원자성 사유를 남긴다.
- 진행률은 완료된 작업 수가 아니라 실행 계획의 단계에서 계산한다. 시작·진행·성공·실패를
  구분하고, 퍼센트가 멈췄을 때 어떤 단계인지 말한다.
- 이미 보이던 로컬 목록을 동기화 시작 때문에 비우지 않는다. pull 성공 뒤에는 배지뿐 아니라
  목록도 같은 로컬 정본을 다시 읽는다.

## 4. 사용자에게 말하는 법

- `running`, `ok`, `failed`, `offline`, `signed-out`을 하나의 “동기화 중” 문구로 뭉개지
  않는다.
- 「동기화됨」은 pending이 0이라는 뜻이 아니라 최근 서버 대조가 같을 때만 쓴다. 대조하지
  못한 상태는 `unknown`이다.
- 완료 뒤에는 보냄·받음·실패 수를 짧게 남기고, 실패면 이유와 진단으로 가는 행동을 제공한다.
- 정상 배지의 수동 확인은 실제 전체 동기화를 시작해야 한다. 눌러도 아무 일도 하지 않는
  장식 행동을 만들지 않는다.

## 5. 변경 전·후 점검

1. `npm run brief -- <변경 파일>`로 이 문서와 `sync-offline-dev`의 형제 계약을 확인한다.
2. 첫 세션 1회, 완료 뒤 무작위 복귀 무실행, 보류 작업 재개, 영구 실패 무재시도, 병렬 계획,
   성공 뒤 목록 갱신을 유닛으로 고정한다.
3. `npm test`, `npm run gates`, `npm run build`를 실행한다. 화면을 바꾸면 `npm run live`도
   실행하고, 포트·브라우저 같은 외부 방해로 못 쟀으면 통과로 쓰지 않는다.
