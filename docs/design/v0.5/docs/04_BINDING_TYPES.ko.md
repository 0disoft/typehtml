# 함수 타입과 상태 판정을 함께 연결한다

[BindingRoleMap](../reference/binding-roles.ts)은 주문 예제의 역할 시그니처다. [order-bindings](../reference/order-bindings.ts)는 앱 포트를 조립한다. 정본에서 Input·PublicOutput·PageView를 파생하고, 실제 앱의 Principal·Resource·Result·Tx를 사용한다. 범용 SDK를 구현했다고 표시하지 않는다.

## 역할별 계약

| 역할 | 결과 | 실행 경계 |
| --- | --- | --- |
| principal | Promise의 검증된 Principal | DB 쓰기 밖 |
| prepareIntent | SyncResult의 Resource 또는 null | begin POST 동기 트랜잭션 |
| load·authorize·execute·project | 동기 Resource·Decision·Result·PublicOutput | 최초 쓰기 트랜잭션 |
| loadReceipt·authorizeReceipt·projectReceipt | 동기 Receipt·Decision·PublicOutput | 현재 권한을 포함한 하나의 읽기 스냅샷 |
| resolvePage | Promise의 PageResolution | 짧은 읽기 스냅샷으로 조회 후 종료 |
| renderStart·renderForm·renderReceipt | 이스케이프한 HTML 문자열 | 모든 DB 잠금 밖 |

## object라는 반환 타입은 동기성을 보장하지 않는다

v0.4에서는 Result를 넓은 `object`로 선택하면 async execute가 타입 검사를 통과했다. [기존 코드 재현](../evidence/v04-reproductions.json)에 실제 compiler exit 0과 소스를 남겼다. TypeScript의 구조적 호환성은 필요한 속성을 비교하며, 동기 실행이나 데이터 투영을 자동 수행하지 않는다. [R43](13_SOURCES.ko.md#r43)

v0.5는 동기 역할의 결과를 `SyncResult<T>`로 제한해 `then` 속성을 배제한다. 런타임 coordinator도 각 동기 역할 호출 직후 [assertSynchronous](../reference/sync-result.ts)를 적용하고 실패 시 같은 트랜잭션을 rollback해야 한다. cast·JavaScript 호출·잘못된 외부 라이브러리는 타입 경계를 통과할 수 있으므로 타입 검사만 두지 않는다. 반환 객체의 getter를 실행해서 then을 읽지 않고 속성 존재로 거부한다.

이 검사는 이미 시작한 비동기 외부 부수효과를 취소하지 않는다. callback 내부 외부 I/O 금지와 신뢰 코드 검토를 유지한다. Bun SQLite의 transaction은 동기 callback에 맞춰 사용해야 한다. [R11](13_SOURCES.ko.md#r11)

`draft => draft`는 내부 필드가 추가된 객체를 공개 반환 타입으로 내보내도 TypeScript에서 허용된다. 이를 의도적인 정상 컴파일 반례로 남겼다. 실제 공개 경계에서는 명시적 projector와 `additionalProperties=false`인 출력 schema 검증이 필요하다. callback의 반환 타입을 비공개 필드 제거 기능으로 설명하지 않는다.

## 페이지 조회는 view와 실패를 구별한다

v0.4의 `loadPage(): Promise<PageView | null>`은 완료된 intent의 303, 만료 410, 충돌 409를 표현하지 못했다. 이를 `resolvePage(): Promise<PageResolution<PageView, PublicOutput>>`로 바꾼다.

| kind | 의미 | wrapper가 만드는 응답 |
| --- | --- | --- |
| start | 상품 안내와 시작 폼 | 200, renderStart |
| form | 현재 OPEN intent와 표시 가능한 view | 200, renderForm |
| receipt | 현재 권한으로 투영한 완료 영수증 | 검증된 고정 경로로 303 |
| failure | 분류된 부재·충돌·만료·내부 불일치 | 고정 오류 HTML과 404·409·410·500 |

PageTarget은 productId와 intentId를 구별한다. query는 둘 중 정확히 하나이고 중복·혼합 키는 400이다. resolvePage는 현재 principal·tenant·회원·객체 권한과 intent scope를 한 읽기 스냅샷에서 확인하고 [공통 판정](../reference/intent-decisions.ts)에 연결한다. 임의 HTTP Response나 redirect 문자열을 반환하지 않는다. wrapper는 variant별 payload schema와 target 일치도 확인한다.

이 포트의 DB 읽기와 정책은 앱의 신뢰 코드다. union 타입이 그 내부 구현을 증명하지 않는다. 실제 SQLite coordinator는 P1에서 구현한다. GET에서는 업무 intent를 발급하지 않고, 시작 POST만 prepareIntent의 현재 발급 권한과 Resource revision을 확인해 저장한다.

## Grant·revision·트랜잭션

Grant는 요청·transaction identity·principal·tenant·action·input hash·resource ID·발급 revision에 묶인다. 런타임 registry의 identity와 한 번 사용 규칙을 검사하고 transaction 종료 시 폐기한다. 타입 brand나 cast로 권한을 만들지 않는다. 실제 writer는 CAS 조건과 영향 행 1개를 확인한다. [07](07_SQLITE_IDEMPOTENCY.ko.md)

async 인증은 쓰기 트랜잭션 전에 마친다. 최종 DB 권한·revision은 쓰기 안에서 확인한다. 읽기 응답은 읽기 스냅샷에서 일관성을 확인한 뒤 복사한 공개 데이터만 잠금 밖으로 가져간다. 쓰기 후보를 읽기 transaction에서 승격하지 않고, 읽기를 종료한 뒤 새 IMMEDIATE transaction에서 다시 판정한다. [R41](13_SOURCES.ko.md#r41)

## 타입 진단과 실제 범위

직접 작성한 역할의 오류 위치는 tsc 원본 위치를 유지한다. 파생 타입 오류에는 source hash·JSON Pointer를 연결하고, 역매핑이 없으면 생성 파일 위치를 숨기지 않는다. 구문만 읽었으면 bindingTypeStatus는 not-checked다.

[타입 참고 사례](../reference/type-rejection-cases.ts)는 기존 6개 거부에 넓은 Result의 async 반환, 넓은 Output의 async 반환, 분류 없는 페이지 반환을 추가했다. 공개 projector의 넓은 객체 반환은 통과하는 반례로 구분한다. 실제 compiler 버전과 실행 결과는 [검증 보고서](../validation/REPORT.ko.md)에 있다.

후속 PostgreSQL은 별도 async-sql 역할과 coordinator를 갖는다. 현재 타입을 `T | Promise<T>`로 넓히지 않는다. Grant.operation과 PageTarget은 주문 예제에 맞춘 값이며 지금 범용화하지 않는다. 검사-only 사용자는 이 타입과 DB 포트를 도입할 필요가 없다.

transaction이 닫히면 해당 Tx 핸들의 활성 토큰을 무효화한다. 지연된 continuation이 예전 핸들로 DB를 호출하면 어댑터가 거부해야 한다. 이 조치는 외부 네트워크 같은 이미 시작한 부수효과를 취소하지 않으며, 참고 타입만으로 구현됐다고 표시하지 않는다.

