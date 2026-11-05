# 진단은 어떤 폼의 어떤 제출을 읽었는지 설명해야 한다

Doctor의 최소 제품은 정적 form과 입력 계약 사이의 연결을 읽는 CLI다. 실행 래퍼·DB·서버 import 분석은 필수가 아니다. P0는 BC010~BC013에 집중하고, 기존 parser·lint·tsc를 재구현하지 않는다.

## 입력 연결을 먼저 확정한다

`documents[].bindings[]`가 파일·form ID·의도한 action ID를 연결한다. 실제 action을 검색 조건으로 삼지 않는다. 예상 form이 사라졌거나 중복이면 BC014이며 검사 대상 0건 성공으로 끝내지 않는다. 이 작은 수동 mapping도 도입 비용으로 기록한다.

`documentUrl`, source hash, sourceKind, 실행 가정과 각각의 submitter를 기록한다. 계약의 목적지와 폼에서 해석한 목적지는 별개 필드다. raw action·base·유효 URL의 근거를 함께 보존한다. 템플릿 원본 위치가 없으면 rendered snapshot 위치라고 쓰고 가상의 source map을 만들지 않는다.

## SubmissionFact의 최소 형태

| 필드 | 의미 |
| --- | --- |
| artifact | 파일, SHA256, 원본/렌더 스냅샷 구분, 선택적 생성 근거 |
| intendedAction | form에 독립적으로 연결한 action ID |
| formIdentity | form ID와 위치, 유일성 상태 |
| context | document URL, 적용 base, script·native 가정 |
| activation | explicit submitter 또는 지원하는 implicit 경로 |
| effectiveTarget | origin·method·pathname·query·encoding·validation mode |
| fields | name별 공급 개수 범위와 source span, 고정/사용자 편집값 구분 |
| evaluations | 규칙별 checked·unknown·unsupported·not-evaluated |

값이 없는 정보는 추론해서 채우지 않는다. `count=[0,1]`은 항상 존재한다는 뜻이 아니다. 허용되지 않는 임의 동적 분기에서 count를 계산하려고 전체 프로그램 분석을 시작하지 않는다. 부분적으로 아는 규칙만 계속 진행한다.

## 결과의 네 축

| 축 | 값과 용도 |
| --- | --- |
| outcome | defect·no-finding·inconclusive·not-applicable |
| analysisStatus | checked·unknown·unsupported·not-evaluated |
| certainty | confirmed·conditional·none |
| severity | error·warning·info |

confirmed는 증거의 범위이고 error는 프로젝트의 차단 정책이다. 둘을 같게 취급하지 않는다. 예를 들어 확정한 UI 입력 범위 차이는 warning, 필수 입력의 확정 공급 누락은 error다. 한 form에 custom element가 있어 cardinality가 미지원이어도 독립적으로 확정한 외부 origin 오류까지 지우지 않는다.

## 진단 카탈로그

| ID | 내용 | 기본 처리 |
| --- | --- | --- |
| BC001·BC002 | 서버 소유 입력 충돌, codec 계약 오류 | 전체 계약을 읽은 경우 error |
| BC003 | 실제 역할 타입 불일치 | 원래 tsc 코드·출처 유지 |
| BC010 | required key를 공급할 수 없음 | supported 경로의 확정 오류 |
| BC011 | 유효 목적지·미등록 키·중복 scalar | 경로·subcode와 함께 error |
| BC012 | 미지원 transport·control 의미 | unsupported, 취약점 개수에 합치지 않음 |
| BC013 | 한정된 제약의 구체 반례 | 기본 warning, 전체 동치 주장 금지 |
| BC014 | 선언한 form/action binding 없음·중복 | 명시적 연결 오류 |
| BC020 | 서버 오류 필드와 화면 연결 결함 | 오류 mapping 제공 시 검사 |
| BC021 | HTML·접근성 기존 엔진 진단 | 원래 엔진·rule ID 보존 |
| BC030 | 민감 입력명 휴리스틱 | warning, 권한 판정 아님 |
| BC101~BC103 | 알려진 execute·route·writer 우회 | 후속 scanner, 초기 form-only는 미평가 |
| BC190·BC191 | 동적 등록·JS 직렬화·snapshot 바깥 상태 | 해당 규칙의 gap |
| BC193 | stale source·파생물 | 영향받는 연결 검사 중단 |

## 허용하는 주장

이 snapshot과 선택한 submitter의 native 경로에서 required quantity가 공급되지 않는다는 주장은 가능하다. 이 애플리케이션의 모든 폼과 모든 상태가 안전하다는 주장은 대상이 아니다. 외부 JS의 존재만으로 정적인 원문 오류가 사라지지도 않는다. local-native 결과에 실행 전제를 붙이고 runtime 경로의 complete 상태는 주지 않는다.

스크립트가 없는 파일 한 장은 HTTP CSP·다른 template branch·서비스워커·DOM 주입의 부재를 증명하지 않는다. 릴리스 gate는 개발자가 명시한 문서와 규칙 그룹만 요구한다. 미설정 전체 애플리케이션을 보호했다고 표시하지 않는다. markup-only 검사는 토큰 유효성·인증·정책·SQL을 평가하지 않는다.

## 반례와 오류 수정

반례에는 input 문자열·codec·서버 schema pointer·관련 HTML span·검증 활성 조건을 적는다. 실제 비밀 값과 사용자 body는 기록하지 않는다. 문자열 샘플은 길이를 제한하며 테스트용 값임을 표시한다. BC013은 기본적으로 설명만 하고 HTML을 자동 변경하지 않는다.

suppression은 rule ID·action·문서·submitter 범위·사유를 가진다. source가 달라지면 재확인이 필요하다. ignore는 finding을 숨기는 UI 설정일 뿐 checked coverage를 늘리지 않는다. 광범위 wildcard suppression은 strict gate에서 따로 표시한다. 보안 가정을 suppression으로 덮어쓰지 않는다.

## 실행 권한과 출력

CLI는 JSON 구성·정적 export만 읽고 사용자 TS/JS 설정·schema exporter·package script를 실행하지 않는다. 파일·전체 크기 제한과 repository 밖 symlink 거부를 유지한다. 캐시는 내용·파서·설정·projection·문서 URL·실행 가정의 hash를 포함한다.

명시적 별도 typecheck만 tsc를 실행한다. 표준 출력은 하나의 기계용 JSON, 진행은 stderr다. exit 2는 설정·실행 오류, exit 1은 확정 차단 진단, exit 3은 요구한 경계의 분석 미완료, exit 0은 해당 gate에 차단이 없다는 뜻이다. 동시에 나타나면 2, 1, 3 순으로 코드를 선택하고 JSON에는 모두 남긴다. 기본 audit의 partial exit 0도 분석 상태를 숨기지 않는다.

## 공로와 조사 범위

`engineOrigin`, `originalRuleId`, `causeKey`, `stage`, `evidenceRef`를 유지한다. comparativeValue는 실제 B/L/S/D 비교에서만 채운다. no-finding은 safe가 아니며, 한 원인을 여러 rule이 보고해도 추가 결함은 하나다.

경로 수는 form·submitter·implicit·미지원 control·미조사 상태를 구분한다. 수집하지 못한 전체 분모로 탐지율을 만들지 않는다. [기대 진단](../examples/diagnostic-attribution.expected.json)과 [커버리지 형식](../examples/coverage.expected.json)은 작성한 설계 예시다. [참고 실행·브라우저 차단 기록](../validation/REPORT.ko.md)은 Doctor 실행 결과가 아니다.

## v0.5의 빈 분석과 증거 대상 검증

명시적 binding이 0개면 설정 오류다. binding이 있지만 모든 native activation이 미지원·비활성으로 빠지면 요구한 경로 분석은 incomplete다. vacuous success를 만들지 않는다. 경로별 결함 판정과 실제 native 제출 가능성은 별도 증거이며 하나를 다른 것으로 대신하지 않는다.

v0.4 coverage 예시의 `#order-form`은 실제 예제 ID `#create-draft`와 달랐다. v0.5는 예시를 수정하고 문서 경로·form ID를 실제 구성과 대조하는 패키지 검사를 추가했다. 이는 authored expectation의 일관성 확인이며 Doctor 실행 결과가 아니다. BC014를 구현했다는 증거로 집계하지 않는다.

P0의 차단 대상은 binding·target·supply·cardinality이며 미지원 control을 모두 구현할 필요는 없다. URL 참고 함수·상태 참고 함수·SQL 실행 결과를 Doctor 탐지 건수에 합치지 않는다. 실제 비교는 기존 B/L/S/D의 동일한 세 변경 과제로 유지한다.
