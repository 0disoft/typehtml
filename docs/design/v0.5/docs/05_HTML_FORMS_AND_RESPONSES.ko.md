# DOM의 입력 목록과 실제 제출을 구분한다

현재 설계는 일반 HTML의 native 제출을 대상으로 한다. 정적 DOM을 파싱한 뒤 파일·form ID·submitter·목적지·entry 공급을 한 경로로 연결한다. JSON 응답, SvelteKit 향상 제출, 사용자 JS 직렬화는 자동 호환으로 취급하지 않는다.

## 안정적으로 폼을 지정한다

[구성 예제](../examples/doctor.config.json)는 action 문자열과 독립적으로 form ID를 지정한다. `create-draft` 폼을 `orders.createDraft`에 연결한 뒤 실제 목적지를 검사한다. action이 잘못되어도 검사 대상에서 사라지지 않는다. 찾는 form이 없거나 ID가 중복되면 연결 오류다.

`documentUrl`은 분석의 필수 문맥이다. 상대 action은 문서 URL과 유효한 base를 고려해 해석한다. native HTML의 기본값과 submitter override를 먼저 적용한 뒤 origin·method·pathname·query·encoding을 비교한다. 지원하지 않는 base·프록시 rewrite를 임의로 정규화하지 않는다. [R06](13_SOURCES.ko.md#r06) [R37](13_SOURCES.ko.md#r37)

현재 action 계약은 같은 origin, query 없는 고정 path, POST, URL 인코딩이다. 대소문자·말단 slash·percent-encoded slash를 같은 route로 추측하지 않는다. 외부 origin·query·지원하지 않는 target이 나타나면 정확한 불일치 또는 미지원 원인을 기록한다. fragment는 요청 path에 포함되지 않지만 경고와 원래 URL은 남긴다.

## native-form/1의 지원 경계

아래 표는 구현해야 할 규칙과 미지원 판정을 정한 설계다. 현재 Doctor가 이 표를 구현했다는 뜻은 없다. HTML 표준의 form owner·entry list·검증 대상 규칙을 참고한다. [R06](13_SOURCES.ko.md#r06) [R36](13_SOURCES.ko.md#r36)

| 경우 | entry·검증 의미 | Doctor의 초기 처리 |
| --- | --- | --- |
| input text·hidden과 명시적으로 연결된 외부 input | DOM 하위 관계만으로 소유자를 정하지 않음 | 같은 문서의 form owner를 해석 |
| `disabled="false"` | 속성이 있으므로 disabled | 해당 입력은 공급에서 제외 |
| disabled fieldset | 첫 legend 안의 예외가 있음 | 조상별 예외를 적용하고 그 밖의 입력 제외 |
| readonly text | 제출되지만 constraint validation 대상에서 빠짐 | 필드 공급과 값 검증을 따로 판정 |
| hidden 속성·CSS display:none | 그 이유만으로 제출이 빠지지 않음 | UI 가시성과 entry 공급을 분리 |
| name이 없는 input·빈 name | 일반 entry가 없음 | 필수 키 공급으로 세지 않음 |
| named submit button | 선택한 submitter의 name/value만 들어감 | 버튼별 경로와 중복·미등록 키 검사 |
| `formaction`·`formmethod`·`formenctype`·`formnovalidate` | form의 기본값을 바꿈 | submitter별 유효 tuple 기록 |
| 같은 scalar name 두 개 | list에는 둘 다 남음 | 객체로 덮기 전에 중복 오류 |
| checkbox·radio·select·textarea | 사용자 선택·개행 등 별도 의미가 있음 | 초기 Doctor에서는 unsupported, 모델을 추가한 뒤 승격 |
| dirname·image submit·custom element·Shadow DOM | 추가 entry 또는 별도 알고리즘 | 관련 cardinality 규칙 unsupported |
| template·JS submit/formdata 변경 | 현재 snapshot 바깥 변화 가능 | snapshot 한정 결과와 unknown gap |

임의 script가 없는 정적 예제라도 사용자의 값 편집은 허용한다. input의 초기 `value`만 보고 입력 전체가 검증됐다고 쓰지 않는다. 이름·소유자·submitter가 고정된 부분을 먼저 검사한다. browser에서 `FormData`를 만들 수 있다는 사실은 HTML 검증을 통과했다는 의미가 아니다.

명시적 submit button은 각각 경로다. Enter에 의한 implicit submit은 첫 기본 버튼을 반영해야 한다. 버튼 없는 implicit 경로·dialog method 등 아직 구현하지 않은 경로는 supported 분모에서 빼고 이유를 남긴다. synthetic click·requestSubmit·submit()의 모든 JS 동작을 P0에서 추적하지 않는다.

잘못된 중첩·중복 ID·폼 소유자에 영향을 주는 parser 복구가 있으면 구조 진단을 먼저 낸다. source의 텍스트 순서만으로 가짜 DOM을 만들지 않는다. 기존 HTML 파서와 린터를 재사용하고 파싱 불확실성은 해당 분석에 전달한다.

## 제약 비교는 구체적인 반례를 설명한다

JSON Schema의 required는 키 존재다. HTML required는 지원하는 control의 비어 있음 등에 관여한다. text input은 required가 없어도 빈 문자열 entry를 만들 수 있다. 그래서 `required 없음`을 바로 `필수 키 누락`으로 판정하지 않는다. [R06](13_SOURCES.ko.md#r06) [R39](13_SOURCES.ko.md#r39)

BC013의 기본 심각도는 warning이다. UI가 서버보다 좁은 범위를 제공하는 것은 의도적인 선택일 수 있고, 서버만 상세 규칙을 검증하는 폼도 허용한다. client-prevalidation을 필수 정책으로 선택한 프로젝트만 확정 반례를 릴리스 차단으로 올린다. 이 선택은 보안 보장을 추가하지 않는다.

C3는 quantity 문자열 11, 지정한 decimal-integer codec, 알려진 native 검증 상태에서 HTML은 허용하고 서버 maximum=10은 거부한다는 한 반례다. `novalidate`, readonly, JS 값 주입 등 전제가 달라지면 같은 증거를 재사용하지 않는다. 반례를 못 찾은 상태를 동치 증명으로 표시하지 않는다.

HTML 길이 제약과 JSON Schema 문자열 길이는 그대로 복사하지 않는다. UTF-16 code unit·Unicode code point·UTF-8 byte가 다르며, 브라우저의 길이 검증은 값 변경 경로에도 영향을 받는다. HTML pattern은 전체 일치와 자체 정규식 의미를 사용하고 JSON Schema pattern은 기본적으로 부분 일치다. P0에서는 알려진 ASCII 정수 패턴만 다루고 임의 regex 비교는 보류한다. [R07](13_SOURCES.ko.md#r07) [R39](13_SOURCES.ko.md#r39)

## GET과 intent 발급을 나눈다

GET `/orders/new?productId=...`은 안내 화면과 시작 form만 반환한다. POST `/actions/orders/begin-draft`가 CSRF·현재 권한·발급 한도를 확인하고 intent를 저장한다. 그 후 `/orders/new?intent=...`로 303 이동한다. GET·HEAD·미리읽기는 업무 intent나 초안을 만들지 않는다. HTTP safe method와 CSRF 지침을 근거로 선택한 설계이며 모든 임시 저장이 표준 위반이라고 일반화하지 않는다. [R40](13_SOURCES.ko.md#r40) [R01](13_SOURCES.ko.md#r01)

시작 POST가 중복되면 아직 업무를 실행하지 않은 열린 intent가 추가될 수 있다. 발급 한도·열린 개수 상한을 한 transaction 안에서 확인한다. 초기 profile은 bootstrap까지 exactly-once라고 주장하지 않는다. 새로고침·탭 복제는 발급 이후 URL의 같은 intent를 사용한다. 추가 시작 단계의 UX 비용도 래퍼 평가에 기록한다.

## 응답 프로토콜

| 요청 결과 | HTTP | 규약 |
| --- | --- | --- |
| 최초 안내 GET | 200 HTML | 현재 상품·시작 form, intent 생성 없음 |
| 시작 POST 성공 | 303 | 새 intent URL, 업무 초안은 아직 없음 |
| 유효 open intent GET | 200 HTML | 저장된 revision과 현재 상품을 대조한 작성 form |
| 초안 POST 성공·허용된 재응답 | 303 | 영수증 경로 |
| open intent의 입력 오류 | 422 HTML | 같은 intent·허용된 raw 값·현재 권한 |
| 완료 intent에 다른 값·형식의 제출 | 409 HTML | 완료한 작업을 수정하지 않음 |
| 계약 변경·보여준 상품 revision 변경 | 409 HTML | 사유 코드와 명시적 새 작업 안내, 자동 재실행 없음 |
| intent 또는 결과 보존 종료 | 410 HTML | 이전 POST로 새 intent를 만들지 않음 |
| 인증 없음 / 권한 없음·리소스 부재 | 401 / 404 | 일반 안내, 404의 상세 내부 사유는 로그만 |
| 잘못된 구조·중복 / CSRF·출처 위반 | 400 / 403 | 받은 원문·토큰 노출 없음 |
| 미지원 전송 / HTML 불허 Accept | 415 / 406 | 업무 변경 전에 거절 |
| 초과 body·제한 / writer 획득 예산 소진 | 413·429 / 503 | 503은 Retry-After 1초, 같은 intent 유지 |

완료된 intent GET은 현재 영수증 권한이 있으면 기존 영수증으로 이동한다. 계약 변경이 POST 재시도를 막더라도 영수증 GET의 현재 권한 경로는 별도로 남긴다. 422 renderer는 intent의 scope와 현재 권한·revision을 다시 읽는다. 그 사이 권한이 없어지면 404, revision이 바뀌면 409다.

## 입력·오류 렌더링

수량 기본값은 text·inputmode=numeric·required·maxlength=2·`pattern="([1-9]|1[0-9]|20)"`다. inputmode 자체를 검증기로 보지 않는다. [초기 form](../examples/html/form.initial.html), [422 form](../examples/html/form.invalid.html), [시작 form](../examples/html/start.html)은 합성 스냅샷이다. 운영 token이나 서버는 포함하지 않는다.

FormState는 허용한 업무 키와 크기가 제한된 원문만 갖는다. 프로토콜 토큰은 저장된 세션에서 새로 공급하고 받은 body를 echo하지 않는다. `renderStart(PageView, StartState)`, `renderForm(PageView, FormState)`, `renderReceipt(PublicOutput)`을 구분한다. HTML 문맥 인코딩은 기존 renderer에 맡긴다. [R18](13_SOURCES.ko.md#r18)

기존 린터의 label·참조 ID 검사와 필드 오류 연결을 재사용한다. 서버 오류 매핑 없이 BC020을 완료로 표시하지 않는다. 오류 요약·입력 옆 설명·펼쳐진 정보는 유지한다. 실제 스크린리더·키보드·전체 접근성은 별도 확인 대상이다. [R20](13_SOURCES.ko.md#r20) [R21](13_SOURCES.ko.md#r21)

## v0.5의 목적지와 경로 수 판정

action 속성 부재와 빈 action은 문서 URL로 제출한다. 선택한 버튼의 빈 formaction도 명시적 override이므로 form의 action으로 되돌리지 않는다. 비어 있지 않은 상대 경로에만 effective base URL을 적용한다. DOM의 formAction getter에서 보이는 기본값을 곧바로 실제 선택 알고리즘으로 사용하지 않는다. [R06](13_SOURCES.ko.md#r06)

[URL 참고 함수](../reference/native-target.ts)는 파서가 이미 제공한 속성 사실에 대해서만 이 구분을 계산한다. HTML 파서·브라우저 제출·CSP 판정을 구현하지 않는다. 서버에 선언하는 fixed path는 같은 origin의 canonical absolute path이며 `//host`, 역슬래시, dot segment 정규화로 달라지는 path를 허용하지 않는다. percent-encoded separator가 있는 route는 현재 profile에서 미지원이다. HTML 원문 자체는 먼저 표준 URL 의미로 해석하고 차이의 근거를 남긴다. [R45](13_SOURCES.ko.md#r45)

비활성 submitter는 사용자의 native activation 경로로 세지 않는다. datalist 하위 control은 entry에 포함하지 않는다. reset·일반 button을 submit button으로 세지 않는다. 실제로 열거한 제출 경로가 0개면 릴리스 gate의 분석 완료로 처리하지 않는다. 버튼 없는 implicit submission을 지원하지 않은 경우는 그 이유를 기록하며 오류 폼이 없다는 결과로 바꾸지 않는다. [R06](13_SOURCES.ko.md#r06)

페이지 응답은 이제 resolvePage의 start·form·receipt·failure union을 사용한다. 상태 우선순위는 [06](06_RUNTIME_SECURITY.ko.md)의 공통 판정을 따른다. 422 화면도 현재 OPEN 상태를 확인했을 때만 보낸다. 다른 탭의 완료 이후에는 오래된 수정 폼 대신 409와 허용된 영수증 이동 안내를 제공한다.
