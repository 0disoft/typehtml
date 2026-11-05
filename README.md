# TypeHTML (Boundary Contracts)

HTML 폼과 서버 경계를 하나의 타입 안전 계약으로 연결하는 설계·검증 저장소다.

## 현재 상태

- `docs/design/v0.5/`에 2026-11-05 설계 스냅샷을 보관한다.
- 계약 코어(엄격 JSON, canonical JSON, behavior digest, 계약 검증, form-check 투영)와 최소 form-only Doctor CLI를 구현했다.
- P0a/P0b B/L/S/D 비교와 P1 런타임, Hono/Bun SQLite 어댑터는 아직 실행하거나 구현하지 않았다. 실제 대상 프로젝트가 없으므로 비교 결과를 합성하지 않는다.
- 이 저장소는 아직 SDK나 배포 패키지가 아니다.

## 먼저 읽을 것

- 설계 진입점: `docs/design/v0.5/00_START_HERE.ko.md`
- 범위: `docs/design/v0.5/docs/01_DECISION_AND_SCOPE.ko.md`
- 다음 실험: `docs/design/v0.5/docs/09_DELIVERY_AND_EXPERIMENTS.ko.md`
- 구현 전달문: `docs/design/v0.5/docs/12_IMPLEMENTER_HANDOFF.ko.md`

## 범위

- 첫 제품 후보는 읽기 전용 폼 연결 검사기(Doctor)다. 필요할 때만 typed wrapper를 선택한다.
- v0.1은 native HTML, 평평한 string/integer, URL-encoded POST, JSON Schema 부분집합만 다룬다.
- `.thtml`, 새 반응성, 서버 생성기, 일반 정보흐름 분석은 범위 밖이다.
- P0a(실제 쓰기 폼 조사)와 P0b(한 경로 B/L/S/D 비교) 전에는 P1 런타임을 만들지 않는다.

## 구조

- `docs/design/v0.5/` — v0.5 설계 스냅샷 (수정하지 않음)
- `src/contract/` — 계약 로더·검증·behavior digest·form-check 투영
- `src/doctor/` — form-only 정적 연결 검사기 (BC010~BC014, 제한된 BC013 witness)
- `src/cli.ts` — `boundary doctor` CLI
- `test/` — Bun 테스트
- `examples/` — 제품 예제가 생기면 추가 (현재 설계 예제는 docs 안에 있음)

## 개발

Bun 1.4+ 기준.

```bash
bun test

# 설계 패키지의 예제 config는 root "."를 현재 디렉터리 기준으로 해석한다.
cd docs/design/v0.5
bun ../../../src/cli.ts doctor --config examples/doctor.config.json
```

Doctor는 stdout에 기계 판독 JSON 보고서 하나를 쓰고, exit code `0`(막는 결함 없음), `1`(확인된 error), `2`(설정/런타임 오류), `3`(필수 경계 미완료)를 쓴다.

## 다음 단계

1. P0a: 실제 프로젝트의 쓰기 폼 경로 최대 10개를 조사한다.
2. P0b: 같은 baseline에서 B/L/S/D를 비교한다.
3. 결과가 Doctor 또는 wrapper를 정당화할 때만 P1을 연다.