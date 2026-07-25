---
name: sync-offline-dev
description: 동기화·오프라인 개발 프롬프트 — services/sync.ts·sync/merge.ts·offline/db.ts·domain/*/rowmap.ts(로컬 우선 저장/서버 동기화/병합/충돌)를 만들거나 수정하기 전에 반드시 로드한다. 이 저장소의 **최고 위험 표면**. 좀비 차단·빈-클라우드 가드·push 순서·cascade 전파 계약과 과거 결함 사례·검증 레시피를 담은 작업 헌장. 새 엔티티 동기화, 큐 op, rowmap 추가 시 사용.
---

# 동기화·오프라인 개발 프롬프트 (Sync & Offline Dev Charter)

**이 영역은 이 저장소에서 가장 위험하다** — 여기 버그는 조용히 사용자의 기억을 지운다.
계약의 정본은 `docs/SYNC_PROTOCOL.md`(무엇이어야 하는가)이고, 이 문서는 **작업 헌장**(그 코드를 안전하게 만지는 법)이다.
규칙과 코드가 어긋나면 **코드가 진실**이고 이 문서를 갱신한다.

## 0. 파일 지도

| 파일 | 역할 | 성격 |
|---|---|---|
| `src/sync/merge.ts` | `mergeDecision`·`isEmptyCloudAnomaly`·`classifyError` | **순수 → 유닛테스트 대상**. 병합 판단은 전부 여기 |
| `src/services/sync.ts` | 엔티티별 Remote 포트(trips·moments·expenses·media) + `pushPending*`/`pull*` + `runSync` | 네트워크. 포트 뒤로 백엔드 격리 |
| `src/offline/db.ts` | Dexie 스키마(로컬 진실 사본) + `syncQueue` | 버전 체인 — 기존 버전 수정 금지, 새 `.version(n)` 추가 |
| `src/domain/*/rowmap.ts` | `XRow ↔ LocalX` 직렬화 경계(snake_case는 이 파일 밖 금지) | 순수. `check-schema-parity` 대상 |

## 1. 불변 계약 (어기면 기억이 사라진다)

1. **로컬 우선·내구성 커밋**: 저장은 로컬(Dexie) 엔티티+큐 op를 **한 트랜잭션**으로 커밋한 뒤에야 "저장됨"이다. 서버 성공은 저장의 조건이 아니다.
2. **하드 삭제 없음**: 삭제는 `deletedAt` tombstone만. 서버도 DELETE 정책을 주지 않는다(Storage 바이트 스윕은 별개 단계).
3. **version 기반 tombstone 우위(좀비 차단)**: 삭제상태가 다른 전이는 **벽시계가 아니라 version**으로 판정한다. 활성이 tombstone을 이기려면 version이 더 커야 하고(진짜 복원), **동률이면 삭제가 이긴다.**
   - 이유: 시계 스큐·지연 pull·**오래된 백업 복원**이 삭제한 데이터를 부활시키던 사고(메디컬 앱)를 원천 차단.
4. **빈-클라우드 가드**: 서버가 빈 배열을 줘도 로컬을 지우지 않는다(`isEmptyCloudAnomaly`). 죽은/초기화된 서버가 기억을 삭제하지 못하게.
5. **멱등 upsert + read-back**: HTTP 200이나 성공 토스트가 아니라 **같은 레코드를 되읽어** 확인한 뒤에만 큐 op를 제거한다.
6. **push 순서 = 부모 먼저**: `runSync`는 여행 → 순간 → 비용·사진. 복합 FK `(parent_id,user_id)`가 서버에 부모가 있기를 요구한다(H-02).
7. **cascade는 큐까지 전파**: 순간을 삭제/복원하면 딸린 비용·사진에도 **각각 큐 op**를 넣어야 한다. 로컬만 바꾸고 큐를 빠뜨리면 다른 기기에서 되살아난다.
8. **pull은 비파괴**: 다운로드 성공 시에만 로컬을 교체한다. tombstone pull은 `deletedAt`만 세팅하고 **로컬 blob을 지우지 않는다**. 로컬에 없는 행을 tombstone 하지 않는다(오래된 기기가 신선한 클라우드 데이터를 지우는 것 방지).
9. **snake_case 격리**: 서버 컬럼명은 `rowmap.ts` 밖으로 새지 않는다. 새 필드는 rowmap 왕복 유닛 + `check-schema-parity`로 잠근다.

## 2. 새 엔티티를 동기화에 추가하는 순서 (빠뜨리기 쉬운 것 포함)

1. 서버 마이그레이션: 테이블 + **소유자 RLS + 초대제(`is_allowed()`)** + 복합 FK + `updated_at` 트리거 + **좀비 방지 트리거**
2. `domain/<x>/rowmap.ts`: `XRow` 인터페이스 + `toXRow`/`fromXRow` (+ 왕복 유닛)
3. `services/<x>.ts`: 모든 mutation에 **큐 op enqueue**(create/update/delete). 부모 cascade에서도 전파
4. `services/sync.ts`: `XRemote` 포트 + `pushPendingX`(upsert→read-back→LWW→큐 제거) + `pullX`(빈-클라우드 가드)
5. `runSync`에 **부모 다음** 순서로 배치
6. `scripts/check-schema-parity.mjs`의 `ROW_TO_TABLE`에 매핑 추가 ← **잊으면 게이트가 그 엔티티를 안 지킨다**
7. `app/blueprint.ts` SOURCES에 `hasRowmap`/`hasSync` 반영(`check-blueprint`가 대조)
8. 백업 커버리지: 새 Dexie 테이블이면 `backup.ts` export/import 양쪽에 넣거나, 파생이면 EXCLUDE에 **근거와 함께** 등록

## 3. 과거 결함 등록부

| 버전 | 결함 | 근본형 | 재발 방지 |
|---|---|---|---|
| 0.29 | 좀비데이터(삭제한 것이 되살아남) | 병합이 **벽시계(updatedAt) 우선**이라 시계 스큐로 오래된 활성 사본이 tombstone을 덮음 | version 기반 tombstone 우위 + 적대적 유닛(옛 로직 주입 시 부활 4건 RED 재현) + 서버 `prevent_zombie_resurrection` 트리거 |
| 0.32 | 클라가 서버에 없는 컬럼을 밀어 조용히 깨짐 | rowmap↔서버 스키마 드리프트 | `check-schema-parity` 게이트(신규 엔티티는 `ROW_TO_TABLE` 등록 강제). 실제로 0009 누락을 RED로 잡음 |
| 0.33 | (예방) 순간 삭제 시 딸린 비용이 다른 기기에서 부활 위험 | cascade가 로컬만 바꾸고 큐 op 미전파 | moments cascade에서 비용·사진에 각각 큐 op enqueue |
| 0.34 | (예방) 사진 pull이 로컬 원본을 덮을 위험 | pull을 "서버가 진실"로 취급 | 다운로드 성공 시만 교체·tombstone은 `deletedAt`만·실패 시 로컬 유지 |
| 0.37 | 사진 tombstone 후 Storage 표시본이 고아로 남음 | 행 삭제와 바이트 삭제의 시점이 다름(DEL-CONTRACT) | tombstone 서버 반영 후 최선노력 `remove` + 마이그 0010 소유자 폴더격리 DELETE 정책 |

**결함 → 결함군 승격**: 위 근본형이 다른 엔티티에서 보이면 단건 수정하지 말고 전 엔티티를 쓸고 게이트를 추가한다.

## 4. 검증 레시피 (정직한 완료)

자동층:
1. `npm run harness`(12게이트) — 특히 `check-schema-parity`·`check-blueprint`·`check-backup-coverage`
2. **`merge.ts` 적대적 유닛**: 좀비 시나리오(지연 pull·오래된 백업·동률 version)를 넣고, **옛 로직을 주입하면 RED가 나는지** 확인(비공허)
3. rowmap 왕복 유닛(필드 누락·tombstone·null 경계)

서버층(Supabase MCP — **프로덕션 무변경**이 조건):
- `supabase/tests/*.sql`을 **`BEGIN … ROLLBACK`**으로 실행: 격리(타인 조회/수정/삭제 차단)·초대제·H-02 위조·좀비 차단
- 실행 후 advisor 신규 이슈 0 + 행 수 무변경 확인

**정직한 경계**: 이 샌드박스는 `*.supabase.co`를 차단한다 → **실 네트워크 왕복(runSync over the wire)은 실기기 몫**이다. "동기화 확인함"이라고 쓰지 말 것. 앱측 로직·서버 정책까지만 검증됐다고 적는다.

## 5. 변경 후 의무

- `changelog.ts` +0.01 · `researchLog.ts` 3단 기록 · `docs/HANDOFF.md` 인계 · 새 교훈은 **이 문서 §3에 행 추가**
- 계약 자체가 바뀌면 `docs/SYNC_PROTOCOL.md`를 갱신(이 문서가 아니라 그쪽이 정본)
- 데이터 안전에 닿는 변경은 `.claude/agents/disaster-recovery-guardian`로 사전·사후 감사
