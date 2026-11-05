# v0.5 구현 재대조

- 날짜: 2026-11-06 (Asia/Seoul).
- 기준: 첨부 `typehtml-research-design-v0.5-2026-11-05.zip`의 79개 파일을 `docs/design/v0.5/`와 SHA-256으로 비교했고 모두 일치했다. 설계 스냅샷은 변경하지 않았다.
- 시작 commit: `e79c924`. 기존 테스트 97개가 통과하는 상태에서도 아래 누락과 오구현을 재현했다.
- 대상: 설계의 form-only Doctor와 선택된 동기 Bun SQLite/Hono 주문 P1 참조 구현. 제품 적합성이나 운영 배포 완료를 주장하지 않는다.

## 구현·수정한 연결

| 영역 | 반영한 동작 |
| --- | --- |
| 정본·파생물 | 2 MiB를 읽기 전에 적용, 정수 표기·문자열 literal·protocol/input 충돌·영수증 route 검증. 정본에서 타입·두 form-check·digest 생성 및 check 명령. 생성 디렉터리 묶음 교체, 관련 없는 파일·정본·설계 snapshot 보호, junction 회귀 검사 |
| Doctor | 정본 byte hash·behavior digest·실제 projection 검증, 파싱 후 파일 재확인. 제출별 source/activation/target/field 근거와 schema pointer를 보존. optional binding·필수 규칙 gate·미지원 경로·진단 상한·부분 실행 실패 처리 |
| native form | form owner·중복 ID·fieldset/첫 legend·datalist·reset·implicit/default submitter·빈 formaction·base·fragment 처리. radio/select 등의 미지원 의미를 확정 결함으로 오판하지 않음. native step·readonly·검증 활성 상태를 반영한 제한된 정수 반례 |
| HTTP·화면 | 계약에 선언한 route 사용, query 중복/혼합/미등록 키 및 begin 미등록 필드 거부. method/전송 사전 검사. 최신 권한·revision·완료 상태가 422를 덮어씀. text 수량 입력·pattern·오류 요약·설명 ID·공개 숫자 escape·재시도 안내 |
| 제한·세션 | 공유 가능한 계정 rate-limit port와 ingress/IP hook, 참조 sliding window, transaction 안 OPEN intent 상한. 로그인도 엄격·제한된 parser 사용, 로그인 epoch의 이전 세션 폐기, 세션 회전 원자성, 비밀번호 검증 중 철회 재확인, HTTPS Secure cookie |
| 권한·투영 | 완료 POST 재응답의 현재 영수증 권한·투영 확인. 시작/작성 화면 view schema 검증. 잘못된 주문 ID를 내보내는 projector와 accessor 출력 거부. 검증된 입력·principal·resource·결과 복사본 동결 |
| transaction | 실행 직후 동기 반환 검사, 종료된 Tx handle·내부 DB·발급 함수 유출 경로 차단. transaction identity에 등록된 동결 Grant의 1회 사용과 principal/session/resource/revision/input hash 검사. CAS·초안·소비·결과·감사 원자성 유지 |
| 복구 | 업무 clock과 독립된 writer 예산. rollback이 transaction을 남기면 연결 격리·강제 종료. COMMIT 결과 불명은 새 연결에서 같은 intent만 재조회하며 업무 callback을 내부에서 재실행하지 않음 |

## 실행한 검증

| 검사 | 결과 |
| --- | --- |
| `bun test` | **165 pass, 0 fail, 557 expect, 22 files** |
| `bun run typecheck` | exit 0 |
| `bun run generate:check` | `status=current`, exit 0 |
| 설계 예제 Doctor | 3 documents / 3 forms / 3 paths, findings 0, exit 0 |
| 생성→실제 renderer→Doctor 연결 | root-relative 정본 출처가 일치하고 start/form 두 경로 findings 0. 진단에 CSRF 원문 없음 |
| 실제 SQLite | 두 writer 경합, 고정 clock 예산, projection rollback, 실제 COMMIT 전/후 오류 주입, rollback 실패 뒤 다른 연결 writer 획득, 위조·복제·재사용·다른 transaction Grant 거부 |
| 실제 소켓 | 임시 `Bun.serve`와 fetch로 로그인부터 영수증까지 실행하고 서버 종료 |
| 실제 브라우저 | Playwright의 새 browser context에서 `javaScriptEnabled=false`. 로그인→begin→form 새로고침→탭 복제→수량 21의 native 제출 차단→수량 2의 Tab/Space 제출→KRW 24000 영수증. 복제 탭 재제출과 완료 intent GET도 같은 영수증. 화면 script 0개 |
| 작업 범위 | Git diff 공백 검사 통과. 설계 snapshot·의존성·lockfile 변경 없음. 배포·push 없음 |

브라우저는 HTTP/화면 흐름 확인이며 transaction fault injection을 대신하지 않는다. 실제 스크린리더 낭독과 물리 전원 손실 시험은 실행하지 않았다. 기존 벤치마크 수치는 이번 변경의 성능 결과로 재사용하지 않는다.

## 남겨 둔 지원 경계

- P0a/P0b와 물리 전원 손실은 기존 소유자 범위 결정대로 제외했다. P0 결과를 합성하거나 통과로 바꾸지 않았다.
- checkbox/radio/select/textarea/file·사용자 JS 직렬화·Shadow DOM·임의 regex 동치는 초기 Doctor 지원 대상이 아니다. unknown/unsupported로 보고하며 필수 gate의 완료로 세지 않는다.
- TS 호출 그래프·route/execute 우회 scanner, 기존 lint/접근성 엔진 취합, 오류 mapping 없는 BC020은 form-only 분석 범위에 포함하지 않는다. 외부 엔진을 실행했다는 주장도 하지 않는다.
- 기본 rate limiter는 앱 인스턴스의 메모리에 있다. 동일 tenant/subject/action을 묶고 활성 key 수를 제한한다. 운영 공유 저장소·신뢰할 IP 판별은 `rateLimiter`/`requestLimit` hook의 호스트 책임이다.
- 외부 IdP/OAuth, 운영 다중 인스턴스 배포, PostgreSQL/Workers, 서버 생성기·SDK 배포는 이번 참조 구현 범위가 아니다.
- Grant/Tx 방어는 어댑터의 공개 실행 경계를 지킨다. 신뢰 callback의 임의 외부 I/O나 별도 DB 직접 접근을 sandbox로 차단한다고 주장하지 않는다.

브라우저 시험 서버와 context는 종료했다. 시험 DB `C:/Users/cherr/AppData/Local/Temp/typehtml-design-audit-01a1ad64.sqlite` 삭제는 자동 승인 검토의 정책 차단으로 실행하지 못해 Temp에 남겼다. 합성 demo 데이터만 사용했다.
