# DECISIONS · Bugeon Journey (ADR)

추가 전용, 최신이 위. 결정을 기록하는 경우: ≥2 대안 존재, 사용자가 제안/선택/거부, 되돌리기 어려움, 관례에 반하지만 근거 있음.
**정직한 귀속** — 결정유형(`[user-decided]` / `[AI-proposed→user-approved]` / `[AI-autonomous]` / `[user-review-pending]`) × 어느 AI. 일어나지 않은 승인을 기록하지 않는다. (LESSONS §4)

---

## ADR-0033 · 지도 정확도 — 제공자를 바꾸지 않고 **말하지 않던 것을 말하게** 한다
- 유형: `[AI-proposed→user-approved]`(사용자 *"내가 장소 저장으로 쓰는 기본맵인데 너무 부정확해서 고치고 싶어요… 구현가능한가요? 더 정확도 높은 걸로?"* → 세 단계 제시 → *"A+B+C단계 전부 · 한국+해외 여행지 둘 다"*) · AI: Claude Code · 날짜: 2026-07-30
- **문제 제기의 형태**: 사용자가 다른 AI의 제안(Mapbox Search/Geocoding + Mapbox GL JS + Supabase PostGIS)을 함께 가져왔다. 제안 자체는 성실했지만 **아무도 재지 않았다.**
- 🔴 **먼저 쟀다(§9 4단계)**: 스크린샷의 축척 기준점으로 핀을 역산 → **127.00E / 37.587N = 혜화동로터리, 대학로의 북쪽 끝.** **좌표는 틀리지 않았다.** 이 측정이 결론을 뒤집었다 — 재지 않았다면 제공자를 갈아엎었을 것이다.
- **실제 원인 둘, 둘 다 우리 코드**: ①지점이 **하나일 때만** zoom을 안 건드려 초기값 10이 남음(§7 비대칭 — 형제는 제대로 하고 있었다) ②파서가 `place_rank`·`boundingbox`를 버려 **도(道) 중심점과 건물 출입구를 같은 문장으로** 말함(§8 — 정밀도를 모르면서 아는 척).
- **채택**:
  - **A**: `domain/place/precision.ts`(순수) — 등급·범위(m)·확대수준·글리프. 확대수준 출처를 `zoomForSpan()` **한 곳**으로 통일. 검색 결과와 배지가 「⚠ 길 전체를 가리켜요 · 약 1.5km」처럼 한정해 말하고, 건물(점)이면 **조용하다**.
  - **B**: 제공자를 **바꾸지 않고 늘렸다.** 한글/한국 좌표면 국내 제공자 먼저, 없거나 실패하면 Nominatim. **Nominatim은 언제나 마지막에 있어 시크릿 0에서도 앱이 지금과 똑같이 돈다.** 키는 §0에 따라 `supabase/functions/geocode` 뒤에만 두고 JWT를 매 요청 직접 확인한다. 정밀도는 **앱이 다시 판정한다**(등급 규칙 한 벌 — §7 2층).
  - **C**: `journey.places`(0022) + `moments.place_id`(0023). `location`은 **생성 컬럼**이라 앱이 경도·위도를 뒤집을 방법이 없다. 장소는 **여행의 자식이 아니다**(한 장소는 여러 여행에 걸친다).
  - **측정 도구**: `npm run compare:geocoders` — 응답률·1순위 정밀도 분포·제공자 간 1순위 거리. **승자를 정하지 않는다.**
- **기각과 이유**:
  - **Mapbox로 교체** — ①전제가 이 앱과 다름(단일 HTML이 아니라 Dexie 로컬 우선) ②**한국 질의에서 더 정확하다는 근거가 없음**(정밀 지도데이터 국외반출 제한으로 국내 제공자가 강한 영역) ③토큰·유료 등급(`permanent=true`)이 따라옴. **비교 없이 「더 정확하다」고 말하는 것은 측정이 아니라 취향이다** — 그래서 교체 대신 **재는 도구**를 만들었다.
  - **순간의 장소 필드를 places 참조로 이전** — 기존 기억을 옮기는 마이그레이션은 그 자체가 최고 위험 연산이고(비타협 원칙 #1), 순간에 적힌 장소는 *그때 그렇게 기록한 사실*이다. 라이브러리 좌표 수정이 과거 기록을 조용히 바꾸면 사용자가 쓴 것을 앱이 고쳐 쓴 셈이 된다. → `place_id`는 **선택 링크**이고 `on delete set null`이다.
  - **장소를 여행 cascade에 넣기** — 작년 여행을 지웠다고 그 카페를 잊을 이유가 없다.
- **정직한 경계**: 카카오·VWorld **실 응답을 이 환경에서 한 번도 받아본 적이 없고**(호스트 차단), 마이그레이션 0022·0023도 **아직 적용하지 않았다**. 검증된 것은 응답 변환·라우팅·앱측 로직까지다.
- **되돌리기**: `drop table journey.places cascade;` + `alter table journey.moments drop column place_id;` + syncQueue에서 `place` op 비우기. 시크릿을 지우면 국내 제공자는 자동으로 빠지고 Nominatim만 남는다.

## ADR-0032 · 오디오 노트도 **서버가 정본**이 된다 — 로컬 전용은 예외가 아니라 빚이었다
- 유형: `[user-decided]`(사용자 *"당연히 서버동기화를 진행해야죠. 사진과 동일하게... 우리가 오프라인에서도 사용하기 위해서 로컬저장소를 이용하고는 있지만 핵심은 모든 기기에서 모든 정보를 확인해야 합니다. 따라서 서버에 올라가는 순간 클라우드가 정본이 되야 합니다."*) · AI: Claude Code · 날짜: 2026-07-27 결정 / 2026-07-28 구현
- **문제**: 오디오 노트(v1.14)는 **로컬 전용**으로 태어났다. 근거는 `blueprint.ts`의 `localOnlyReason`에 적혀 있었고("서버 오디오 테이블이 아직 없다 — 마이그레이션 + 함수 확장자 허용 + FN_VERSION 상향 + 3단 배포가 함께 와야 한다"), 형식상 §7이 요구하는 *이유 있는 예외*였다. 그런데 그 예외의 값은 사용자에게 **다른 기기로 로그인하면 소리만 없다**는 것이었다.
- **사용자가 뒤집은 것**: "아직 못 했다"는 정당한 사정일 수 있지만 **영구 면허는 아니다.** 로컬에만 있는 자료는 기능이 아니라 결함이고, `localOnlyReason`은 예외가 아니라 **갚아야 할 빚**이었다.
- **"클라우드가 정본"을 곧이곧대로 구현하지 않았다**(중요): *"pull할 때 서버가 항상 이긴다"*로 만들면 오프라인에서 적은 것이 다음 동기화에 덮여 사라진다 — 비타협 원칙 #1 정면 위반이다. 목표(모든 기기가 같은 것을 본다)는 **기존 세 규율의 조합**으로 이룬다: ①로컬 변경은 예외 없이 큐 op를 만든다 ②모든 기기가 서버의 것을 전부 pull한다(빈-클라우드 가드 유지) ③충돌은 LWW, 삭제상태 전이는 version으로 판정한다. 소리에는 ①이 통째로 없었을 뿐이다.
- **채택**:
  - **마이그레이션 0019** `journey.audio` — 사진과 같은 계약(소유자 RLS + 초대제·복합 FK(H-02)·tombstone 전용·`set_updated_at`·좀비 차단 트리거·GRANT 4종). 다른 점 **하나**: 사진은 표시본만 올리지만 소리는 **원본이 곧 유일본**이라 그것을 올린다(60초 opus ≈100KB로 표시본 사진보다 가볍다).
  - **`domain/audio/rowmap.ts`** — `AudioRow` ⊆ `journey.audio`(`check-schema-parity`가 강제). 모든 `*_at`은 `isoInstant()`를 지난다(M-0034 — `recorded_at`이 사진의 `taken_at`과 같은 자리다).
  - **R2**: 사진과 **같은 여행 폴더**에 나란히. 종류는 **확장자가 말한다**(`.webm`·`.m4a`·`.ogg`·`.mp3`·`.wav`). 함수 `media-sign` **v6** — `safeRest`가 확장자 목록을 받고, `list`가 **사진 id와 소리 id를 나눠** 돌려준다(합치면 멀쩡한 소리가 「기록 없는 사진 파일」로 뜨고 화면이 그걸 치우라고 권한다).
  - **`LOCAL_ONLY_DOMAINS` 삭제** — 소리가 `PURGE_DOMAINS`의 다섯 번째 형제가 되면서 그 목록이 비었다. **빈 예외 구멍은 남기지 않는다**(언젠가 또 채워도 된다는 뜻으로 읽힌다). `blueprint.ts`의 `localOnlyReason` 필드도 함께 제거했다.
  - **백필**(§9 4단계 — *"옛 방식으로 만들어진 것을 누가 데려오는가?"*): v1.14~v1.19 녹음에는 큐 op가 **존재한 적이 없다.** 코드만 고치면 그 행들은 영원히 로컬에 남는다(M-0023과 같은 형태). `backfillAudioOps()`가 `runSync` 맨 앞에서 1회 돈다(표식 `bj.repair.audioSync.v1`, [정리 실행] 버튼이 다시 돌린다).
- **기각**: (a) 로컬 전용 유지 + 백업 권고 — 사용자가 명시적으로 거부. (b) 소리를 `media` 표에 얹기 — `check-backup-coverage`가 테이블 단위로 보므로 필드 추가는 게이트를 **GREEN인 채로** 통과한다(별도 표여야 자동으로 걸린다). (c) 모르는 코덱에 `.webm`을 붙여 올리기 — 거짓 확장자는 재생기가 잘못된 디코더를 고르게 하고 `mediaIdOfKey`도 못 읽는다. 대신 **올리지 않고 op을 남긴다**(진단이 말한다).
- **되돌리기**: `drop table journey.audio cascade;` + syncQueue에서 `audio`/`purge:audio` op 비우기. 로컬 데이터는 그대로 남고 앱은 다시 로컬 전용으로 동작한다.
- **배포 순서는 계약이다**: 마이그레이션 0019 → 함수 v6 → 앱. 뒤집으면 앱이 없는 표에 upsert하고(400), 함수가 `.webm`을 거부해(400) 소리 op이 `permanent_failed`로 박힌다.
- **검증**: 유닛 **37건 신설**(`audioRowmap` 19 · `audioServerSync` 18) + 기존 케이스 **4건 뒤집음**(§11 ② — 전제가 바뀌면 케이스를 먼저 뒤집는다). 비공허 실증: tombstone에도 바이트를 올리게 주입 → RED 확인. 게이트 31종·라이브 165건 그린.
- **정직**: 2기기 실제 전파는 이 환경에서 재현할 수 없다 — **사용자 실기기 확인이 필요하다**(§10의 마지막 층).

## ADR-0031 · 바깥 지도는 **넷**을 열고, 동의는 **제공자마다** 받는다
- 유형: `[user-decided]`(사용자 *"위치 칩을 클릭하면 지도가 뜨도록 하고 그 지도는 혹시 구글지도로 연동시킬 수 있나요?"* → 이어서 *"얀덱스맵, 네이버맵, 카카오맵 같은 것도 추가할 수 있나요? 무료라는 조건에서"*) · AI: Claude Code · 날짜: 2026-07-28
- **왜 무료인가**: 돈이 드는 것은 지도 **API**(JavaScript SDK·Static Maps·Places·Geocoding — 키·과금 필요)다. 여기서 쓰는 것은 전부 **그냥 링크**라 키도 계정도 과금도 없다. 그래서 이 앱의 구도가 성립한다 — **입력은 무료 OSM(Nominatim), 출력은 사용자가 고른 지도.**
- **왜 넷인가**: 지도는 **어디를 여행하느냐에 따라 쓸모가 갈린다.** 구글은 한국에서 길찾기가 약하고, 카카오·네이버는 해외가 비어 있고, 얀덱스는 중앙아시아·러시아에서 가장 정확하다. 하나만 두면 여행지의 절반에서 쓸모가 없다.
- **URL 형식과 검증 상태**(이 줄이 `externalMap.ts`가 가리키는 곳이다):
  | 제공자 | 좌표 링크 | 좌표 순서 | 검증 |
  |---|---|---|---|
  | 구글 | `maps/search/?api=1&query={lat},{lng}` | 위도,경도 | 실기기 확인(2026-07-28) |
  | 얀덱스 | `yandex.com/maps/?ll={lng},{lat}&z=17&pt={lng},{lat}` | 🔴 **경도,위도** | 실기기 확인(`pt=126.800932,37.565642`) |
  | 네이버 | `map.naver.com/p?title=…&lat=…&lng=…` | 위도,경도 | 실기기 확인(핀에 「김포국제공항」 표시) |
  | 카카오 | `map.kakao.com/link/map/{이름},{lat},{lng}` | 위도,경도 | 실기기 확인(`urlX/urlY`로 변환됨) |
- **두 개의 함정**: ①**얀덱스만 경도가 먼저다** — 뒤집으면 서울이 아니라 인도양이 열린다. ②**카카오 경로는 쉼표로 나뉜다** — 「서울시청, 본관」 같은 이름이 좌표 자리를 밀어낸다(`commaSafe`가 쉼표를 공백으로 바꾼다). 둘 다 `tests/unit/externalMap.test.ts`가 잠근다.
- **동의는 제공자마다 따로**(PRIVACY): 처음엔 키가 하나(`bugeon:externalMapOk`)였다. 그러면 구글에 한 번 동의한 사용자에게 얀덱스·네이버·카카오가 **묻지 않고 열린다** — 그건 동의가 아니라 끼워 팔기다. **받는 회사가 다르면 다른 결정**이므로 키를 `bugeon:externalMapOk:{제공자}`로 나눴고, 옛 키는 일부러 물려받지 않는다(비용은 한 번의 확인뿐이다).
- **기각**: (a) 앱 안에 구글 지도를 심기 — 키·과금이 필요하고 좌표가 상시 나간다. (b) 지도 하나만 두기 — 여행지의 절반에서 쓸모가 없다. (c) 동의 키 하나로 공용 — 위 참조.

## ADR-0030 · 영구삭제는 **서버 자료를 실제로 지운다** — 남는 건 id 원장 한 줄뿐
- 유형: `[user-decided]`(사용자 "의도를 가지고 삭제하는건데 서버에 왜 살려두나요? 자료를..한 번 클릭으로 영구삭제는 막아야겠지만 2번 이상 클릭으로 삭제한거라면 영원히 복구가 안되도록 기록줄까지도 삭제시켜야 되는게 맞는거 아닌가요?") · AI: Claude Code · 날짜: 2026-07-26
- **문제**: ADR-0025·0027이 두 번 연속 서버 행 하드 삭제를 기각했다. 근거는 **매번 똑같이 하나**였다 — *"그 사실을 모르는 다른 기기가 자기 사본을 다시 올려 좀비를 만든다."* 그 결과 영구삭제해도 제목·메모·좌표·금액이 서버에 그대로 남았고, 사용자가 Supabase를 열어 볼 때마다 "안 지워졌다"를 마주했다("스트레스 받기 일보직전일 정도로").
- **무엇이 틀렸나**: 기각 근거는 사실이었지만 **해법이 아니라 증상에 대응했다.** 좀비를 막는 방법이 "행을 남긴다"뿐이라고 가정했는데, 더 강한 방법이 있다 — **서버가 재삽입을 거부하게** 만드는 것. 그러면 자료를 살려둘 이유가 통째로 사라진다. 두 번 같은 결론에 도달한 것이 오히려 그 가정을 검증하지 않았다는 신호였다.
- **채택**(마이그레이션 0012):
  - **`journey.purged_ids` 원장** — `id · user_id · purged_at`만. 종류도 담지 않는다(자료를 남기지 않는 것이 목적인데 종류는 자료다). RLS는 **select + insert만** — update/delete 정책을 **일부러 두지 않는다.** 원장을 지울 수 있으면 좀비 차단이 뚫린다.
  - **BEFORE INSERT 트리거**(4개 테이블) — 원장에 있는 id는 서버가 물리적으로 거부한다. 예외를 던지지 않고 **조용히 그 행만 버린다**(`return null`): 밀린 편집을 가진 기기가 오류로 막히면 나머지 동기화까지 멈추는데, 그 기기의 다른 기억은 죄가 없다.
  - **행은 하드 삭제**한다. `pushPurges`가 자식(`trip_id = X`) → 부모 순으로 지우고 read-back으로 확인한다. `purged_at` 컬럼(0011)은 제거.
  - **전파는 원장이 한다** — 서버 행이 없으니 pull은 영구삭제를 볼 수 없다. `runSync`가 원장을 읽어 `applyPurgedLedger()`로 이 기기 사본을 치운다. 종류를 모르므로 **네 테이블을 모두 훑고**, 표식의 `entityType`은 `'unknown'`으로 적는다(거짓 종류를 지어내지 않는다 — 원칙 #4).
- **§0 "하드 삭제 없음"과의 관계**: 그 조항의 **목적**은 좀비 차단이었다. 원장+트리거가 그 목적을 더 강하게 달성하므로, **영구삭제(2단계 확인을 거친 명시적 의도)에 한해** 하드 삭제를 허용한다. 일반 삭제(휴지통행)는 **여전히 tombstone 전용**이다. CLAUDE.md §0에 이 예외를 명시했다.
- **순서가 곧 안전이다**(이 ADR의 실질): 되돌릴 수 없는 일을 하기 전에 필요한 것을 먼저 읽는다. ①지우기 전에 묻는다(자식 id·사진 경로 — 행이 사라지면 함께 사라진다) ②**원장을 먼저 적는다**(지운 뒤에 적으면 그 틈에 다른 기기가 다시 올린다) ③행을 지운다 ④되읽어 확인한다 ⑤사진 바이트를 지운다(최선노력). 이 순서는 산문이 아니라 **게이트**(`purgeOrderContract`)가 지킨다 — 코드를 훑어봐선 뒤집힌 줄 모르기 때문이다.
- **사용자가 짚은 두 번째 것 — "사진이 올라가는 건 오직 수동 업로드 때만"**: 확인 결과 **이미 그렇다.** 서버로 올라가는 것은 큐 op가 있을 때뿐이고, 큐 op는 사용자 행동으로만 생긴다(`*LocalFirst`). 가만히 둔 기기는 아무것도 올리지 않는다. 유일한 구멍이던 "밀린 오프라인 편집을 가진 기기"를 이제 트리거가 물리적으로 막는다.
- **기각**: (a) 행 유지 + 표식(ADR-0027) — 자료가 남아 사용자 요구를 만족하지 못한다. (b) 트리거 없이 하드 삭제만 — 좀비가 돌아온다. (c) 원장에 종류·시각 외 정보 저장 — 자료를 안 남기는 목적에 반한다.
- **되돌리기**: 트리거·테이블을 drop하면 옛 동작으로 돌아간다. **단, 이미 지워진 행은 복구 불가** — 그게 이 기능의 목적이다.
- **검증**: 유닛 27건(순서 계약·원장 실패 시 아무것도 안 지움·read-back 3종·서버에만 있는 자식 id 포함·멱등·`'unknown'` 표기) + 게이트 3종 신설(`purgeOrderContract`·`runSyncAppliesLedger`·`noDroppedPurgedAtColumn`). **비공허 확인**: 원장을 삭제 뒤로 옮김 / `storeState.ts`에 사라진 컬럼 조회 복원 / `runSync`에서 원장 적용 제거 — 셋 다 RED.
- **정직**: 실제 2기기 전파는 이 환경에서 재현할 수 없다. 마이그레이션은 라이브 DB에 적용했고 기존 데이터도 이관(원장 6건, 하드 삭제 완료)했으나, **다른 기기에서의 실제 사라짐은 사용자 확인이 필요하다.**

## ADR-0029 · 사진 바이트는 **영구삭제 때만** 지운다 — 휴지통을 진짜 휴지통으로
- 유형: `[user-decided]`(사용자 질문 "앱에서 삭제하면 사정없이 서버에서도 삭제하는거 맞아요?" → 선택지에서 "영구삭제 때 지운다" 채택) · AI: Claude Code · 날짜: 2026-07-26
- **발견**: 사용자의 질문에 답하려고 코드를 확인하다 드러났다. `pushPendingMedia`가 tombstone을 밀면서 곧바로 `remote.remove(path)`를 호출해 **삭제(휴지통행) 즉시 서버 사진을 지우고 있었다.** 즉 휴지통에 있는 동안 사진은 이미 서버에 없다.
- **왜 위험한가**: 복원은 "사본을 아직 가진 기기가 **다시 올리는**" 방식이다(`deletedAt === null`이면 `uploadDisplay`). 그래서 그 기기에서 사이트데이터를 지웠거나, 애초에 그 사진을 안 받은 기기에서만 복원하면 **사진이 영영 돌아오지 않는다.** 휴지통이 사진에 대해서는 휴지통이 아니었고, 비타협 원칙 #1(기억을 잃지 않는다)과 정면으로 어긋났다.
- **채택**: 바이트 삭제를 **영구삭제 시점으로만** 옮긴다. `pushPurges`가 유일한 파괴 경로이고, 경로 목록은 **서버에 묻는다**(`familyMediaPaths`) — 로컬에 없는 사진도 지워야 하기 때문(M-0016과 같은 이유).
- **기각(현행 유지)**: 저장 공간을 가장 적게 쓰지만 휴지통이 불완전하다. 대가는 휴지통에 머무는 동안의 공간뿐이고 R2 무료 한도 10GB에서 무시할 수준이라, 원칙 #1이 이긴다.
- **실패 처리**: 바이트 삭제 실패는 purge op를 되돌리지 **않는다**. 행 표식은 이미 durable하고 남는 것은 **잉여 파일**일 뿐 기억 손실이 아니다. 다만 조용히 넘기지 않고 오류 로그를 남긴다(진단의 [오류 기록]이 잡는다).
- **검증**: 유닛 4건 — 영구삭제가 서버 경로의 바이트를 지우는가 · 바이트 실패가 표식을 되돌리지 않는가 · 바이트 포트가 없으면 행만 처리하는가 · **tombstone push가 remove를 한 번도 부르지 않는가**. 비공허: 옛 동작을 되돌리면 각각 RED.

## ADR-0028 · 자동 동기화 — 저장·삭제와 동시에 올린다(사람이 기억하지 않는다)
- 유형: `[user-decided]`(사용자 "기본적으로 저장, 삭제버튼을 누름과 동시에 모든 기기에 동기화가 즉시 되어야 된다고 생각합니다 … 휴먼에러를 방지하기 위해서") · AI: Claude Code · 날짜: 2026-07-26
- **발견된 구멍**: `dataManager.ts`가 `runSync`를 **아예 import하지 않아** 휴지통 복원·영구삭제·백업 복원 뒤에 동기화가 일어나지 않았다. 영구삭제 전파(ADR-0027)를 만들어 놓고도 그 op가 큐에 앉아만 있었다 — 사용자가 2기기 테스트를 했다면 **코드가 아니라 이 배선 때문에** 실패했을 것이다. 게다가 `trySync`가 두 화면에 손으로 중복 구현돼 있었고 둘 다 오류를 조용히 삼켰으며 연타 방지가 없었다.
- **채택**: `services/autoSync.ts` 단일 진입점 — 모든 상태 변경 뒤 `requestSync(reason)`. 자동 트리거는 `main.ts`에서 1회 설치(온라인 복귀·화면 복귀·주기 5분).
- **삭제 위험 판단(사용자 논거 수용)**: 삭제는 확인 절차를 거쳐 **휴지통행**(복구 가능)이고 영구삭제도 확인이 있다. 연산 자체가 이미 안전장치를 가졌으므로 즉시 전파가 위험을 더하지 않는다.
- **정직한 범위**: 우리 구조에서 다른 기기는 **자기가 당겨와야** 안다. 이 결정이 보장하는 것은 ①내가 한 일은 즉시 올라간다 ②다른 기기는 열릴 때·복귀·주기로 받는다. **"모든 기기에 즉시"는 아니다** — 그걸 원하면 Supabase Realtime 구독이 필요하고 별도 결정이다. 이 한계를 숨기면 사용자가 "갔다"고 믿게 되는데 그건 거짓말이다.
- **자동화가 만든 새 위험과 처방**: ①**실패 은폐** — 옛 `trySync`의 `catch {}`. 자동이 유일 경로가 되면 "당연히 됐겠지"가 된다(M-0008 부류) → 상태(`phase`/`lastError`/`lastOkAt`)를 보관하고 진단 화면이 지표로 노출한다. ②**중복 실행** — 사진 여러 장 저장 시 겹침 → **단일 실행 + 후행 1회 + 디바운스**. ③**비용** — pull이 전체 조회라 디바운스로 합친다(push/pull 분리는 후속: 지금 나누면 "올렸는데 안 받은" 상태가 새로 생긴다).
- **돌 수 없는 상황은 실패가 아니다**: 오프라인·미로그인은 `offline`/`signed-out`으로 구분해 오류로 겁주지 않는다(원칙 #4).
- **구조(§7)**: 화면이 `runSync`를 직접 부르지 못하게 하고(게이트), 로컬 상태를 바꾸는 함수를 import하는 화면은 `requestSync`도 import해야 한다(게이트). 서비스 계층은 `check-domain-symmetry`가 "모든 *LocalFirst는 큐 op를 만든다"를 이미 강제하는데, **화면 계층엔 같은 방어가 없었다** — 큐에 op가 들어가도 아무도 push를 부르지 않으면 결과는 같다.
- **검증**: 유닛 9건(단일 실행·후행 합치기·실패 보고·예외 미전파·오프라인/미로그인 구분·구독 통지) + 게이트 2종, **실제 결함 2종 주입으로 RED 확인**(dataManager 배선 제거 / 화면이 runSync 직접 호출).

## ADR-0027 · 영구삭제는 **모든 기기에서** 사라진다 — 행은 남기고 의도(`purged_at`)를 전파
- 유형: `[user-decided]`(사용자 "다른 기기에서 휴지통을 비웠으면 연동기기에서도 사라져 있어야 되는 거 아닌가요?" + 선택지 승인) · AI: Claude Code · 날짜: 2026-07-26
- **문제**: ADR-0025는 영구삭제를 **기기별**로 뒀다. 태블릿에서 휴지통을 비웠는데 휴대전화 휴지통엔 그대로 남았다. 1인 사용 앱에서 '영구'가 이 기기만을 뜻하면 그건 영구삭제가 아니라 **숨김**이다.
- **ADR-0025의 판단 중 무엇이 맞고 무엇이 틀렸나**: 서버 행 하드 삭제(B안) 기각 근거 — *"그 사실을 모르는 다른 기기가 자기 사본을 다시 올려 좀비를 만든다"* — 는 **지금도 유효하다**. 틀린 것은 거기서 멈춘 것이다: **"서버 행을 지우지 않는다"와 "다른 기기에 알리지 않는다"는 별개인데** 한 묶음으로 처리했다.
- **채택**: 서버 4개 테이블에 `purged_at timestamptz` 추가(마이그레이션 0011). 행은 tombstone으로 **남기고 의도만 실어 보낸다** → §0 "하드 삭제 없음"과 "모든 기기에서 사라짐"을 동시에 만족한다.
  - 영구삭제 시: 기존 사전조건(대기 op 0) 통과 → 로컬 하드 삭제 + 표식 + **전파 op 생성**(도메인별 `purge:*`).
  - 전파 push(`pushPurges`): 서버 `purged_at`을 찍고 **read-back으로 확인**. 서버에 행이 없으면(한 번도 동기화 안 된 기록) 완료로 본다 — 실패로 두면 그 op가 영원히 큐에 남아 다음 영구삭제의 사전조건까지 막는다.
  - 각 pull: `purged_at`이 있으면 로컬 행을 하드 삭제 + 표식(멱등). **`purged.has()` 검사보다 먼저** 와야 한다 — 표식이 없는 기기가 여기서 처음 배우기 때문이다.
- **쓰기 규율(치명적)**: `toRow()`는 `purged_at`을 **절대 담지 않는다**. 담으면 평범한 upsert가 다른 기기의 영구삭제를 `null`로 덮어써 지운 것이 되살아난다. 게이트가 이걸 검사한다.
- **사용자 결정**: 다른 기기에 아직 안 보낸 변경이 있어도 **그냥 지운다**. 의도에 충실하고 동작이 예측 가능하다(영구삭제를 누른 기기는 이미 "보낼 것 없음"을 통과해야 하므로 이 상황 자체가 드물다).
- **구조(§7)**: 영구삭제 경로를 `services/purge.ts`의 **`Record<PurgeDomain, …>` 등록부 하나**로 모았다 — 도메인을 빠뜨리면 **컴파일 오류**다. 전파 op의 entityType을 `purge:*`로 둬서 기존 도메인 push 루프 4개가 **구조적으로** 건너뛰게 했다(네 곳에 "purge는 빼라"를 손으로 적지 않는다). 그 루프들이 처리하면 로컬 행이 없다는 이유로 **op를 조용히 폐기**해 전파가 영영 안 되는데, 이게 이 설계의 가장 위험한 함정이었다.
- **검증**: 유닛 12건(전파 op 생성·도메인 push가 삼키지 않음·read-back·서버 행 없음 처리·멱등·등록부 완전성) + 게이트 `check-verdict-symmetry`에 검사 2종 추가, **실제 결함 3종 주입으로 RED 확인**(비용 pull만 누락 / 사진 pull만 누락 / toRow가 purged_at 포함).

## ADR-0026 · 진단 도구는 판정(Verdict)을 한다 — 계약 4단 + 렌더러 하나 + 헌법 조항
- 유형: `[AI-proposed→user-approved]`(사용자 "이런 개념을 우리가 만든 모든 도구에 수평전개하고, 수평전개 및 대칭성의 개념을 헌법에 박아두자") · AI: Claude Code · 날짜: 2026-07-26
- **문제**: 진단 화면 여섯 개가 *관측*을 했다 — 사실을 전부 같은 무게로 나열. 사용자 실기기 지적: *"뭐가 문제인지도 잘 모르겠고 너무 나열되어 있기도 하구요. 우리가 이런 도구를 만드는 건 정상은 어떤 상태이고 문제가 발생한 게 뭔지 차이를 아는 것 아닐까요?"* 정상 항목 11개가 화면 대부분을 먹고 이상은 그 더미에 파묻혔다. 같은 결함이 **3곳에서 동형 반복**(M-0010).
- **채택**: 판정 계약 `Verdict{level, headline, metrics[], actions[], evidence[], context[]}` + **단일 렌더러** `panels/verdict.ts`. 도구는 데이터만 만들고 그리는 코드를 갖지 않는다.
  - **판정 4단**: `ok`(✓) / `todo`(●) / `problem`(!) / `unknown`(?). 색만으로 인코딩하지 않고 글리프·이름이 항상 함께 간다.
  - **`unknown`을 왜 두는가**: 진단에는 로컬 정보만으로 판정 불가한 지표가 실제로 있다(op 없는 tombstone). M-0008에서 이걸 '문제'로 단정해 거짓 경보를 냈다. 모르는 것을 정상·문제 어느 쪽으로 밀어도 거짓말이 되므로 자기 칸을 준다(비타협 원칙 #4).
  - **침묵이 정상**: 기대값과 일치하는 지표는 카드가 아니라 접힌 한 줄. 스크롤 단축이 목적이 아니라 **"남아 있는 것이 곧 문제"라는 규칙**을 세우는 게 목적이다.
  - **기대값 필수**: 못 쓰는 값은 지표가 아니라 맥락 → 접힌 곳으로. 이 감사로 옛 최상위 5줄 중 4줄이 자리를 잘못 잡고 있었음이 드러났다.
- **기각 A(각 도구가 판정 로직만 공유하고 렌더는 각자)**: 그게 지금 상태이고 정확히 그래서 3곳이 갈라졌다. **기각 B(문서 조항만 추가)**: `docs/LESSONS.md` §3에 "도메인 대칭성"이 이미 적혀 있었는데도 cascade가 갈라졌다(M-0006) — 선언만으로는 안 지켜진다는 것이 **관측된 사실**이다.
- **3층 강제**: ① 헌법 조항(`CLAUDE.md` §7 수평전개와 대칭성 · §8 진단 도구의 제1 규율) ② 구조(렌더러 하나 — 우회 선택지 없음) ③ 게이트(`check-verdict-symmetry`, 셀프테스트 14건 + 실제 결함 재주입 검증) + 유닛 2종.
- **함께 고친 것**: `guide-card` 클래스 계약 위반(허브 레이아웃 깨짐), 화면 문자열의 마크다운 리터럴 노출, 심각도 색의 계절 강조색 종속, 시맨틱 틴트 위 텍스트 대비 미달(라이트 2.5:1 → `--sem-*-ink` 신설), 진단 목록 무제한 렌더(`ITEM_CAP`).
- **잔여 위험(정직)**: 라이브 렌더 미실행 — 실기기 세로에서의 실제 스크롤 길이·대비 체감·계절 전환 시 배지 색은 사용자 확인이 필요하다.

## ADR-0025 · 영구삭제 = "서버 tombstone 유지 + 이 기기 무시 표식"(A안)
- 유형: `[AI-proposed→user-approved]`(사용자 "니 권고로 가자") · AI: Claude Code · 날짜: 2026-07-25
- 정밀 감사에서 드러난 결함(F1): `purgeTripPermanently`가 **로컬 행만 하드 삭제**하고 서버에 알리지 않았다. `mergeDecision`은 로컬에 없으면 무조건 서버를 채택하므로(`if (!local) return 'take-server'`) 다음 pull에서 **되살아났다**. 특히 *동기화 전* 영구삭제는 큐 op를 고아로 만들어 폐기시켰고(`sync.ts` 4곳), 서버에 **활성 행**이 남아 **지운 여행이 통째로 부활**했다. 바이트(R2·Supabase 객체)도 영구 고아가 됐다.
- **채택 A**: ①**사전 조건** — 그 여행 가족에 대기 중인 큐 op가 하나라도 있으면 거부(`PendingSyncError`, `permanent_failed`도 포함해 센다). op가 없다 = tombstone이 서버에 반영됐다는 뜻이므로 "서버에 활성 행이 남는" 갈래가 사라진다. ②**영구삭제 표식** — 지운 id를 `purgedIds`(Dexie v6)에 남기고 **네 pull 함수 모두** 그 id를 건너뛴다. 서버 행은 tombstone으로 **남겨 둔다**(다른 기기 전파용).
- **기각 B(서버 행 하드 삭제)**: 그 사실을 모르는 다른 기기가 자기 사본을 다시 올려 **좀비**를 만들 수 있고, tombstone 전용 규율(§0)도 깨진다. **기각 C(문구만 정정)**: 안전하지만 기능이 이름값을 못 한다.
- `purgedIds`는 **기억이 아니라 로컬 표시 상태**다 → 동기화·백업 제외(`check-backup-coverage`·`check-blueprint` EXCLUDE에 근거 명시). 백업에 담으면 오히려 해롭다: 복원은 기억을 되살리는 행위인데 표식까지 복원되면 되살리려는 것을 다시 무시한다 → 그래서 `importMergeRows`는 **복원한 행의 표식을 지운다**(사용자 의사 우선).
- 함께 고친 것: **F2** 백업 복원이 sync op를 만들지 않아 복원한 기억이 이 기기에만 갇히던 문제, **F4** 비용에만 없던 개별 복원(실행취소), **F6** 휴지통 안내문 부정확·오류 은폐.
- 검증: `tests/unit/cascadeOps.test.ts` 12개. **비공허 실증** — (a) 표식만 지우면 pull이 되살리는 것을 테스트로 재현(옛 결함 그대로), (b) 백업 op 생성을 제거하면 2건 RED. harness 13게이트·verify-editor-live 77/77·build 그린.
- **정직**: 실제 2기기 시나리오(A에서 영구삭제 → B가 여전히 보유 → A가 다시 pull)는 이 환경에서 재현할 수 없다 — 유닛은 한 기기의 결정 로직만 증명한다.

## ADR-0024 · 사진 바이트를 Cloudflare R2로 — 읽기도 서명(정책 B), 공개 URL 없음
- 유형: `[AI-proposed→user-approved]`(사용자 "B로 가자") · AI: Claude Code · 날짜: 2026-07-25
- `docs/STORAGE_R2_PROPOSAL.md` §8의 **단 하나 남은 결정**을 확정. 사진 표시본 바이트를 Supabase Storage → **Cloudflare R2**로 옮기되, 버킷은 **비공개**로 두고 **읽기도 5분 presigned GET**으로 준다(A=공개 URL 기각, C=커스텀 도메인+Access 보류). `R2_PUBLIC_BASE`를 쓰지 않으므로 시크릿은 5개가 아니라 **4개**.
- 근거: 비타협 원칙 #3(개인자료 기본 비공개). "URL을 모르면 안전"은 보안이 아니라 은닉이며 백업·기기 공유·브라우저 이력으로 URL은 잘 샌다. **B의 대가가 우리 앱에선 작다** — 화면은 언제나 로컬 blob(`tripDetail.ts`의 `thumbBlob`/`displayBlob`)으로 그리므로 읽기 서명은 *새 기기가 그 사진을 처음 받을 때 사진당 1회*뿐이다. (Medical-Note는 URL로 직접 표시해 A가 합리적이었다 — 같은 구조가 아니라서 같은 결론이 되지 않는다.)
- 구조(Medical-Note 실증 채택): Edge Function `media-sign`이 SigV4로 presigned PUT/GET/DELETE를 발급, 바이트는 브라우저↔R2 직행. **객체 키를 서버가 만든다** — 클라이언트는 `mediaId`만 보내고 사용자 폴더는 검증된 `sub`에서 나온다. 덕분에 기존 경로 규약 `{uid}/{id}.webp`가 **그대로 유지**되어 이미 저장된 행의 마이그레이션이 없다(원본 경로를 건드리지 않는 쪽이 원칙 #1에 안전). 인증은 플랫폼 `verify_jwt`에 의존하지 않고 매 요청 `/auth/v1/user`로 실제 확인한다. 삭제는 함수가 서명·실행(브라우저에 삭제 권한 없음).
- 어댑터 경계: 포트 `MediaRemote`의 **바이트 3종만** 교체(`src/services/r2.ts`). 메타 테이블·RLS·좀비 트리거·동기화 병합 규율·백업 형식은 무변경. 기본값은 여전히 Supabase Storage이고 **`VITE_MEDIA_STORE=r2`로만 켜진다** → 되돌리기는 환경변수 하나(옛 객체 스윕 전까지 무손실).
- 검증: `tests/unit/mediaSign.test.ts` 13개 — 경로 규약 파리티(함수 `objectKey` ↔ 앱 `mediaStoragePath`), 클라이언트가 보낸 폴더/키 무시, 미인증 401, 서명에 정규 URI·메서드가 참여, 비밀키가 URL·probe 응답에 미포함. **비공허 확인**: (a) 클라이언트 키 신뢰 (b) 확장자 어긋남 두 결함을 주입해 각각 RED 확인 후 복원. CSP `connect-src`에 `https://*.r2.cloudflarestorage.com` 추가(`check-csp` REQUIRED 동시 갱신) — `img-src`는 **열지 않는다**(로컬 blob 표시라 필요 없다).
- **정직**: 서명값이 R2에 실제로 받아들여지는지는 이 환경에서 증명 불가(샌드박스가 R2에 못 붙는다). 검증 사다리 3번(실기기 업로드)이 유일한 결정적 증명이며 릴리스 체크리스트에 사람 단계로 남는다. 외부 콘솔 설정(버킷·CORS·토큰)은 사용자 몫이며 코드가 볼 수 없다.

## ADR-0023 · A-006 지도 타일 제공자 = OSM 래스터 기본값(교체 가능)
- 유형: `[AI-proposed→user-approved]`(사용자 "지도 진행하자") · AI: Claude Code · 날짜: 2026-07-23
- 오래 대기하던 A-006(지도 타일 제공자·예산)을 확정. 기본값 = **OpenStreetMap 래스터 타일**(키·계정 불필요, GitHub Pages 정적 배포·무료 티어 호환, 귀속표시 필수). `VITE_MAP_STYLE_URL` 설정 시 그 스타일로 교체(사용자 자신의 MapTiler/Stadia 등). CSP `img-src`·`connect-src`에 `https://tile.openstreetmap.org` 추가(index.html + `check-csp.mjs` REQUIRED, 같은 커밋).
- 근거: MapLibre GL 스택(이미 의존성)로 인라인 래스터 스타일 → 스타일 JSON 외부 fetch 불필요(글리프·스프라이트 없음), 타일만 로드. 대안(Mapbox=키·비용, MapTiler=키, 벡터 demotiles=저해상). **정직**: OSM 타일 사용정책은 대량 트래픽 앱을 권장하지 않음 — 개인·저트래픽 용도라 수용하되, 규모 확대 시 전용 제공자로 교체 권장(override 가능). 실 타일 렌더는 사용자 기기 몫(샌드박스 프록시가 외부 타일 차단).
- 오프라인 우선: 타일 실패·WebGL 미지원 시 **장소 목록**으로 대체(기억 접근 보장). GeoJSON 내보내기는 타일과 무관하게 동작.

## ADR-0022 · 순간(Moment) 서버 동기화 — 복합 FK 소유권 방어 + trips 대칭
- 유형: `[user-decided]`(사용자 "다 진행") · AI: Claude Code · 날짜: 2026-07-23
- 타임라인의 순간을 로컬우선에서 기기 간 동기화로 확장. migration `0003_journey_moments.sql`: `journey.moments` + **복합 FK `(trip_id,user_id)→trips(id,user_id)`**(H-02 — 타인 여행에 순간 부착 불가), 소유자 RLS + `is_allowed()`(초대제), tombstone 전용(DELETE 없음), `updated_at` 트리거.
- 동기화 코드는 trips와 **대칭**: `MomentsRemote`·`pushPendingMoments`·`pullMoments`(멱등 upsert→read-back→LWW 서버시각→작업 제거, 빈-클라우드 가드). `runSync`는 **여행을 순간보다 먼저 push**(복합 FK가 서버의 부모 여행 존재를 요구). `mergeDecision`은 `SyncMeta`로 일반화.
- 검증: `rls_attack_moments.sql` **MOMENTS_RLS_PASS**(격리·초대제·H-02 위조·user_id 위조·없는 trip 부착 전부 차단, ROLLBACK) via MCP. rowmap 왕복 유닛테스트. **실 2기기 네트워크 동기화는 대시보드/실기기 필요 — 이 환경 미검증(정직한 완료)**.

## ADR-0021 · 초대제 접근 잠금(allowlist) — DB RLS + 앱 게이트 이중
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-23
- 공유 프로젝트의 Google 로그인은 회계 앱과 공용이라 전역으로 열려 있어, 아무 Google 계정이나 여행 앱에 로그인해 자기 기록을 만들 수 있었다. RLS로 사용자 간 데이터는 이미 격리되지만(타인 데이터 열람 불가), 개인 기억 앱 원칙(개인자료 기본 비공개) + 낯선 사용자 데이터를 프로젝트 소유자가 보관·열람하게 되는 부담 때문에 **초대제(invite-only)로 잠금** 결정.
- 구현(migration `0002_journey_invite_only.sql`): `journey.allowed_users(email)` 목록 + `journey.is_allowed()`(SECURITY DEFINER, JWT email 소문자 비교). `trips_{select,insert,update}` 정책에 `and journey.is_allowed()` 결합 → **허용목록 밖 사용자는 로그인해도 자기 행조차 읽기/쓰기 불가**. 앱(`services/auth.ts` `isAllowedUser()` + `home.ts` 게이트)은 비허용자 자동 로그아웃 안내(UX; 진짜 방어는 DB).
- 검증: `supabase/tests/rls_invite_only_trips.sql` **INVITE_ONLY_PASS**(비허용 조회 0·INSERT 차단·email 없는 세션 차단), 기존 `rls_attack_trips.sql` 갱신 후 **RLS_ATTACK_PASS** 유지.
- **되돌리기 쉬움(양방향)**: 초대 추가 = `allowed_users`에 insert / 다시 공개 = 정책의 `and journey.is_allowed()` 조건 제거(후속 migration). 데이터 손실 없음. 회계(`public`) 스키마 무영향.

## ADR-0020 · Supabase 공유 프로젝트 + journey 스키마 분리
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 무료 한도(2개)로 신규 프로젝트 불가 → 사용자가 기존 News&Accounting을 **Travel&Accounting**(`ihxiywffzmvrwmqvatzt`, ap-south-1 뭄바이)으로 개명해 공유 결정. 분리: 회계 앱 = `public` 스키마(불가침) / 여행 앱 = **`journey` 스키마 전용**(클라이언트 `db.schema='journey'`).
- 적용 완료: `journey.trips` migration + RLS 공격검사 6종 **RLS_ATTACK_PASS**(위조 INSERT·타인 조회/수정/삭제·소유자 하드삭제·anon 전부 차단, ROLLBACK). advisor에서 journey 지적 0건.
- **문서화된 공유 위험**: 무료 쿼터 공유(DB 500MB·Storage 1GB·egress 5GB — 사진이 Storage 먼저 소진), Auth 설정 프로젝트 전역(Google provider·redirect·signup), **백업 복원 프로젝트 단위**(한 앱 복원 = 다른 앱도 롤백 — 복구 전 상호 확인 필수), pause/upgrade 공동 영향, 뭄바이 리전 지연(~100ms대).
- 잔여 수동 1단계: 대시보드 Settings → Data API → Exposed schemas에 `journey` 추가(Q7).

## ADR-0019 · 설정 화면에 개발자 정보 필수 포함
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 사용자 지시("앱 설계시 개발자 정보도 꼭 추가"). 선행 앱(dr-bugeon)의 개발자 정보 화면 준거: 개발자·버전·최초 개발일·코드 최종 수정·업데이트 이력(펼치기). **버전·이력은 package.json·CHANGELOG에서 파생 생성**(손편집 금지, M-0001 규율) — 하드코딩 시 게이트 차단. 표기값(이름·소속)은 A-015 잠정, 구현 전 확인(Q6). 구현 Phase 5~6(설정 화면). 명세 PROJECT_SPEC §4.

## ADR-0018 · Phase 0B 스택 = npm · Vite · TS strict · history 라우팅
- 유형: `[AI-autonomous]`(관례적 기본값, override 가능) · AI: Claude Code · 날짜: 2026-07-22
- 패키지 매니저 **npm**(보편성), 빌드 **Vite**, **TypeScript strict**. 라우팅은 ADR-0012대로 **history + 404 복제**로 착수(해시 아님). Supabase 클라이언트는 **PKCE** 옵션으로 초기화(실 연동 Phase 1). 골격은 빌드·타입체크·하네스·라이브 렌더 통과.

## ADR-0017 · v0.2 sync 모델 = operation receipt + base_version + 단조 커서 + conflict table
- 유형: `[AI-proposed→user-approved]`(사용자 "정밀 병합" 승인) · AI: Claude Code · 날짜: 2026-07-22
- 동기화가 `updated_at`-LWW 중심에서 **operation receipt(멱등) + `base_version` 비교 + `sync_changes.sequence` 단조 pull 커서 + `sync_conflicts` 테이블**로 이동(C-07). LWW는 불변식 내 tiebreaker로만 잔존. 신규 운영 테이블 `user_devices`·`sync_changes`·`sync_conflicts`·`deletion_jobs` 추가. 상세 `docs/SYNC_PROTOCOL.md`·`docs/DATA_MODEL.md`.

## ADR-0016 · v0.2 거버넌스·범위 정련 (S-01~S-10)
- 유형: `[AI-proposed→user-approved]` / 일부 `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- S-01 음성=OS 받아쓰기(앱내 STT 후속) · S-02 MVP=키워드 검색, semantic=Phase 7 · S-03 원본보관 기본 비활성 · S-04 공개 회원가입 비활성/invite-only, 소셜은 소유자 한정 · S-07 agent report는 `schemas/agent-report.schema.json` 검증 + `artifacts/agent-reports/`에 저장 · S-08 `docs/ACTIVE_TASKS.md` 소유권 + hook/CI 강제 · S-09 CLAUDE/AGENTS=맥락, hook+CI=강제 · S-10 Gate 0A(감사·문서·에이전트) / Phase 0B(스캐폴드) 분리.

## ADR-0015 · AI 출력은 `ai_artifacts`에만 (인라인 AI 컬럼 제거) — 리뷰어 확인 필요
- 유형: `[AI-proposed→user-approved]`(표 구조 변경은 reviewer-release/사용자 확인 대기) · AI: Claude Code · 날짜: 2026-07-22
- `ai_generations`→**`ai_artifacts`**(v0.2 명) 리네임. `trip_days.ai_summary/ai_confirmed`, `moments.ai_summary/ai_confirmed`, `reflections.ai_draft` 등 **인라인 AI 컬럼을 제거**하고 AI 출력은 `ai_artifacts`에만 저장(비타협 원칙 2 강화). MVP 표 형태를 바꾸므로 구현 전 reviewer-release 확인. `client_operations.operation_type` `upload`→`finalize_upload`, `version` bigint 표준화도 포함.

## ADR-0014 · v0.2 기술 하드닝 채택
- 유형: `[AI-proposed→user-approved]`(사용자 "정밀 병합" 승인) · AI: Claude Code · 날짜: 2026-07-22
- 복합 소유자 FK `(parent_id,user_id)`(H-02) · soft-delete 부분 고유 인덱스(H-03) · 내구성 유실범위 한정(C-01) · onLine은 힌트, 실연결=Supabase probe(C-04) · deletion_jobs 상태머신·pending→verify 미디어 흐름(C-08/09) · EXIF 시각=local+offset+tz+source+confidence(C-10) · WebP magic-byte 검증·JPEG/PNG fallback(H-07) · 입력검증 magic bytes·pixel cap·SVG 거부(H-08) · 강한 콘텐츠 해시로 중복 확정(H-10) · 불변 Storage `upsert:false`(H-11) · >6MB TUS 재개 업로드 · EXIF whitelist(H-09) · publishable/secret 키 체계, 프론트=publishable만(H-13) · RLS 완료조건=local Supabase+pgTAP+익명/A/B 공격검사(H-12) · DB 백업은 Storage 바이트 미포함(H-15) · 지도 어댑터 분리(H-05) · 디코딩 동시성 1(H-06).

## ADR-0013 · 배포 = GitHub Pages 주 + 헤더호스트 병행 미러 (S-05)
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 사용자 "GitHub 주 + 헤더호스트 병행". GitHub Pages를 주 배포로 유지(필수 요건)하되 커스텀 보안헤더 한계는 CSP meta + git revert 롤백으로 완화, 후속으로 Cloudflare Pages/Netlify 미러(보안 응답헤더·즉시 롤백) 옵션. 상세 `docs/DEPLOYMENT.md`.

## ADR-0012 · SPA 라우팅 + OAuth PKCE + Service Worker 캐시
- 유형: `[AI-autonomous]` · AI: Claude Code · 날짜: 2026-07-22 · (revisable — override 가능)
- history 라우팅 + `404.html`→`index.html` 복제(GitHub Pages 딥링크 대응) + Supabase PKCE OAuth(쿼리 콜백) + Service Worker 캐시 버저닝/`skipWaiting`. 정적 호스팅·하위경로(`base=/Travel-Memories/`) 제약의 귀결. 기본값이며 사용자 검토 시 조정 가능. 상세 `docs/DEPLOYMENT.md`·`docs/ROADMAP.md`.

## ADR-0011 · 삭제 계약(DEL-CONTRACT) — tombstone 전용
- 유형: `[AI-autonomous]` · AI: Claude Code · 날짜: 2026-07-22
- 동기화 엔티티 행은 **tombstone 전용**(`deleted_at`, 하드 삭제 금지). Storage 바이트 삭제는 **사용자 확인 + tombstone 전파 후** 별도 단계이며, 고아 파일 스윕으로 정합한다. 비가역 삭제 경로의 문서 간 상충을 계약으로 고정(`docs/records/coding-mistakes.md` M-0002). 상세 `docs/SECURITY.md`·`docs/SYNC_PROTOCOL.md`.

## ADR-0010 · GitHub Pages 정적 배포를 필수 목표로 확정
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 사용자 "무조건 GitHub로 배포". 정적 호스팅 제약을 설계에 못박음: Vite `base=/Travel-Memories/`, Service Worker scope·라우터 하위경로 대응, 서버 없음 → 백엔드는 클라이언트가 Supabase 직접 호출(anon 키만 번들, service_role 금지), GitHub Actions 빌드→Pages 자동배포. 단일 HTML은 보조 빌드. 상세 `docs/DEPLOYMENT.md`.

## ADR-0009 · 인증 = 소셜 로그인(Google), 매직링크는 무료 대안
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 사용자 "소셜로그인으로 진행". 비용 정정: 이메일 매직링크는 SMS와 달리 전송 비용 없음(무료 SMTP). 그럼에도 소셜(Google)이 무료·무마찰이라 채택. Apple 로그인은 연 $99 개발자 계정 필요 → 보류. ADR-0002(소유자 범위 RLS)와 정합.

## ADR-0008 · 사진 기본 저장 = 절약 모드
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 사용자 "절약 모드". 앱용 압축본+썸네일만 서버 저장, 원본은 기기에만(설계지시서 §9.1 기본값과 일치). 균형/원본보관은 사용자 선택 옵션으로 유지.

## ADR-0007 · 디자인 계열 에이전트 모델 = fable, 그 외 = opus
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 사용자 지시 "설계를 fable5 버전으로 아주 멋지게". 디자인·UX·비주얼 생산 에이전트(125–133, product-ux, frontend)는 `fable`, 총괄·감사·엔지니어링·보안·QA는 `opus`.

## ADR-0006 · 통합 10개 + 디자인 16개 에이전트를 새로 생성
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 사용자 지시 "싹 다 다시 시작". 진행 중이던 디자인 에이전트 2개를 폐기하고, 설계지시서 §28의 통합 10개 + 디자인 제안서의 16개를 전체 재생성. 139개 논리 역할은 `docs/AGENT_REGISTRY.md`에 등록.

## ADR-0005 · 기존 MVP 삭제 후 신규 구조로 재구축
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 사용자 지시 "삭제 후 새로". 순수 HTML/JS + Leaflet MVP를 삭제(git 히스토리 보존)하고 TypeScript+Vite+Supabase+Dexie+MapLibre+PWA 구조로 재구축.

## ADR-0004 · 이번 단계는 기능 구현 없이 문서·에이전트 스캐폴딩만
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 설계지시서 §28·§29 및 사용자의 "추천대로 진행". Phase 0 코드 골격(Vite 초기화)은 파일 목록 제시 후 별도 작업.

## ADR-0003 · 선행 프로젝트 자료는 교훈만 이식
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 사용자 "다른 앱 자료인데 교훈들이 많으니 참고해". dr-bugeon 스킬과 appdevpromptsall.md의 도메인은 이식하지 않고 규율·계약·안티패턴만 `docs/LESSONS.md`로 추출.

## ADR-0002 · 다중 사용자 소유자 범위 RLS를 처음부터
- 유형: `[AI-autonomous]` · AI: Claude Code · 날짜: 2026-07-22
- 근거: Bugeon Journey는 다중 사용자. 선행 앱의 anon-write 호환 자세를 물려받지 않고 `auth.uid()` 소유자 예측자로 시작(LESSONS §2). 다중 사용자·기본 비공개의 강제 귀결이며 사용자 override 가능. 인증(ADR-0009) 확정으로 블로커 해소.

## ADR-0001 · 정본 기준 문서를 저장소 SSOT로
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 설계지시서 v0.1을 `docs/PROJECT_SPEC.md` 등 저장소 문서로 반영. 특정 AI 대화가 아니라 저장소가 최종 정보원. 충돌 시 공유 문서가 이긴다.

---
## 확인 대기 (사용자 결정 필요)
- ~~지도 타일 제공자·예산 — A-006~~ → **ADR-0023에서 OSM 래스터 기본값으로 확정(교체 가능)**.
- Supabase 프로젝트 생성 시점 — Q4.
- Google OAuth 클라이언트 설정 시점 — Q5 (Phase 1).
- SPA 라우팅·삭제 계약 기본값 검토(override 가능) — ADR-0011/0012.
