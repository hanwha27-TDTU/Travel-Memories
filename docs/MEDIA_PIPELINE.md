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
| 동시 처리 / 업로드 (모바일) | 2 / 2 |

## 처리 순서 (19단계)

1. 파일 선택 → 2. 개수·크기·형식 검사 → 3. **원본 EXIF 읽기** → 4. 촬영시각·GPS·방향 임시저장 → 5. 빠른 해시 → 6. 중복 후보 확인 → 7. 디코딩 → 8. 방향 보정 → 9. 긴 변 2560px 축소 → 10. WebP 0.82 변환 → 11. 640px 썸네일 → 12. 압축 결과+메타데이터 IndexedDB 저장 → 13. 업로드 대기열 등록 → 14. 앱용 파일 업로드 → 15. 썸네일 업로드 → 16. `media_assets` 저장 → 17. 실제 파일 접근 확인(read-back) → 18. 동기화 완료 → 19. Bitmap/Canvas/Blob 참조 해제.

> **EXIF는 압축 전에 읽어 별도 저장한다** — Canvas 재인코딩 후 원본 EXIF가 유지된다고 가정하지 않는다. 저장 필드: `captured_at, latitude, longitude, orientation, original_width, original_height, camera_make, camera_model, original_filename`.

## 대체경로 (feature-detect)

- OffscreenCanvas 지원 → Web Worker 처리. 미지원 → 메인 스레드 Canvas, 1장씩, 처리 사이 UI 제어권 반환.
- WebP 인코딩 미지원 → JPEG 0.82.
- HEIC 직접 디코딩 불가 → 지연 로딩 HEIC 변환 모듈, 실패 시 원본 보존 상태로 사용자 안내.
- 사진이 이미 기준보다 작음 → 확대 금지.
- 침묵 기본값 금지 — 인식 못 하는 입력은 명시적 거부(LESSONS §3).

## 중복 검사 (2단계)

1차: 파일크기 + 촬영시각 + 폭 + 높이. 2차: 빠른 해시/콘텐츠 해시. 같은 해시면 기본적으로 중복 업로드 차단하고 기존 사진 연결 제안. dedup identity는 **안정 id/해시**이지 파일명 아님.

## 메모리 해제 (사진 1장 완료 시)

`ImageBitmap.close()` · `URL.revokeObjectURL()` · Canvas 폭/높이 최소화 · Canvas·context 참조 제거 · 완료 Blob 참조 제거 · IndexedDB 임시 작업 정리. 배치는 **행 수 + 직렬화 바이트 크기 둘 다로 바운드**. 부분 실패를 성공으로 숨기지 않는다.

## needs_review (기계 파생값)

EXIF 지오태그·자동 태그·자동 장소 후보는 `confidence`와 함께 `needs_review`로 시작한다. 재생성이 검토·tombstone된 행을 덮어쓰거나 부활시키지 않는다(같은 안정 id → 사용자 결정 우선, 신규 후보만 추가). 기계 분류를 확정 사실로 표시하지 않는다.

## 개인정보

EXIF GPS/시각은 민감 PII. 공유용 파일에는 GPS·불필요한 EXIF를 넣지 않는다. 상세 `docs/PRIVACY.md`.

## 검증 (TEST_PLAN 연계)

JPEG/PNG/WebP/HEIC 각 1장, EXIF 없음, GPS 없음, 세로방향, 50MB 이상, 손상, 확장자≠MIME, 동일 2회, 100장, 500장, 압축 중 화면이동/앱종료, 업로드 중 인터넷 끊김 — 앱 강제종료 없이 대기열 처리, 실패 항목만 재시도.
