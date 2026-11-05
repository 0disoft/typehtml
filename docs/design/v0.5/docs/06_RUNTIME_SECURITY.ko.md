# 요청 처리 규칙을 실행 가능한 순서로 제한한다

v0.1 신뢰 모델은 등록된 경계를 통과한 요청의 처리 순서, 입력 허용 목록, 현재 객체 권한 호출, 원자적 변경, 공개 투영이다. OriginSet·Audience 대수는 계약에서 제거해 [후속 연구](../research/01_INFORMATION_FLOW.ko.md)로 옮겼다. callback 내부의 의미까지 검증한다는 표현도 제거했다.

## 신뢰하는 코드와 책임

| 신뢰 코드 | 남아 있는 책임 |
| --- | --- |
| 인증·세션 포트 | 실제 세션 검증, 취소·만료, 요청자·조직 결정 |
| load·authorize | 조직 범위 조회, 현재 구성원 자격, 실제 업무 정책 |
| execute·SQLite 어댑터 | CAS, 금액 범위, 원자성, 정확한 SQL |
| projector·renderer | 공개 값의 의미, HTML 문맥 인코딩 |
| wrapper·배포 설정 | 순서 실행, 올바른 Origin, 필수 hooks 연결 |
| doctor | 발견 범위·미분석 영역의 정직한 표시 |

인증된 principal과 객체 권한은 분리한다. 서버에서 읽은 문자열도 출력 문맥에 맞게 처리한다. 요청이 다른 route나 DB 직접 호출로 우회하면 이 래퍼의 처리 순서를 보장할 수 없다. 권한은 요청별로 확인하고 누락을 기본 허용으로 해석하지 않는다. [R02](13_SOURCES.ko.md#r02)

## 초안 쓰기 요청의 순서

| 단계 | 수행 작업 | 실패 처리 |
| --- | --- | --- |
| 1 | method·Content-Type·Accept·Content-Encoding·본문 한도·IP 제한 | 405·415·406·413·429 |
| 2 | Origin·Referer·Fetch Metadata, 인증·세션 | 403·401 |
| 3 | 한 번의 제한된 stream 읽기, entry·중복·길이·위험 키 | 413·400 |
| 4 | CSRF·intent 키 분리, 세션 토큰 비교, principal 제한 | 400·403·429 |
| 5 | scoped intent·결과·업무 참조·현재 권한을 한 읽기 snapshot으로 조회 | 404·410·500 |
| 6 | 공통 상태 판정 후 필요한 경우에만 업무 입력 codec·schema·hash | 409, OPEN 입력 오류 후보 422 |
| 7 | 완료 재응답·오류는 새 읽기 snapshot에서 상태를 최종 확인 | 303·404·409·410·500 또는 422 |
| 8 | 최초 쓰기 후보만 읽기 종료 후 BEGIN IMMEDIATE, 현재 상태·시간 재판정 | 503 또는 현재 상태에 맞는 분기 |
| 9 | OPEN의 현재 상품·발급 revision·정책·Grant·CAS | 404·409 또는 rollback |
| 10 | 공개 투영·schema·Location, 소비·결과 참조·감사, commit | 오류 분류와 rollback/복구 |
| 11 | 잠금 밖에서 응답, 유실이면 같은 intent로 복구 | 새 intent 자동 발급 금지 |

완료 재응답을 위해 writer lock을 획득하지 않는다. 현재 receipt 권한과 결과를 같은 짧은 read transaction에서 읽는다. 쓰기 후보는 그 snapshot을 닫고 새 IMMEDIATE transaction에서 모든 변경 관련 조건을 다시 확인한다. 한 요청 안에서 멀리 떨어진 SELECT들을 같은 시점의 상태로 취급하지 않는다. SQLite의 read snapshot과 writer 예약은 서로 다르다. [R41](13_SOURCES.ko.md#r41)

## 상태 판정의 우선순위

[순수 참고 판정 함수](../reference/intent-decisions.ts)는 HTTP 인증·CSRF·DB 구현을 포함하지 않는다. 이미 인증하고 scope를 제한해 얻은 하나의 snapshot과 입력 검사 상태를 받아 분기만 선택한다. `write-candidate`도 실행 허가증이 아니며 writer 안의 현재 정책·Grant·CAS를 요구한다.

| 현재 상태 | 판정 순서 |
| --- | --- |
| scoped intent 없음 | 410, 자동 신규 발급 없음 |
| 현재 객체 권한 없음 | 404, 내부 상태·계약 차이를 먼저 노출하지 않음 |
| intent·업무·결과 연결 불일치 | 500과 내부 경보, 자료 보존 |
| OPEN | expiry → behavior digest → 표시 revision → view 또는 입력 검사 |
| COMMITTED | result expiry → GET 영수증 또는 POST digest·입력 hash 비교 |

유효 완료 결과가 남아 있으면 OPEN 만료 시각과 이후 상품 가격 변경은 완료 영수증을 무효화하지 않는다. 완료 POST의 입력 오류는 409이며 수정 가능한 422 화면을 만들지 않는다. HTTP/CSRF/body 구조 오류는 이 상태 판정 전에 거절될 수 있다.

422를 만들기 직전에 새 읽기 snapshot으로 다시 확인한다. 그 사이 다른 탭이 완료했다면 잘못된 입력 요청은 409로 바꾸고 제출 가능한 폼과 raw echo를 보내지 않는다. 권한 소멸은 404, 시간 경계는 410, 계약·가격 변경은 409다. 입력을 검증하기 전에는 unchecked, 검증 후에는 valid hash 또는 invalid를 명시해 분기한다. GET 완료 intent는 현재 영수증 권한이 있으면 계약 digest가 바뀌어도 현재 영수증 경로로 이동한다.

이 판정의 시점은 짧은 로컬 DB snapshot이다. snapshot 종료 이후 화면 전송 사이의 모든 변화나 외부 세션 취소를 동시에 고정하지 않는다. 이후 제출은 다시 현재 상태를 검사한다.

## 시작 POST와 읽기 경로

`begin-draft` POST는 같은 method·Origin·body·CSRF 방어와 발급 rate limit을 적용한다. 입력은 productId 하나다. request intent key는 아직 없으며 임의 키를 발급 요청에서 받지 않는다. transaction 안의 prepareIntent가 현재 회원·상품·발급 정책을 확인한다. wrapper는 열린 intent 상한을 확인하고 revision·behavior digest를 저장한 뒤 303으로 이동한다.

GET/HEAD는 업무 intent나 초안을 만들지 않는다. GET은 현재 principal·scope·리소스 권한을 확인하며 intent가 완료됐으면 영수증으로 이동한다. 쿠키 인증의 세션 갱신 같은 기존 인증 프레임워크의 부수효과와 업무 intent 생성을 혼동하지 않는다.

## Origin과 Fetch Metadata 정책

아래는 서비스가 선택하는 엄격한 데모 정책이다. OWASP의 방어 기법을 참고하되 이 표의 조합과 상태 코드는 본 설계가 결정했다. 신뢰할 origin은 설정에 명시하고 임의 Host·X-Forwarded-Host를 그대로 믿지 않는다. 프록시가 있다면 신뢰할 ingress가 정규화한 값을 사용한다. [R01](13_SOURCES.ko.md#r01)

| 요청 헤더 상황 | 정책 |
| --- | --- |
| Origin이 정확한 허용 origin | 다른 방어와 함께 진행 |
| Origin이 다른 값·`null`·다중·잘못된 URL | 403 |
| Origin 없음, Referer의 origin이 정확히 일치 | 세션 CSRF가 유효해야 진행 |
| Origin과 Referer 모두 없음 | 403; 비브라우저 API는 별도 인증 경로 |
| Sec-Fetch-Site가 cross-site 또는 same-site | 데모의 동일 origin 쓰기에서는 403 |
| Sec-Fetch-Site 없음 | Origin·Referer와 CSRF 규칙 적용 |
| Sec-Fetch-Site가 same-origin 또는 none | 이것만으로 허용하지 않음 |

옛 브라우저에서 Fetch Metadata가 없어도 Origin 또는 Referer와 토큰이 있으면 동작한다. 둘 다 누락되는 개인정보 설정은 이 데모의 지원 범위 밖이며 명확한 안내를 제공한다. CORS를 넓게 열어 해결하지 않는다. non-browser 클라이언트가 헤더를 만들 수 있으므로 이 표를 인증 수단으로 설명하지 않는다.

## CSRF와 여러 탭

기존 인증 시스템의 검증된 synchronizer token 방식에 연결한다. 참고 프로필은 인증 세션 epoch마다 충분한 난수 토큰을 한 번 발급하고, 같은 epoch의 여러 탭에서는 같은 토큰을 허용한다. 정상적인 매 제출마다 교체하지 않는다. 로그인·로그아웃·세션 재생성·권한 상승으로 epoch가 바뀌면 이전 토큰을 폐기한다. 세션 만료·취소도 함께 적용한다. [R01](13_SOURCES.ko.md#r01) [R05](13_SOURCES.ko.md#r05)

폼 토큰은 서버 세션 값과 timing-safe 비교한다. 존재 여부만 확인하지 않는다. CSRF 토큰과 intent는 역할이 다르다. intent는 중복 작업 식별자이고 인증 비밀이 아니다. 두 필드 모두 정확히 하나만 받아야 한다. 데모 문자열은 운영 토큰으로 허용하지 않는다.

## 본문 한도와 객체 구성

16,384바이트는 전송 본문 전체 한도이며 Content-Length 없는 스트림도 실제 읽은 바이트를 센다. 최대 entry는 예약 필드를 포함해 16개, 디코딩한 키는 UTF-8 64바이트, 값은 각각 1,024바이트다. 모든 숫자는 초기 설계값이며 성능 측정 결과가 아니다. Content-Encoding은 없거나 identity만 허용한다.

UTF-8 외 charset, 잘못된 percent escape, 잘못된 UTF-8은 400이다. `+`는 공백으로 해석한다. entry list에서 중복을 먼저 판정한 뒤 Map 또는 null-prototype 객체를 만든다. own-property 검사로 허용 목록을 비교한다. 일반 객체에 임의 키를 대입하거나 Object.assign으로 요청 전체를 업무 객체와 합치지 않는다. [R04](13_SOURCES.ko.md#r04)

`__proto__`, `constructor`, `prototype`은 거부한다. 업무 키는 ASCII 식별자 하나로 제한해 중첩 경로 문법을 해석하지 않는다. `_bc_csrf`·`_bc_request`만 프로토콜에서 받아 검증하고 제거한다. 나머지 `_bc_*`와 구판의 `_th_*`는 거부한다. 남은 키가 input.schema에 없으면 이름과 관계없이 400이다. [R03](13_SOURCES.ko.md#r03)

트랜잭션에서 읽은 intent의 principal·tenant·action·product scope와 요청을 대조한다. 허용된 input.productId라도 intent에 저장된 상품과 다르면 실행하지 않는다. 유효한 키만 얻어 다른 객체의 작업에 전용하는 경로를 막는다.

## 응답·로그·호출 제한

HTML 응답에 정확한 Content-Type, nosniff, private/no-store, same-origin Referrer-Policy를 적용한다. 데모 CSP는 script를 막고 form-action·base-uri·frame-ancestors를 제한한다. Svelte 같은 다른 렌더러에 이 CSP를 그대로 적용하지 않는다. host별 보안 헤더 정책을 분리한다.

성공 감사 이벤트는 최소 필드만 같은 트랜잭션에 기록하고 외부 전송은 이후에 한다. 거절 로그는 코드·action ID·trace ID·가명 식별자·상태만 남긴다. 본문·CSRF·세션·비공개 출력은 기록하지 않는다. 외부 로그 전송 실패가 주문 중복 실행을 유도하지 않아야 한다.

rate limit은 표준 hook으로 넣는다. 첫 내부 예제의 제안값은 동일 principal/action당 POST 60초에 30회, intent 발급 60초에 10회, 열린 intent 20개다. 운영 기본값을 이 수치로 보장하지 않고 서비스가 설정한다. edge/IP 제한과 계정 제한의 저장소도 명시한다. 운영 프로필에서 필수 제한 포트가 없으면 지원 완료로 표시하지 않는다.

## 존재 노출과 실행 오류

인증된 요청에서 리소스 부재와 객체 권한 거부는 404와 동일한 외부 메시지로 합친다. 조회를 tenant 범위로 제한하고 반환 형태를 맞추지만 일정 시간을 보장한다고 쓰지 않는다. 임의 sleep으로 타이밍 보안을 흉내 내지 않는다. 내부 로그는 원인을 구별한다.

업무 callback 예외는 rollback하고 범용 오류를 반환한다. SqliteBusy, revision conflict, 입력 오류, 시스템 오류를 분리해 503·409·422·500으로 매핑한다. SQLite COMMIT의 BUSY·I/O 오류·결과 불명은 구분한다. 불명 상태에서 새 intent를 발급해 업무를 다시 실행하지 않고 기존 intent 결과를 확인한다. 열린 transaction을 둔 채 await하지 않는다.


## 해석과 자원 제한을 다른 계층에서 중복 실행하지 않는다

Request body의 byte를 한 번만 읽고 entry·codec·schema의 순서를 고정한다. Hono validator가 먼저 객체화해 중복 키를 지운 결과와 raw stream을 섞지 않는다. 이미 읽힌 body를 임의 복구하지 말고 adapter 계약 오류로 처리한다. HTTP message framing·중복 Content-Length 해석은 ingress와 runtime HTTP stack 책임이며 이 폼 parser가 request smuggling 전체를 방어한다고 주장하지 않는다.

Accept에 `text/html;q=0`처럼 HTML을 명시적으로 거부한 경우를 단순 substring으로 허용하지 않는다. 검증된 HTTP 파서를 사용하고 unsupported negotiation은 변경 전에 406이다. stream limit은 Content-Length 검사와 별개이며 cancel/timeout 때 reader를 종료한다. 실행 deadline·rate limit 저장소의 설계값은 배포 환경에서 확정한다.

세션 인증은 요청 시작 시점의 검증이다. transaction 내부 membership은 현재 로컬 권한을 확인하지만 외부 인증 시스템의 순간 취소까지 DB와 원자적으로 확인한 것은 아니다. 보장 범위를 넓히려면 별도 revocation protocol이 필요하며 초기 구현에 추가하지 않는다.
