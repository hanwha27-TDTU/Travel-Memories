# 소비 앱 프로필

`consumers/*.json`은 공통 스킬과 앱별 프로필의 접점을 기록한다. 프로젝트 정본을 복사하지 않고 경로와 필요한 capability만 둔다.

필수 필드:

- `schemaVersion`: 현재 `1`
- `project`: 소비 앱 안정 식별자
- `repository`: HTTPS GitHub 정본
- `skills[]`: 공통 skill별 호환성 선언
  - `name`: `shared-skills.json`의 skill 이름
  - `profilePaths`: 소비 앱 안의 실제 프로필·계약 경로 하나 이상
  - `requiredCapabilities`: 공통 skill이 제공해야 하는 capability 하나 이상
  - `exceptions`: 공통 기본보다 엄격하거나 다른 구현을 쓰는 경우에만 추가
    - `scope`, `projectRule`, `reason`을 모두 쓴다.

호환성 원장은 현재 소스와의 의미 호환을 나타낸다. 어느 공통 커밋을 실제로 채택했는지는 소비 앱의 vendor lock이 정본이다.
