# 프로젝트 릴리스 프로필 계약

## 목차

1. 목적
2. 필수 필드
3. 릴리스 그래프
4. 설치와 공급망

## 1. 목적

공통 스킬은 원칙만 소유한다. 저장소별 파일명·명령·그룹·버전·산출물·배포 표면은 JSON 프로필 하나가 소유한다.
프로필을 산문에 다시 복사하지 말고 실행기와 문서가 같은 프로필을 읽게 한다.

## 2. 필수 필드

- `schemaVersion`: 현재 `1`.
- `project`: 프로젝트 안정 식별자.
- `sharedLaw`: 공용 저장소 URL, 고정 커밋, 내용 해시, 프로젝트 안의 공급망 스냅샷 경로.
- `gateRegistry`: Required 모집단의 실행 가능한 정본 경로.
- `groups`: 안정 `id`, 실행 명령, 실제로 덮는 범위. 빈 그룹은 허용하지 않는다.
- `fullRequired`: 전체 명령, 증거 주체 `ci`, 최신 개정 요구 여부. 실제 실행 여부는 `verificationPolicy`가 정한다.
- `verificationPolicy`: `HRL-19`·`HRL-20`을 쓰는 프로젝트의 기계 계약.
  - `mode`: `risk-triggered`.
  - `classifier`: 변경분을 분류하고 전체 실행·면제를 판정하는 실행 파일.
  - `unknown`: 분류하지 못한 변경은 반드시 `full-required`.
  - `fullHarnessClasses`·`exemptClasses`: 서로 겹치지 않는 안정 분류 이름. 둘 다 비어 있으면 안 된다.
  - `exemptEvidence`: 면제 때도 남길 분류기 결과와 영향받은 좁은 검사 증거.
  - `browserRoundtrip`: 격리 가능한 정확한 그룹·워크플로·판정 이름과 필수 기록 필드. `blocking`은 `false`,
    `verdict`는 `quarantined-failure`, `nextSessionPriority`는 `true`여야 한다. 이 선언이 없는 프로젝트는
    브라우저 실패를 기존처럼 차단한다.
- `versioning`: 변경 감지 대상, 기준선, writer, 사람이 확인할 이력 위치.
- `releaseNodes`: 릴리스 단계의 안정 `id`, 역할 `kind`, 쓰는 표면, 완료를 직접 판정하는 방법.
  `kind`는 `integration`·`verification`·`input-closeout`·`artifact`·`deployment` 중 하나다.
- `releaseEdges`: 실제 의미 의존만 `from → to`로 선언하고 사유를 붙인다.
- `runnerWriters`: 브랜치나 저장소에 쓰는 러너와 독점 대상.
- `deploymentSurfaces`: 영향 조건, 배포 명령, 라이브 되읽기 명령. 소비자와 독립 배포되는 제공자는
  프로토콜 버전뿐 아니라 정확한 소스/빌드 정체성, 필수 capability, 설정 준비 상태와 구형 소비자
  호환 조건을 판정할 수 있어야 한다.
- `exceptions`: 공통 기본값보다 엄격하거나 다른 프로젝트 예외와 근거.

## 3. 릴리스 그래프

그래프는 순환하면 안 된다. 모든 간선 끝점은 선언된 노드여야 한다. 독립 표면 사이에 편의를 이유로 간선을 만들지 않는다.
산출물을 만드는 노드와 그 산출물을 검사하는 노드는 별개다. 완료 판정은 HEAD 변화 같은 대리 지표가 아니라
워크플로 결론, 종료코드, 라이브 되읽기 중 하나를 가리켜야 한다.

`kind: 'artifact'` 노드로 들어오는 **모든** 경로는 `kind: 'input-closeout'` 노드를 지나야 한다(HRL-17).
검사기는 선행 노드가 없는 산출물과 마감을 건너뛰는 곁길 간선도 위반으로 낸다. 마감 노드는 writer를 실행하지
않고 재생성 원장에서 파생한 읽기 전용 check만 돌리며, 실행 전후 작업 트리 지문이 같아야 한다.

새 소비자가 별도 서버 capability에 의존하면 `releaseEdges`에 제공자 선배포·운영 대조 → 소비자 검증/배포의
의미 간선을 선언한다. 제공자는 선배포 동안 구형 소비자와 호환되어야 하며, 운영 대조 실패는 소비자 릴리스를
차단해야 한다. 단순 revision 증가나 같은 프로토콜 버전은 정확한 배포 정체성의 대체물이 아니다.

`verificationPolicy`를 쓰면 릴리스 검증 노드의 판정은 “모든 그룹 성공” 한 문장으로 고정하지 않는다.
분류기가 `full-required`를 냈으면 전체 집합을, `exempt`를 냈으면 영향받은 좁은 집합과 면제 기록을 판정한다.
브라우저 격리는 브라우저 실패를 없애는 기능이 아니라 실패를 보존하면서 배포 차단만 해제하는 기능이다.
격리 산출물에는 최소 `sha`·`runId`·`gate`·`exitCode`·`cause`·`impact`·`reproduce`·`nextAction`이 있어야 한다.

## 4. 설치와 공급망

공용 GitHub 저장소가 유일한 정본이다. 프로젝트는 고정 커밋의 공급망 스냅샷과 해시를 커밋한다.
전역 설치본과 프로젝트 스냅샷을 직접 고치지 않고 공용 저장소의 동기화 스크립트로 갱신한다.
CI는 외부 비공개 저장소에 접속하지 않아도 커밋된 스냅샷과 잠금 해시를 검증할 수 있어야 한다.
