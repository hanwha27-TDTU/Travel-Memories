---
name: backup-restore-dev
description: 백업·복원 개발 프롬프트 — services/backup.ts·backupCrypto.ts·zip.ts·backupMeta.ts(내보내기/가져오기/암호화/ZIP)를 만들거나 수정하기 전에 반드시 로드한다. 기억의 **마지막 방어선**. 병합 복원 계약·완전성 게이트·역할 분리(export/import)·과거 결함 사례·복원 드릴 레시피를 담은 작업 헌장. 새 테이블 추가, 백업 형식 변경, 복원 로직 수정 시 사용.
---

# 백업·복원 개발 프롬프트 (Backup & Restore Dev Charter)

백업은 **기억의 마지막 방어선**이다(기기와 클라우드가 동시에 죽어도 여기서 되살린다).
복구 지도의 정본은 `docs/DISASTER_RECOVERY.md`이고, 이 문서는 **작업 헌장**(그 코드를 안전하게 만지는 법)이다.
규칙과 코드가 어긋나면 **코드가 진실**이고 이 문서를 갱신한다.

## 0. 파일 지도

| 파일 | 역할 | 성격 |
|---|---|---|
| `src/services/backup.ts` | **db층**(`exportCollectRows`/`importMergeRows`) + **순수 직렬화층**(`serializeJson`/`deserializeJson`·`serializeZip`/`deserializeZip`) + 사용자 진입점(`exportBackup*`/`importBackupAuto`) | 층 분리가 핵심 — 순수층은 Node에서 테스트 가능 |
| `src/services/zip.ts` | 의존성 0 store(무압축) ZIP 리더/라이터 + CRC32 | 순수 → 유닛테스트 대상 |
| `src/services/backupCrypto.ts` | AES-GCM-256 + PBKDF2 210k 봉투(MAGIC `BGJENC1\n`) | WebCrypto. **키를 저장하지 않는다** |
| `src/services/backupMeta.ts` | 마지막 백업 시각·신선도(localStorage) | 캐시성 메타(기억 아님) |

## 1. 불변 계약

1. **복원은 "교체"가 아니라 "병합"이다**: 모든 import 경로는 `mergeDecision`(version 기반 tombstone 우위 + 빈-데이터 가드)만 거친다. 어떤 경로도 로컬을 통째로 덮어쓰지 않는다 — **좀비와 유실을 동시에** 막는 유일한 방법.
2. **오래된 백업이 삭제를 되살리지 못한다**: §1-1의 귀결. "예전 백업을 복원했더니 지운 여행이 돌아왔다"가 나오면 병합 규율이 깨진 것이다.
3. **두 형식은 공통 코어를 공유한다**: JSON·ZIP 모두 `exportCollectRows`/`importMergeRows`를 거친다. 형식이 늘어도 완전성·병합 안전성이 자동으로 같아진다 — **형식별로 수집/병합을 따로 짜지 말 것.**
4. **완전성은 기계가 지킨다**: `check-backup-coverage`가 db.ts의 사용자 데이터 테이블이 export-role·import-role **양쪽**에서 참조되는지 대조한다. 역할 분류는 **함수명**(이름에 `export`/`import` 포함)으로 하므로 새 함수 이름을 그 규칙에 맞춘다.
5. **파생 테이블만 EXCLUDE**: 재취득 가능한 캐시(`syncQueue`·`localFxRates`)만 제외하고 **근거 주석을 함께** 남긴다.
   - ⚠ 자문: **"이걸 잃으면 사용자의 기억이 사라지나?"** 그렇다면 제외 금지.
6. **백업은 자족적이다**: 사진을 파일 안에 품는다(JSON=base64 내장, ZIP=실제 이미지 파일). 외부 URL 참조 금지 — 깨진 링크로 기억이 날아가는 약한 고리를 만들지 않는다.
7. **파일명은 자유, 복원은 메타 경로로**: ZIP 안 사진 파일명(`날짜_시간_제목_용도__id8`)은 사람이 읽기 위한 것이고, 복원은 `trip.json`의 `displayFile`/`thumbFile`/`originalFile` 경로로 되읽는다. **파일명을 바꿔도 복원이 깨지지 않아야 한다**(이 성질을 유닛으로 잠가 뒀다).
8. **복원의 의사는 서버에도 닿아야 한다**: 복원은 로컬만의 일이 아니다. 서버가 그 id를 **거부하도록 설계된 장치**(영구삭제 원장 + BEFORE INSERT 트리거)가 있으면, 복원은 그 장치에도 *"이건 사용자가 되살린 것"*이라고 말해야 한다. 안 말하면 push가 조용히 거부되고 다음 pull이 로컬 사본까지 지운다 — **오류 하나 없이 기억이 사라진다**(M-0032, v1.03에서 수정).
   - 구현: 복원이 `requestUnpurge(ids)`로 **큐에 의사를 남기고**(오프라인·실패에도 살아남는다), `pushUnpurges`가 `runSync` **맨 앞에서** 보낸 뒤 **원장을 되읽어** 확인한다. 성공 응답은 완료가 아니다.
   - ⚠ 자문: **"이 복원을 서버가 거부할 이유가 있는가? 있다면 어느 문으로 들어가나?"**
9. **암호 키는 저장하지 않는다**: 사용자만 보유하며 분실 시 복원 불가임을 UI에 명시. 암호 없이 내보낼 때는 평문 PII 경고를 한 번 확인받는다.

## 2. 코드 관례 (실제로 걸렸던 것)

- **`FileReader` 금지, `arrayBuffer()` + `btoa` 사용**: FileReader는 브라우저 전용이라 Node 유닛테스트에서 못 돈다. 순수층이 테스트 가능해야 복원 드릴이 성립한다.
- **`Uint8Array<ArrayBuffer>`로 타입 고정**: 기본 `Uint8Array<ArrayBufferLike>`는 `SharedArrayBuffer` 변성 때문에 `BlobPart`에 대입되지 않는다. ZIP·암호화 바이트는 단일 신규 버퍼로 모아 이 타입으로 다룬다.
- **ZIP은 store(무압축)**: 백업 대부분이 이미 압축된 WebP라 재압축 이득이 미미하고, 구현·검증이 단순해진다. UTF-8 파일명 비트(범용비트 11)로 한글 폴더를 그대로 쓴다. DOS date는 고정(재현성).
- **고아 행은 버리지 않는다**: 부모 없는 행은 `_orphans/`에 담아 유실을 막는다.

## 3. 과거 결함 등록부

| 버전 | 결함 | 근본형 | 재발 방지 |
|---|---|---|---|
| 0.35 | (예방) 새 테이블을 추가하고 백업 반영을 잊으면 조용히 유실 | 완전성이 사람의 기억에 의존 | `check-backup-coverage` 게이트(비공허 자체검사 + 실파일 뮤테이션 검증) |
| 0.36 | 형식이 둘로 갈리며 수집·병합이 중복될 뻔함 | 형식별로 로직을 복제 | 공통 코어(`exportCollectRows`/`importMergeRows`) 추출 후 두 형식이 공유 |
| 0.37 | 순수층이 `FileReader`에 묶여 Node 테스트 불가 | 브라우저 전용 API가 순수 로직에 침투 | `arrayBuffer`+`btoa`로 교체 → 왕복 드릴이 가능해짐 |
| 0.38 | 복원이 "가정"이었음(순수 직렬화만 검증) | db 접근층 미검증 | `fake-indexeddb`로 **실 Dexie에 구워** 저장·되읽기·blob 바이트 왕복 검증(`restoreDrill`) |
| 0.38 | 기본 평문 내보내기로 사진·GPS·메모가 그대로 노출 | 안전한 기본값 부재 | 선택적 AES-GCM 봉투 + 암호 없을 때 명시 확인 |
| 0.53 | (게이트가 잡음) `localFxRates` 추가 시 커버리지 RED | 새 테이블의 성격(기억 vs 파생) 미분류 | EXCLUDE에 근거 주석 + "기억이 사라지나?" 자문 문구를 게이트에 박음 |
| 1.03 | **복원이 서버 영구삭제 원장에 막혀 조용히 무효화**(M-0032). 앱엔 아무것도 없고 서버엔 원장 24건·R2에 고아 파일 10개만 남았다 | **규칙을 한쪽(로컬)에만 구현**(§7 비대칭). 차단 장치를 만들며 **정당한 예외의 문**을 안 만들었다 | migration `0017` 좁은 문(`journey.unpurge_ids` — 자기 행만·명시한 id만, **테이블 DELETE는 여전히 안 준다**) + `unpurge` 큐 op + 되읽기 확인 + `applyPurgedLedger` 가드 + **런타임 지표**「복원했는데 서버가 막은 항목」 |
| 1.03 | 복원 중인 사진의 R2 파일 10개를 「치워도 되는 잔재」로 분류하고 **정리 버튼까지 내어 줬다** | 성격이 정반대인 것을 한 숫자에 섞음(근본형 C) — **기억 손실 직전까지** 갔다 | `classifyOrphanFiles(orphans, ledger, restorePending)`이 `restoring`을 따로 가른다. 분류 판단을 화면 코드의 `filter` 한 줄로 흩지 않는다 |

## 4. 검증 레시피 (정직한 완료)

자동층:
1. `npm run harness` — **`check-backup-coverage`가 핵심**
2. `tests/unit/backupRoundtrip`: JSON·ZIP 모두 export→import 파리티(전 행·**사진 바이트**·tombstone·고아·좌표·원본 폴백). 비공허: 행을 하나 빼면 실패해야 함
3. `tests/unit/restoreDrill`: `fake-indexeddb`로 실 Dexie 왕복(빈가드·LWW·tombstone 우위 포함)
4. `tests/unit/restoreUnpurge`: 복원이 **서버 원장 되돌리기 의사를 남기는지**(멱등·빈 목록), 그 의사가 있는 동안 `applyPurgedLedger`가 그 id를 **안 건드리는지**, 되돌리기가 실패하면 **큐에 남는지**(재시도 가능해야 한다), **되읽기로** 확인하는지
5. `tests/unit/zip`: CRC 벡터(`0xCBF43926`)·왕복·한글 폴더·오프셋·손상 감지
6. `tests/unit/backupNaming`: 파일명 형식·FS 금지문자·충돌 방지

외부 도구 상호운용(권장):
- 생성된 ZIP에 **표준 `unzip -l` / `unzip -t`** 를 돌려 `No errors detected` 확인 — 우리 구현만의 착각이 아님을 증명하고, 사용자가 탐색기에서 여행별 폴더로 사진을 바로 열 수 있음을 보증.

**정직한 경계**: 실기기 대용량 사진 ZIP 생성 체감·다운로드 UX는 사용자 확인 몫. 로직은 장당 순차 `arrayBuffer`라 메모리는 안전하다.

## 5. 변경 후 의무

- `changelog.ts` +0.01 · `researchLog.ts` · `docs/HANDOFF.md` · 새 교훈은 **이 문서 §3에 행 추가**
- 복구 지도(계층·시나리오)가 바뀌면 `docs/DISASTER_RECOVERY.md`를 갱신(그쪽이 정본)
- 백업·복원 변경은 `.claude/agents/disaster-recovery-guardian`로 사전·사후 감사(문서만 보고 PASS 금지)
