# Boundary Contracts 설계도 v0.5

HTML 폼과 서버 경계의 타입 안전 계약을 연결한다. 초기 제품 후보는 읽기 전용 폼 검사기와 선택적인 typed wrapper다. v0.5는 완료·실패·만료·재시도의 처리 규칙을 하나로 맞추고, v0.4에서 재현한 참고 타입·SQL·계약·증거 연결 결함을 수정했다.

다음 개발은 여전히 P0다. 기존 타입 검사·폼 린터·작은 스크립트보다 어떤 추가 가치를 주는지 먼저 비교한다. 선택적인 DB runtime을 먼저 완성하거나 새로운 언어를 도입할 필요는 없다.

## 읽는 순서

| 목적 | 문서 |
| --- | --- |
| 개정 내용과 마이그레이션 | [개정 요약](REVISION_SUMMARY.ko.md), [변경 안내](MIGRATION.ko.md) |
| 범위와 가장 작은 다음 구현 | [01 범위](docs/01_DECISION_AND_SCOPE.ko.md), [09 P0](docs/09_DELIVERY_AND_EXPERIMENTS.ko.md), [12 전달문](docs/12_IMPLEMENTER_HANDOFF.ko.md) |
| 폼과 진단 | [05 HTML](docs/05_HTML_FORMS_AND_RESPONSES.ko.md), [08 Doctor](docs/08_DOCTOR_AND_DIAGNOSTICS.ko.md) |
| 계약·타입·실행 | [03 정본](docs/03_CONTRACT_AND_SINGLE_SOURCE.ko.md), [04 역할](docs/04_BINDING_TYPES.ko.md), [06 runtime](docs/06_RUNTIME_SECURITY.ko.md), [07 저장](docs/07_SQLITE_IDEMPOTENCY.ko.md) |
| 주문 한 건의 흐름 | [15 실행 예](docs/15_ORDER_WALKTHROUGH.ko.md) |
| 실제 실행 증거와 한계 | [검증 보고서](validation/REPORT.ko.md), [자체 검토](evidence/self-review.json), [이전 결함 재현](evidence/v04-reproductions.json) |

## 파일을 읽는 기준

`examples/order.boundary.json`만 계약의 수동 정본이다. TypeScript 모델·두 폼 검사 projection·digest는 재생성한다. `reference`의 상태·URL·입력 함수와 SQL은 실행 가능한 작은 참고 자료다. 인증·HTTP coordinator·Doctor·renderer·Bun 어댑터 제품은 들어 있지 않다.

핵심 문서는 15개다. 문서 버전은 0.5이고 미출시 제품 목표는 0.1이다. 실제 폼 조사와 P0 44개 결과 슬롯은 미실행 상태다. 이전에 차단된 브라우저 관찰은 역사 기록으로 보존했으며 이번 개정에서는 다시 시도하지 않았다.
