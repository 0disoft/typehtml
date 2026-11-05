# 구현 에이전트 전달문

첫 질문은 “Doctor를 만들 수 있는가”보다 “기존 도구와 작은 스크립트로 끝낼 수 있는가”다. [결정](01_DECISION_AND_SCOPE.ko.md), [비교 계획](09_DELIVERY_AND_EXPERIMENTS.ko.md), [기계 판독 계획](../experiments/p0-plan.json)을 읽고 P0a부터 수행한다. 이 ZIP은 설계·참고 예제이며 제품 SDK는 없다.

## 먼저 실제 도입 대상부터 확인한다

사용자가 지정한 저장소에서 기존 언어·schema·패키지 관리자·lockfile·라우터·입력 helper·검사 명령을 읽는다. 쓰기 폼 제출 경로를 정해진 순서로 최대 10개 기록한다. 동적 폼·파일·multipart·중첩 schema·변환 규칙을 숨기지 않는다. 실제 프로젝트 접근이 없으면 이 조사를 합성 예제로 대체한 뒤 실측이라고 쓰지 말고 미실행으로 남긴다.

지원되는 실제 경로가 없으면 P0를 멈추고 원인을 보고한다. JSON Schema 정본 또는 의미가 확인된 정적 투영이 필요하다. 기존 Zod/TypeBox를 수작업 JSON으로 중복 작성하지 않는다. 사용자가 쓰던 framework action이나 typed form helper를 약한 수제 코드로 바꿔 비교하지 않는다.

## 한 경로에서 네 구성을 비교한다

동일 baseline에 B, L, S, D 구성만 바꾼다. B는 기존 타입·validator·wrapper/helper, L은 여기에 기존 폼 린터, S는 L과 작은 schema 연결 스크립트, D는 L과 최소 Doctor다. 별도 앱·별도 DB를 네 개 만들지 않는다. S에도 같은 표준 parser·schema·metadata를 허용한다.

필수 입력 누락, submitter의 오래된 경로, 제한된 정수 제약 어긋남을 우선 비교한다. N1 tsc 누락 역할, N2 정상 projector, N3 기존 lint 오류는 대조군이다. 일반 접근성 엔진과 tsc를 재구현하지 않는다. 정상·unknown·unsupported 대조군은 계획에 있는 좁은 경우만 사용한다.

Doctor의 검사 입력은 [폼용 파생 데이터](../examples/form-check.generated.json)처럼 필요한 정보만 받게 한다. 전체 runtime contract·DB·세션·intent 작성은 정적 검사의 선행 조건이 아니다. 파생물은 생성 스크립트로 만들고 hash를 검사한다. 원본 코드·schema exporter·config JS를 읽기 전용 검사 중 임의 실행하지 않는다.

결과에는 원래 엔진·규칙·원인·단계·위치를 기록한다. `NOT_RUN`을 미탐으로 처리하지 않는다. 같은 결함의 메시지 중복을 제거하고, B·L·S가 이미 잡은 오류의 Doctor 추가 공로는 0으로 기록한다. 비교 결과는 [빈 결과 양식](../experiments/results.template.json)의 복사본에만 채운다.

## 다음 단계 선택

| 결과 | 행동 |
| --- | --- |
| 기존 lint·작은 스크립트로 충분 | 그 설정·스크립트와 사용법을 전달하고 Doctor 확장 종료 |
| Doctor의 국소 추가 발견 | 다른 실제 경로에서 해당 규칙 하나만 확인 |
| 같은 발견, 적은 유지비 | 편의 도구로만 평가하고 비용 근거를 보고 |
| 래퍼만 별도 가치 있음 | 기존 helper와 변경 비용을 비교한 뒤 래퍼만 유지 |
| 입력 범위가 실제 폼과 불일치 | 조사 결과를 전달하고 임의로 framework·DB 지원을 늘리지 않음 |

## P1을 선택한 경우만 실행할 범위

Hono의 읽기 전용 시작 GET·CSRF 보호 begin POST·안정 intent GET·초안 POST·영수증 GET을 연결하고 [05 응답](05_HTML_FORMS_AND_RESPONSES.ko.md), [06 요청 순서](06_RUNTIME_SECURITY.ko.md), [07 DB](07_SQLITE_IDEMPOTENCY.ko.md)를 구현한다. 기존 인증 시스템을 사용하고 실제 revision 조건·영향 행·intent/초안/감사 원자성을 확인한다. 실제 결제·메일·재고 예약은 추가하지 않는다.

Bun SQLite의 load·authorize·execute·project는 동기 계약을 유지한다. PostgreSQL 지원을 핑계로 모든 역할을 `T | Promise<T>`로 넓히지 않는다. 비동기 어댑터는 [10 이식 경로](10_ARCHITECTURE_AND_TOOLCHAIN.ko.md)의 별도 profile이며 현재 미지원이다.

## 전달물과 검증 범위

현재 단계의 [수용 기준](14_ACCEPTANCE_AND_EVIDENCE.ko.md)만 수행한다. 수동 연결 수·전체 artifact·추가 발견·발견 시점·오탐·unknown·도구 미실행을 나눠 보고한다. 구현 시간은 실제 기록한 경우에만 적고, 최신 의존 버전은 사용한 lockfile·버전 출력과 함께 남긴다.

사용자가 요청한 저장소 범위 밖에 접근하거나 배포·DB·GitHub Actions를 변경하지 않는다. 문서 수정만 요청된 경우 이 전달문 자체가 제품 구현·푸시 승인이 되지 않는다. 서버 생성기·새 언어·다중 DB는 별도 필요와 승인 없이 시작하지 않는다.


## v0.5에서 구현자가 놓치면 안 되는 연결

폼은 action 값으로 발견하지 말고 선언된 form ID에 결합한다. 하나의 DOM query로 모든 name을 모아 객체화하는 구현은 피한다. form owner와 submitter를 해석한 entry list에 중복·미등록 규칙을 적용한다. 지원하지 않는 control은 해당 규칙을 unsupported로 남기고 전체 결과의 알려진 오류를 지우지 않는다.

참고 wire 함수와 digest 규약은 작은 경계 로직만 제공한다. HTTP·auth·runtime 구현으로 착각하지 않는다. 값의 유효성 검사를 renderer 값으로 대체하지 말고, 의미 digest·발급 revision·scope·expiry를 실제 transaction 안에서 다시 읽는다.

DB 초안에 intent_id UNIQUE를 두고 결과와 초안의 연결을 확인한다. BEGIN의 BUSY 재시도와 COMMIT 복구를 분리하며 async 대기 전에 transaction이 끝났는지 확인한다. GET에는 업무 intent 발급을 넣지 않는다. P0만 수행하는 요청에서 이 DB 구현까지 자동 시작하지 않는다.

완료 재응답과 422 직전에는 fresh read snapshot으로 상태를 확인한다. 최초 쓰기만 read를 종료하고 IMMEDIATE로 다시 읽는다. consumed인데 결과가 없는 상태를 만료나 OPEN으로 바꾸지 말고 500과 운영 진단으로 분리한다. 정상 정리는 이 자료를 삭제하지 않는다.

resolvePage union의 네 결과를 처리하고, 동기 역할의 결과를 즉시 assertSynchronous로 검사한다. 타입 projector가 내부 필드를 자동 제거한다고 가정하지 않는다. 서버 경로 canonical 검사와 정본 JSON 중복 키 거부도 일관되게 적용한다. 이 작업들은 P1을 선택한 경우에만 수행하며 첫 Doctor 비교의 선행 조건으로 옮기지 않는다.
