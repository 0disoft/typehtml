# P1 참조 런타임 실행 기록

- 날짜: 2026-11-05
- 대상: `src/runtime/`, `src/adapter/sqlite/`, `src/adapter/hono/`, `src/render/`, `examples/order-app.ts`
- 설계 기준: `docs/design/v0.5/`
- 환경: Bun 1.4.4, TypeScript 7.0.2, SQLite(Bun 내장), Windows
- 판정: **참조 구현 실행됨.** P0a/P0b 비교는 실제 대상 프로젝트가 없어 구현 목표에서 제외했고, 제품 적합성 주장으로 쓰지 않는다.

이 문서는 실행한 것과 실행하지 않은 것을 구분한다. P1 구현이 P0a/P0b의 B/L/S/D 비교를 대체하지 않는다.

## 실행한 검사

| 검사 | 명령 | 결과 |
| --- | --- | --- |
| 전체 테스트 | `bun test` | 93 pass, 0 fail, 272 expect, 16 files |
| 정적 타입 | `bun run typecheck` | exit 0 |
| Doctor 설계 예제 | `cd docs/design/v0.5 && bun ../../../src/cli.ts doctor --config examples/doctor.config.json` | exit 0, findings 0, 3 documents / 3 forms / 3 bindings |
| 주문 흐름 | `test/runtime/order-flow.test.ts` | start, begin, 422 재시도, 303, replay, 만료 410, revision 409, 영수증 보존 |
| HTTP 어댑터 | `test/adapter/order-app.test.ts` | start HTML escape, begin/invalid/valid/receipt, 406, null Origin 403, no session 401 |
| 요청 사례 행렬 | `test/adapter/order-app.test.ts` | malformed/unknown/proto/reserved 400, exponent/empty 422, bad CSRF 403, multipart 415, oversized 413, invalid UTF-8 400, unknown intent 410, replay 303, different input 409, other tenant 404, same-origin Referer 303, missing source 403, revoked receipt 404 |
| 실제 소켓 | `test/e2e/order-socket.test.ts` | `Bun.serve` 포트 0 + `fetch`로 login 303, start 200, begin 303, form 200, submit 303, receipt 200 / KRW 24000 |
| 실제 브라우저 | DSH 내장 Chromium으로 수동 실행 | 로그인 폼(테넌트/사용자/비밀번호) 제출 → start → form → keyboard Tab+Space → receipt 200. 접근성 트리에서 `spinbutton "수량" required`, `button "주문 확정"` 확인. 문서 `scripts.length=0` |
| SQLite 세션·자격 증명 | `test/adapter/session-store.test.ts` | Argon2id 해시 검증, 만료, 세션 회전, 두 인스턴스가 같은 세션·CSRF를 공유, A 로그인 후 B에서 begin 303, logout 뒤 B 401 |
| 두 연결 경합 | `test/adapter/sqlite-contention.test.ts` | 실제 파일 WAL에서 두 번째 writer `StoreBusyError`, coordinator 503 `BUSY`, lock 해제 뒤 성공 |
| 정리·감사 | `test/adapter/sqlite-contention.test.ts` | OPEN+업무 보존, 정상 만료만 삭제, 초안은 intent 정리 뒤에도 유지 |
| 영수증 보존 | `test/adapter/sqlite-contention.test.ts` | 결과 보존 종료 뒤 직접 영수증 GET 410 `RESULT_EXPIRED` |
| 응답 유실 | `test/adapter/sqlite-backup.test.ts` | commit 뒤 첫 응답을 잃은 상황에서 같은 intent 재요청이 같은 receipt Location을 반환 |
| 백업·복구 | `test/adapter/sqlite-backup.test.ts` | `VACUUM INTO` 백업을 새 저장소로 열어 draft/result와 영수증 KRW 24000 복구 |
| 프로세스 강제 종료 | `test/adapter/sqlite-crash.test.ts` | SIGKILL 시 미커밋 트랜잭션은 사라지고, 커밋된 행은 남으며 `integrity_check=ok` |
| 로컬 마이크로벤치 | `bun run bench -- --iterations=200` | 200회 파일 SQLite 흐름: elapsed 367.1ms, mean 1.833ms, p50 1.727ms, p95 2.979ms, max 5.128ms, 약 544.9/s. HTTP·세션 제외, 용량 주장 아님 |

## 설계 14번 P1 최소 수용 조건 대조

| 대상 | 상태 | 근거·한계 |
| --- | --- | --- |
| 네이티브 응답 | 확인 | GET start, intent form, 정상 303, 영수증, 422와 같은 intent 수정을 Hono `app.request`, 실제 `Bun.serve` 소켓, 실제 브라우저로 확인 |
| 조작 요청 | 부분 확인 | 미등록 key, 중복 entry, 잘못된 Origin, JSON Accept, 세션 없음, bad CSRF, 초과 스트림 413, 지수 422, malformed percent/UTF-8, encoded duplicate 확인. prefetch·start POST의 새 intent 수, exact expiry, consumed-without-result는 미실행 |
| 현재 권한 | 부분 확인 | membership 없음, 다른 tenant 상품 404, 비활성 상품, 영수증 권한 철회 404, 로컬 비밀번호 로그인·SQLite 세션·로그아웃 확인. 외부 IdP/OAuth와 계정 관리 화면은 범위 밖 |
| DB 원자성 | 부분 확인 | CAS 0행 409, 초안 intent UNIQUE, 결과 FK, 정상 만료 rollback, SIGKILL 복구 확인. projection 실패 rollback은 별도 주입 미실행 |
| 경합·복구 | 부분 확인 | 실제 두 연결 writer 경합과 503 예산, commit 뒤 응답 유실 replay, SQLite 백업 복구, 프로세스 강제 종료 후 rollback/commit 확인. 전원 장애 내구성은 미실행 |
| intent 수명 | 부분 확인 | 만료 410, 결과 보존 410, 정리, replay, 다른 입력 409 확인. 복제 탭·새로고침의 실제 브라우저 동작은 미실행 |
| 공개 화면 | 확인 | escaped product name, label/오류 연결, 실제 브라우저 키보드 제출, 접근성 트리 확인. 실제 스크린리더 낭독은 미실행 |

## 구현 목표에서 제외한 것

- **P0a/P0b B/L/S/D 비교**: 실제 대상 프로젝트가 있어야 하는 설계 실험이고 코드 산출물이 아니다. 대상 프로젝트가 제공되지 않아 구현 목표에서 제외했다. 설계 09번도 대상 없이 임의 프로젝트를 만들어 비교 결과로 포장하지 말라고 명시한다. 비교 결과를 합성하지 않는다.
- **외부 IdP/OAuth, 다중 테넌트 계정 관리**: 로컬 SQLite 자격 증명·세션 저장소로 참조 구현을 닫았다. 실제 외부 인증 공급자 연동은 P1 참조 범위 밖이다.
- **다중 인스턴스 운영 배포**: 두 앱 인스턴스가 같은 SQLite 세션·CSRF를 공유하는 것은 테스트했지만, 로드밸런서·sticky session·운영 세션 만료 정책은 범위 밖이다.
- **실제 스크린리더 낭독**: 접근성 트리와 키보드 제출까지만 확인했다.
- **전원 장애**: SIGKILL 프로세스 강제 종료로 WAL rollback/commit을 확인했다. 전원 손실 내구성은 주장하지 않는다. WAL + `synchronous=FULL` 설정은 유지한다.
- **PostgreSQL 등 비동기 어댑터**: v0.5 참조 범위가 아니다.

## 남은 미해결 (UNRESOLVED)

- **P0a/P0b**: 현재 워크스페이스에서 `<form`을 쓰는 HTML/JSX/Vue/Svelte 파일을 검색했으나 0건이었다. 실제 대상 프로젝트가 없고, 설계 09번이 임의 프로젝트 생성·비교 결과 포장을 금지하므로 실행하지 않았다. 통과가 아니라 미해결이다.
- **전원 손실 내구성**: SIGKILL 프로세스 종료까지만 확인했다. 물리 전원 손실은 재현하지 않았고 내구성을 주장하지 않는다.

## 구현 편차

- SQLite `products`에 설계 스냅샷에 없는 `name` 컬럼을 추가했다. 화면 표시용 어댑터 확장이며 계약 동작에는 쓰지 않는다.
- demo 인증은 로컬 SQLite 자격 증명(Argon2id)과 세션 저장소를 쓴다. 외부 IdP가 아니며 `DEMO_PASSWORD` 기본값은 로컬 전용이다.
- `resolveReceipt`는 결과 보존이 끝나면 410을 반환한다. `order_drafts`가 남아 있어도 영수증을 계속 읽을 수 있던 설계 검토 지적을 닫은 것이다.
- COMMITTED 상태에서 입력이 없으면 409 `COMPLETED_INPUT_CONFLICT`로 처리한다. OPEN의 unchecked는 422다.

## 검증 명령 원문

```bash
bun test
bun run typecheck
bun run bench -- --iterations=200
cd docs/design/v0.5
bun ../../../src/cli.ts doctor --config examples/doctor.config.json
bun test test/e2e/order-socket.test.ts
bun test test/adapter/session-store.test.ts
bun test test/adapter/sqlite-crash.test.ts
```

마지막 전체 실행 결과는 이 문서 작성 시점 기준 93 pass / 0 fail / 272 expect, typecheck exit 0이다.
