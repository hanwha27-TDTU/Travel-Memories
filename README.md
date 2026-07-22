# 🧳 Travel-Memories · 여행 추억

나의 여행 추억을 **사진 · 지도 · 별점 · 태그**와 함께 기록하는 웹 앱입니다.
서버 없이 브라우저에서 동작하고, **GitHub Pages로 무료 배포**할 수 있어요.

## ✨ 기능

- 🗓️ **타임라인** — 날짜순으로 여행 기록을 카드로 보기
- 📷 **사진** — 여러 장 첨부, 갤러리로 보기
- 🗺️ **지도** — 방문한 장소를 지도에 핀으로 표시 (Leaflet + OpenStreetMap)
- ⭐ **별점 · 태그** — 만족도 별점과 `#태그`로 분류·검색
- 🔍 **검색/필터** — 제목·장소·메모·태그로 즉시 검색
- 💾 **오프라인 저장** — IndexedDB에 기기 안에 저장 (인터넷 없어도 기록 가능)

## 🏗️ 기술 구성

| 영역 | 사용 기술 |
|------|-----------|
| 프론트엔드 | 순수 HTML / CSS / JavaScript (프레임워크 없음) |
| 로컬 저장 | IndexedDB (사진은 Blob으로 저장) |
| 지도 | Leaflet + OpenStreetMap (API 키 불필요) |
| 호스팅 | GitHub Pages |

데이터 모델은 향후 **기기 간 동기화(Supabase)**를 얹기 쉽도록
모든 레코드에 UUID · 수정시각(`updatedAt`) · 소프트삭제 플래그를 갖도록 설계했습니다.

## 🚀 실행 방법

### 로컬에서 보기
```bash
# 저장소 폴더에서
python3 -m http.server 8000
# 브라우저에서 http://localhost:8000 접속
```
> IndexedDB는 `file://`에서 제한이 있어 로컬 서버로 여는 것을 권장합니다.

### GitHub Pages로 배포하기
1. 이 저장소를 GitHub에 푸시
2. **Settings → Pages → Source**를 `main`(또는 배포 브랜치) / `/root`로 설정
3. 잠시 후 `https://<사용자명>.github.io/Travel-Memories/` 에서 공개

## 📁 폴더 구조

```
Travel-Memories/
├── index.html      # 앱 화면 구조
├── css/styles.css  # 스타일 (라이트/다크 모드 지원)
├── js/
│   ├── db.js       # IndexedDB 데이터 계층 (CRUD, 사진, 내보내기)
│   └── app.js      # UI 로직 (타임라인, 지도, 폼, 상세)
└── README.md
```

## 🗺️ 로드맵

- [x] 1단계: 오프라인 MVP (IndexedDB)
- [ ] 2단계: Supabase 로그인 + 기기 간 동기화 (태블릿 · 모바일 · PC)
- [ ] 사진 여러 장 라이트박스 보기
- [ ] 여행별 그룹핑 / 지도 클러스터링
