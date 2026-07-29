#!/usr/bin/env node
// compare-geocoders.mjs — **「더 정확하다」를 재는 자.** (선택 도구 · 실 네트워크 필요)
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 이 스크립트가 있나
// ─────────────────────────────────────────────────────────────────────────────
// 2026-07-30, 사용자가 다른 AI의 제안을 가져왔다: *"Mapbox로 바꾸면 정확해진다."*
// 그럴 수도 있다. 그런데 **아무도 재지 않았다.** 이 저장소의 규율은 §4다 —
// *알려진 실패를 주입해 RED를 확인한 뒤에만 게이트를 신뢰한다.* 제공자 선택도 같다:
// **비교 없이 「더 정확하다」고 말하면 그건 측정이 아니라 취향이다.**
//
// 특히 한국 질의는 직관이 자주 틀린다. 세계적으로 강한 제공자가 국내 상호명·건물에서는
// 국내 제공자보다 약할 수 있다. 그래서 **바꾸기 전에 이 스크립트를 돌린다.**
//
// ─────────────────────────────────────────────────────────────────────────────
// 무엇을 재나 — 「정답 좌표」가 없으므로 **정답률을 재지 않는다**(§8 정직)
// ─────────────────────────────────────────────────────────────────────────────
// 이 스크립트는 각 제공자에 대해 세 가지를 센다:
//   ① **응답률**   — 답을 아예 못 주는 질의가 몇 %인가
//   ② **정밀도 분포** — 건물/길/동네/행정구역/확인불가가 각각 몇 건인가
//   ③ **1순위 합의** — 다른 제공자의 1순위와 얼마나 떨어져 있는가(m)
//
// ①②는 그 제공자만으로 판정되고, ③은 **서로를 견제**한다. 셋이 함께여야 의미가 있다:
// 응답률만 보면 아무 답이나 주는 제공자가 이기고, 정밀도만 보면 근거 없이 「건물」이라
// 우기는 제공자가 이긴다.
//
// 🔴 **이 스크립트는 승자를 정하지 않는다.** 숫자를 내놓을 뿐이고, 어느 쪽을 쓸지는 사람이
//    정한다. 「기계가 골랐다」고 말할 수 있는 종류의 문제가 아니다.
//
// 사용:
//   node scripts/compare-geocoders.mjs                     # Nominatim만(키 불필요)
//   KAKAO_REST_KEY=... node scripts/compare-geocoders.mjs  # 카카오와 비교
//   VWORLD_KEY=...     node scripts/compare-geocoders.mjs  # VWorld와 비교
//
// 종료코드: 0=측정 완료 · 2=전제 미충족(네트워크 차단 등 — **SKIP이지 통과가 아니다**)

const QUERIES = [
  // 🔴 원래 신고를 낸 질의. 길이라 어느 제공자도 「점」으로 답할 수 없다 — 그걸 밝히는지 본다.
  { q: '대학로', note: '길(전국 다수) — 원래 신고 사례' },
  { q: '경복궁', note: '유명 POI' },
  { q: '스타벅스 종로점', note: '체인 상호(국내 제공자가 강한 부류)' },
  { q: '서울대학교병원', note: '기관명' },
  { q: '협재해변', note: '자연 지물' },
  { q: '서울 종로구 대학로 101', note: '도로명 주소(건물번호까지)' },
  { q: '한남동 카페', note: '동네 + 업종(모호한 질의)' },
  { q: '인천국제공항 제2여객터미널', note: '긴 시설명' },
  // 해외 — 국내 제공자는 여기서 못 답하는 것이 **정상**이다(그 사실도 측정값이다).
  { q: 'Roma Termini', note: '해외 역' },
  { q: 'Tashkent State Medical University', note: '해외 기관' },
  { q: 'Shibuya Crossing', note: '해외 랜드마크' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 등급 자 — src/domain/place/precision.ts와 **같은 경계**를 쓴다(다르면 비교가 거짓말이 된다). */
function rankGrade(placeRank) {
  if (placeRank === null || !Number.isFinite(placeRank)) return 'unknown';
  if (placeRank >= 28) return 'point';
  if (placeRank >= 26) return 'street';
  if (placeRank >= 22) return 'area';
  if (placeRank >= 17) return 'settlement';
  return 'region';
}

function meters(a, b) {
  const mid = (((a.lat + b.lat) / 2) * Math.PI) / 180;
  const dLat = (a.lat - b.lat) * 111320;
  const dLng = (a.lng - b.lng) * 111320 * Math.cos(mid);
  return Math.round(Math.sqrt(dLat * dLat + dLng * dLng));
}

async function askNominatim(q) {
  const p = new URLSearchParams({ format: 'jsonv2', limit: '5', 'accept-language': 'ko', addressdetails: '1', q });
  const r = await fetch(`https://nominatim.openstreetmap.org/search?${p}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'bugeon-journey-geocoder-comparison' },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const rows = await r.json();
  return (Array.isArray(rows) ? rows : []).map((x) => ({
    name: x.name ?? String(x.display_name ?? '').split(',')[0],
    lat: Number(x.lat),
    lng: Number(x.lon),
    grade: rankGrade(Number(x.place_rank)),
  }));
}

async function askKakao(q, key) {
  const r = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?size=5&query=${encodeURIComponent(q)}`, {
    headers: { Authorization: `KakaoAK ${key}` },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return (j.documents ?? []).map((d) => ({
    name: d.place_name,
    lat: Number(d.y),
    lng: Number(d.x),
    grade: 'point', // 키워드 검색 결과는 정의상 POI
  }));
}

async function askVworld(q, key) {
  const p = new URLSearchParams({ service: 'search', request: 'search', version: '2.0', size: '5', query: q, type: 'place', key });
  const r = await fetch(`https://api.vworld.kr/req/search?${p}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const items = j?.response?.result?.items ?? [];
  return items.map((it) => ({
    name: it.title,
    lat: Number(it.point?.y),
    lng: Number(it.point?.x),
    grade: 'point',
  }));
}

const providers = [{ id: 'nominatim', ask: askNominatim, delay: 1100 }]; // 공용 서버 예의: 1초 간격
if (process.env.KAKAO_REST_KEY) {
  providers.push({ id: 'kakao', ask: (q) => askKakao(q, process.env.KAKAO_REST_KEY), delay: 120 });
}
if (process.env.VWORLD_KEY) {
  providers.push({ id: 'vworld', ask: (q) => askVworld(q, process.env.VWORLD_KEY), delay: 120 });
}

// 전제 확인 — 네트워크가 막혀 있으면 **SKIP이라고 말한다.** 0건 측정을 「통과」로 적지 않는다(§2-G).
try {
  await askNominatim('서울');
} catch (e) {
  console.error(`compare-geocoders: SKIP — Nominatim에 닿지 못했습니다(${e.message}).`);
  console.error('  이 샌드박스는 외부 지오코딩 호스트를 막습니다. **실기기·실 네트워크에서 돌리세요.**');
  console.error('  이 실행은 어떤 제공자도 재지 않았습니다 — 「비교했다」고 적지 마세요.');
  process.exit(2);
}

const stats = new Map(providers.map((p) => [p.id, { answered: 0, total: 0, grades: {} }]));
const firsts = [];

for (const { q, note } of QUERIES) {
  const row = { q, note, byProvider: {} };
  for (const p of providers) {
    const s = stats.get(p.id);
    s.total++;
    try {
      const got = await p.ask(q);
      if (got.length) {
        s.answered++;
        s.grades[got[0].grade] = (s.grades[got[0].grade] ?? 0) + 1;
        row.byProvider[p.id] = got[0];
      }
    } catch (e) {
      row.byProvider[p.id] = { error: e.message };
    }
    await sleep(p.delay);
  }
  firsts.push(row);
  const parts = providers.map((p) => {
    const v = row.byProvider[p.id];
    if (!v) return `${p.id}: (없음)`;
    if (v.error) return `${p.id}: 오류 ${v.error}`;
    return `${p.id}: ${v.name} [${v.grade}]`;
  });
  console.log(`\n■ ${q}  — ${note}\n  ${parts.join('\n  ')}`);
}

console.log('\n═══ 요약 ═══');
for (const p of providers) {
  const s = stats.get(p.id);
  const grades = Object.entries(s.grades)
    .sort((a, b) => b[1] - a[1])
    .map(([g, n]) => `${g} ${n}`)
    .join(' · ');
  console.log(`${p.id.padEnd(10)} 응답 ${s.answered}/${s.total}  1순위 정밀도: ${grades || '(없음)'}`);
}

if (providers.length > 1) {
  console.log('\n═══ 1순위 합의(제공자 간 거리) ═══');
  for (const row of firsts) {
    const pts = providers.map((p) => row.byProvider[p.id]).filter((v) => v && !v.error && Number.isFinite(v.lat));
    if (pts.length < 2) continue;
    const d = Math.max(...pts.slice(1).map((v) => meters(pts[0], v)));
    const verdict = d <= 100 ? '일치' : d <= 2000 ? '같은 동네(다른 지점)' : '🔴 서로 다른 곳';
    console.log(`  ${row.q.padEnd(28)} 최대 ${String(d).padStart(7)}m  ${verdict}`);
  }
  console.log('\n  「서로 다른 곳」이 나오면 **적어도 하나는 틀렸다.** 어느 쪽이 옳은지는');
  console.log('  이 스크립트가 모른다 — 사람이 지도에서 확인해야 한다(§8 확인 불가).');
} else {
  console.log('\n제공자가 하나뿐이라 **비교는 하지 못했습니다**(응답률·정밀도 분포만 잰 것입니다).');
  console.log('KAKAO_REST_KEY 또는 VWORLD_KEY를 주고 다시 돌리면 서로를 견제할 수 있습니다.');
}
