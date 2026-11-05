# TypeHTML (Boundary Contracts)

HTML 폼과 서버 경계를 하나의 타입 안전 계약으로 연결하는 설계·검증 저장소다.

## 현재 상태

- `docs/design/v0.5/`에 2026-11-05 설계 스냅샷을 보관한다.
- 제품 런타임, Doctor, Hono/Bun 어댑터, P0 B/L/S/D 비교는 아직 구현하거나 실행하지 않았다.
- 이 저장소는 아직 SDK나 배포 패키지가 아니다. 설계 문서와 참고 코드, 최소 검증 코드만 있다.

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
- `src/contract/` — 계약 로더·검증 기반 코드
- `test/` — Bun 테스트
- `examples/` — 제품 예제가 생기면 추가 (현재 설계 예제는 docs 안에 있음)

## 개발

Bun 1.4+ 기준.

```bash
bun test
```

## 다음 단계

1. P0a: 실제 프로젝트의 쓰기 폼 경로 최대 10개를 조사한다.
2. P0b: 같은 baseline에서 B/L/S/D를 비교한다.
3. 결과가 Doctor 또는 wrapper를 정당화할 때만 P1을 연다.
