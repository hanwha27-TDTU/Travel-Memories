// app/researchLog.ts — 연구노트(특허 증거용) 데이터의 단일 진실원(SSOT).
//
// 이 앱을 만들며 "사람이 생각하고 결정한 흔적"을 사람/AI/최종결정 3단으로 남긴다.
// AI가 도왔지만 방향·판단·최종결정은 사람이 했다는 구조화 기록이다(app/hashchain.ts로 해시체인).
// 정직성(§4): 여기 적힌 건 실제 세션에서 오간 결정만이다. 새 항목은 배열 끝에 append(순서·seq 불변).

import type { ChainInput } from './hashchain';

/** 연구노트 항목. seq는 append-only 순번(재배열 금지 — 해시체인이 순서에 의존). */
export const RESEARCH_LOG: ChainInput[] = [
  {
    seq: 1,
    date: '2026-07-22',
    topic: '기술 스택 — 프레임워크 없이 갈까',
    human: '개인 여행기록 앱을 오프라인 우선으로. 무겁지 않게.',
    ai: 'Vanilla TS + Vite + Dexie(IndexedDB) + Supabase를 제안. MVP에서 프레임워크 추가 안 함.',
    decision: 'Vanilla TS 구조 채택. 실제 유지불가로 측정될 때만 기술변경 제안서를 쓴다(CLAUDE.md).',
  },
  {
    seq: 2,
    date: '2026-07-22',
    topic: '데이터 안전 — 기억을 잃지 않기',
    human: '기록한 여행 기억은 절대 잃으면 안 된다.',
    ai: '내구성 로컬 커밋(entity+operation atomic)+read-back, tombstone(하드삭제 없음), LWW, 빈-클라우드 가드를 제안.',
    decision: '로컬 커밋 이후 앱 원인 유실 0을 비타협 원칙으로 못박음(SYNC_PROTOCOL).',
  },
  {
    seq: 3,
    date: '2026-07-23',
    topic: '저장된 기록을 못 고침',
    human: '이미 저장된 순간·사진이 편집·삭제가 안 된다.',
    ai: '순간 편집/삭제 + 사진 개별 삭제를 tombstone·실행취소(undo)로 제안(복구 가능성 우선).',
    decision: '편집/삭제를 복구 가능한 형태로 구현. 원본 사진은 기기에서 변경/삭제하지 않음(§0).',
  },
  {
    seq: 4,
    date: '2026-07-23',
    topic: '코딩 규율을 헌법에',
    human: '코딩할 때 항상 육하원칙(5W1H)을 생각하도록 헌법에 박아두자.',
    ai: '왜/무엇을/어디서/언제/누가/어떻게를 착수 전·중 자문하는 Pre-flight 5W1H를 CLAUDE.md에 삽입 제안.',
    decision: '5W1H를 결함 예방 장치로 헌법에 명문화. 답이 서로 모순되면 멈추고 재설계.',
  },
  {
    seq: 5,
    date: '2026-07-23',
    topic: '장소 — 구글맵인가 무료맵인가',
    human: '장소는 구글맵 또는 다른 무료 맵을 못 쓰나?',
    ai: '구글맵은 API 키·결제 필요. OSM 타일과 일관된 무료·키 불필요의 Nominatim 지오코딩을 제안.',
    decision: 'Nominatim 채택. 검색은 버튼 제출 시에만(저트래픽·귀속), 결과는 textContent로만 렌더(XSS 방지).',
  },
  {
    seq: 6,
    date: '2026-07-23',
    topic: '제목 자간이 기기마다 갈라짐',
    human: '제목 연도 숫자 자간이 갈라진다. 맑은고딕으로 픽스하면?',
    ai: '맑은고딕은 Windows 전용이라 안드로이드에 없음. 기기 독립적인 Pretendard 웹폰트 번들을 제안.',
    decision: 'Pretendard woff2를 앱에 번들(self-host). 모든 기기에서 동일 렌더로 자간 문제 확정 해결.',
  },
  {
    seq: 7,
    date: '2026-07-23',
    topic: '선택 후 검색창이 안 사라짐',
    human: '장소를 선택하면 선택창이 사라져야 하는 것 아닌가?',
    ai: 'display를 가진 클래스가 [hidden] 속성을 이기는 CSS 결함군으로 진단. 전역 [hidden]{display:none!important} 제안.',
    decision: '단건 수정이 아니라 결함군으로 승격해 전역 박멸(형제 위치 일괄).',
  },
  {
    seq: 8,
    date: '2026-07-23',
    topic: '등록되지 않은 장소',
    human: '지도에서도 위치를 지정하고, 등록 안 된 곳은 이름을 직접 적게 하자.',
    ai: '지도 탭-투-픽(마커 드래그) + 이름·좌표 독립 입력을 제안(mapPicked 플래그로 이름 입력 시 좌표 유지).',
    decision: '지도 위치 지정 + 자유 이름 입력 채택. 검색 좌표는 이름과 묶고, 지도 좌표는 독립.',
  },
  {
    seq: 9,
    date: '2026-07-23',
    topic: '세로 사진 편집 화질·크롭',
    human: '세로 사진이 작게 뜨고 여백이 크다. 자르기 적용 버튼도 안 보인다.',
    ai: '폭 맞추기 + 미리보기 해상도 상향, 이미지 아래 크롭 확정 버튼, 폭 100%(세로 스크롤) 선택 옵션을 제안.',
    decision: '폭 맞춤/폭 채우기 선택 + 크롭 확정 버튼 채택. 두 방식 모두 크롭 오버레이 정렬 보장.',
  },
  {
    seq: 10,
    date: '2026-07-23',
    topic: '버전·개발자 정보·법령 체계',
    human: '버전을 0.00부터 0.01씩 올리고, 메디컬 앱처럼 개발자 정보·이력·법령 체계를 넣자.',
    ai: 'PR 병합=릴리스로 소급 버전 부여, changelog SSOT, 문서 지도를 규범 위계로 재구성 제안.',
    decision: 'src/app/changelog.ts를 버전 SSOT로. 개발자 정보 화면 + 문서 규범 체계 5단 시각화 채택.',
  },
  {
    seq: 11,
    date: '2026-07-23',
    topic: '연구노트(특허 증거용)',
    human: '메디컬 앱처럼 연구노트(사람/AI/최종결정 흔적·해시체인)를 넣자.',
    ai: 'ChainInput을 SHA-256으로 append-only 체인화(Web Crypto), 앵커 해시로 위·변조 감지를 제안.',
    decision: '연구노트 채택. 법적 보증이 아니라 특허 검토용 구조화 증거 로그로 명확히 표기(과장 금지).',
  },
];
