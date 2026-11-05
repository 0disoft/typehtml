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
| 전체 테스트 | `bun test` | 88 pass, 0 fail, 251 expect |
| 정적 타입 | `bun run typecheck` | exit 0 |
| Doctor 설계 예제 | `cd docs/design/v0.5 && bun ../../../src/cli.ts doctor --config examples/doctor.config.json` | exit 0, findings 0, 3 documents / 3 forms / 3 bindings |
| 주문 흐름 | `test/runtime/order-flow.test.ts` | start, begin, 422 재시도, 303, replay, 만료 410, revision 409, 영수증 보존 |
| HTTP 어댑터 | `test/adapter/order-app.test.ts` | start HTML escape, begin/invalid/valid/receipt, 406, null Origin 403, no session 401 |
| 요청 사례 행렬 | `test/adapter/order-app.test.ts` | malformed/unknown/proto/reserved 400, exponent/empty 422, bad CSRF 403, multipart 415, oversized 413, invalid UTF-8 400, unknown intent 410, replay 303, different input 409, other tenant 404, same-origin Referer 303, missing source 403, revoked receipt 404 |
| 실제 소켓 | `test/e2e/order-socket.test.ts` | `Bun.serve` 포트 0 + `fetch`로 login 303, start 200, begin 303, form 200, submit 303, receipt 200 / KRW 24000 |
| 실제 브라우저 | DSH 내장 Chromium으로 수동 실행 | login → start → form → keyboard Tab+Space 제출 → receipt 200. 접근성 트리에서 `spinbutton "수량" required`, `button "주문 확정"` 확인. 문서 `scripts.length=0` |
| 두 연결 경합 | `test/adapter/sqlite-contention.test.ts` | 실제 파일 WAL에서 두 번째 writer `StoreBusyError`, coordinator 503 `BUSY`, lock 해제 뒤 성공 |
| 정리·감사 | `test/adapter/sqlite-contention.test.ts` | OPEN+업무 보존, 정상 만료만 삭제, 초안은 intent 정리 뒤에도 유지 |
| 영수증 보존 | `test/adapter/sqlite-contention.test.ts` | 결과 보존 종료 뒤 직접 영수증 GET 410 `RESULT_EXPIRED` |
| 응답 유실 | `test/adapter/sqlite-backup.test.ts` | commit 뒤 첫 응답을 잃은 상황에서 같은 intent 재요청이 같은 receipt Location을 반환 |
| 백업·복구 | `test/adapter/sqlite-backup.test.ts` | `VACUUM INTO` 백업을 새 저장소로 열어 draft/result와 영수증 KRW 24000 복구 |
| 로컬 마이크로벤치 | `bun run bench -- --iterations=200` | 200회 파일 SQLite 흐름: mean 2.253ms, p50 2.185ms, p95 3.465ms, 약 443/s. HTTP·세션 제외, 용량 주장 아님 |

## 설계 14번 P1 최소 수용 조건 대조

| 대상 | 상태 | 근거·한계 |
| --- | --- | --- |
| 네이티브 응답 | 확인 | GET start, intent form, 정상 303, 영수증, 422와 같은 intent 수정을 Hono `app.request`, 실제 `Bun.serve` 소켓, 실제 브라우저로 확인 |
| 조작 요청 | 부분 확인 | 미등록 key, 중복 entry, 잘못된 Origin, JSON Accept, 세션 없음, bad CSRF, 초과 스트림 413, 지수 422, malformed percent/UTF-8, encoded duplicate 확인. prefetch·start POST의 새 intent 수, exact expiry, consumed-without-result는 미실행 |
| 현재 권한 | 부분 확인 | membership 없음, 다른 tenant 상품 404, 비활성 상품, 영수증 권한 철회 404 확인. demo 로그인만 있고 실제 인증 공급자·tenant 전환은 범위 밖 |
| DB 원자성 | 부분 확인 | CAS 0행 409, 초안 intent UNIQUE, 결과 FK, 정상 만료 rollback 경로 확인. projection 실패 rollback은 별도 주입 미실행 |
| 경합·복구 | 부분 확인 | 실제 두 연결 writer 경합과 503 예산, commit 뒤 응답 유실 replay, SQLite 백업 복구 확인. 프로세스 강제 종료·전원 장애는 미실행 |
| intent 수명 | 부분 확인 | 만료 410, 결과 보존 410, 정리, replay, 다른 입력 409 확인. 복제 탭·새로고침의 실제 브라우저 동작은 미실행 |
| 공개 화면 | 확인 | escaped product name, label/오류 연결, 실제 브라우저 키보드 제출, 접근성 트리 확인. 실제 스크린리더 낭독은 미실행 |

## 구현 목표에서 제외한 것

- **P0a/P0b B/L/S/D 비교**: 실제 대상 프로젝트가 있어야 하는 설계 실험이고 코드 산출물이 아니다. 대상 프로젝트가 제공되지 않아 구현 목표에서 제외했다. 비교 결과를 합성하지 않는다.
- **실제 인증 공급자·다중 인스턴스·rate limit·IP/프록시 신뢰**: P1 참조 범위 밖이다. demo는 `InMemorySessionStore`와 단일 프로세스를 쓴다. 운영 보안 구현으로 표시하지 않는다.
- **실제 스크린리더 낭독**: 접근성 트리와 키보드 제출까지만 확인했다.
- **전원 장애·프로세스 강제 종료**: 안전하게 재현할 수 없다. WAL + `synchronous=FULL`을 설정했지만 내구성 보장을 주장하지 않는다.
- **PostgreSQL 등 비동기 어댑터**: v0.5 참조 범위가 아니다.

## 구현 편차

- SQLite `products`에 설계 스냅샷에 없는 `name` 컬럼을 추가했다. 화면 표시용 어댑터 확장이며 계약 동작에는 쓰지 않는다.
- Hono demo의 session/CSRF는 in-memory다. 운영 보안 구현이 아니다.
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
```

마지막 전체 실행 결과는 이 문서 작성 시점 기준 88 pass / 0 fail / 251 expect, typecheck exit 0이다.
