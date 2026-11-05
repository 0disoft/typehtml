# TypeHTML (Boundary Contracts)

HTML 폼과 서버 경계를 하나의 타입 안전 계약으로 연결하는 설계·검증 저장소다.

## 현재 상태

- `docs/design/v0.5/`에 2026-11-05 설계 스냅샷을 보관한다. 이 디렉터리는 수정하지 않는다.
- 계약 코어(엄격 JSON, canonical JSON, behavior digest, 계약 검증, form-check 투영)와 최소 form-only Doctor CLI를 구현했다.
- 정본에서 런타임 타입·두 form-check·digest를 생성하며 `bun run generate:check`로 stale 산출물을 확인한다.
- 설계의 P1 참조 세로 조각도 구현했다: order coordinator, Bun SQLite 어댑터, Hono 어댑터, escaped HTML renderer, 실행 가능한 demo server.
- P0a/P0b B/L/S/D 비교는 실제 대상 프로젝트가 없어 **판단 보류**이며, 2026-11-06 목표 소유자가 **범위 밖**으로 확정했다. P1 구현은 설계 검증이나 제품 적합성 증거가 아니라 참조 구현이다.
- 실제 브라우저에서 앱 스크립트 없이 키보드로 폼을 제출하는 흐름과 접근성 트리를 확인했다. 실제 스크린리더 낭독은 실행하지 않았다.
- 로컬 마이크로벤치, commit 응답 유실 replay, SQLite `VACUUM INTO` 백업 복구, SIGKILL 후 rollback/commit을 확인했다. 물리 전원 손실 내구성은 주장하지 않으며, 2026-11-06 목표 소유자가 **범위 밖**으로 확정했다.
- 외부 IdP/OAuth, 운영 다중 인스턴스 배포는 P1 참조 범위 밖이다.
- 참조 rate limiter(동일 principal/action당 POST 30회/60초, begin 10회/60초), transaction 안 OPEN intent 상한 20개, 서비스별 제한 hook을 구현했다. 기본 rate limiter는 프로세스 메모리이며 운영 IP 판별·공유 제한 저장소는 호스트가 연결한다.
- 이 저장소는 아직 SDK나 배포 패키지가 아니다.

## 먼저 읽을 것

- 설계 진입점: `docs/design/v0.5/00_START_HERE.ko.md`
- 범위: `docs/design/v0.5/docs/01_DECISION_AND_SCOPE.ko.md`
- 다음 실험: `docs/design/v0.5/docs/09_DELIVERY_AND_EXPERIMENTS.ko.md`
- 구현 전달문: `docs/design/v0.5/docs/12_IMPLEMENTER_HANDOFF.ko.md`
- 현재 증거: `docs/acceptance/P1_REFERENCE_RUNTIME.ko.md`
- v0.5 구현 재대조와 수정 결과: `docs/acceptance/V05_IMPLEMENTATION_AUDIT.ko.md`
- P0 판정: `docs/acceptance/P0_DECISION.ko.md`

## 범위

- 첫 제품 후보는 읽기 전용 폼 연결 검사기(Doctor)다. 필요할 때만 typed wrapper를 선택한다.
- v0.1은 native HTML, 평평한 string/integer, URL-encoded POST, JSON Schema 부분집합만 다룬다.
- `.thtml`, 새 반응성, 서버 생성기, 일반 정보흐름 분석은 범위 밖이다.
- P0a/P0b는 실제 대상이 없어 판단 보류다. 2026-11-06 목표 소유자가 범위 밖으로 확정했으며, 비교 결과를 합성하지 않는다.

## 구조

- `docs/design/v0.5/` — v0.5 설계 스냅샷 (수정하지 않음)
- `src/contract/` — 계약 로더·검증·behavior digest·form-check 투영
- `src/doctor/` — form-only 정적 연결 검사기 (BC010~BC014, 제한된 BC013 witness)
- `src/runtime/` — intent 상태 결정, wire 입력, order coordinator, ports
- `src/adapter/sqlite/` — Bun SQLite 저장소, CAS, 정리·감사 진단
- `src/adapter/hono/` — Hono 라우트와 데모 세션/CSRF
- `src/render/` — escaped HTML 렌더러
- `src/cli.ts` — `boundary doctor` CLI
- `examples/order-app.ts` — 로컬 데모 server
- `scripts/order-benchmark.ts` — 로컬 SQLite 흐름 마이크로벤치
- `test/` — Bun 테스트
- `docs/acceptance/` — 실행한 검사, P0 판정, NOT_RUN 목록

## 개발

Bun 1.4+ 기준.

```bash
bun install
bun test
bun run typecheck
bun run generate
bun run generate:check
bun run bench -- --iterations=200

# 설계 패키지의 예제 config는 root "."를 현재 디렉터리 기준으로 해석한다.
cd docs/design/v0.5
bun ../../../src/cli.ts doctor --config examples/doctor.config.json
```

데모 server:

```bash
bun run example
# http://localhost:3000/login
# tenant_demo / subject_demo / demo-password
```

`DATABASE_PATH`, `PORT`, `ALLOWED_ORIGIN`, `DEMO_PASSWORD` 환경 변수로 바꿀 수 있다. demo는 같은 SQLite 파일에 비밀번호 해시(Argon2id), 세션, CSRF 토큰을 저장하고 단일 상품을 seed한다. 로컬 데모용 자격 증명이며 외부 IdP나 운영 인증이 아니다.

Doctor는 stdout에 기계 판독 JSON 보고서 하나를 쓰고, exit code `0`(막는 결함 없음), `1`(확인된 error), `2`(설정/런타임 오류), `3`(필수 경계 미완료)를 쓴다.

`boundary generate --contract <json> --out-dir <전용 생성 디렉터리> [--root <프로젝트 루트>] [--check]`는 타입·폼 투영·digest만 만든다. `--root` 기본값은 현재 작업 디렉터리이며 Doctor의 `root`와 일치시킨다. 관련 없는 파일이 있는 디렉터리나 설계 스냅샷에는 출력하지 않는다. `--check`는 파일을 바꾸지 않고 stale이면 exit 1을 반환한다.

Hono 어댑터의 `rateLimiter`로 공유 계정 제한 저장소를, `requestLimit`로 신뢰할 ingress/IP 제한을 연결할 수 있다. `OrderCoordinator` 생성 옵션의 `maxOpenIntents`는 transaction 안 발급 상한이다. HTTPS origin에서는 Secure 세션 쿠키를 기본 사용하며 `secureCookies`로 호스트 정책을 지정할 수 있다.

## 알려진 구현 편차

- SQLite `products` 테이블에 설계 스키마에 없는 `name` 컬럼을 추가했다. 공개 화면의 상품명 표시를 위한 어댑터 확장이며 계약 의미에는 쓰지 않는다.
- Hono demo는 로컬 SQLite 자격 증명·세션 저장소를 쓴다. 외부 IdP, OAuth, 다중 테넌트 계정 관리, 세션 회전 API는 범위 밖이다.
- 기본 요청 횟수 제한은 단일 프로세스용이다. 운영 IP 제한·프록시 신뢰 경계와 다중 인스턴스용 공유 제한 저장소는 호스트 hook으로 제공한다.

## 다음 단계

1. P0a: 실제 프로젝트의 쓰기 폼 경로 최대 10개를 조사한다.
2. P0b: 같은 baseline에서 B/L/S/D를 비교한다.
3. 결과가 Doctor 또는 wrapper를 정당화할 때만 P1을 제품 경로로 승격한다.
