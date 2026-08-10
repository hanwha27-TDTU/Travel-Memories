// domain/diagGroups.ts — 진단 도구의 **분류 축과 사각지대 등록부**.
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 재설계했나 (사용자 결정 2026-08-05)
// ─────────────────────────────────────────────────────────────────────────────
// 도구가 8개가 되면서 **성격이 다른 것이 한 카드에 눌렸다.** 실측:
//   · `storeStateProbe` = **222줄**(이 저장소 3번째로 큰 함수). 혼자서 6개 도메인 개수 대조 +
//     사진/소리 파일 대조 6종씩 + 휴지통 + 서버 잔재 + 기기별 현황 + 함수 판을 다 한다.
//   · 정작 판정을 뒤집는 정보가 **접힌 출처에** 있었다 — 「내 기기들 N대」는 M-0048에서
//     *"정리를 권하면 안 된다"*를 결정한 근거였는데 펼쳐야 보인다.
//
// 사용자 지시: *"도구를 통합한다기 보다 오히려 도구를 세분화해서 상세하고 깊게 볼 수 있도록"*
// 그리고 *"니가 못보는 건 당연히 모두 넣어야 해..빼면 안 됨"*.
//
// ─────────────────────────────────────────────────────────────────────────────
// 분류 축 = **경로축** (기억이 지나는 길을 따라간다)
// ─────────────────────────────────────────────────────────────────────────────
// 사용자가 진단을 여는 이유는 늘 하나다 — *"어디서 끊겼나?"* 그래서 목록이 그 길의 순서대로
// 서 있으면 위에서부터 내려가며 좁힐 수 있다. (다른 앱 사례의 6그룹과 대조해 보니 거의
// 겹쳤고, 겹치지 않은 **📡 서버 계약**·**🖼 파일 실물**을 그대로 받아들였다 — 오늘 고친
// 결함 셋이 전부 *"서버가 내 가정과 다르게 행동한다"*였기 때문이다.)

export const DIAG_GROUPS = [
  'local', // 📒 이 기기 안에서 앞뒤가 맞는가
  'upload', // 📤 보낸 것이 실제로 가는가
  'compare', // ☁️ 이 기기와 서버가 같은가
  'contract', // 📡 서버가 내 가정대로 행동하는가
  'files', // 🖼 가리키는 파일이 실제로 열리는가
  'safety', // 🛡 잃어도 되돌릴 수 있는가
  'device', // 🧩 이 기기·계정이 갖췄는가
  'meta', // 🧪 검증 체계 자신의 상태
] as const;

export type DiagGroup = (typeof DIAG_GROUPS)[number];

export interface GroupMeta {
  icon: string;
  label: string;
  /** 이 묶음이 묻는 질문 **한 문장**. 못 쓰면 그 묶음은 경계가 흐린 것이다(§7-E). */
  asks: string;
}

/** Record이므로 그룹을 추가하면 **컴파일러가 여기로 데려온다**(§7 2층). */
export const GROUP_META: Record<DiagGroup, GroupMeta> = {
  local: { icon: '📒', label: '이 기기', asks: '이 기기에 담긴 기록이 스스로 앞뒤가 맞는가' },
  upload: { icon: '📤', label: '올려보내기', asks: '이 기기에서 저장한 것이 실제로 서버까지 가는가' },
  compare: { icon: '☁️', label: '서버와 대조', asks: '이 기기와 서버가 같은 것을 갖고 있는가' },
  contract: { icon: '📡', label: '서버 계약', asks: '서버가 앱이 가정한 대로 행동하는가' },
  files: { icon: '🖼️', label: '파일 실물', asks: '기록이 가리키는 사진·소리가 실제로 열리는가' },
  safety: { icon: '🛡️', label: '안전망', asks: '잃어버려도 되돌릴 수 있는가' },
  device: { icon: '🧩', label: '기기·계정', asks: '이 기기와 로그인이 앱에 필요한 것을 갖췄는가' },
  meta: { icon: '🧪', label: '검증 체계', asks: '검사하는 것 자신은 건강한가' },
};

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 사각지대 등록부 — **「빼면 안 됨」을 기계가 지킨다**
// ─────────────────────────────────────────────────────────────────────────────
//
// 이 목록은 *"개발 환경에서는 확인할 수 없지만 사용자 기기는 확인할 수 있는 것"*이다.
// 산문으로 적어 두면 다음 세션이 못 찾는다 — **데이터로 두고 게이트가 대조**한다
// (`check-diag-blindspots.mjs`). 도구를 만들면 `coveredBy`에 도구 id를 적고, 아직 못 만들었으면
// **이유를 적는다**. 🔴 **이유 없는 미구현은 게이트가 RED로 잡는다**(§7 — 이유 없는 제외는 결함).

export interface BlindSpot {
  /** 보고서와 게이트가 공유하는 안정적인 식별자. 문구가 바뀌어도 같은 사각지대임을 안다. */
  id: string;
  /** 무엇을 확인 못 하는가 — 사용자가 읽을 한 줄. */
  what: string;
  /** 왜 개발 환경에서는 못 재는가. 이게 곧 이 항목이 등록부에 있는 이유다. */
  whyDevCannot: string;
  /** 어느 그룹에 속하는가(도구를 만들 때 갈 자리). */
  group: DiagGroup;
  /** 이 한계를 사용자에게 설명할 책임이 있는 도구. 그룹이 같아야 한다. */
  ownerToolId: string;
  /** 환경상 영구 경계인지, 조건이 갖춰지면 다시 잴 수 있는지. */
  kind: 'structural' | 'transient';
  /**
   * 이 사각지대를 덮는 도구 id. `null`이면 **아직 안 만든 것**이고, 그때는 `pendingReason`이
   * 반드시 있어야 한다. 게이트가 그 짝을 강제한다.
   */
  coveredBy: string | null;
  /** coveredBy가 null일 때 필수 — 왜 아직 안 만들었는가. */
  pendingReason?: string;
}

/**
 * 🔴 **개발 환경이 못 보는 것 전수.** 빼지 않는다 — 빼는 순간 다음 사람은 그런 사각지대가
 * 있는 줄도 모른다(실제로 이 저장소는 그 형태로 여러 번 넘어졌다: M-0019 저장소 혼재 ·
 * M-0023 옛 방식 잔재 · M-0059 채팅 업로드가 GPS를 0으로 덮음 — 전부 *"내 환경에서는 안 보이는
 * 것"*이었다).
 */
export const BLIND_SPOTS: BlindSpot[] = [
  // ── 개발 컨테이너에 Supabase 시크릿이 없어 못 재는 것들 ──
  {
    id: 'SESSION-LOGOUT-HIDES-LOCAL',
    what: '로그아웃하면 이 기기의 기록이 실제로 가려지는가(M-0102 수정)',
    whyDevCannot: '개발 빌드에 Supabase 시크릿이 없어 isConfigured()===false — 잠금 경로 자체가 안 돈다',
    group: 'device',
    ownerToolId: 'session',
    kind: 'structural',
    coveredBy: 'session',
  },
  {
    id: 'SESSION-DEEPLINK-GUARD',
    what: '딥링크(/trip/<id>)로 들어와도 로그아웃 잠금이 걸리는가',
    whyDevCannot: '위와 같음 — 로그인 상태를 만들 수 없어 가드가 발화하지 않는다',
    group: 'device',
    ownerToolId: 'session',
    kind: 'structural',
    coveredBy: 'session',
  },
  {
    id: 'SESSION-LIFETIME',
    what: '로그인 세션이 얼마나 유지되는가(사용자 요청: 6개월)',
    whyDevCannot: '실제 토큰이 없어 만료 시각을 읽을 수 없다. 서버 정책은 Supabase 대시보드가 정한다',
    group: 'device',
    ownerToolId: 'session',
    kind: 'structural',
    coveredBy: 'session',
  },
  // ── 플랫폼이 답을 안 주는 것 ──
  {
    id: 'STORAGE-APK-PERSIST-MEANING',
    what: '설치된 앱(APK)에서 브라우저 저장소 보호(persist)가 실제로 무엇을 뜻하는가 — 옛 T-005',
    whyDevCannot:
      '안드로이드 WebView는 `persist()`에 허락을 주지 않는다(사용자 태블릿 실측 2026-08-06: 앱이 시작할 때 요청 → 거절). ' +
      '그렇다고 「위험하다」도 아니다 — 그 표면에서 이 값이 무엇을 뜻하는지 **잴 방법이 앱에 없다**. ' +
      '「지웠다/안 지웠다」는 브라우저 축출이 실제로 일어나야 관측되는데 그건 만들 수 없다.',
    group: 'safety',
    ownerToolId: 'storage',
    kind: 'structural',
    // 🔴 **덮였다고 적지 않는다**(M-0109의 교훈 — 항목의 질문을 소리 내어 읽어라).
    // 「저장소 안전」 도구는 *물어봤고 거절당했다*를 말할 뿐, *그 값이 이 표면에서 무엇을
    // 뜻하는가*에는 답하지 못한다. 그게 이 항목의 질문이다.
    coveredBy: null,
    pendingReason:
      '🔴 **과제가 아니라 경계다.** 백로그에 두면 영원히 안 끝나는 행이 된다(BACKLOG의 「다섯 번째 형제」 규칙). ' +
      '사용자에게 유효한 답은 이미 화면에 있다 — 물어본 사실·거절 시각을 말하고, 확실한 보호(백업)로 안내한다. ' +
      '재는 방법이 생기면 `persistIsMeaningful()`부터 고친다.',
  },
  // ── 기기가 하나뿐이라 못 재는 것 ──
  {
    id: 'STORE-MULTI-DEVICE-TRASH',
    what: '두 기기가 실제로 같은 휴지통을 보는가(ADR-0049)',
    whyDevCannot: '개발 환경에는 기기가 하나뿐이라 「기기 간」이 성립하지 않는다',
    group: 'compare',
    ownerToolId: 'store',
    kind: 'structural',
    coveredBy: 'fleet',
  },
  // ── 운영 DB에 직접 질의해야 했던 것들(오늘 결함 셋을 좁힐 때 실제로 필요했다) ──
  {
    id: 'CONTRACT-PAGE-LIMIT',
    what: '서버가 한 번에 주는 행수 상한이 앱의 가정과 같은가',
    whyDevCannot: '개발 컨테이너의 프록시가 운영 서버 질의를 막는다 — Range/Content-Range를 실측할 수 없다',
    group: 'contract',
    ownerToolId: 'contract',
    kind: 'transient',
    coveredBy: 'contract',
  },
  {
    id: 'CONTRACT-PAGE-GAP',
    what: '페이지를 나눠 받을 때 사이가 빠지지 않는가',
    whyDevCannot: '위와 같음 — 실제 서버에 두 페이지를 요청해 대조해야 안다',
    group: 'contract',
    ownerToolId: 'contract',
    kind: 'transient',
    coveredBy: 'contract',
  },
  {
    id: 'SYNC-RELEASE-SOURCE',
    what: '앱이 기대하는 media-sign 소스와 실제 배포된 Edge Function 소스가 같은가',
    whyDevCannot: '프로토콜 판과 실제 배포 소스는 다르며, 운영 함수가 자기 소스 식별자를 되돌려줘야만 대조할 수 있다',
    group: 'contract',
    ownerToolId: 'sync-release',
    kind: 'transient',
    coveredBy: 'sync-release',
  },
  {
    id: 'SYNC-RELEASE-STALL',
    what: '동기화가 실행 중인 척한 채 같은 단계에서 영구히 멎지 않았는가',
    whyDevCannot: 'Promise 미정산과 모바일 네트워크·브라우저 정체는 실기기 실행 시간축에서만 드러난다',
    group: 'upload',
    ownerToolId: 'sync',
    kind: 'transient',
    coveredBy: 'sync-release',
  },
  {
    id: 'ROUNDTRIP-UPDATE-STAMP',
    what: '서버 트리거가 updated_at을 덮어써서 LWW 판정을 흔들지 않는가',
    whyDevCannot: '실제로 저장해 보고 응답을 비교해야 안다 — 쓰기 권한이 있는 서버가 필요하다',
    group: 'upload',
    ownerToolId: 'roundtrip',
    kind: 'transient',
    // 🔴 「서버 계약」(읽기 전용)이 아니라 **「왕복 시험」**이 덮는다(2026-08-06 · T-013 종결).
    //    `update` → `stampRead` 두 단계가 붙었다: 이미 있는 행을 **고쳐** 서버의 UPDATE 트리거를
    //    실제로 돌린 뒤, 이 기기와 서버가 **같은 수정 시각**을 들고 있는지 되읽어 확인한다.
    //    🔴 만들기(INSERT)만 재면 트리거가 안 도는 자리에서 초록이 나고, 그 초록의 뜻은
    //    「없다」가 아니라 **「안 봤다」**이다(§17).
    coveredBy: 'roundtrip',
  },
  {
    id: 'CONTRACT-ANON-RLS',
    what: '로그인하지 않은 요청이 실제로 막히는가(RLS·초대제)',
    whyDevCannot: '실제 anon 키와 실제 RLS 정책이 있는 서버가 필요하다',
    group: 'contract',
    ownerToolId: 'contract',
    kind: 'transient',
    coveredBy: 'contract',
  },
  // ── R2 자격증명이 없어 못 재는 것 ──
  {
    id: 'FILES-SERVER-BYTES',
    what: '기록이 가리키는 사진·소리가 **서버 저장소에** 실제로 있는가(전수)',
    whyDevCannot: 'R2 자격증명이 없어 객체를 조회할 수 없다',
    group: 'files',
    ownerToolId: 'files',
    kind: 'transient',
    // 🔴 **덮은 것은 「파일 실물」이 아니라 「저장 상태」다**(2026-08-05 정정). 새 도구를 만들며
    //    이 항목까지 자기가 덮는다고 적었다가 되돌렸다 — 「파일 실물」은 **이 기기의 바이트**만
    //    보고 R2를 조회하지 않는다. `storeState`의 `auditMediaFiles`가 r2ListObjects로 id 집합을
    //    전수 대조하고, 목록이 잘리면 `truncated`로 **unknown**을 낸다(모르는 것을 정상으로
    //    반올림하지 않는다). 덮였다고 잘못 적는 것이 이 등록부에서 가장 위험한 형태다(게이트 D).
    coveredBy: 'store',
  },
  {
    id: 'FILES-LOCAL-DECODE',
    what: '이 기기에 내려받은 사진·소리가 **실제로 열리고 재생되는가**',
    whyDevCannot: '개발 환경에는 사용자의 바이트가 없다 — 실제 파일을 디코드해 봐야 안다',
    group: 'files',
    ownerToolId: 'files',
    kind: 'structural',
    coveredBy: 'files',
  },
  {
    id: 'FILES-SERVER-DECODE',
    // 🔴 새 도구를 만들면서 **새로 알게 된 사각지대**다(§9 4단계 — 세계를 보면 구멍이 늘기도 한다).
    what: '**서버에 있는** 사진·소리 바이트가 실제로 열리는가(내려받아 디코드)',
    whyDevCannot: '자격증명이 없고, 있어도 전수 다운로드는 이 앱에서 egress가 실제 제약이다',
    group: 'files',
    ownerToolId: 'files',
    kind: 'structural',
    coveredBy: null,
    pendingReason:
      '「파일 실물」은 이 기기 바이트만 연다. 서버 바이트를 전수로 받아 열면 사진 앱에서 사용자 요금이 든다 — ' +
      '다른 기기에서 이 도구를 돌리면 그 기기가 받은 바이트를 열어 보므로, 기기를 합치면 실질적으로 덮인다.',
  },
  // ── 왕복 자체 ──
  {
    id: 'ROUNDTRIP-SERVER-FLOW',
    what: '저장한 것이 서버까지 갔다가 지운 흔적까지 남기고 사라지는가',
    whyDevCannot: '쓰기 가능한 실제 서버가 필요하다. 유닛은 가짜 클라이언트를 재므로 계약 위반을 못 본다',
    group: 'upload',
    ownerToolId: 'roundtrip',
    kind: 'transient',
    coveredBy: 'roundtrip',
  },
  {
    id: 'SYNC-OFFLINE-RETURN',
    what: '오프라인에서 쌓인 것이 연결 복귀 시 실제로 올라가는가',
    whyDevCannot: '유닛은 이벤트 배선까지만 잰다 — 진짜 네트워크 단절·복귀는 실기기 몫이다',
    group: 'upload',
    ownerToolId: 'sync',
    kind: 'structural',
    coveredBy: 'roundtrip',
  },
  {
    id: 'BACKUP-FILE-ROUNDTRIP',
    what: '백업 파일이 실제로 다시 읽혀 원래 기록으로 복원되는가',
    whyDevCannot: '유닛은 만든 것을 바로 되읽으므로 **실제 파일 왕복**(내려받기→고르기→파싱)을 못 잰다',
    group: 'safety',
    ownerToolId: 'backup',
    kind: 'structural',
    coveredBy: 'backup',
  },
  // ── 사람·CI만 판단할 수 있는 것(앱이 재는 척하면 안 된다) ──
  {
    id: 'ERRORS-GATE-HEALTH',
    what: '게이트가 실제로 돌았는가 · 대조군이 의미 있는가',
    whyDevCannot: '앱 밖(CI·사람 판단)의 영역이다',
    group: 'meta',
    ownerToolId: 'errors',
    kind: 'structural',
    coveredBy: null,
    pendingReason:
      '🔴 앱이 잴 수 없다 — CI 결과와 사람의 판단이 정본이다. 앱이 이걸 판정하는 척하면 그 초록이 거짓이 된다(§8). ' +
      '대신 「게이트 건강」 도구가 **게이트 목록과 마지막 실행 정보**만 관측으로 보여준다.',
  },
];

/** 도구 상세·보고서·게이트가 같은 책임 관계를 읽는다. */
export function blindSpotsForTool(toolId: string): BlindSpot[] {
  return BLIND_SPOTS.filter((spot) => spot.ownerToolId === toolId);
}
