# 분석 엔진과 실행 래퍼를 먼저 분리한다

하나의 저장소 안에서 작은 모듈 경계를 사용한다. 별도 패키지 여러 개를 먼저 배포하지 않는다. 분석기는 계약·폼·route에서 확인한 사실만 IR에 넣고, 런타임은 HTTP·인증·DB·응답을 처리한다.

## 초기 모듈

| 모듈 | 책임 |
| --- | --- |
| contract | 데이터 검증, 지원 keyword, 폼 검사 projection과 선택적 runtime 계약 |
| runtime | 순서 고정, codec, 권한·투영 포트, error mapping |
| adapter/hono | Request·Response와 route 조립 |
| adapter/sqlite | 동기 트랜잭션, CAS, intent·결과 저장 |
| doctor/html | 폼 사실, 소유자·submitter, field-error 연결 |
| doctor/ts | 알려진 import·route·execute 호출 연결 |
| diagnostics | confirmed·conditional·unknown과 원본 위치 |
| cli | 읽기 범위·캐시·취소·JSON 출력 |

server emitter 디렉터리는 P3 승인 전 만들지 않아도 된다. 기본 경로는 `정본 → typed wrapper 조립`과 `정본 + 폼 + route → doctor`다. 단순 schema-to-type 참고 스크립트는 데이터 중복 방지용이며 제품 compiler로 배포하지 않는다.

## IR을 구현 범위에 맞춘다

ActionContract, FormPath, RouteFact, BindingFact, CoverageGap, Diagnostic만 초기 필수 구조다. BindingFact에는 역할·심볼·타입 검사 상태를 넣는다. 값 전체의 OriginSet·Audience 라벨 전파는 없다. 판정 근거가 없는 정보는 unknown으로 남긴다.

HTML에는 기존 표준 파서, TS 구문에는 프로젝트에서 검증한 파서를 사용한다. Oxc를 HTML 파서나 TypeScript의 의미 타입 검사기로 취급하지 않는다. AST 사실과 tsc 결과를 합쳐 설명하되 한쪽의 성공으로 다른 쪽을 실행했다고 표시하지 않는다. 새 tokenizer·번들러·라우터는 만들지 않는다.

## TypeScript 경계

2026년 11월 5일 확인한 공식 자료는 TypeScript 7.0의 프로그램 API 부재와 7.1 베타의 새 API·content mapper를 구분한다. 첫 구현은 stable CLI의 일반 TS 타입 검사를 사용하고 7.1 베타 API를 필수로 넣지 않는다. [R23](13_SOURCES.ko.md#r23) [R24](13_SOURCES.ko.md#r24)

이번 개정은 환경에 설치된 tsc로 참고 예제를 다시 검사하고 실제 버전을 기록한다. v0.2의 DNS 오류는 당시 기록이다. v0.5에서는 새 도구 설치를 시도하지 않으며 이전 네트워크 실패를 새 실행 사실로 재사용하지 않는다. 최신 목표 도구의 호환성은 별도 미검증이고, 구형 참고 검사를 제품 버전 선택으로 삼지 않는다.

새 프로젝트의 도구체인은 Bun과 안정 메이저 범위를 기본으로 한다. lockfile은 실제 버전과 무결성을 기록하고 같은 메이저 업데이트를 묶어 반영한다. 기존 프로젝트의 package manager는 바꾸지 않는다. 실제 패키지 설치를 수행하지 않았으므로 가짜 lockfile을 만들지 않았다.

## 캐시와 실행 권한

캐시 키에 파일 콘텐츠·설정·엔진·어댑터·파서·계약·schema snapshot 해시를 포함한다. mtime만 보지 않는다. schema exporter의 전이 의존이 바뀌면 스냅샷이 stale인지 확인하고 불완전한 의존 목록이면 exact라고 표시하지 않는다.

읽기 전용 scanner는 작업 폴더 밖 symlink를 따라가지 않고, 기본적으로 build output·node_modules·대형 바이너리를 제외한다. 초기 자원 제한은 파일당 2 MiB, 전체 100 MiB이며 조정 가능하다. 제한에 걸린 파일을 분석 성공 0건으로 삼지 않고 부분 결과와 함께 보고한다.

생성기 실험을 추가할 때도 임시 폴더에 출력하고 tsc·hash 일치를 확인한 뒤 묶음으로 교체한다. 런타임 공개 메타데이터에는 서버 import 경로·세션 설정·policy 내부를 넣지 않는다. 작업 manifest와 브라우저 공개 데이터는 별도 산출물이다.

## 어댑터 확장

일반 HTML 이후 Svelte·Astro 중 실제 앱에서 필요한 하나를 택한다. parser 연결뿐 아니라 제출 본문·action routing·HTML/JSON 오류·redirect 처리·CSRF 중복 적용을 함께 맞춰야 한다. Workers는 SQLite 파일 어댑터를 그대로 실행하지 못하므로 별도 저장소·원자성 검토가 필요하다. 구현하지 않은 어댑터를 플랫폼 독립이라는 이름으로 지원 목록에 넣지 않는다.

## 검사 입력은 저장소 실행 profile과 독립시킨다

FormCheckInput은 action·HTTP 전송·input schema/codec·protocol key·source 정보만 담는다. 이 구조를 읽는 CLI는 Bun SQLite 모듈을 import하지 않는다. runtime full contract는 이 구조의 공급원 중 하나이며, 기존 JSON Schema와 명시적 route mapping도 공급원 후보다. 현재 패키지에서는 전자만 작은 파생 스크립트로 보여준다.

실제 CLI의 Node·Bun·Windows 지원은 구현 후 해당 경로에서 확인한다. 순수 데이터 구조를 분리했다는 사실만으로 모든 런타임에서 실행됐다고 말하지 않는다. P0의 reference memory port는 비교용이며 운영 adapter의 대체물이 아니다.

## 원격 DB로 옮기는 경로를 설계하되 지금 구현하지 않는다

| profile | 역할의 실행 형태 | 배포 전제 | 현재 상태 |
| --- | --- | --- | --- |
| form-check-only | 파일·schema 정적 분석 | DB 없음 | 입력 설계·단일 정본 projection 예제 |
| sqlite-local-sync | 현재 동기 BindingRoleMap | Bun·동일 호스트·단일 DB | 타입·SQL 참고안, 운영 미구현 |
| postgres-async | 별도 비동기 DB 역할 map | 동일 transaction client와 명시적 격리 정책 | 후속 설계 |
| Workers 계열 | 해당 저장소의 원자성 모델에 맞춘 별도 coordinator | 플랫폼별 제약 검토 | 미지원 |

PostgreSQL로 갈 때 기존 동기 callback을 Promise로 감싸는 일만으로 완료하지 않는다. node-postgres는 같은 client로 transaction의 모든 query를 실행하도록 요구한다. Read Committed와 더 높은 격리 수준에서 보이는 상태·충돌·재시도가 다르므로 잠금과 정책 재검사를 새로 검토해야 한다. [R34](13_SOURCES.ko.md#r34) [R35](13_SOURCES.ko.md#r35)

## 이식 시 보존할 불변식과 다시 구현할 부분

| 불변식 | SQLite 참고 설계 | 비동기 SQL에서 필요한 작업 |
| --- | --- | --- |
| 같은 intent로 업무 완료 한 번 | 단일 writer와 결과 PK | intent row 잠금/고유 제약과 같은 transaction 내 결과 저장 |
| 정책 판단과 실제 변경의 일치 | transaction 안 현재 조회·revision 조건 | membership·resource 변경까지 다루는 row lock 또는 명시적 격리/CAS 전략 |
| 업무·intent·결과·감사의 원자성 | 하나의 파일·하나의 transaction | 같은 DB·같은 client·같은 commit, 별도 감사 DB는 범위 밖 |
| 이전 성공 재응답의 권한 | 현재 loadReceipt·authorizeReceipt | 동일하게 현재 권한 확인, 오래된 응답 cache만 반환하지 않음 |
| commit 응답 유실 | 동일 intent 결과 재조회 | 불확실한 commit 결과를 조회한 뒤 결정, 새 키로 맹목 재실행 금지 |
| 숫자·시간 의미 | JS safe integer·초 단위 TTL | DB bigint·문자열·timestamp 변환 및 codec 재확인 |

후속 첫 후보는 intent 잠금 → 회원/리소스 조회와 동시 변경 방어 → 정책 → revision 조건 변경 → 투영 → 결과/감사 → commit 순서다. 잠금 순서는 다른 writer와 함께 정하고, 정책에서 읽은 행의 변경을 포함해 검토한다. READ COMMITTED의 단순 SELECT와 product revision 하나가 회원 자격 변경까지 막는다고 가정하지 않는다.

deadlock·serialization failure의 재시도는 전체 DB 작업이 되돌려졌고 외부 부수효과가 없는 경우에만 예산 안에서 수행한다. callback 안에 결제·메일을 넣어 재실행하지 않는다. commit 여부가 불명확한 경우는 일반 rollback 재시도와 다른 경로다. 이 규약은 설계 제안이고 실행된 PostgreSQL 보장은 없다.

## 이식 비용을 숨기지 않는다

보존 가능한 것은 schema 의미·폼 검사·응답 모델·진단 분류다. 다시 작성할 부분은 async 역할 타입, coordinator, query·migration, lock/retry, commit 복구, 최소 두 연결 사례다. 운영 이관에는 intent TTL·기존 결과·업무 ID의 유지와 rollback 계획도 필요하다. 이 비용을 단순 설정 교체로 설명하지 않는다.

실제 첫 서비스의 저장소 요구가 SQLite를 배제한다는 사실이 확인되면 어댑터 하나를 재선택한다. 이를 이유로 P0에서 범용 DB 추상화나 모든 profile의 union 타입을 구현하지 않는다. schema·doctor 입력 분리만 먼저 유지한다.


## provenance와 cache 경계

form AST cache와 contract validation cache를 나눈다. 합성 진단 cache에는 원본 파일·설정·파서 버전·projection digest·document URL·form binding·실행 가정이 들어간다. source byte hash는 freshness용, behavior digest는 runtime intent 호환성용이며 서로 대체하지 않는다.

file snapshot은 원문 hash와 파싱 종료 시 hash를 비교해 중간 변경을 감지한다. 파일이 바뀌면 그 파일 결과를 버리고 한 번 재시도하거나 변경 중 상태를 보고한다. 실행 중인 소스가 바뀌었는데 예전 진단을 현재 결과로 반환하지 않는다. schema importer는 코드·network·원격 ref를 실행하지 않는다.

initial modules 중 P0에 실제 필요한 것은 projection reader·표준 HTML parser·제한된 native-form 사실·진단이다. doctor/ts·호출 그래프·DB module을 미리 만들어 공통 엔진이라고 부르지 않는다. 저장소를 먼저 여러 package로 나누지도 않는다.

## v0.5의 상태와 effect 경계

intent-state/2의 순수 판정은 검증된 snapshot의 분기만 담당한다. DB 읽기·auth·grant·HTML·HTTP는 coordinator와 어댑터 책임이다. 한 판정 함수에 network나 DB를 숨겨 테스트를 무겁게 만들지 않는다. 실제 coordinator가 fresh snapshot과 쓰기 재검사를 연결했는지는 P1에서 확인한다.

page resolver도 판정된 union을 반환하며 renderer는 DB 상태를 변경하지 않는다. 동기 역할에는 타입과 반환값 검사를 함께 사용한다. 검사기 CLI에는 이 runtime 모듈들을 로딩하지 않는다. 정본 reader의 duplicate-key 정책은 exporter·형식 검증·digest 계산에서 일치시킨다.
