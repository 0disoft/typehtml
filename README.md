# TypeHTML (Boundary Contracts)

HTML 폼과 서버 경계를 하나의 타입 안전 계약으로 연결하는 설계·검증 저장소다.

## 현재 상태

- `docs/design/v0.5/`에 2026-11-05 설계 스냅샷을 보관한다. 이 디렉터리는 수정하지 않는다.
- 계약 코어(엄격 JSON, canonical JSON, behavior digest, 계약 검증, form-check 투영)와 최소 form-only Doctor CLI를 구현했다.
- 설계의 P1 참조 세로 조각도 구현했다: order coordinator, Bun SQLite 어댑터, Hono 어댑터, escaped HTML renderer, 실행 가능한 demo server.
- P0a/P0b B/L/S/D 비교는 실제 대상 프로젝트가 없어 **NOT_RUN**이다. P1 구현은 설계 검증이나 제품 적합성 증거가 아니라 참조 구현이다.
- 실제 브라우저에서 앱 스크립트 없이 키보드로 폼을 제출하는 흐름과 접근성 트리를 확인했다. 실제 스크린리더 낭독은 실행하지 않았다.
- 로컬 마이크로벤치, commit 응답 유실 replay, SQLite `VACUUM INTO` 백업 복구를 확인했다. 전원 장애·프로세스 강제 종료 내구성은 주장하지 않는다.
- 실제 인증 공급자, 다중 인스턴스, rate limit/IP 제한은 P1 참조 범위 밖이다. P0a/P0b는 실제 대상 프로젝트가 없어 실행하지 않았다.
- 이 저장소는 아직 SDK나 배포 패키지가 아니다.

## 먼저 읽을 것

- 설계 진입점: `docs/design/v0.5/00_START_HERE.ko.md`
- 범위: `docs/design/v0.5/docs/01_DECISION_AND_SCOPE.ko.md`
- 다음 실험: `docs/design/v0.5/docs/09_DELIVERY_AND_EXPERIMENTS.ko.md`
- 구현 전달문: `docs/design/v0.5/docs/12_IMPLEMENTER_HANDOFF.ko.md`
- 현재 증거: `docs/acceptance/P1_REFERENCE_RUNTIME.ko.md`

## 범위

- 첫 제품 후보는 읽기 전용 폼 연결 검사기(Doctor)다. 필요할 때만 typed wrapper를 선택한다.
- v0.1은 native HTML, 평평한 string/integer, URL-encoded POST, JSON Schema 부분집합만 다룬다.
- `.thtml`, 새 반응성, 서버 생성기, 일반 정보흐름 분석은 범위 밖이다.
- P0a/P0b 결과는 아직 없으며, 비교 결과를 합성하지 않는다.

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
- `docs/acceptance/` — 실행한 검사와 NOT_RUN 목록

## 개발

Bun 1.4+ 기준.

```bash
bun install
bun test
bun run typecheck
bun run bench -- --iterations=200

# 설계 패키지의 예제 config는 root "."를 현재 디렉터리 기준으로 해석한다.
cd docs/design/v0.5
bun ../../../src/cli.ts doctor --config examples/doctor.config.json
```

데모 server:

```bash
bun run example
# http://localhost:3000/login
```

`DATABASE_PATH`, `PORT`, `ALLOWED_ORIGIN` 환경 변수로 바꿀 수 있다. demo는 in-memory 세션과 단일 상품 seed를 쓰며 운영 인증이 아니다.

Doctor는 stdout에 기계 판독 JSON 보고서 하나를 쓰고, exit code `0`(막는 결함 없음), `1`(확인된 error), `2`(설정/런타임 오류), `3`(필수 경계 미완료)를 쓴다.

## 알려진 구현 편차

- SQLite `products` 테이블에 설계 스키마에 없는 `name` 컬럼을 추가했다. 공개 화면의 상품명 표시를 위한 어댑터 확장이며 계약 의미에는 쓰지 않는다.
- Hono demo의 세션·CSRF 저장소는 메모리 구현이다. 실제 로그인·세션 회전·다중 인스턴스 저장소는 범위 밖이다.
- rate limit, IP 제한, 실제 프록시 신뢰 경계는 구현하지 않았다.

## 다음 단계

1. P0a: 실제 프로젝트의 쓰기 폼 경로 최대 10개를 조사한다.
2. P0b: 같은 baseline에서 B/L/S/D를 비교한다.
3. 결과가 Doctor 또는 wrapper를 정당화할 때만 P1을 제품 경로로 승격한다.
