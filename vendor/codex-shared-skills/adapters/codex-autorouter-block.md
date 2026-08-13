<!-- BG_CODEX_AUTOROUTER_START -->
# BG Codex AutoRouter 공통 정책

`C:\AppDevelopment\` 아래 소프트웨어 개발 작업에는 전역 `bg-codex-autorouter`를 적용한다.
게이트·CI·버전·산출물·PR·머지·배포 작업에는 `release-harness-governance`도 함께 적용한다.

전역 설치본은 파생물이다. 두 스킬의 유일한 정본은
`https://github.com/hanwha27-TDTU/Codex-Shared-Skills`이며 프로젝트 `AGENTS.md`와 저장소 스킬이 더 엄격하면 그것이 우선한다.

모든 코드·보안·저장소·아키텍처·데이터·동기화·배포 감사에는 **벽시계 30분 상한**을 적용한다.
30분을 넘거나 종료 시점을 확정할 수 없는 감사는 시작 전에 최대 30분 구간으로 나눠 제안하고 첫 구간만 승인받는다.
각 구간 종료 시 실행을 멈추고 확인된 사실·미검증 후보·산출물·다음 구간을 보고하며, 사용자의 새 명시적 승인 없이는 다음 구간을 시작하거나 자동 재개하지 않는다.
30분 안에 안전하게 중단할 수 없는 감사 도구·모드와 완료 시점을 모르는 무기한 감사는 금지한다. 지속 목표나 `finish`·`do not stop` 지시는 다음 구간 승인으로 간주하지 않는다.

최종 보고에는 `AutoRouter: <실제 사용 경로> — <짧은 이유>`를 남기고 숨은 추론은 공개하지 않는다.
<!-- BG_CODEX_AUTOROUTER_END -->
