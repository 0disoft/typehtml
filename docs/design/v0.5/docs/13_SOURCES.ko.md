# 근거 자료와 적용 범위

자료 목록의 수와 이번에 다시 읽은 수를 구분한다. v0.5의 등록 자료는 45개다. 기존 R02·R06·R11·R23·R24를 다시 확인했고 R41–R45를 추가했다. 나머지는 이전 기록을 유지했다. 각 항목의 확인 버전은 [구조화 목록](../evidence/sources.json)에 있다.

공식 문서는 표준과 도구 동작의 근거다. intent 상태 정책·오류 우선순위·도입 판단은 이 프로젝트가 선택한 설계다. 참고 코드 실행과 실제 제품의 검증 상태는 [검증 보고서](../validation/REPORT.ko.md)에서 분리한다.

<a id="r01"></a>

## R01 OWASP CSRF Prevention

[OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)

Origin·Referer·Fetch Metadata와 세션 결합 토큰을 함께 고려한다. 이 패키지의 정확한 거부 정책은 자체 설계다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.4.0-design`다.

<a id="r02"></a>

## R02 OWASP Authorization

[OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)

각 요청의 객체·작업 권한을 확인한다. 인증 성공만으로 객체 권한이 생기지 않는다.

이번 개정에서 확인. 마지막 확인 버전은 `0.5.0-design`다.

<a id="r03"></a>

## R03 OWASP Mass Assignment

[OWASP Mass Assignment](https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html)

입력 허용 목록과 별도 입력 DTO가 방어의 중심이다. 이름 휴리스틱은 이 방어를 대체하지 않는다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.2.0-design`다.

<a id="r04"></a>

## R04 OWASP Prototype Pollution Prevention

[OWASP Prototype Pollution Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Prototype_Pollution_Prevention_Cheat_Sheet.html)

Map 또는 null-prototype 객체 활용과 위험 경로 통제를 참고했다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.2.0-design`다.

<a id="r05"></a>

## R05 OWASP Session Management

[OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)

세션 교체·만료·취소와 쿠키 보안 속성을 기존 인증 시스템과 연결한다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.2.0-design`다.

<a id="r06"></a>

## R06 WHATWG HTML form submission

[WHATWG HTML form submission](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html)

form 소유자, submitter override, disabled·checkbox와 entry list 의미를 확인했다.

이번 개정에서 확인. 마지막 확인 버전은 `0.5.0-design`다.

<a id="r07"></a>

## R07 WHATWG HTML input

[WHATWG HTML input](https://html.spec.whatwg.org/multipage/input.html)

number의 부동소수점 문법과 text/pattern 제약을 구분한다. inputmode는 검증기가 아니다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.4.0-design`다.

<a id="r08"></a>

## R08 SQLite transaction control

[SQLite transaction control](https://www.sqlite.org/lang_transaction.html)

단일 writer와 BEGIN IMMEDIATE의 잠금 획득·BUSY 동작을 확인했다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.4.0-design`다.

<a id="r09"></a>

## R09 SQLite WAL

[SQLite WAL](https://www.sqlite.org/wal.html)

동일 호스트 제약과 WAL-reset 수정 이력을 확인했다. 운영에는 해당 수정이 포함된 배포판을 요구한다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.4.0-design`다.

<a id="r10"></a>

## R10 SQLite pragmas

[SQLite pragmas](https://www.sqlite.org/pragma.html)

busy_timeout·foreign_keys 등 연결 설정을 확인했다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.4.0-design`다.

<a id="r11"></a>

## R11 Bun SQLite

[Bun SQLite](https://bun.com/docs/runtime/sqlite)

동기 transaction, strict parameter binding과 integer 처리의 공식 제약을 확인했다. 제품 어댑터는 아직 미구현이다.

이번 개정에서 확인. 마지막 확인 버전은 `0.5.0-design`다.

<a id="r12"></a>

## R12 Bun transaction callback

[Bun transaction callback](https://bun.com/reference/bun/sqlite/Database/transaction)

트랜잭션 callback은 동기 함수여야 한다. await 이후 작업을 같은 트랜잭션으로 오인하지 않는다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.2.0-design`다.

<a id="r13"></a>

## R13 Zod JSON Schema

[Zod JSON Schema](https://zod.dev/json-schema)

Zod 4의 JSON Schema 변환과 표현 불가능한 타입 처리, 입력·출력 표현의 구분을 확인했다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.3.0-design`다.

<a id="r14"></a>

## R14 TypeBox official repository

[TypeBox official repository](https://github.com/sinclairzx81/typebox)

TypeBox가 JSON Schema 객체와 정적 타입 추론을 연결함을 확인했다. 이번 패키지에서 라이브러리를 실행하지 않았다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.2.0-design`다.

<a id="r15"></a>

## R15 SvelteKit form actions

[SvelteKit form actions](https://svelte.dev/docs/kit/form-actions)

use:enhance의 대상과 액션 응답 규약이 일반 Hono HTML 응답과 다름을 확인했다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.3.0-design`다.

<a id="r16"></a>

## R16 SvelteKit PR 12198

[SvelteKit PR 12198](https://github.com/sveltejs/kit/pull/12198)

2024-06-24에 병합된 enctype 처리 변경이다. 향상 제출이 항상 multipart라는 주장을 반박하는 역사적 근거다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.2.0-design`다.

<a id="r17"></a>

## R17 SvelteKit 2.5.18 forms implementation

[SvelteKit 2.5.18 forms implementation](https://raw.githubusercontent.com/sveltejs/kit/@sveltejs%2Fkit@2.5.18/packages/kit/src/runtime/app/forms.js)

multipart 이외에서 URLSearchParams를 사용하는 분기를 확인했다. 이 태그를 최신 버전으로 취급하지 않는다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.2.0-design`다.

<a id="r18"></a>

## R18 Hono HTML helper

[Hono HTML helper](https://hono.dev/docs/helpers/html)

HTML 템플릿 helper와 raw 출력의 구분을 확인했다. 본 패키지에는 실행된 Hono 렌더러가 없다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.2.0-design`다.

<a id="r19"></a>

## R19 Hono routing

[Hono routing](https://hono.dev/docs/api/routing)

라우트·그룹 구성의 분석 범위를 설계할 때 참고했다. 임의 동적 등록의 완전 탐지는 주장하지 않는다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.2.0-design`다.

<a id="r20"></a>

## R20 Markuplint accessibility configuration

[Markuplint accessibility configuration](https://markuplint.dev/docs/configuration/usecases/accessibility)

접근성·HTML 적합성 preset과 단계적 severity 설정을 재사용한다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.3.0-design`다.

<a id="r21"></a>

## R21 W3C WAI form notifications

[W3C WAI form notifications](https://www.w3.org/WAI/tutorials/forms/notifications/)

오류 요약·필드별 오류 연결·수정 안내 설계의 근거다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.2.0-design`다.

<a id="r22"></a>

## R22 Thymeleaf tutorial

[Thymeleaf tutorial](https://www.thymeleaf.org/doc/tutorials/3.1/usingthymeleaf.html)

th:text·th:value 등 th:*의 기존 사용을 확인하여 새 문법 접두사로 채택하지 않는다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.2.0-design`다.

<a id="r23"></a>

## R23 TypeScript 7.0 release

[TypeScript 7.0 release](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)

7.0은 2026-07-08 발표되었고 프로그램 API 부재를 명시한다. 기본 설계는 CLI 타입 검사 경계다.

이번 개정에서 확인. 마지막 확인 버전은 `0.5.0-design`다.

<a id="r24"></a>

## R24 TypeScript 7.1 beta

[TypeScript 7.1 beta](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/)

2026-10-20 베타의 content mapper·새 API·외부 코드 실행 허용을 확인했다. 필수 의존에서 제외한다.

이번 개정에서 확인. 마지막 확인 버전은 `0.5.0-design`다.

<a id="r25"></a>

## R25 Ajv standalone validation

[Ajv standalone validation](https://ajv.js.org/standalone.html)

AOT 검증기 생성의 기존 수단이다. AOT의 효과는 별도 측정·배포 요건으로 결정한다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.2.0-design`다.

<a id="r26"></a>

## R26 Hono validation

[Hono validation](https://hono.dev/docs/guides/validation)

form validation과 Zod/Standard Schema 연결은 기존 기능이다. 이 기능 자체를 Doctor의 추가 발견으로 계산하지 않는다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.3.0-design`다.

<a id="r27"></a>

## R27 Hono RPC

[Hono RPC](https://hono.dev/docs/guides/rpc)

validator 입력과 c.json 응답의 client 타입 연결을 확인했다. 원시 HTML 필드 전부를 정적으로 검사한다는 자료로 사용하지 않는다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.3.0-design`다.

<a id="r28"></a>

## R28 React Router form validation

[React Router form validation](https://reactrouter.com/how-to/form-validation)

server action·form·실패 결과·redirect의 기존 흐름을 비교한다. 프레임워크 변환 없이 대안을 검토하는 근거다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.3.0-design`다.

<a id="r29"></a>

## R29 htmx documentation validation

[htmx documentation validation](https://htmx.org/docs/#validation)

브라우저 검증 연계와 서버에서 재검증해야 한다는 요구를 확인했다. BC 응답 protocol 호환성 테스트는 아니다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.3.0-design`다.

<a id="r30"></a>

## R30 HTML-validate form-dup-name

[HTML-validate form-dup-name](https://html-validate.org/rules/form-dup-name.html)

중복 form control name의 기존 검사와 disabled·radio·checkbox 예외 설정을 확인했다. 실제 baseline 버전·설정은 실행 때 기록한다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.3.0-design`다.

<a id="r31"></a>

## R31 Markuplint rules

[Markuplint rules](https://markuplint.dev/docs/rules)

form owner·label·ID 참조·접근 가능한 이름 관련 기존 규칙을 확인했다. 출처 보존과 기존 lint 공로 분리의 근거다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.3.0-design`다.

<a id="r32"></a>

## R32 Conform getZodConstraint

[Conform getZodConstraint](https://conform.guide/api/zod/getZodConstraint)

스키마에서 HTML 입력 제약을 만드는 기존 helper다. 수동 마크업 검사와 생성 기반 예방을 비교한다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.3.0-design`다.

<a id="r33"></a>

## R33 Conform getInputProps

[Conform getInputProps](https://conform.guide/api/react/getInputProps)

입력 metadata로 접근성·입력 props를 만드는 helper다. 모든 동적 폼 오류를 자동 검출한다는 의미로 확대하지 않는다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.3.0-design`다.

<a id="r34"></a>

## R34 node-postgres transactions

[node-postgres transactions](https://node-postgres.com/features/transactions)

transaction의 모든 문장을 같은 client에서 실행해야 한다. pool.query 호출을 섞는 방식은 이식 설계에서 제외한다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.3.0-design`다.

<a id="r35"></a>

## R35 PostgreSQL transaction isolation

[PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)

읽기와 경합의 의미가 isolation level에 따라 달라진다. 정책 조회와 변경의 일치를 위한 잠금·격리·retry 검토 근거다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.3.0-design`다.

<a id="r36"></a>

## R36 WHATWG form elements

[WHATWG form elements](https://html.spec.whatwg.org/multipage/form-elements.html)

disabled fieldset와 첫 legend 예외, form-associated controls를 참고했다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.4.0-design`다.

<a id="r37"></a>

## R37 WHATWG base element

[WHATWG base element](https://html.spec.whatwg.org/multipage/semantics.html#the-base-element)

문서 URL과 base URL이 상대 action 해석에 미치는 영향을 참고했다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.4.0-design`다.

<a id="r38"></a>

## R38 WHATWG URL encoded parsing

[WHATWG URL encoded parsing](https://url.spec.whatwg.org/#urlencoded-parsing)

entry 분리·plus·percent 해석을 참고했다. 잘못된 percent와 UTF-8을 거부하는 strict profile은 자체 설계다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.4.0-design`다.

<a id="r39"></a>

## R39 JSON Schema validation 2020-12

[JSON Schema validation 2020-12](https://json-schema.org/draft/2020-12/json-schema-validation)

문자열 길이와 pattern·annotation의 의미를 참고했다. 자동 coerce/default 실행은 별도 구현 설정이다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.4.0-design`다.

<a id="r40"></a>

## R40 HTTP Semantics RFC 9110

[HTTP Semantics RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html)

safe method와 자동 조회를 참고해 업무 intent 발급을 CSRF 보호 POST로 분리했다. 모든 GET 부수효과가 표준 위반이라는 주장은 하지 않는다.

이전 확인 기록 유지. 마지막 확인 버전은 `0.4.0-design`다.

<a id="r41"></a>

## R41 SQLite Isolation

[SQLite Isolation](https://www.sqlite.org/isolation.html)

WAL의 읽기 snapshot은 다른 연결의 commit 후에도 유지된다. 새 읽기는 transaction을 끝내고 다시 시작해야 하며 오래된 읽기의 쓰기 승격은 별도 실패 조건이다.

이번 개정에서 확인. 마지막 확인 버전은 `0.5.0-design`다.

<a id="r42"></a>

## R42 SQLite ON CONFLICT

[SQLite ON CONFLICT](https://www.sqlite.org/lang_conflict.html)

REPLACE는 충돌한 기존 행을 삭제할 수 있고 ABORT는 해당 statement 범위에 적용된다. 완료된 요청을 덮어쓰지 않는 저장 규칙의 근거다.

이번 개정에서 확인. 마지막 확인 버전은 `0.5.0-design`다.

<a id="r43"></a>

## R43 TypeScript Type Compatibility

[TypeScript Type Compatibility](https://www.typescriptlang.org/docs/handbook/type-compatibility.html)

구조적 타입 호환성은 객체의 추가 속성을 제거하지 않는다. 타입 검사를 통과한 projector도 실제 응답 값은 별도로 제한해야 한다.

이번 개정에서 확인. 마지막 확인 버전은 `0.5.0-design`다.

<a id="r44"></a>

## R44 RFC 8259 JSON

[RFC 8259 JSON](https://www.rfc-editor.org/rfc/rfc8259.html)

중복 member 이름은 상호운용성이 없고 수의 범위·정밀도에도 구현 차이가 있다. 이 설계는 원본 JSON의 중복 키와 비유한 값 등을 명시적으로 거부한다.

이번 개정에서 확인. 마지막 확인 버전은 `0.5.0-design`다.

<a id="r45"></a>

## R45 WHATWG URL Standard

[WHATWG URL Standard](https://url.spec.whatwg.org/)

상대 URL과 정규화된 URL 해석의 기준이다. 고정 route path에는 별도 제한을 적용하고 form action 속성의 빈 값 의미는 HTML 규약에서 가져온다.

이번 개정에서 확인. 마지막 확인 버전은 `0.5.0-design`다.
