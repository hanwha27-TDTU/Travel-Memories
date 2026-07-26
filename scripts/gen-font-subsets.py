#!/usr/bin/env python3
"""gen-font-subsets.py — 제목 웹폰트(Pretendard)를 unicode-range 조각으로 나눈다.

왜: 제목 폰트 한 장이 793KB였다. 여행 중 휴대전화 데이터로 여는 앱에서 JS 번들보다 큰
단일 자산이다. 그런데 그 안엔 **거의 안 쓰는 것**이 대부분이었다(실측):
    희귀 받침 조합 7,980자 = 442KB   ·   기호 2,402자 = 122KB   ·   가나 184자 = 14KB
    상용 한글 3,192자 = 212KB        ·   라틴·자모 = 36KB

왜 "쓰는 글자만" 서브셋하지 않나: `.trip-title`·`.detail-title`은 **사용자가 쓴 여행 제목**이다.
앱 정적 문구만 남기면 사용자 글자가 폴백 폰트로 갈라진다 — 이 폰트를 번들한 이유가 바로
그 갈라짐을 없애는 것이었다(researchLog seq 참조). 그래서 **커버리지는 100% 유지**하고,
브라우저가 `unicode-range`를 보고 **실제로 쓰인 조각만** 받아가게 한다.

한글을 어떤 축으로 자르나: **받침(종성)**. 받침 없음과 ㄱㄴㄹㅁㅂㅅㅇ 7종이 실사용의 대부분이고,
ㄳㄵㄶㄺㄻㄼㄽㄾㄿㅀㅄㅋ 같은 조합은 사실상 안 나온다. 초성·중성 축은 ㄲㄸㅃㅉ(까·때·빠·짜)가
흔해서 좋은 분할축이 아니다.

실행(수동 — CI에 파이썬 의존을 넣지 않는다):
    python3 -m pip install fonttools brotli
    python3 scripts/gen-font-subsets.py
생성물(woff2 + fonts.css의 @font-face 블록)은 커밋한다. `check-font-subsets`가
CSS ↔ 실제 파일의 어긋남을 RED로 잡는다.
"""

import os
import sys
from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT_DIR = os.path.join(ROOT, "src/ui/styles/fonts")
SRC = os.path.join(FONT_DIR, "Pretendard-ExtraBold.woff2")

HANGUL_LO, HANGUL_HI = 0xAC00, 0xD7A3
# 종성 인덱스 → 실사용 대부분을 덮는 8종(없음·ㄱ·ㄴ·ㄹ·ㅁ·ㅂ·ㅅ·ㅇ).
COMMON_FINALS = {0, 1, 4, 8, 16, 17, 19, 21}


def syllable(initial: int, medial: int, final: int) -> int:
    return HANGUL_LO + (initial * 21 + medial) * 28 + final


def hangul_sets():
    common, rare = set(), set()
    for i in range(19):
        for m in range(21):
            for f in range(28):
                (common if f in COMMON_FINALS else rare).add(syllable(i, m, f))
    return common, rare


def to_ranges(codepoints):
    """정렬된 코드포인트 → 연속 구간 목록. CSS unicode-range 길이를 줄인다."""
    out = []
    for cp in sorted(codepoints):
        if out and cp == out[-1][1] + 1:
            out[-1][1] = cp
        else:
            out.append([cp, cp])
    return out


def css_unicode_range(codepoints) -> str:
    parts = []
    for lo, hi in to_ranges(codepoints):
        parts.append(f"U+{lo:04X}" if lo == hi else f"U+{lo:04X}-{hi:04X}")
    return ",".join(parts)


def build(name, codepoints, available):
    cps = sorted(codepoints & available)
    if not cps:
        return None
    out = os.path.join(FONT_DIR, f"{name}.woff2")
    subset.main([
        SRC,
        "--flavor=woff2",
        f"--output-file={out}",
        "--unicodes=" + ",".join(f"{c:04X}" for c in cps),
        "--layout-features=*",
        "--no-hinting",
        "--desubroutinize",
    ])
    return {"name": name, "file": f"{name}.woff2", "size": os.path.getsize(out), "cps": cps}


def main():
    if not os.path.exists(SRC):
        sys.exit(f"원본 폰트가 없습니다: {SRC}")

    available = set(TTFont(SRC).getBestCmap().keys())
    common_h, rare_h = hangul_sets()
    non_hangul = {c for c in available if not (HANGUL_LO <= c <= HANGUL_HI)}
    latin = {c for c in non_hangul if c <= 0x024F}
    compat_jamo = {c for c in non_hangul if 0x3130 <= c <= 0x318F}
    punct = {c for c in non_hangul if 0x2000 <= c <= 0x206F}
    # 첫 조각: 라틴·숫자·문장부호·호환자모. 어떤 화면에서든 거의 항상 필요하다.
    core = latin | compat_jamo | punct
    rest = non_hangul - core  # 기호·가나 등 — 실제로 그런 글자가 나올 때만 받는다

    # 조각의 **선언 순서가 곧 우선순위**다(CSS Fonts: 같은 family에서 unicode-range가 겹치면
    # 나중 선언이 이긴다). 그래서 희귀 조각을 **먼저** 선언하고 한글 블록 전체를 성기게 잡는다:
    #   · 흔한 음절 → 뒤에 선언된 `ko`가 이긴다(희귀 조각을 받지 않는다)
    #   · 희귀 음절 → `ko`에 없으니 `ko-ext`가 받는다
    # 왜 이렇게까지: 희귀 조각의 정확한 구간을 CSS에 적으면 ~24KB가 붙는데, CSS는 **렌더 차단**이라
    # 폰트(swap·비차단)와 성격이 다르다. 안 쓰는 조각 때문에 첫 페인트를 늦출 이유가 없다.
    # 이 순서 의존은 추측이면 안 되므로 `verify-editor-live`가 **실제 네트워크 요청**으로 확인한다.
    tiers = [
        ("pretendard-ko-ext", rare_h, {(HANGUL_LO, HANGUL_HI)}),
        ("pretendard-core", core, None),
        ("pretendard-ko", common_h, None),
        ("pretendard-sym", rest, None),
    ]

    built = []
    for name, cps, coarse in tiers:
        b = build(name, cps, available)
        if b:
            b["range_cps"] = coarse  # None이면 실제 글자 집합 그대로를 구간으로 쓴다
            built.append(b)

    lines = [
        "/* GENERATED — 손으로 편집하지 마세요. 재생성: python3 scripts/gen-font-subsets.py",
        "   제목(--font-disp) 웹폰트 Pretendard(OFL)를 unicode-range로 쪼갠 것.",
        "   브라우저는 화면에 실제로 쓰인 글자가 든 조각만 내려받는다 — 커버리지는 100% 그대로다.",
        "   font-display: swap — 폰트 도착 전에도 글자는 폴백으로 즉시 보인다(투명글자 없음).",
        "   라이선스: fonts/Pretendard-OFL.txt · 검사: scripts/check-font-subsets.mjs */",
        "",
    ]
    for b in built:
        if b["range_cps"] is None:
            urange = css_unicode_range(b["cps"])
            note = f"{len(b['cps']):,}자"
        else:
            urange = ",".join(f"U+{lo:04X}-{hi:04X}" for lo, hi in sorted(b["range_cps"]))
            note = f"{len(b['cps']):,}자 · 구간은 성기게(뒤 선언이 이김 — 위 주석 참조)"
        lines += [
            f"/* {b['name']} — {note} · {b['size']:,} B */",
            "@font-face {",
            "  font-family: 'Pretendard';",
            f"  src: url('./fonts/{b['file']}') format('woff2');",
            "  font-weight: 400 900;",
            "  font-style: normal;",
            "  font-display: swap;",
            f"  unicode-range: {urange};",
            "}",
            "",
        ]

    css_path = os.path.join(ROOT, "src/ui/styles/fonts.css")
    with open(css_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))

    total = sum(b["size"] for b in built)
    orig = os.path.getsize(SRC)
    print(f"원본 {orig:,} B → 조각 {len(built)}개 합계 {total:,} B")
    for b in built:
        print(f"  {b['file']:<28} {b['size']:>9,} B  ({len(b['cps']):,}자)")
    common_path = sum(b["size"] for b in built if b["name"] in ("pretendard-core", "pretendard-ko"))
    print(f"한국어 화면 상시 경로: {common_path:,} B  ({common_path / orig * 100:.0f}% of 원본)")
    print(f"CSS 갱신: {css_path}")


if __name__ == "__main__":
    main()
