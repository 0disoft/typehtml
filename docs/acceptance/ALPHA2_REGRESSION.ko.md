# alpha.2 추가 기능 회귀 점검 및 alpha.3 패키지

- 날짜: 2026-11-07 (Asia/Seoul)
- 점검 시작점: `fe9c3ca` (`0.1.0-alpha.2`)
- 패키지 소스 기준: `17d50b93b40bed096b6af99adfd3403e70447c07`
- 환경: 네이티브 Windows, Bun 1.4.4, Node.js v24.14.0
- 범위: 신규 폼/검증기/HTML 도우미, 공통 요청 경계, 프레임워크 연결, Doctor/수집/CLI/LSP, 보안/멱등성/SQLite

## 재현한 문제와 수정

| 구간 | 재현 조건과 영향 | 수정 및 회귀 검증 |
| --- | --- | --- |
| 취소와 업무 실행 | 비동기 CSRF 검증 또는 권한 확인 중 요청을 취소해도 가드가 나중에 true를 반환하면 업무 쓰기를 새로 실행함 | 권한 확인 전과 업무 시작 직전에 요청 취소 확인. 실행 전 취소에서는 효과 0회, 원래 취소 사유를 `onError`에 전달. 이미 실행 중인 효과는 재시도하거나 취소된 척하지 않음. |
| 출력 스키마 transform | `project`가 출력 스키마의 변환 후 타입을 반환하도록 강제돼, 문자열 입력을 숫자/객체로 바꾸는 정상 검증기가 500을 냄 | projected 입력 타입과 validated 출력 타입 분리. `project`는 `InferStandardInput`, `success`는 `InferStandardOutput`. 기존 flat form 기본 타입은 유지. 실제 Zod 및 설치된 declarations로 확인. |
| 중첩 반복 필드 오류 | `items[0].tags[0]` 같은 vendor 오류 경로가 반복 필드 `items[0].tags`에 연결되지 않음 | 가장 깊은 선언 배열부터 연결. 필드 오류, 요약 앵커, `aria-invalid`/설명 연결 검사. |
| radio 재표시·선택 필수 | enum 없는 string/const radio가 422에서 기본값으로 바뀌거나 미선택 상태가 됨. 빈 문자열 허용 필수 radio는 선택 필수 힌트도 빠짐 | 제출값을 선택 상태로 보존하고, 빈 값을 허용해도 그룹 선택은 required로 표시. parse5 재제출 값과 속성 검사. checkbox 그룹에는 불필요한 all-required 제약을 추가하지 않음. |
| HTML 수집 시간 제한 | 동기 렌더링이나 준비된 Promise 연쇄로 타이머 실행이 늦어지면 제한 시각을 넘긴 결과도 성공 처리 | 단조 시계로 완료/읽기/해시 계산 후에도 deadline 확인. 초과 및 늦은 Response 본문 취소 확인. 실행 중 render/fetch 콜백을 바꿔 다음 상태에 다른 동작을 주입하던 문제도 시작 시 참조 고정으로 방어. |
| Doctor required radio 판정 | disabled·checked radio가 네이티브 그룹 검증은 만족시키지만 값은 제출하지 않는 경우에 공급을 보장한다고 오판해 exit 0 | 비활성 radio까지 그룹 상태에 반영. 공급이 조건부인 경로는 unknown/exit 3. 실제 폼 fixture 회귀 검사. |
| LSP 분할 프레임 | 누적 본문을 작은 청크마다 다시 복사하여 바이트 단위 전달 시 O(N²) 복사 | 헤더 크기 제한 후 본문을 한 번 할당하고 각 바이트를 한 번 복사. 32KiB 바이트 단위 메시지에서 전체 LSP 검증의 `Buffer.concat` 호출 32,864회 → 1회. 시간 단언 없이 복사 횟수와 UTF-8·분할/합쳐진 프레임·1MiB/8KiB 경계 검사. |
| 멱등성 JSON 메모리 | 64KiB 총량 검사를 전체 문자열을 조립한 뒤 수행하여, 노드 한도 내에서도 수백 MiB 임시 문자열을 만든 후 거부 | 인코딩 중 UTF-8 누적 예산 차감. 65,536바이트 경계 유지, 초과 즉시 중단. 기존 canonical JSON과 digest 순서 유지. |
| SQLite scope 충돌 | 서로 다른 단독 surrogate를 포함한 JavaScript scope가 SQLite UTF-8 변환에서 같은 문자열로 합쳐질 수 있음 | 공통 identity 검증에서 비정상 UTF-16 scope 거부. 메모리/SQLite 일관성 및 서로 다른 유효 Unicode scope 분리 확인. |
| SQLite 원자적 경계 | 권한 확인이 immediate 트랜잭션 밖에서 수행됨. bound async 콜백 차단이 누락되고, 권한 callback이 뒤에 실행할 callback/시간 정책을 바꿀 수도 있음 | 권한 확인과 replay를 동일 immediate 트랜잭션 안에서 수행. `authorize(db)`에 같은 연결 전달, 기존 인자 없는 함수 호환. 함수/시간 정책 참조 고정, bound async 선차단. 두 연결의 잠금·권한 재확인·rollback·늦은 쓰기 차단 검사. |

## 기존 동작 비교

신규 기능 도입 전 `9814315`의 handler 소스를 별도 임시 모듈로 읽어 현재 handler와 비교했다. 동일한 현재 저수준 parser/validator/renderer를 사용하므로 이 비교는 **handler 제어 흐름과 훅 실행의 호환성**에 대한 증거다. 저수준 구현 전체의 과거/현재 차등 검증이라고 주장하지 않는다.

- 비교 수: **238개 요청 조합**, 차이 0개.
- 비교 대상: 상태 코드, 전체 응답 헤더, HTML 본문, 훅 실행 순서.
- 조합: 정상/빈 값/Unicode/범위 초과/잘못된 정수/누락/중복/모르는 키/잘못된 인코딩 및 경로·쿼리·메서드·미디어 타입·출처·Accept·인증·권한·업무 예외·출력 오류·리다이렉트·커스텀 invalid 렌더러.
- 요청 취소 후 새 효과를 차단하는 동작은 의도한 결함 수정이며, 별도 취소 회귀 테스트로 검사했다.
- 기본 synchronizer CSRF, scalar 중복 거부, unknown key 거부, 오류 응답 순서, 422 HTML 및 성공 303을 유지했다.

## 최종 검증

| 명령/검증 | 결과 |
| --- | --- |
| `bun test` | **526 pass, 0 fail, 3,636 assertions, 57 files** |
| `bun run typecheck` | 통과 |
| `bun run generate:check` | current, 생성물 변경 없음 |
| 기존 handler 차등 검사 | 238건 일치 |
| `bun run pack` | alpha.3 ESM/declarations 빌드 및 tarball 생성 |
| `bun run package:smoke` | **14개 검증 묶음 통과**, 임시 소비자 정리 완료 |
| `git diff --check` | 통과 |
| `docs/design/v0.5/` | 변경 없음 |

Fresh npm/Bun 소비자 각각에서 Node/Bun으로 기존 API, 새 중첩/반복/불리언 입력, 서명 CSRF, 멱등성 재호출, adapter exports와 실제 Node 소켓을 검사했다. 이번에는 출력 스키마 입력/변환 후 타입이 다른 사례도 실행 및 declaration 타입 검사(`skipLibCheck=false`)에 추가했다. Bun SQLite의 원자적 처리·재호출 및 Node의 Bun 전용 경로 거부, 설치 CLI/Doctor SARIF, 독립 starter 흐름도 통과했다.

## 갱신된 설치 패키지

- 패키지: `@0disoft/typehtml@0.1.0-alpha.3`
- 파일: `artifacts/0disoft-typehtml-0.1.0-alpha.3.tgz`
- 크기: **142,832 bytes**
- SHA-256: `583c23619a783ba7847a08386c1907217446b70895fc9b1b95df42ab71191f83`
- alpha.2 archive는 비교용으로 유지. npm 공개 배포와 Git push는 실행하지 않음.

## 범위의 한계

검사 범위에서 확인한 결함은 수정했다. 모든 입력이나 모든 호스트 앱에서 결함이 없다는 증명은 아니다. Node 22 최소 버전 직접 실행, Linux/macOS, 각 프레임워크 전체 앱 빌드, 실제 편집기별 LSP, GitHub SARIF 업로드 및 외부 저장소 공급자 연결은 미실행이다. 기존 정적 Doctor 프로필/렌더 상태의 범위, 외부 효과의 exactly-once 비보장, 범위 밖 P0 결정은 변경하지 않았다.
