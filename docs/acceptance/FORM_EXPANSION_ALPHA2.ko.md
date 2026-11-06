# 폼 확장 및 설치 패키지 검증 — 0.1.0-alpha.2

- 날짜: 2026-11-07 (Asia/Seoul)
- 요청: 추천 순서에 따라 미구현 기능 추가, 기존 동작 보존, npm 공개 배포 없이 설치 패키지 완성
- 패키지 소스 기준: `6e856467900bfd122d769f11515e6221817c9c73`
- 환경: 네이티브 Windows, Bun 1.4.4, Node.js v24.14.0
- 배포 상태: 로컬 tarball만 생성. npm publish 및 Git push 실행하지 않음.

## 구현 범위

| 제안 | 구현 | 보장 범위 |
| --- | --- | --- |
| 계약 → HTML 속성 | `getFormProps`, `getFieldProps`, `getSchemaFieldProps`, `getOptionProps`, `renderAttributes` | 서버 계약이 기준. Unicode 코드 포인트와 브라우저 UTF-16 길이 차이를 보수적으로 처리. 임의 검증기의 제약을 추측하지 않음. |
| Standard Schema | `defineSchemaForm`, `createSchemaFormHandler`, `validateStandard`, 타입 추론 | 실제 Zod 4·Valibot 1·ArkType 2로 성공/실패 검증. 필드 allowlist와 코덱은 명시적. 외부 라이브러리는 소비자가 선택. |
| 오류 상태·다국어 | `createFormState`, 오류 요약/필드 도우미, `errors` 옵션 | 기존 기본 422 유지. 입력값 escape, 접근성 속성, 사용자 문구/locale 지원. |
| 컨트롤·자료형 확장 | scalar textarea/select/radio/checkbox, 불리언, 반복 배열, 고정 중첩 경로 | scalar/프로토콜 중복은 계속 거부. 배열 순서·중복 보존. 없는 선택 scalar를 빈 값으로 바꾸지 않음. prototype 경로·겹친 경로·희소 배열 방어. |
| 프레임워크 연결 | Hono, Astro endpoint, React Router resource route, SvelteKit endpoint, Node/Express, Fastify | 표준 Request/Response 또는 원본 Node 스트림을 연결. 프레임워크 고유 action-data/반응성 모델을 생성하지 않음. |
| 렌더 HTML 수집 | `collectRenderedHtml`, `writeRenderedCollection`, CLI `capture` | 명시한 URL/상태만 GET 또는 호스트 렌더 callback으로 수집. 출처 allowlist, 취소, 시간/바이트/동시 실행 제한. |
| Doctor 개발 도구 | `--format json|text|sarif`, `--watch`, stdio `lsp` | SARIF 2.1.0, 기존 종료 코드 유지. watch는 선택 의존성만 직렬 재검사. LSP는 저장된 스냅샷 진단. |
| 범용 멱등성 | atomic store 계약, 메모리/SQLite 구현, `executeIdempotent`, `executeAtomic` | 원자적 claim, fencing CAS, 매 호출 권한 확인. 불확실/만료 키 자동 재사용 금지. SQLite 동일 DB 업무/결과 기록 원자화. |
| 보안 도우미 | 세션 결합 서명 CSRF, 제한기 인터페이스/메모리 구현, 유한 대기 래퍼 | Origin/Fetch Metadata와 기존 synchronizer 비교 유지. 서명 검증·rate limit은 opt-in. 장애 cause 및 취소 사유 보존. |

기존 `defineForm`과 `createFormHandler`는 공통 경계를 재사용한다. 기존 route/method/query/Accept → 전송 헤더 → Origin → 인증 → 본문 → CSRF → 입력 → 권한 → 업무 → 출력 → 303 순서는 기본 설정에서 유지한다. 추가 rate-limit은 선택한 경우 인증 다음에만 실행한다. 기본 `_bc_request` 거부는 유지하며, 정의의 `protocol: { requestKey: 'required' }` 또는 handler의 `acceptRequestKey: true`로 명시적으로 활성화한다. 정의에 선언한 프로토콜은 정적 manifest와 Doctor projection에도 포함된다.

## 회귀 및 경계 검증

| 실행 | 결과 |
| --- | --- |
| `bun test` | **498 pass, 0 fail, 3,551 assertions, 55 files** |
| `bun run typecheck` | 통과 |
| `bun run generate:check` | `current`, 생성 파일 변경 없음 |
| `bun run pack` | ESM 및 declarations 빌드, alpha.2 tarball 생성 |
| `bun run package:smoke` | **14개 검증 묶음 통과**, 임시 소비자 정리 완료 |
| `git diff --check` | 통과 |
| 불변 설계 스냅샷 | `docs/design/v0.5/` 변경 없음 |

추가 검증에는 다음이 포함된다.

- parse5로 재표시 HTML을 다시 읽어 성공 컨트롤의 순서·중복, textarea 첫 줄바꿈, 잘못된 enum/불리언 값, 명시적 false 토큰 보존 확인.
- 정수 범위 직전·경계·직후, 반복 값 최대 개수, 희소 배열, 위험 경로 및 설정 객체 getter/순환 방어.
- 비동기 검증 취소/시간 초과, 타이머·리스너 정리, 원본 예외 보존.
- 멱등성 동시 제출, 느린 claim 이후 만료, 취소 이후 결과 회수, 손상된 결과, 불확실한 실행 재시도 차단.
- SQLite 동시 연결 fencing, 업무/결과 트랜잭션 rollback, async 콜백 오용 차단.
- 실제 Hono 경로와 Node HTTP 소켓에서 303/422/400/413, 복수 쿠키, 출력 시간 초과, 연결 종료 정리, 늦은 응답 본문 취소.
- 실제 HTTP HTML 응답 → CLI capture → 생성 설정 → Doctor SARIF 검증, watch 복구 및 LSP framing/진단/종료.
- fresh npm/Bun 설치 소비자 각각에서 Node/Bun 실행: 구 API, 새 폼/중첩/배열/불리언, 서명 CSRF, 멱등성 replay, 공개 adapters 및 실제 소켓.
- 설치된 declarations의 정상/오류 타입 추론 검사(`skipLibCheck=false`). 검사 전용 Zod/Valibot/ArkType·TypeScript 개발 의존성이 tarball 소비자로 유출되지 않음.
- 설치 CLI init → generate/check → Doctor → 독립 Bun starter의 GET 200, 422 재표시, 303, 공개 receipt 200.

## 설치 산출물

- 파일: `artifacts/0disoft-typehtml-0.1.0-alpha.2.tgz`
- 크기: **140,718 bytes**
- SHA-256: `4bdcd07e32838358c72602be911dffdbb1dc6e60d8182c70e8111a8d5a4df46e`
- 소비자 사용법: 패키지에 포함된 `docs/FORM_INTEGRATIONS.md`.

## 한계 및 미실행 범위

- Doctor의 source-verified manifest는 평면 문자열·정수 프로필이다. 중첩·배열·불리언 runtime 정의를 평면 프로필로 내보내려 하면 명시적으로 거부한다. Standard Schema refinement/transform과 업무·출력 동작은 정적 검증 증거가 아니다.
- 렌더 수집은 명시한 상태만 다룬다. JSX/TSX/Astro 소스 파서, 모든 경로 발견, 스크립트 실행, 애플리케이션 전체 완전성 증명을 추가하지 않았다. LSP는 저장되지 않은 버퍼를 해석하지 않는다.
- Astro/SvelteKit/React Router/Fastify/Express 전체 애플리케이션 빌드 및 모든 프레임워크 버전 조합은 미실행이다. 표준 연결 계약과 원본 Node 전송은 검사했으며, 실제 Hono 및 Node 소켓은 실행했다.
- Redis/PostgreSQL/D1/KV 공급자별 어댑터와 실제 서비스 연결은 포함하지 않는다. 원자적·지속성 있는 store 계약을 제공하며, 메모리는 개발용, SQLite는 Bun용이다. 원자적 조정이 없는 KV는 멱등성 보장을 충족하지 못한다.
- 외부 결제·이메일 등의 효과와 결과 기록 사이에 범용 exactly-once를 주장하지 않는다. 동일 SQLite DB 경계 밖 효과는 호스트의 outbox/후속 멱등성 설계가 필요하다.
- Node 최소 지원 버전 22에서의 직접 실행, Linux/macOS 실행, 실제 편집기별 LSP 연결, GitHub SARIF 업로드는 미실행이다.
- P0 및 전원 손실 실험은 기존 소유자 결정대로 범위 밖이다. 이번 테스트는 제품 적합성 증거로 제시하지 않는다.
