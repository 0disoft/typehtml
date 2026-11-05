# 계약 데이터는 한 곳에서만 작성한다

이번 패키지의 정본은 [order.boundary.json](../examples/order.boundary.json)이다. 동일한 객체를 담은 `.boundary.ts`는 제거했다. [파생 타입](../reference/order-types.generated.ts)은 [작은 참고 생성 스크립트](../validation/generate_reference_types.py)가 정본에서 만든다. 타입·폼 projection·digest 생성은 JSON과 TypeScript의 중복 작성을 없애기 위한 패키지 도구이며, P3의 서버 코드 생성기를 구현했다는 뜻으로 사용하지 않는다.

## 계약 영역

| 영역 | 담당 내용 | 정본과 실행의 관계 |
| --- | --- | --- |
| `http` | 메서드·경로·인코딩·바이트와 entry 한도 | 실제 본문을 런타임에서 제한 |
| `protocol` | CSRF·intent 예약 필드 | 업무 입력과 분리해 정확히 한 번 검증 |
| `input` | 도메인 스키마·codec·미등록 및 중복 거부 | 문자열 디코딩 후 스키마 검사 |
| `bindings` | 타입 지정 factory의 모듈·export | 실행 시 앱이 포트를 공급 |
| `serverOwnedFields` | 선언상 제출 불가 필드 | 교집합은 계약 오류, 이름 자체는 권한 근거 아님 |
| `guards` | CSRF·동기 트랜잭션·revision·intent 정책 | 구현 가능한 어댑터만 연결 |
| `output` | 공개 영수증 스키마와 투영 정책 | 내부 결과와 별개 |
| `page` | 최초 화면의 별도 view 스키마 | 영수증 스키마를 페이지 타입으로 재사용하지 않음 |
| `response` | 성공·422·영수증 GET·거부 응답 | 네이티브 HTML 흐름을 완성 |
| `headers` | 데모 HTML의 보안·캐시 정책 | 다른 렌더러의 CSP를 자동 덮어쓰지 않음 |

`sourceMode=json-authoritative`인 이번 예제에서 JSON은 수동 작성하고 TypeScript는 재생성한다. 후속 exporter 모드에서는 기존 schema 모듈이 정본이고 JSON은 생성물이다. 한 액션에서 두 모드를 동시에 사용하거나 JSON과 TS를 양쪽에서 편집하는 기능은 제공하지 않는다.

## 스키마와 codec

v0.1은 최상위 object, `additionalProperties=false`, 명시적 required, scalar string·integer과 제한된 const·enum·길이·정수 범위를 사용한다. 이번 예제의 output orderId 패턴은 제한된 ASCII 식별자 검사다. 임의 정규식·원격 `$ref`·재귀·배열·파일·실행 가능한 변환은 제품 지원으로 포함하지 않는다. 인식하지 못한 keyword는 무시하지 않고 지원 범위 오류로 낸다.

number 타입으로 선언한 도메인 수량과 HTTP 전송 문자열은 다르다. `decimal-integer`는 `0`, 양의 정수, 0이 아닌 음의 정수의 정규 10진 표기를 해석하고 safe integer 범위를 확인한다. 주문 수량 스키마가 그 결과를 다시 1부터 20으로 제한한다. 공백·빈 값·앞자리 0·지수·소수·부호 있는 0·양의 부호는 거부한다. 이 엄격한 codec은 제품 설계 선택이다. [R06](13_SOURCES.ko.md#r06)

## 기존 스키마를 연결하는 규약

정식 첫 지원은 JSON Schema 정본 사용자로 제한한다. TypeBox는 JSON Schema 객체를 만들므로 명시적으로 실행하는 직렬화 bridge 후보이고, Zod 4에는 공식 변환 API가 있다. 그러나 transform·refinement·coercion·사용자 정의 타입의 의미가 JSON 구조와 같다고 가정하지 않는다. [R13](13_SOURCES.ko.md#r13) [R14](13_SOURCES.ko.md#r14)

exporter를 후속 도입할 때 결과에는 원본 모듈·전이 의존 파일·lockfile·exporter 버전의 해시와 `structuralProjection=exact|partial`을 남긴다. 검사기는 모듈을 실행하지 않고 이 스냅샷만 읽는다. partial이면 필드 이름 등 확인 가능한 진단만 내고 범위·형식 완전 일치를 주장하지 않는다. 표현하지 못한 규칙을 `{}`로 바꿔 완전 지원으로 표시하지 않는다.

런타임은 원래 schema validator를 계속 호출할 수 있다. 이때 JSON은 정적 검사용 투영이며 동일한 validator의 두 번째 수동 정의가 아니다. exporter가 없으면 기존 코드를 강제로 옮기는 대신 해당 액션의 필드 분석을 unsupported로 표시한다.

## 민감 이름 검사의 정확한 역할

허용하지 않은 `ownerId`나 `userId`는 이름 목록에 없어도 입력 스키마의 허용 목록에서 거부된다. 설정 가능한 이름 패턴은 실수로 그런 필드를 스키마에 넣었는지 검토를 요청하는 warning이다. 관리자 기능에서 대상 사용자 ID가 정당한 입력이면 명시적 정책과 사유를 남긴다. 이름 패턴만으로 차단하거나 허용하지 않는다. [R03](13_SOURCES.ko.md#r03)

실제 예제의 `serverOwnedFields`와 입력 키가 겹치면 확정된 계약 모순이다. 반면 `sensitiveInputNames`와 겹쳤다는 사실만으로는 모순이 확정되지 않는다. 진단의 확실성을 분리한다.

[참고 메타스키마](../schemas/boundary-contract.schema.json)는 이번 형식과 제한된 예제 키워드를 검사한다. 스키마 키워드의 교차 의미와 역할 연결은 별도의 의미 검사 대상이다. boolean·배열·checkbox 컬렉션은 첫 codec 범위에 넣지 않는다.

## 검사 전용 입력을 전체 런타임 계약에서 분리한다

`order.boundary.json`은 주문 래퍼 전체의 설명용 정본이다. 폼을 검사하는 모든 사용자가 이 분량을 작성해야 하는 API로 삼지 않는다. 폼용 데이터는 method·path·body, 입력 schema·codec·중복/미등록 처리, 제출 가능한 protocol key로 제한한다. principal·DB·grant·idempotency·공개 output·CSP는 폼 구조 검사에 필요하지 않다.

[form-check.generated.json](../examples/form-check.generated.json)은 기존 정본에서 그 부분만 추출한 파생물이다. [참고 생성 스크립트](../validation/generate_reference_types.py)가 타입과 함께 생성하며 source 해시를 검증한다. 파일 이름에 generated가 있어도 서버 실행 코드나 새로운 언어 compiler를 구현했다는 뜻으로 사용하지 않는다.

| 데이터 | 검사에 쓰는 범위 | 생성 또는 작성 책임 |
| --- | --- | --- |
| action ID·method·path·encoding | 고정 제출 대상 연결 | 원본 route/계약에서 파생하거나 한 번만 연결 |
| input schema·codec | 공급할 필드·제한된 값의 의미 | 기존 정본 유지 |
| protocol field 목록 | CSRF·intent 키를 미등록 업무 필드로 오탐하지 않음 | 기존 서버 protocol에서 가져온다 |
| HTML 경로·선택 범위 | 검사할 폼을 고름 | 작고 명시적인 scanner 설정 |
| source 해시·정적 투영 상태 | 오래된 파생물·누락 의미 식별 | 기계가 생성 |

protocol key의 존재와 이름을 검사했다고 CSRF·intent 서버 검증까지 확인한 것은 아니다. 검사 전용 입력에 runtime 보장 표식을 넣지 않는다. schema field의 도메인 타입과 wire codec도 구분한다.

기존 JSON Schema 사용자용 최소 연결은 schema 파일 위치, codec map, method/path와 HTML 범위다. 이 작은 연결도 실제 도입비로 기록한다. source code에서 route를 자동 찾지 못하면 한 번의 명시적 mapping 또는 unknown을 선택한다. 코드 추론을 위해 앱을 실행하지 않는다.

검사 전용 loader·기존 프로젝트 exporter는 현재 제품 구현이 없다. 이번 파생 스크립트는 이 패키지의 알려진 단일 정본만 처리한다. Zod exporter 후보는 input/output 구분과 표현 불가능한 타입을 명시해야 한다. 구조 투영이 partial이면 값 제약 검사는 제한하고 이미 원본 서버가 사용하는 validator를 그대로 둔다. [R13](13_SOURCES.ko.md#r13)

## 지원 범위와 계약 비용을 함께 판단한다

flat scalar와 URL 인코딩을 받아들이는 대신 얻을 수 있는 효과는 구체적인 필드·전송 대상·제약 연결 오류를 배포 전에 설명하는 것이다. 이미 typed input helper가 같은 연결을 생성한다면 추가 contract 작성 이유가 줄어든다. 파일·배열 지원을 추가해 문서상 시장을 넓히기 전에 실제 미지원 원인과 연결 비용을 [P0a](09_DELIVERY_AND_EXPERIMENTS.ko.md)에 기록한다.


## wire 의미

raw body는 entry list로 해석한다. `%` 해석은 정확히 한 번이며 `+`는 공백, `%2B`는 문자 plus다. 첫 `=`에서 키와 값을 나누고 빈 segment는 무시한다. 잘못된 percent·UTF-8·NUL, 빈/비지원 키, 중복된 디코딩 후 키는 400이다. strict rejection은 URL 표준 parser보다 엄격한 제품 정책이다. 표준 API가 복구한 문자열을 받은 뒤 원래 byte 오류를 찾을 수 있다고 가정하지 않는다. [R38](13_SOURCES.ko.md#r38)

`quantity=`는 빈 값이고 키 자체가 없는 경우와 다르다. text는 trim·NFC·case 변경을 하지 않는다. 숫자 codec은 정규 10진 표현과 safe integer를 확인하며 `-0`, `+1`, `01`, `1e2`를 거절한다. schema validator는 coerce·default 삽입·unknown key 제거 없이 순수 판정으로 호출한다. keyword default·readOnly가 서버 보호나 자동 값 공급을 실행한다고 해석하지 않는다. [R39](13_SOURCES.ko.md#r39)

UTF-8 byte 한도, JSON Schema code point 길이, HTML UTF-16 길이는 별개다. source BOM과 값 안의 U+FEFF도 별개이며 값의 BOM은 임의 제거하지 않는다. `[...value].length`는 참고 예제의 code point 계산이고 사용자가 보는 글자 수를 세는 grapheme 계산은 지원 목표가 아니다.

[wire-semantics.ts](../reference/wire-semantics.ts)는 in-memory decoding·정수·입력 직렬화의 작은 참고 구현이다. stream 읽기·schema·CSRF·전체 HTTP를 대신하지 않는다. 관리되는 규약에 대한 국소 재현 자료로만 사용한다.

## 원문 무결성과 실행 의미 digest를 나눈다

sourceSha256은 JSON 원문 byte의 무결성과 파생물 freshness를 확인한다. behaviorSha256은 `boundary-behavior/1`이 고른 필드를 canonical JSON으로 정렬해 계산한다. 객체 key는 정렬하고 array 순서는 유지한다. 부동소수점은 이 계약 부분집합에 없다. 의미가 같은 모든 JSON Schema를 같은 값으로 합치는 범용 정규화는 아니다.

포함 필드는 id·operationRevision·operation·http·protocol·input·serverOwnedFields·guards·output·response다. status·format 표시·binding 경로·page 표시 정보·헤더 문자열은 직접 포함하지 않는다. [파생 digest](../reference/contract-digests.generated.json)에 정확한 필드 목록과 값을 남긴다. JSON 줄바꿈·키 배치는 behavior digest를 바꾸지 않지만 source hash는 바꾼다.

정책 callback·가격 계산·권한 의미가 바뀌면 개발자가 operationRevision을 올린다. source 경로를 hash에서 빼도 callback 호환성이 자동 증명되는 것은 아니다. CI는 선택 필드 변경을 기계적으로 잡고, 명시적 revision 변경 책임은 코드 리뷰에서 확인한다. 과거 revision handler를 자동 로딩하는 기능은 없다.

입력 hash는 검증된 flat 값을 ASCII key 순서의 `[key, kind, value]` 목록으로 만들고 `['bc-input/1', entries]`를 UTF-8 JSON으로 직렬화해 SHA256을 계산한다. 문자열과 정수·빈 값·누락이 구분되고 전송 순서·CSRF·intent는 제외한다. 이 직렬화 함수에는 검증된 값만 넣으며 비밀 body 전체를 hash 명목으로 저장하지 않는다.

v0.3의 전체 contract byte hash를 기존 결과와 비교하는 정책은 폐기한다. 발급된 intent와 결과는 현재 behavior digest를 보관한다. 새 계약에서 required가 추가된 경우도 먼저 intent 호환성을 확인해 CONTRACT_CHANGED를 반환하며, 뒤늦게 422로 잘못 안내하지 않는다.

## v0.5의 정본 읽기와 경로 의미

정본과 설정 JSON은 중복된 디코딩 후 객체 키를 거부한다. 같은 키를 마지막 값으로 덮어쓴 뒤 hash를 만들면 사람이 본 계약과 도구가 본 계약이 갈라진다. JSON의 중복 키와 표현 범위 차이는 공식 규격도 상호운용성 문제로 다룬다. 이 패키지는 중복·비유한 수·단독 surrogate·과도한 깊이를 거부하는 제한된 읽기 정책을 선택했다. [R44](13_SOURCES.ko.md#r44)

[참고 reader](../validation/strict_json.py)는 입력을 최대 2 MiB와 depth 64로 제한한다. 계약/codegen 숫자는 safe integer만 허용한다. float 측정값이 필요한 증거 파일은 별도 일반 JSON 모드로 읽되 비유한 값은 거부한다. JSON source BOM 거부와 HTTP 값의 U+FEFF 보존은 서로 다른 계층이다. 제품 loader는 같은 정책을 실제 파서로 구현해야 하며 이번 Python 도구를 제품 CLI라고 표시하지 않는다.

http.path는 슬래시 하나로 시작해야 하고 URL로 round-trip 했을 때 origin·pathname이 바뀌지 않아야 한다. 메타스키마는 `//host`·역슬래시 등 명백한 충돌을 거르고 남은 canonical 검사는 의미 검사로 수행한다. receipt template의 parameter는 검증된 orderId를 하나의 path segment로 인코딩해 넣는다. 임의 Location을 callback에서 받지 않는다. [R45](13_SOURCES.ko.md#r45)

이번 statePolicy·동기 역할·페이지 응답 의미의 변경에 맞춰 operationRevision을 2로 올렸다. behavior digest 계산의 선택 필드 규칙은 그대로이며 새 guards도 digest에 들어간다. 옛 handler를 자동 실행하지 않는다. 발급된 이전 OPEN intent는 계약 변경 안내, 유효 완료 영수증 GET은 현재 권한으로 별도 처리한다.
