# CODING MISTAKES · Journey Archive (실수 원장)

> LESSONS §7·최우선10 #1: **실수는 고치는 것이 아니라 기록하는 것이다.** 체크포인트를 넘은(병합·배포·게이트 거짓통과) 또는 재발한 실수는 **수정과 같은 변경에서** 여기에 기록하고, 가능하면 게이트/hook로 기계화한다. 기록 없이 고친 실수는 다음 세션에 재발한다.

형식: `증상 / 원인 / 수정 / 예방(게이트)`. 추가 전용, 최신이 위.

---

## M-0001 · 문서 카운트·인벤토리 드리프트 (스캐폴딩 단계에서 자기 규칙 위반)
- 날짜: 2026-07-22 · 발견: 독립 검토 에이전트(일관성 렌즈) · 심각도: major
- **증상**: `DEPLOYMENT.md`를 나중에 추가했는데 `CLAUDE.md` 문서지도·`CHANGELOG`("15종")·`ROADMAP`·`HANDOFF` 인벤토리에 반영 안 됨. `ASSUMPTIONS` A-004는 역할 수를 "123"으로 적어 나머지(139)와 모순.
- **원인**: 열거 가능한 사실(문서 목록·카운트)을 손편집으로 여러 곳에 중복시켰고, 파생·게이트로 잠그지 않음 — 저장소가 막겠다던 바로 그 드리프트.
- **수정**: 인벤토리에 DEPLOYMENT 추가, 하드 카운트("15종"·"123") 제거하고 파생 가능한 표현으로 대체, A-004를 139로 정정.
- **예방(게이트, Phase 0)**: `check-doc-inventory` — `docs/*.md` 실제 목록과 CLAUDE 문서지도·README 표를 대조해 불일치 시 실패. 카운트는 문서에 숫자로 박지 않고 스크립트가 생성.

## M-0003 · v0.1 설계의 차단 수준 결함 (외부 v0.2 리뷰 발견, 병합으로 정정)
- 날짜: 2026-07-22 · 발견: 외부 v0.2 비판적 검증 보고서 · 심각도: critical(설계 단계)
- **증상/원인**: v0.1 설계가 브라우저 현실과 어긋난 지점들 — ① "오프라인 유실 0건" 절대표현(브라우저 축출·quota 무시) ② EXIF 시각을 단일 timestamptz로 확정(TZ 없는 DateTimeOriginal 오변환) ③ `updated_at`+행 version만으로 다기기 동기화(동시수정·동일 timestamp·응답유실·tombstone pull 누락) ④ 삭제 즉시 Storage 제거(휴지통 복원 불가) ⑤ DB·Storage를 한 트랜잭션처럼 취급(orphan) ⑥ WebP 인코딩 성공 가정 ⑦ 사진 500장 전량 내구성 대기열 전제 ⑧ MIME·확장자 중심 검증(magic bytes·SVG·폭탄 미방어).
- **수정**: v0.2 정밀 병합으로 각 항목을 상태머신·계약·스키마로 대체 (ADR-0014·0017; DATA_MODEL/SYNC_PROTOCOL/MEDIA_PIPELINE/SECURITY 반영).
- **예방(게이트, Phase 0B)**: `check-empty-cloud-guard`·`check-no-delta-in-fullset-decision`·`check-no-hard-delete`·`check-readback-before-success`·`check-storage-immutable`·`check-exif-whitelist`·`check-exif-strip-on-share`. 그리고 "저장 완료"의 의미(내구성 로컬 커밋)를 문서·UI에서 일관되게 표기.

## M-0002 · 비가역 경로(삭제) 문서 간 상충
- 날짜: 2026-07-22 · 발견: 독립 검토(완결성 렌즈) · 심각도: major
- **증상**: `SECURITY.md` 삭제 절차가 하드 삭제를 암시(Storage 파일 삭제 + "관계 데이터 삭제 또는 deleted_at")했는데, `SYNC_PROTOCOL.md` 불변식 #2는 동기화 엔티티 하드 삭제 금지(tombstone 우선)라 상충.
- **원인**: 두 계약을 따로 작성하며 삭제의 정본 규칙을 한 곳에서 정하지 않음.
- **수정**: 정본 규칙 확정 — **동기화 엔티티 행은 tombstone 전용(하드 삭제 금지)**, Storage 바이트 삭제는 **사용자 확인 + tombstone 전파 후** 별도 단계. SECURITY·SYNC·DECISIONS(ADR-0011)에 반영.
- **예방(게이트)**: `check-no-hard-delete` — 동기화 도메인 repository에 `delete from`/하드 `.delete()` 부재 확인(tombstone 경로만 허용).
