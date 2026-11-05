# 표시한 revision과 완료한 intent를 DB에서 함께 지킨다

첫 runtime profile은 Bun SQLite·동일 호스트·단일 DB·동기 업무 transaction이다. 검사 전용 도입에는 필요 없다. 실제 프로젝트와 P0가 래퍼 도입을 정당화한 경우에만 이 어댑터를 구현한다.

## 운영 연결과 비용

`new Database(path, { strict: true })`로 빠진 바인딩을 NULL로 넘기지 않는다. 연결마다 foreign_keys=ON, journal_mode=WAL, synchronous=FULL, busy_timeout=0을 설정하고 실제 반환값을 읽어 확인한다. SQLite STRICT 테이블과 Bun strict binding은 서로 다른 기능이다. FULL은 이 profile의 성공 응답 내구성 선택이며 전원 장애·하드웨어·백업 복구를 검증했다는 뜻은 없다. [R11](13_SOURCES.ko.md#r11) [R09](13_SOURCES.ko.md#r09) [R10](13_SOURCES.ko.md#r10)

운영에는 공식 WAL 수정이 반영된 배포를 사용하고 Bun이 링크한 sqlite_version·source ID·설정을 기록한다. WAL은 여러 호스트가 같은 파일을 공유하는 설계를 지원하지 않는다. Python 메모리 SQL 확인을 운영 적합성으로 대체하지 않는다. [R09](13_SOURCES.ko.md#r09)

| 작업 | 구현 부담이 발생하는 지점 |
| --- | --- |
| 저장소 연결·migration | 기존 데이터 유지, 제약 추가, settings read-back |
| intent 발급·종료 | 명시적 POST, 현재 권한, 발급 한도, revision·digest 저장 |
| 업무 쓰기 | 현재 회원·상품 정책, SQL CAS, Grant 수명, 완료 원자성 |
| 재시도·복구 | 잠금과 commit 실패 구분, 재조회, 연결 폐기 정책 |
| 운영 | 백업·복구·WAL 상태·정리, 단일 호스트 자원 |

시간·금액 견적은 아직 없다. 범용 DB abstraction, 다중 호스트, PostgreSQL 구현을 여기서 시작하지 않는다. 이식 설계는 [10번](10_ARCHITECTURE_AND_TOOLCHAIN.ko.md)에 남긴다.

## 발급할 때 revision을 저장한다

begin POST는 현재 membership·product·policy를 쓰기 transaction 안에서 확인한 뒤 `form_intents.resource_revision`과 `behavior_hash`를 저장한다. prepareIntent 역할이 현재 상품과 발급 정책을 확인하고, 같은 transaction의 coordinator가 발급을 수행한다. 읽기 페이지 resolver가 발급 권한과 저장을 겸하지 않는다.

발급 이후 GET은 저장된 revision과 현재 상품 revision이 같은 경우에만 가격을 보여주고 제출 form을 만든다. 가격·통화·판매 상태에 영향을 주는 변경은 상품 revision을 증가시켜야 한다. 모든 상품 writer가 이를 지키는 것은 앱의 신뢰 책임이다.

POST에서 현재 revision과 발급 revision이 다르면 `QUOTE_CHANGED` 409다. 가격이 바뀐 상태로 초안을 조용히 만들지 않는다. 오래된 intent의 revision을 덮어쓰지 않고 사용자의 명시적 시작 POST로 새 intent를 발급한다. 이번 예제는 결제·재고 예약을 수행하지 않지만 표시값과 작성 결과의 불일치는 처리한다.

## 단계가 끝나기 전 Grant를 재사용하지 못한다

Grant는 요청·transaction identity·principal·tenant·action·input hash·resource ID·issued revision에 연결한다. 앱이 만든 객체나 다른 요청에서 받은 객체는 거절한다. 내부 registry에서 grant를 기록하고 writer 사용 시 scope를 확인하며 한 번 사용한 grant는 소비한다. transaction 종료 시 모두 폐기한다. timeout·예외의 종료 경로도 포함한다.

타입 brand는 런타임 권한을 대신하지 않는다. input·principal·resource의 flat 값을 검증 뒤 변경하지 않도록 보관하고, grant 검사 다음에 다른 객체를 writer에 넘기는 일이 없게 한다. 임의 callback의 부수효과를 타입만으로 증명하지는 않는다.

## 실제 SQL 조건과 원자성

[INSERT SELECT](../reference/insert-draft-cas.sql)는 intent scope·미소비·만료·behavior hash·발급 revision·현재 membership·상품 상태를 조건에 넣는다. `changes()=1`이어야 성공이다. 사전 분류 뒤에도 0행이면 409로 되돌린다. 앱은 계산 전 safe integer 범위를 확인하고 SQL CHECK를 추가 방어로 둔다.

같은 transaction 안에서 초안 생성, intent의 consumed_at 설정, action_results, 성공 감사가 함께 commit된다. consumed_at UPDATE도 `IS NULL`과 현재 scope를 조건에 넣고 한 행을 확인한다. 공개 투영·schema·Location 검사는 commit 전에 끝낸다. HTML 렌더와 네트워크 송신은 잠금 밖이다.

초안의 `intent_id UNIQUE`는 실제 업무 기록의 중복을 제한한다. 결과 표의 PK만 믿지 않는다. 결과의 `(draft_id,intent_id)` FK는 다른 intent의 영수증을 잘못 연결하지 못하게 한다. 초안 intent_id는 임시 intent 표로 FK를 걸지 않아 임시 자료를 정리해도 업무 기록은 남는다. 이 논리적 연결은 deliberate retention 정책이며 모든 우회 SQL을 막는 장치가 아니다.

결과 표에는 공개 JSON 사본을 저장하지 않는다. 영수증 ID와 입력·behavior hash, 완료·보존 시각만 저장한다. 초안의 금액은 작성 시 기록으로 남기고 재응답 시 현재 권한을 확인해 projection을 다시 만든다. 내부 값 노출과 불필요한 이중 데이터를 줄인다.

## intent 상태와 만료

| 상태 | 초안 POST 처리 |
| --- | --- |
| ID 없음·scope 불일치 | 410 또는 동일한 외부 일반 안내, 자동 신규 발급 없음 |
| OPEN, 현재 digest·revision·시간 유효 | 입력을 검사하고 최초 완료 진행 |
| OPEN, 값 오류 | 422, 동일 intent로 수정 가능 |
| OPEN, digest 변경 | CONTRACT_CHANGED 409, 새 form 명시적 시작 |
| OPEN, 표시한 revision 변경 | QUOTE_CHANGED 409, 자동 재가격 반영 없음 |
| COMMITTED, 같은 digest·입력 | 현재 영수증 권한 확인 뒤 기존 303 |
| COMMITTED, 다른 digest·입력·형식 | 409, execute 재호출 없음 |
| 완료 결과의 보존 종료 | 410, OPEN으로 되돌리지 않음 |
| 소비한 intent에 결과·업무 참조가 없거나 모순 | 500, 운영 경보와 증거 보존, 재실행 없음 |

모든 비교는 `now >= expires_at`에서 만료다. OPEN은 발급부터 86,400초, 결과는 commit부터 86,400초다. 성공한 결과가 남아 있으면 open 만료 시각보다 결과 보존 시각을 우선한다. TTL 수치는 설계값이며 실험 결과가 아니다.

[정리 SQL](../reference/cleanup-intents.sql)은 일관된 정상 만료 기록만 최대 100개씩 지운다. 소비했는데 결과가 없는 기록, OPEN인데 이미 업무가 있는 기록, 결과의 hash·시각·scope가 맞지 않는 기록은 삭제하지 않는다. [상태 점검 SQL](../reference/audit-intent-consistency.sql)로 분리 보고한다. 결과가 유효하면 intent도 보존하고, 임시 기록이 없어졌어도 기존 초안은 남는다. 모르는 intent를 POST가 다시 발급하지 않으며 ID는 재사용하지 않는다. 감사·초안의 법정 보존 기간은 서비스 정책에서 별도로 정한다.

## 잠금과 commit 오류

BEGIN IMMEDIATE의 BUSY일 때만 callback 시작 전 비동기 대기로 재시도한다. 총 획득 예산 5,000ms, 대기 최대 50ms, 503의 Retry-After 1초를 사용한다. 같은 connection은 한 transaction만 소유하며 열린 transaction을 둔 채 await하지 않는다. [R08](13_SOURCES.ko.md#r08)

callback 도중 실패하면 rollback한다. COMMIT의 BUSY는 BEGIN 실패와 다르며 transaction이 살아 있을 수 있다. 이 profile은 명시적 rollback 상태를 확인하고 503을 반환하는 쪽으로 단순화한다. 같은 callback을 내부에서 자동 반복하지 않는다. 드라이버가 자동 rollback했는지도 확인한다. [R08](13_SOURCES.ko.md#r08)

IO 오류·디스크 오류·commit 상태 불명은 일반 lock retry로 처리하지 않는다. 해당 connection을 정리하거나 격리하고 새 connection으로 intent 결과를 읽는다. 완료가 확인되면 현재 권한으로 재응답하고, 상태를 확정하지 못하면 503 또는 500과 같은 intent 유지 안내를 준다. 새 키 발급·execute 재실행으로 불확실성을 숨기지 않는다.

동기 callback의 장시간 실행을 안전하게 강제 취소할 수 있다고 약속하지 않는다. 내부 작업은 짧은 DB 조회·정책·쓰기·projection만 허용하며 외부 결제·메일·LLM·파일 I/O는 제외한다. 다른 저장소와의 원자성이나 외부 세션 취소의 선형화 보장은 이 profile 밖이다.

## 읽기 재응답과 불일치 복구

GET·완료 POST·422 직전 확인은 짧은 읽기 transaction에서 intent·업무·결과·현재 권한을 함께 본다. 재응답은 쓰지 않으므로 BEGIN IMMEDIATE를 사용하지 않는다. OPEN을 읽고 쓰기로 진행할 때는 기존 read transaction을 닫은 다음 새 IMMEDIATE transaction에서 다시 읽는다. 오래된 snapshot을 write로 승격하지 않는다. [R41](13_SOURCES.ko.md#r41)

consumed_at·completed_at이 다르거나 결과 참조가 빠진 상태는 정상 만료가 아니다. 자동 정리나 fallback이 이를 OPEN으로 복구하지 않는다. 일반 사용자에게는 generic 500, 내부에는 추적 가능한 진단을 남긴다. 수동 복구는 보존한 업무 기록과 현재 상태를 조사한 별도 운영 작업이다.

이 profile의 intent·업무·결과 쓰기에는 INSERT OR REPLACE나 기존 완료 결과를 덮는 UPSERT를 쓰지 않는다. SQLite REPLACE는 충돌 행을 삭제할 수 있다. 유일성 충돌을 성공으로 숨기지 않고 transaction을 종료한 뒤 기존 결과와 불변식을 확인한다. [R42](13_SOURCES.ko.md#r42)

## 현재 증거의 한계

한 메모리 연결에서는 업무 제약·rollback·정상 만료·불일치 자료 보존을 확인한다. 별도의 작은 Python 두 연결 WAL 실험은 읽기 snapshot의 유지, 다른 연결 commit 후 새 snapshot의 상태, 읽기와 writer 예약의 차이만 관찰한다. Bun wrapper·동시 HTTP·처리량·전원 장애·백업 복구는 실행하지 않았다. 설치된 오래된 SQLite의 국소 실험을 배포 적합성으로 표시하지 않는다. [검증 기록](../validation/REPORT.ko.md)
