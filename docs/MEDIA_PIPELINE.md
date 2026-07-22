# MEDIA PIPELINE · Journey Archive

설계지시서 §9 + LESSONS §2·§5. **원본 불변**, **압축 전 EXIF 먼저**, **기계 파생값은 needs_review**가 핵심.

## 저장 정책 (기본: 절약 모드)

| 모드 | 앱용 사진 | 썸네일 | 원본 |
|------|-----------|--------|------|
| 절약 (기본) | 저장 | 저장 | 저장 안 함 |
| 균형 | 저장 | 저장 | 선택한 사진만 |
| 원본보관 | 저장 | 저장 | 전체 저장 |

원본 사진을 기본적으로 Supabase에 저장하지 않는다. 기기 원본은 변경하지 않는다.

## 앱용 사진 기준

| 항목 | 기본값 |
|------|--------|
| 긴 변 | 최대 2560px |
| 형식 | WebP (미지원 시 JPEG 0.82) |
| 품질 | 0.82 |
| 목표 크기 | 약 0.5~1.5MB |
| 썸네일 긴 변 / 품질 | 640px / 0.70 |
| 디코딩·변환 동시성 (모바일) | **기본 1** (큰 Bitmap 메모리, H-06) |
| 업로드 동시성 (모바일) | 기본 2 (H-06) |

## 스테이징 상태머신 (C-02 — 전량 내구성 대기열 전제 폐기)

사진 500장을 모두 즉시 내구성 큐에 넣을 수 있다고 가정하지 않는다(모바일 origin quota 부족 가능). `selected_non_durable`는 저장 완료가 아니며, `staged`부터 앱 재시작 복구 대상이다.

```text
selected_non_durable
→ (quota preflight) staged
→ EXIF·orientation·decode → derived_ready
→ pending server row
→ immutable upload
→ remote verify
→ synced
실패/제어: quota_blocked · decode_failed · unsupported · retryable_failed · permanent_failed · cancelled · conflict
```

- **저장공간 사전점검(preflight)**: 앱 시작·대량 선택 전 `navigator.storage.estimate()`로 여유를 확인하고, 적절 시점에 `navigator.storage.persist()`를 요청한다.
- **분할 수용(partial acceptance)**: quota가 부족하면 일부만 `staged`로 수용하고 나머지는 `quota_blocked`로 남긴다. 전량 수용을 강제하지 않는다.
- **명시적 거부**: 인식 못 하는 입력·손상·초과 파일은 침묵 기본값 없이 명시적으로 거부한다(LESSONS §3).

## 처리 순서 (C-02 정련)

1. 파일 선택 → 2. 기본 검증(개수·크기·형식, 빈 파일 차단) → 3. **저장공간 사전점검** → 4. **원본 EXIF·규격 읽기(압축 전)** → 5. 원시시각·GPS·방향 whitelist 임시저장 → 6. 1차 fingerprint → 7. 중복 후보 확인 → 8. **내구성 스테이징(staged, OPFS/IndexedDB)** → 9. worker 디코딩 → 10. 방향 정규화 → 11. 긴 변 2560px 축소 → 12. WebP 인코딩 요청 → 13. **결과 Blob MIME·magic bytes 검사 → 불일치 시 JPEG(불투명)/PNG(알파) fallback** → 14. 640px 썸네일 + 동일 검증 → 15. **전체 콘텐츠 강한 해시** → 16. 파생본+메타데이터 로컬 저장(derived_ready) → 17. `media_assets` pending 행 → 18. 불변 경로 immutable upload → 19. 원격 존재·크기·MIME verify(read-back) → 20. `verified`/동기화 완료 → 21. Bitmap/Canvas/Blob 참조 해제.

> **EXIF는 압축 전에 읽어 별도 저장한다** — Canvas 재인코딩 후 원본 EXIF가 유지된다고 가정하지 않는다. whitelist 필드만 저장: `captured_local, OffsetTimeOriginal(오프셋), latitude, longitude, orientation, original_width, original_height, camera_make, camera_model, original_filename`. (H-09 상세는 §EXIF whitelist)

## 대체경로 (feature-detect)

- OffscreenCanvas 지원 → Web Worker 처리. 미지원 → 메인 스레드 Canvas, 1장씩, 처리 사이 UI 제어권 반환. (모바일 디코딩 동시성 기본 1 — H-06)
- **WebP 인코딩 성공을 가정하지 않는다(H-07)**. Canvas 인코더는 요청 형식을 지원하지 않으면 PNG를 반환할 수 있으므로 결과 `blob.type`(MIME)과 **magic bytes(바이트 서명)**를 확인한다. WebP 성공 → `image/webp` / WebP 미지원·불투명 → `image/jpeg` 0.82 / WebP 미지원·알파 필요 → `image/png`.
- HEIC 직접 디코딩 불가 → 지연 로딩 HEIC 변환 모듈, 실패 시 원본 보존 상태로 사용자 안내.
- 사진이 이미 기준보다 작음 → 확대 금지.
- 침묵 기본값 금지 — 인식 못 하는 입력은 명시적 거부(LESSONS §3).

## 중복 검사 (2단계)

**1차 후보(fingerprint)**: 파일크기 + 원시 촬영시각 + 폭 + 높이 — **후보일 뿐 확정 아님**. **2차 확정**: 원본 전체 콘텐츠의 **강한 해시**(`content_hash` + `hash_algorithm`/version). 부분 해시나 빠른 fingerprint만으로 완전 중복을 확정하지 않는다(H-10). 같은 해시면 기본적으로 중복 업로드 차단하고 기존 사진 연결 제안하되, 동일 해시여도 기존 자산을 **다른 Moment에 연결**하는 것은 허용한다. dedup identity는 **안정 id/해시**이지 파일명 아님.

## 메모리 해제 (사진 1장 완료 시)

`ImageBitmap.close()` · `URL.revokeObjectURL()` · Canvas 폭/높이 최소화 · Canvas·context 참조 제거 · 완료 Blob 참조 제거 · IndexedDB 임시 작업 정리. 배치는 **행 수 + 직렬화 바이트 크기 둘 다로 바운드**. 부분 실패를 성공으로 숨기지 않는다.

## needs_review (기계 파생값)

EXIF 지오태그·자동 태그·자동 장소 후보는 `confidence`와 함께 `needs_review`로 시작한다. 재생성이 검토·tombstone된 행을 덮어쓰거나 부활시키지 않는다(같은 안정 id → 사용자 결정 우선, 신규 후보만 추가). 기계 분류를 확정 사실로 표시하지 않는다.

## 입력·업로드 검증 (H-08 — MIME·확장자 검사 그 이상)

확장자·MIME만 믿지 않는다. 다음을 모두 적용한다.

```text
- 빈 파일 차단
- 파일명 확장자만 신뢰하지 않음
- MIME 후보와 magic bytes(바이트 서명) 확인
- 실제 디코딩 가능 여부 확인
- SVG를 사진 입력으로 허용하지 않음 (거부)
- 원본 파일크기·픽셀 수·한 변 길이 상한(pixel cap) 확인
- 압축폭탄·비정상 규격·손상 이미지 차단
- 로컬 저장 예상량과 여유 확인
- AbortSignal 지원
```

입력 상한은 Phase 0 성능시험으로 확정한다. 50MB 이상 파일 테스트는 "반드시 성공"이 아니라 **안전한 처리 또는 명시적 거부**를 검증한다.

## 불변 Storage 객체 (H-11)

```text
- 업로드는 upsert: false
- 동일 path가 이미 있으면 멱등 검증 후 재사용 또는 오류
- 내용 교체는 UPDATE가 아니라 새 media_id + 새 불변 path
- 앱은 일반 UPDATE·MOVE 권한을 요구하지 않음
- 삭제는 별도 영구 삭제 작업(deletion_jobs)에서만 수행
```
게이트 후보 `check-storage-immutable`(upsert:false 강제) — 상세 `docs/SECURITY.md`.

## 업로드 방식 (TUS resumable)

작은 앱용 파생본(2560px WebP 등)은 **standard upload**를 사용한다. 6MB를 넘거나 네트워크 안정성이 중요한 **원본·영상은 TUS resumable upload**를 사용한다(원본보관 모드는 후속, 별도 bucket).

## 개인정보 · EXIF whitelist (H-09)

EXIF GPS/시각은 민감 PII. 원본 EXIF 전체 JSON을 저장하지 않고 **whitelist된 필드만** `media_assets.exif_whitelist`에 담는다 — **MakerNote·기기 일련번호·얼굴영역·불필요한 전체 EXIF 제외**. 공유용 파생 파일에는 GPS·불필요한 EXIF를 넣지 않는다. 게이트 후보 `check-exif-whitelist`. 상세 `docs/PRIVACY.md`.

## 검증 (TEST_PLAN 연계)

JPEG/PNG/WebP/HEIC 각 1장, EXIF 없음, GPS 없음, 세로방향, 50MB 이상, 손상, 확장자≠MIME, 동일 2회, 100장, 500장, 압축 중 화면이동/앱종료, 업로드 중 인터넷 끊김 — 앱 강제종료 없이 대기열 처리, 실패 항목만 재시도.
