---
name: backup-recovery-governance
description: 사용자 데이터의 전체 백업, ZIP·JSON 직렬화, 암호화, 파일 저장, 복원 병합, 형식 호환성과 재해복구 왕복검사를 안전하게 설계·구현·검토한다. 새 테이블·미디어 도메인을 백업에 추가하거나 백업 파일 형식, manifest, CRC·digest, Android·브라우저 저장 경계, 복원·unpurge·tombstone 처리, 백업 신선도와 실제 복구 드릴을 변경할 때 사용한다.
---

# Backup Recovery Governance

백업은 로컬과 클라우드가 함께 실패했을 때의 마지막 방어선이다. 코드가 백업을 만들 수 있다는 사실과
사용자가 최근의 독립 사본을 보유한다는 사실을 분리한다.

## 1. 착수

1. 사용자 원본, 앱 정본, 파생 캐시와 재취득 가능한 데이터를 분류한다.
2. 데이터 저장소의 실제 schema에서 export/import 모집단을 파생한다. 제외에는 이유를 필수로 둔다.
3. 지원 format version, 최대 크기, 암호화 봉투, 저장 표면, 복원 후 동기화 경계를 찾는다.
4. 기존 백업 파일과 운영 데이터의 옛 형식이 있는지 확인하고 reader 호환성을 먼저 설계한다.

## 2. 공통 불변식

### 범위와 형식

- 사용자 기억을 잃게 하는 테이블·행·바이트는 기본 포함이다. 캐시만 근거와 함께 제외한다.
- JSON, ZIP 등 여러 형식은 하나의 collect/import core를 공유한다. 형식별 데이터 수집·병합을 복제하지 않는다.
- 백업은 자족적이어야 한다. 복원에 필요한 앱 정본 바이트와 메타데이터를 품고 외부 URL을 유일한 사본으로 참조하지 않는다.
- 파일명은 사람이 읽기 위한 표현이고 복원은 manifest의 안정된 id·경로로 한다.
- wire format이 바뀔 때만 format version을 올린다. 지원하는 과거 버전과 변환을 명시하고 알 수 없는 미래 버전은 추측 복원하지 않는다.

### 무결성과 fail-closed reader

- writer가 기록한 무결성 주장은 reader가 전부 소비해야 한다. CRC/digest, 크기, offset, 중복 경로, manifest 정확집합을 대조한다.
- manifest가 선언한 필수 bundle·행·바이트가 없거나 예상하지 않은 중복이 있으면 전체를 손상으로 닫는다. 빈 값이나 일부 성공으로 보정하지 않는다.
- 0바이트가 합법인 경우와 누락을 별도 표시로 구분한다. 같은 `null`에 두 뜻을 넣지 않는다.
- ZIP32·메모리·엔트리 수 같은 용량 한계를 만들기 전에 검사한다. 절삭된 파일을 성공으로 만들지 않는다.

### 복원

- 기본 복원은 id별 병합이며 한 경로의 merge decision을 공유한다. version/timestamp와 tombstone 규칙으로 오래된 백업이 삭제를 부활시키지 못하게 한다.
- 전체 교체 복원이 필요하면 별도 명시 모드로 두고, 사전 사본·정확집합·rollback을 갖춘다. 일반 import에 교체 의미를 숨기지 않는다.
- 복원 행과 원격 unpurge/재전송 의사는 한 로컬 트랜잭션으로 커밋한다. 서버의 삭제 차단 원장을 되읽기 전에는 복원 완료로 말하지 않는다.
- 파싱·해시·암호 실패처럼 import 전 실패는 기존 상태를 정리하지 않는다. 일부 복원 뒤 실패하면 transaction rollback 또는 명시적 복구 journal을 사용한다.

### 저장 완료와 개인정보

- 파일 생성 요청, 사용자가 닫은 선택기, 스트림 close, 실제 저장 완료를 서로 다른 상태로 둔다.
- 성공은 저장한 URI/handle을 다시 열어 길이와 digest가 원본과 같을 때만 기록한다. 다운로드 클릭만으로 백업 신선도를 갱신하지 않는다.
- 최후 방어선의 기본 저장 문을 취소 가능한 선택기 하나에만 의존시키지 않는다. 플랫폼이 허용하면 결정적인 기본 위치와 명시적 다른 위치 선택을 분리한다.
- 실제 destination을 네이티브/브라우저 영수증으로 돌려주고, 알 수 없으면 추측 경로를 완료형으로 말하지 않는다.
- 암호 키는 앱에 저장하지 않는다. 복구 불가능성을 알리고, 평문 백업은 PII·위치·미디어 노출을 명시한다.

## 3. 구현 구조

- DB collect/merge, 순수 serialize/deserialize, 파일 저장, 암호화, 신선도 메타를 분리한다.
- 큰 Blob은 단일 base64로 브리지하지 않고 순서 있는 청크와 청크 digest를 사용한다.
- transaction 안의 비DB 비동기가 transaction을 조기 종료하지 않는지 사용 DB의 keep-alive 방식을 확인한다.
- orphan 행을 조용히 버리지 않는다. 부모가 없으면 별도 orphan bundle로 보존하고 복원 보고에 포함한다.
- 사용자 완료 문장의 개수도 backup stats에서 파생한다. serializer가 담은 도메인을 UI가 빠뜨리지 않게 한다.

## 4. 검증 행렬

- Coverage: schema의 사용자 데이터 모집단과 export/import 역할을 양방향 대조하고 누락 주입이 RED인지 확인한다.
- Pure roundtrip: 모든 행, tombstone, orphan, 좌표, 바이트, poster/thumbnail을 export→import parity로 검사한다.
- Corruption: 같은 크기 다른 바이트, CRC 변조, 누락 bundle, 중복 경로, 잘못된 offset, 0바이트 누락을 주입한다.
- Compatibility: 지원하는 과거 버전은 읽고 미래 버전은 거부한다.
- Actual file boundary: 메모리 Blob을 바로 읽지 말고 실제 저장→사용자 선택/handle→production importer 경계를 지난다.
- Production restore drill: 격리된 고유 fixture를 실제 DB에 병합하고 전 필드·바이트를 되읽은 뒤 바깥 transaction을 의도적으로 abort한다. 종료 후 행·큐·원장 잔재 0을 확인한다.
- Storage receipt: 취소, 부분 쓰기, digest 불일치, 구형 네이티브 응답이 완료·신선도로 반올림되지 않는지 검사한다.
- External interoperability: 표준 ZIP 도구처럼 독립 구현으로 목록과 무결성을 대조한다.

## 5. 운영 재해복구 판정

- 코드 테스트 PASS는 운영 DR PASS가 아니다. 최근 백업 존재, 복구 가능한 암호, 기기 밖 독립 보관,
  실제 복원 드릴의 성공 시각을 별도 판정한다.
- 복구 실패 조사에서는 서버 행, 삭제 원장, 실패 큐, 객체 바이트를 시간축으로 읽는다. 행이 없는 동안
  고아처럼 보이는 바이트가 마지막 사본일 수 있으므로 증거 없이 정리하지 않는다.
- 최종 보고에는 백업 format/version, 포함 범위, 저장 영수증, 복원 read-back, 미검사 플랫폼과 실제
  사본의 신선도를 분리한다.
