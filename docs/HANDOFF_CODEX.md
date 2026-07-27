# HANDOFF_CODEX · Bugeon Journey 인계서

> **읽는 사람**: 이 앱 제작에 거의 참여하지 않은 AI(Codex 등) 또는 새 Claude 세션.
> **작성**: 2026-07-27 · Claude Code 세션 종료 시점
> **전제하지 않는 것**: 당신이 이 저장소의 역사·관용구·함정을 안다는 것.

기존 `docs/HANDOFF.md`는 **참여한 사람을 위한 시간순 기록**이다. 이 문서는 다르다 —
**아무 맥락 없이 들어와도 이어서 일할 수 있게** 쓴다. 중복은 의도적이다.

---

## 0. 30초 요약

| | |
|---|---|
| 무엇 | 개인 여행기록 PWA. 사진·장소·비용·감정·**소리**를 순간(Moment) 단위로 엮는다 |
| 누구 | 1인 사용자(소유자 본인). 소셜 없음, 공개 없음 |
| 배포 | GitHub Pages → `hanwha27-tdtu.github.io/Travel-Memories/` |
| 브랜치 | 개발은 `claude/travel-log-app-r2xd5f`(또는 `codex/*`), `main` 직접 push 금지 |
| 현재 판 | **코드 v1.18** / **실기기 v1.16** (배포 대기 — 아래 §6) |
| 지금 하던 일 | **오디오 서버 동기화** — 마이그레이션 0019까지 완료, 앱 코드 미착수 |
| 가장 큰 함정 | 이 저장소는 **문서가 코드만큼 중요하다.** 규율을 안 읽고 짜면 반드시 형제 대칭을 깬다 |

---

## 1. 착수 절차 — 코드를 쓰기 전에 반드시

이건 예의가 아니라 **결함 예방 장치**다. 이 저장소의 사고 대부분은 "규칙이 적혀 있었는데
안 읽었거나, 읽고도 적용 안 함"이었다.

### 환경 준비 (이게 없으면 앱이 안 뜬다)

```bash
npm ci
```

🔴 **검증만 할 거면 `.env`를 만들지 마라.** 이건 직관과 반대라 반드시 읽어야 한다:

| 상태 | `npm run live` 결과 |
|---|---|
| `.env` **없음** | **155/155 PASS** ← CI가 도는 상태이고, 이게 기준이다 |
| `.env` 있음(실제 Supabase URL) | **148/155** — 7건 실패 |

**왜**: `.env`가 있으면 앱이 Supabase에 접속을 시도하는데, 개발 샌드박스는 `*.supabase.co`를
차단한다 → 콘솔 에러가 나고, 상태 줄이 「📴 로컬 저장 모드」(조치 가능) 대신
「🔒 로그인하면…」으로 갈려 그 줄을 재는 검사 6건이 함께 무너진다.
**앱의 결함이 아니라 환경 때문이다.** CI에도 `.env`가 없어서 CI는 통과한다.

> 이 함정은 실제로 이 인계서 초안이 만들었다. 초안은 `cp .env.example .env`를 시켰고,
> 그대로 따라 하니 148/155가 나왔다. **인계서를 그대로 실행해 보지 않았으면 몰랐을 것이다.**

앱을 **실제로 띄워 로그인·동기화까지 보려면** 그때 `.env`를 만든다:

```bash
cp .env.example .env        # 실제 값이 예시 파일에 들어 있다(publishable 키는 공개 안전)
npm run dev
```

`.env.example`이 담는 것 — **전부 브라우저에 나가도 되는 값만**이다:

| 변수 | 용도 |
|---|---|
| `VITE_SUPABASE_URL` | Supabase 프로젝트(**Travel&Accounting** — 회계 앱과 공유, ADR-0020) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | anon/publishable 키. **service_role은 절대 금지** |
| `VITE_MAP_STYLE_URL` | 비워도 된다(기본 OSM 래스터 스타일을 쓴다) |

> 🔴 **R2 자격증명은 여기 없다.** 그건 **Supabase Edge Function Secrets에만** 존재하고
> 브라우저는 `media-sign` 함수가 발급하는 5분짜리 서명 URL만 받는다. `.env`에 R2 키를
> 넣으려는 충동이 들면 그건 설계를 잘못 읽은 것이다.

`.env`는 커밋 금지다(`.gitignore`에 있다). `check-secret-leak` 게이트가 JWT payload를
디코드해 role까지 판정하므로, 실수로 secret 키를 넣으면 harness가 RED가 된다.

### 착수

```bash
npm run brief <고칠 파일들>      # ← 이것부터. 어느 문서를 읽어야 하는지 알려준다
```

`npm run brief`가 출력하는 것:
1. **정독할 스킬 문서** (`.claude/skills/*/SKILL.md`) — 기억이 아니라 라우팅 표가 정한다
2. **필독 사후분석** — 그 영역에서 실제로 난 사고의 전말
3. **형제 목록** — 이 변경이 걸려야 할 대상 전부(§7)
4. **그 영역에서 과거에 낸 실수** (`docs/records/coding-mistakes.md`)

> ⚠️ **스킬 문서를 건너뛰지 마라.** 길다(수백 줄). 하지만 거기 적힌 것을 모르고 동기화를
> 만지면 **사용자의 기억이 조용히 사라진다.** 특히 `sync-offline-dev`와
> `supabase-security-dev`는 이 저장소의 최고 위험 표면을 다룬다.

### 검증 명령

```bash
npm run harness      # 정적 게이트 전부 + 유닛 (Required 전부 통과해야 함)
npm run build        # tsc --noEmit + vite build
npm run live         # verify-editor-live: 헤드리스 브라우저 검사 (build 먼저!)
```

> ⚠️ **이 문서에 게이트/검사 개수를 숫자로 박지 않는다.** 이 저장소는 열거 가능한 사실을
> 손으로 적는 것 자체를 결함으로 본다(M-0001 — 카운트 드리프트, `check-doc-counts`가 막는다).
> 실제로 이 인계서 초안에 「게이트 34개·유닛 663개」라고 적었다가 재보니 **31개·637개**였다.
> 숫자가 필요하면 **재라**:
> ```bash
> npm run harness 2>&1 | grep -cE '^▶'   # harness가 실제로 도는 게이트 수
> npx vitest run 2>&1 | grep 'Tests '     # 유닛 수
> node scripts/verify-editor-live.mjs | tail -1   # 라이브 검사 수
> ```
>
> **같은 이유로 줄 번호·줄 수도 박지 않는다.** 이 문서 초안은 `AGENTS.md:93`과
> 「스킬 문서 208줄」을 적었는데, 바로 그날 내가 두 파일을 고쳐 **93 → 117, 208 → 249**로
> 어긋났다. 위치는 내용으로 가리켜라(`AGENTS.md`의 「Git / 협업」 절).
> 예외: `src/ui/panels/diagnostics.ts`의 `EXPECTED_FN_VERSION`처럼 **고칠 때 반드시
> 눈에 띄어야 하는 상수**는 파일명 + 심볼명으로 가리킨다(줄 번호 없이).

`npm run live`는 **`dist`가 소스보다 낡으면 스스로 멈춘다**(exit 2). 낡은 번들을 재면
검사가 공허해지기 때문이다. 반드시 `npm run build` 다음에 돌린다.

---

## 2. 헌법 — 이 저장소를 다른 저장소와 다르게 만드는 것

전문은 `CLAUDE.md`(Claude용)와 `AGENTS.md`(Codex용). **둘은 어댑터일 뿐**이고 실제 계약은
`docs/`에 있다. 충돌하면 `docs/`가 이긴다.

### 비타협 원칙 5가지 (요약 — 전문은 CLAUDE.md)

1. **사용자의 기억을 잃지 않는다.** 내구성 로컬 커밋 이후 앱 원인 유실 0
2. **사용자 기록과 AI 생성물을 섞지 않는다**
3. **개인자료는 기본 비공개**
4. **정직한 완료.** 자동 검증층이 통과한 것만 "통과"라 말한다
5. **복구 가능성 우선**

### 반드시 알아야 할 조항 넷

| 조항 | 한 줄 | 왜 중요한가 |
|---|---|---|
| **§7 대칭성** | 한 곳에서 옳은 것은 형제 전부에서 옳아야 한다 | 이 저장소 결함의 **최빈형**이 "형제 중 하나만 조용히 빠짐"이다 |
| **§8 진단 제1규율** | 진단은 관측이 아니라 **판정**을 한다. 침묵이 정상 | 정상을 나열하면 문제가 안 보인다 |
| **§10 게이트가 못 잡는 것** | 정적 게이트는 ①계약만 잡는다. ②상태의존은 진단도구가, ③전달결함은 실기기가 잡는다 | 하루에 결함 6건을 잡았는데 **정적 게이트가 잡은 것은 0건**이었다 |
| **§11 검사하는 것도 결함을 갖는다** | 게이트를 넓히면 **새 게이트다** — 다시 주입해 RED를 확인하라 | 게이트가 초록인데 아무것도 안 보고 있던 사고가 실제로 났다 |

### §7이 요구하는 세 층 (조항만으로는 안 지켜진다 — 관측된 사실)

1. **조항** — 판단 기준
2. **구조적 강제** — 규칙을 **한 곳에만** 구현하고 형제가 통과할 수밖에 없게. *누락이 컴파일
   오류가 되게* 타입을 설계한다 (`TripChildren`·`MomentChildren`·`IntegritySnapshot`이 그 예)
3. **기계 검사** — 게이트가 이탈을 잡는다. 단, §11에 따라 **주입해 RED를 본 뒤에만** 신뢰

> **2026-07-27 사용자 결정으로 §7의 기본값이 바뀌었다**: *"형제끼리 차별하면 엇나가잖아요.
> 현실세계에서도."* → **대칭이 기본값**이고, 비대칭은 **설계 단계에서 먼저 심사**한다.
> "아직 안 했다"는 정당한 사정이 될 수 있지만 **반드시 적어야** 한다. 안 적으면 차별이다.

---

## 3. 아키텍처 — 5분 안에 파악하기

### 스택

TypeScript(strict, `exactOptionalPropertyTypes`) · Vite · **Vanilla TS 컴포넌트**(프레임워크 없음) ·
Dexie(IndexedDB) · Supabase(Auth/Postgres) · **Cloudflare R2**(사진 바이트) ·
MapLibre GL + OSM 래스터 · Vitest · Playwright · GitHub Actions

> **프레임워크를 추가하지 마라.** Vanilla 구조가 유지 불가능하다고 *실제 측정*된 경우에만
> 기술변경 제안서를 쓴다.

### 도메인

```
Trip → Moment → { Media(사진) · Expense(비용) · Audio(소리) }
```

「여행을 긴 글 하나로」 저장하지 않는다. **순간(Moment)이 중심 단위**다.

### 데이터가 사는 곳 (3계층)

| 계층 | 무엇 | 비고 |
|---|---|---|
| ① 로컬 | Dexie/IndexedDB (`journey-archive`, **버전 7**) | 오프라인 버퍼 + 캐시 |
| ② 서버 | Supabase `journey` 스키마 + **R2**(사진 바이트) | **정본** |
| ③ 백업 | JSON / ZIP 파일(선택적 암호화) | 사용자가 직접 내려받음 |

**핵심 사용자 결정(2026-07-27)**: *"서버에 올라가는 순간 클라우드가 정본이 되야 합니다."*
→ **로컬에만 있는 자료는 기능이 아니라 결함이다.**

> ⚠️ 단, 이걸 *"pull하면 서버가 항상 이긴다"*로 구현하면 **오프라인 편집이 덮여 사라진다.**
> 목표는 세 규율의 조합으로 이룬다: ①모든 변경이 큐 op를 만든다 ②모든 기기가 전부 pull한다
> ③충돌은 LWW, 삭제 전이는 **version**으로 판정(좀비 차단).

### 파일 지도 (자주 만지는 것)

```
src/
  domain/            순수 로직 — 유닛 검사 대상. DOM·DB 접근 없음
    time.ts          🔴 시각 표기 SSOT. Instant 브랜드 타입
    integrity.ts     무결성 점검(순수 함수)
    media/naming.ts  🔴 파일·객체 이름 SSOT — 손으로 조립 금지
    */rowmap.ts      서버 row ↔ 로컬 타입. snake_case는 이 파일 밖으로 안 샌다
  services/          부수효과 — DB·네트워크
    sync.ts          🔴 최고 위험. push/pull/runSync
    trips.ts moments.ts media.ts expenses.ts audio.ts
    purge.ts trash.ts backup.ts storage.ts diagnostics.ts
  sync/merge.ts      🔴 mergeDecision(LWW·좀비 차단) — 순수, 적대적 유닛 대상
  offline/db.ts      Dexie 스키마. **기존 version 수정 금지**, 새 .version(n) 추가
  ui/                Vanilla TS 화면
  app/
    changelog.ts     🔴 버전 SSOT(0.01 단위). APP_VERSION이 여기서 파생
    blueprint.ts     도메인 배선 선언 — check-blueprint가 코드와 대조
    registry.gen.ts  ⚠️ 생성물. 손편집 금지 — node scripts/gen-registry.mjs
scripts/             게이트들 + harness + brief + gen-registry (개수는 재라 — 위 경고)
supabase/
  migrations/        0001~0019. **추가 전용** — 과거 파일 수정 금지
  functions/media-sign/   🔴 R2 자격증명이 존재하는 유일한 장소
```

### 동기화 순서 (`runSync` — 이 순서가 계약이다)

```
pushUnpurges → pushPending(trips) → pushPendingMoments
  → pushPendingMedia → pushPendingExpenses → pushPurges
  → ledgerAll → applyPurgedLedger
  → pullTrips → pullMoments → pullMedia → pullExpenses
```

**부모 먼저**다. 복합 FK `(parent_id, user_id)`가 서버에 부모가 있기를 요구한다(H-02).
`pushUnpurges`가 맨 앞인 이유: 뒤에 있으면 다른 push들이 먼저 서버 원장에 막힌다.

---

## 4. 절대 하면 안 되는 것 (§0 비타협)

1. **`service_role` 키·DB 비밀번호·관리자 JWT를 프론트엔드·번들·저장소·로그·리포트에 넣지 않는다.**
   클라이언트는 anon/publishable 키만. R2 자격증명은 **Supabase Edge Function Secrets에만**.
2. **RLS 오류를 secret 키로 "고치지" 않는다.** 정책이 막으면 정책을 고친다.
3. **RLS 검증 없이 테이블을 배포하지 않는다.** 그리고 **superuser로 확인한 것은 검증이 아니다** —
   `set local role authenticated` + 실제 JWT 클레임으로 돌린 것만 검증이다(M-0020).
4. **하드 삭제 없음.** `deleted_at` tombstone 전용. 유일한 예외는 영구삭제(ADR-0030).
5. **원본 사진을 기본적으로 서버에 저장하지 않는다**(절약 모드). 표시본만.
6. **사진 압축 *전에* EXIF(촬영시각·GPS)를 먼저 읽어 별도 저장한다.**
7. **`main`에 직접 push하지 않는다.**
8. **`registry.gen.ts` 등 생성물을 손편집하지 않는다** — 재생성한다.
9. **과거 마이그레이션 파일을 수정하지 않는다** — 새 번호로 추가한다.
10. **자동검사를 통과하지 않은 변경을 완료로 표시하지 않는다.**

---

## 5. 지금 하던 일 — 오디오 서버 동기화 (이어서 할 작업)

### 배경

오디오 노트(순간에 붙이는 최대 60초 녹음)는 v1.14에서 **로컬 전용**으로 태어났다.
사용자가 R2 화면을 열어보고 발견했다: *"해당 음성이 r2가 아닌 다른 곳에 저장되고 있는건가요?"*

그리고 결정했다: **"당연히 서버동기화를 진행해야죠. 사진과 동일하게."**

### 완료된 것

- ✅ `supabase/migrations/0019_journey_audio.sql` — 작성 완료
- ✅ **공격검사 7/7 통과** — `BEGIN … ROLLBACK` 안에서 마이그레이션을 먼저 돌리고
  `set local role authenticated`로 검증(격리·강탈·위조·H-02·초대제·좀비차단·진짜복원)
- ✅ 프로덕션 무변경 확인(`audio` 테이블 없음, media 9 / moments 1 / trips 1 그대로)
- ✅ **미적용** — 프로덕션에 반영하지 않았다

### 남은 것 (순서대로 — `sync-offline-dev` §2의 8단계를 따른다)

1. **`src/domain/audio/rowmap.ts`** (신규 생성) — `AudioRow` + `toAudioRow`/`fromAudioRow` + 왕복 유닛
   - 🔴 `fromAudioRow`는 **`isoInstant()`를 통과**하고 반환형은 `WithInstants<T>`여야 한다
     (M-0034 — 서버는 `…48.34+00:00`, 로컬은 `…48.340Z`로 같은 순간을 다르게 적는다)
2. **`src/services/audio.ts`** — 모든 mutation에 **큐 op enqueue**(insert/update/delete)
   - 엔티티와 op은 **한 트랜잭션**(불변식 #1 — M-0033이 이걸 어겨서 났다)
3. **cascade 전파** — `moments.ts`·`trips.ts`에서 소리에도 큐 op를 만든다
   (지금은 "서버로 안 가서" 안 만든다고 주석에 적혀 있다 — 그 주석도 함께 고칠 것)
4. **`purge.ts`** — 소리를 `LOCAL_ONLY_DOMAINS`에서 **`PURGE_DOMAINS`로 승격**
   (`remoteTable: 'audio'`). 그러면 `storeState`·`diagnostics`·`pushPurges`가 자동으로 따라온다
5. **`src/services/sync.ts`** — `AudioRemote` 포트 + `pushPendingAudio` + `pullAudio`
   - `runSync`에서 **순간 다음**(사진·비용과 같은 층)
   - 빈-클라우드 가드 · read-back 후에만 큐 op 제거
6. **R2 바이트** — `media-sign` **v6**: `safeRest()`가 지금 **`.webp`만** 받는다.
   오디오 확장자(`.webm`/`.m4a`/`.ogg`/`.mp4`) 허용 + `mediaIdOfKey`도 함께 + `FN_VERSION` 6
   + 앱의 `EXPECTED_FN_VERSION` 6 (`src/ui/panels/diagnostics.ts`)
   - `naming.ts`에 `audioObjectName`(32자 전체 id — `mediaObjectName`과 같은 규율) 추가
7. **게이트 정리**
   - `scripts/check-domain-symmetry.mjs`의 `NO_OP_REQUIRED`에서 `softDeleteAudio`·
     `restoreAudio`·`addAudioToMoment` **제거**(이제 op를 만들어야 하므로)
   - `scripts/check-schema-parity.mjs`의 `ROW_TO_TABLE`에 `AudioRow → journey.audio` 추가
     ← **잊으면 게이트가 이 엔티티를 안 지킨다**
   - `src/app/blueprint.ts`에서 `localOnlyReason` 제거 + `hasRowmap`/`hasSync` 반영
8. 🔴 **백필(backfill)** — **이게 가장 놓치기 쉽고 가장 중요하다**

### 🔴 백필을 반드시 하라 (안 하면 사용자가 조용히 잃는다)

**이미 녹음된 소리들은 큐 op가 애초에 존재하지 않는다.** 그때는 op를 안 만드는 것이
설계였다. 그래서 동기화를 붙여도 **새로 녹음한 것만 올라가고 기존 것은 영영 안 올라간다.**
사용자가 아무리 동기화를 눌러도 그렇다.

M-0023이 정확히 이 형태였다 — *사용자는 "됐다"고 믿고, 서버는 모르고, 앱은 아무 말도 안 한다.*

- 일회성 백필: `localAudio`에서 op 없는 행을 찾아 `insert` op를 만든다(멱등)
- **그 어긋남을 진단 지표로**: 「로컬에 있는데 서버에 없는 소리」. 정적 게이트는 이 부류를
  원리적으로 못 잡는다(§10 ②)

### 배포 순서 — 이것도 계약이다

```
① 마이그레이션 0019 (Supabase)
② media-sign v6      (Supabase)   ← 함수가 앱보다 먼저
③ 앱                 (Pages)
```

**함수 먼저, 앱 나중.** 새 앱 + 옛 함수는 업로드가 **통째로 실패**한다. 옛 앱 + 새 함수는
정상이다(새 함수가 두 형식을 다 받는다). 서비스워커가 옛 앱을 잠시 살려 두므로
**새 함수는 한동안 옛 형식도 받아야 한다.**

배포 후 **`get_edge_function`으로 소스를 되받아 대조**한다 — 200 응답은 완료가 아니다.

---

## 6. 지금 저장소 상태 (2026-07-27 세션 종료 시점)

### 배포 갭 — ⚠️ 코드와 실기기가 다르다

| 판 | 내용 | 코드(main) | 실기기 |
|---|---|---|---|
| v1.15 | 소리 cascade·휴지통·영구삭제·용량·무결성 (M-0040) | ✅ | ✅ |
| v1.16 | 소리 칩 모양 + 삭제 실행취소 (M-0041) | ✅ | ✅ |
| v1.17 | 순간 실행취소가 사진만 되살리던 것 (M-0042) | ✅ | ⏸ **미배포** |
| v1.18 | 위치 칩 → 앱 지도 → 구글 지도 | ✅ | ⏸ **미배포** |

**미배포 사유**: GitHub Actions **사용량 한도 초과**. 러너가 배정되지 않아
(`runner_id: 0`, 단계 기록 없음, 1~2초 만에 실패) CI·배포가 전부 막혔다.

> **한도가 풀리면 가장 먼저 할 일**: CI를 한 번 돌려 그린을 확인하고 배포한다.
> 그 전까지 v1.17·v1.18은 **"완료"가 아니라 "병합됨 · 배포 대기"**다
> (`AGENTS.md`의 「Git / 협업」 — *완료 = 병합이 아니라 배포 그린 확인*).

### CI가 막혔을 때의 대체 검증 (실제로 이렇게 했다)

로컬 harness만으로는 CI를 대신 못 한다 — CI는 **깨끗한 체크아웃 + `npm ci`**로 돌아서
커밋 안 된 파일·lock 문제를 잡는다. 그래서 이렇게 재현했다:

```bash
# <작업폴더>를 clone한다 — 원격이 아니라 **로컬 저장소**를 복제해야
# "커밋된 것"과 "작업트리"의 차이가 드러난다(그게 CI가 잡는 부류다).
git clone --branch <브랜치> <작업폴더> /tmp/ciclone && cd /tmp/ciclone
# ⚠️ .env를 만들지 않는다 — CI와 같은 상태여야 한다(위 「환경 준비」의 표 참조)
npm ci && npm run harness && npm run build
node scripts/verify-editor-live.mjs
# 커밋 누락 확인 — 출력이 비어야 한다
diff -rq --exclude=.git --exclude=node_modules --exclude=dist --exclude=.env <작업폴더> .
```

> ⚠️ 위 명령의 **브라우저 경로는 환경마다 다르다.** 이 세션에서는 Playwright 브라우저가
> `/opt/pw-browsers`에 미리 깔려 있어 `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`를 앞에
> 붙였다. 당신 환경에 없으면 `npx playwright install chromium`을 먼저 한다.

**이건 CI가 아니다.** 대체물이라고 정직하게 적고, 한도가 풀리면 진짜 CI를 돌린다.

### 검증 현황 (2026-07-27 마지막 측정 — **숫자는 재서 확인하라**, 위 경고 참조)

- harness Required 게이트 전부 통과 (측정 시점 31개)
- 유닛 전부 통과 (측정 시점 637개 / 47개 파일)
- 라이브 렌더 155/155 통과
- 소스 `.ts` 파일 수는 `find src -name '*.ts' | wc -l`로 잰다

### 사용자가 확인 대기 중인 것 (실기기 — 배포 후)

1. 순간 삭제 → 실행취소 시 **비용·소리도** 돌아오는지 (v1.17)
2. 위치 칩 → 앱 지도 → 구글 지도, **좌표가 맞는지** (v1.18)
   - ⚠️ 샌드박스에서 실제 구글 접속 불가 → `window.open` **인자만** 검증했다
3. 소리 칩이 자연스러운지 (v1.16 — 이미 배포됨)

---

## 7. 이 저장소가 반복해서 낸 실수 (근본형 — 전부 다시 날 수 있다)

전체는 `docs/records/coding-mistakes.md`(M-0001 ~ M-0042). 근본형만 추린다.

### ① 형제 중 하나만 조용히 빠진다 (최빈형 — 최소 6회 재발)

M-0006(cascade가 사진·비용에 op 미생성) · M-0007(실행취소가 비용만 복원 안 함) ·
M-0012(형제 화면 절반 누락) · M-0033(새 op이 트랜잭션 규율을 안 물려받음) ·
M-0040(오디오가 계약 다섯 개를 하나도 못 받음) · **M-0042(M-0007이 형제 한쪽에서 그대로 재발)**

**처방**: 묶음 타입으로 **누락을 컴파일 오류화**한다.
```ts
// ❌ 선택적 매개변수의 기본값이 누락을 삼킨다
restoreMomentLocalFirst(id, mediaIds, expenseIds = [], audioIds = [])
// ✅ 삭제가 돌려주는 것과 복원이 받는 것이 같은 타입 — 손으로 고를 기회가 없다
restoreMomentLocalFirst(id, children: MomentChildren)
```

### ② 게이트가 초록인데 아무것도 안 보고 있다 (공허한 게이트)

- M-0004: 첫 매치만 검사해 우회 가능
- M-0036: import 줄만 매칭돼 호출부를 안 봄
- **M-0040: `*LocalFirst` 이름 규약에 기대 → 규약을 안 따르는 새 형제를 통째로 놓침**

**처방**: 판정을 **이름이 아니라 행동**으로. 그리고 §11 — 게이트를 **넓히면 새 게이트다.**
넓힌 능력으로 **다시 주입**해 RED를 확인하라. 누락 방향과 **오탐 방향** 양쪽으로.

### ③ 검사가 딴 것을 재고 있다 (공허한 검사)

- 왕복 검사가 **같은 키로 넣고 꺼내서** `[object Object]` 파일명을 통과시킴(M-0039)
- 픽스처가 0바이트 더미라 **실패 경로만** 재고 있었음
- 격리 테스트는 통과했는데 **실제 화면에서 실패**(부품을 떼어내면 맥락이 만드는 결함을 못 본다)

**처방**: 사용자에게 보이는 산출물이면 **그 산출물 자체를 재라.** 라이브 검사는
마크업을 손으로 세우지 말고 **앱이 스스로 그리게** 하라.

### ④ 앱이 아는 것을 사용자에게 말하지 않는다 (§12)

M-0022(확인해놓고 화면에 안 알림) · M-0035(성공했는데 「판정 불가」) ·
백업 완료 문장에 소리 개수가 없어 사용자가 *"백업에 오디오도 들어있나?"*를 물어야 했음

**처방**: 사용자 문장을 만드는 로직을 **순수 함수로 뽑아** 유닛으로 재라. 그리고 물어라 —
**"지금 이 앱은 사람에게 무엇을 대신 시키고 있는가?"**

### ⑤ 방식을 바꾸면서 옛 방식으로 만들어진 것을 안 데려온다

M-0023(영구삭제 방식을 두 번 바꾸며 옛 것에 아무 일도 안 일어남) ·
**오디오 백필(지금 남은 일)**

**처방**: 저장·삭제·동기화 방식을 바꾸는 커밋에서 반드시 —
```
□ 지금 데이터에 옛 방식으로 만들어진 것이 있는가? (실서버 스냅샷으로 확인 — 추측 금지)
□ 있으면 누가 데려오는가?  답이 "아무도"면 그건 결함이다.
□ 그 어긋남을 진단 지표로 만들었는가?  정적 게이트는 이 부류를 원리적으로 못 잡는다.
```

### ⑥ 시각을 문자열로 비교한다 (M-0034)

서버는 `…48.34+00:00`, 로컬은 `…48.340Z` — **같은 순간인데** `'0' > '+'`라 다르게 읽힌다.
진단이 멀쩡한 사진 9건을 「시간 역전」이라 했고, LWW의 동률 판정도 건너뛰고 있었다.

**처방**: `src/domain/time.ts`가 SSOT. `isoInstant()`로 정규화, `compareInstants()`로 비교.
`check-instant-normalization` 게이트가 src 전체에서 시각의 문자열 비교를 금지한다.

---

## 8. 작업 관용구 (이 저장소에서 "잘한 일"의 모양)

### 게이트에 걸리면 우회하지 말고 덜어내라

`check-fn-size`(함수 길이 래칫)에 걸렸을 때 주석을 지우지 말고 **함수를 뽑아라.**
실제로 그렇게 해서 `checkIntegrity` 133 → 109줄이 됐고 설계가 더 나아졌다.
길이가 줄면 래칫 숫자도 **낮춰서 커밋**해야 한다(한 방향으로만 움직인다).

### 통과했다고 믿지 말고 빨간불을 봐라

고친 결함을 **소스에 다시 주입**해 RED를 확인한다. 이 저장소에서 "검증했다"의 기준이다.
```bash
cp src/x.ts /tmp/x.bak && <결함 주입> && npm run harness ; cp /tmp/x.bak src/x.ts
```

### 마이그레이션은 적용 전에 트랜잭션 안에서 먼저 돌린다

```sql
begin;
  <마이그레이션 DDL 전체>
  set local role authenticated;   -- 🔴 superuser로 확인한 것은 검증이 아니다
  select set_config('request.jwt.claims','{"sub":"…","email":"…"}', true);
  <공격검사: 격리·강탈·위조·H-02·초대제·좀비차단>
rollback;                          -- 프로덕션 무변경
```
`is_allowed()`는 JWT의 **email**을 허용목록과 대조한다. 이메일은 손으로 적지 말고
`select email from journey.allowed_users limit 1`로 **읽어서** 쓴다.

### 변경 후 의무 (빠뜨리면 게이트가 잡는다)

- `src/app/changelog.ts`에 **+0.01** 버전 추가(사용자가 읽는 문장으로)
- `node scripts/gen-registry.mjs` — 카운트 마커 재생성(손편집 금지)
- `docs/HANDOFF.md`에 인계 기록 · 새 교훈은 **해당 스킬 문서에 행 추가**
- 중요한 결정은 `docs/DECISIONS.md`(ADR) — **일어나지 않은 승인을 기록하지 않는다**

### 커밋·PR

```
feat|fix|security|refactor|test|docs|build|chore(scope): 요약
```
PR 본문은 `.github/pull_request_template.md`의 항목을 채운다(작업목적·변경파일·화면변화·
DB변화·Storage변화·개인정보·보안·실행한 검사·되돌리기·확인 필요 항목).
**"실행한 검사"에는 실제 출력을 적고, 자동층만 통과라고 쓴다.**

---

## 9. 열린 결정 (사용자 대기)

| 항목 | 상태 |
|---|---|
| **영상(비디오) 기능** | `docs/VIDEO_PROPOSAL.md`에 설계안 있음. *"오디오 먼저 하고 배포한 뒤 영상은 어떻게 할지 결정하죠"* → 오디오 서버 동기화가 끝나면 재론. 영상도 같은 벽(마이그레이션+함수+3단 배포)을 넘어야 하므로 **오디오 인프라가 절반을 깔아준다** |
| ADR-0015 인라인 AI 컬럼 제거 | `ai_artifacts` 착수 시 재검토 |
| 연구노트 TSA 도입 | 미정 |

---

## 10. 막혔을 때 어디를 보나

| 궁금한 것 | 파일 |
|---|---|
| 무엇을 만드는가 | `docs/PROJECT_SPEC.md` |
| 데이터 모양 | `docs/DATA_MODEL.md` |
| 동기화 계약 | `docs/SYNC_PROTOCOL.md` (**정본**) + `.claude/skills/sync-offline-dev/SKILL.md` (작업법) |
| 보안·RLS | `docs/SECURITY.md` + `.claude/skills/supabase-security-dev/SKILL.md` |
| 개인정보 | `docs/PRIVACY.md` |
| 사진 파이프라인 | `docs/MEDIA_PIPELINE.md` |
| 배포 계약 | `docs/DEPLOYMENT.md` |
| 과거 결정 | `docs/DECISIONS.md` (ADR) |
| **과거 실수** | `docs/records/coding-mistakes.md` (M-0001~M-0042) |
| 하루에 결함 12건 난 전말 | `docs/records/2026-07-26-STORAGE-DELETE-POSTMORTEM.md` |
| 시간순 인계 | `docs/HANDOFF.md` |

**문서끼리 충돌하면**: 실행 코드/migration/테스트(관찰된 현실) > Foundation > Contracts >
Procedures > Playbooks > Records > 생성된 맵. 현실이 계약과 충돌하면 **조용히 고르지 말고**
불일치를 기록하고 → 사용자 데이터를 보호하고 → 코드를 고치거나 계약을 게이트와 함께 개정한다.

---

## 11. 마지막으로 — 이 앱에서 가장 강력한 검출기

> `CLAUDE.md §10` — **이 앱에서 가장 강력한 검출기는 사용자의 실기기 화면이다.**

2026-07-27 하루만 봐도 그렇다. 아래 셋은 전부 **모든 정적 게이트와 라이브 검사를 통과한
상태**로 존재했고, 사용자가 실기기에서 보고 잡았다:

- 소리 칩이 형제보다 두 배 높았던 것
- 소리 삭제에 실행취소가 없던 것
- 소리가 R2에 없던 것 (사용자가 R2 대시보드를 직접 열어봤다)

**기계 검사를 늘려서 이 층을 대체하려 들지 마라.** 대신 **거기까지 가는 길을 짧게** 만든다 —
진단 도구가 하는 일이 그것이고, 배포를 자주 하는 이유가 그것이다.

그리고 **정직하게 보고하라.** "UI 확인함"을 라이브 렌더 없이 말하지 않는다.
통과/스킵/실패를 구분해 적고, 자동층이 못 본 것은 **"사용자 확인 권장"**으로 분리한다.
