# P1 참조 런타임 실행 기록

- 날짜: 2026-11-05
- 대상: `src/runtime/`, `src/adapter/sqlite/`, `src/adapter/hono/`, `src/render/`, `examples/order-app.ts`
- 설계 기준: `docs/design/v0.5/`
- 환경: Bun 1.4.4, TypeScript 7.0.2, SQLite(Bun 내장), Windows
- 판정: **참조 구현 실행됨. 제품 적합성·P0 비교·브라우저 검증은 NOT_RUN.**

이 문서는 실행한 것과 실행하지 않은 것을 구분한다. P1 구현이 P0a/P0b의 B/L/S/D 비교를 대체하지 않는다.

## 실행한 검사

| 검사 | 명령 | 결과 |
| --- | --- | --- |
| 전체 테스트 | `bun test` | 70 pass, 0 fail |
| 정적 타입 | `bun run typecheck` | exit 0 |
| Doctor 설계 예제 | `cd docs/design/v0.5 && bun ../../../src/cli.ts doctor --config examples/doctor.config.json` | exit 0, findings 0, 3 documents / 3 forms / 3 bindings |
| 주문 흐름 | `test/runtime/order-flow.test.ts` | start, begin, 422 재시도, 303, replay, 만료 410, revision 409, 영수증 보존 |
| HTTP 어댑터 | `test/adapter/order-app.test.ts` | start HTML escape, begin/invalid/valid/receipt, 406, null Origin 403, duplicate 400, unknown 400, no session 401 |
| 두 연결 경합 | `test/adapter/sqlite-contention.test.ts` | 실제 파일 WAL에서 두 번째 writer `StoreBusyError`, coordinator 503 `BUSY`, lock 해제 뒤 성공 |
| 정리·감사 | `test/adapter/sqlite-contention.test.ts` | OPEN+업무 보존, 정상 만료만 삭제, 초안은 intent 정리 뒤에도 유지 |
| 영수증 보존 | `test/adapter/sqlite-contention.test.ts` | 결과 보존 종료 뒤 직접 영수증 GET 410 `RESULT_EXPIRED` |

## 설계 14번 P1 최소 수용 조건 대조

| 대상 | 상태 | 근거·한계 |
| --- | --- | --- |
| 네이티브 응답 | 부분 확인 | GET start, intent form, 정상 303, 영수증, 422와 같은 intent 수정을 Hono `app.request`로 확인. 실제 소켓·브라우저는 아님 |
| 조작 요청 | 부분 확인 | 미등록 key, 중복 entry, 잘못된 Origin, JSON Accept, 세션 없음 확인. 잘못된 CSRF·초과 스트림·지수 수량의 HTTP 조합은 미실행 |
| 현재 권한 | 부분 확인 | membership 없음, 다른 subject, 비활성 상품, 영수증 재조회 확인. 실제 로그인·tenant 전환·권한 철회는 미실행 |
| DB 원자성 | 부분 확인 | CAS 0행 409, 초안 intent UNIQUE, 결과 FK, 정상 만료 rollback 경로 확인. projection 실패 rollback은 별도 주입 미실행 |
| 경합·복구 | 부분 확인 | 실제 두 연결 writer 경합과 503 예산 확인. commit 뒤 응답 유실 복구는 미실행 |
| intent 수명 | 부분 확인 | 만료 410, 결과 보존 410, 정리, replay, 다른 입력 409 확인. 복제 탭·새로고침의 실제 브라우저 동작은 미실행 |
| 공개 화면 | 부분 확인 | escaped product name, 제한된 raw echo, label/오류 연결을 문자열 수준에서 확인. 실제 브라우저 a11y·키보드는 미실행 |

## NOT_RUN

- P0a 실제 쓰기 폼 조사와 P0b B/L/S/D 비교
- 실제 브라우저 no-JS 흐름, 키보드 탐색, 스크린리더
- 실제 인증 공급자, 세션 저장소, CSRF 회전, 다중 인스턴스
- `Bun.serve` 데모 서버의 실제 기동과 소켓 HTTP
- rate limit, IP 제한, 프록시 신뢰 경계
- commit 응답 유실, 전원 장애, 백업·복구
- 처리량·지연 측정
- PostgreSQL 등 비동기 어댑터

## 구현 편차

- SQLite `products`에 설계 스냅샷에 없는 `name` 컬럼을 추가했다. 화면 표시용 어댑터 확장이며 계약 동작에는 쓰지 않는다.
- Hono demo의 session/CSRF는 in-memory다. 운영 보안 구현이 아니다.
- `resolveReceipt`는 결과 보존이 끝나면 410을 반환한다. `order_drafts`가 남아 있어도 영수증을 계속 읽을 수 있던 설계 검토 지적을 닫은 것이다.
- COMMITTED 상태에서 입력이 없으면 409 `COMPLETED_INPUT_CONFLICT`로 처리한다. OPEN의 unchecked는 422다.

## 검증 명령 원문

```bash
bun test
bun run typecheck
cd docs/design/v0.5
bun ../../../src/cli.ts doctor --config examples/doctor.config.json
```

마지막 전체 실행 결과는 이 문서 작성 시점 기준 70 pass / 0 fail, typecheck exit 0이다.
