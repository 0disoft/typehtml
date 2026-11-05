# v0.5 실제 참고 실행과 미실행 범위

이번 실행은 문서와 계약의 정합성, 참고 함수, 역할 타입, 제한된 Python SQLite 동작을 확인했다. 제품 HTTP 요청·Doctor·Bun 어댑터·사용자 폼 조사·P0·성능은 실행하지 않았다. v0.4의 브라우저 차단 기록을 보존했으며 이번에는 재시도하지 않았다.

## 실행 환경과 재현

Linux, Python 3.13.5, Node 22.16.0, TypeScript 5.8.3, Python sqlite3 연결의 SQLite 3.46.1을 사용했다. 의존성 설치와 CI 실행은 없었다. 목표 최신 안정판 TypeScript와 운영 Bun·SQLite 적합성은 별도 미실행이다.

```text
python validation/generate_reference_types.py --check
python validation/verify_package.py --report-dir validation/logs
```

검증기는 참고 TS만 임시 디렉터리에 컴파일하고, Python SQL은 메모리 또는 임시 파일에서 실행한다. 문서용 파생 생성기는 알려진 계약 하나만 처리한다. 실제 결과는 [verification.json](logs/verification.json)에 있다. 상태값 `VERIFIED_REFERENCE_ONLY`는 이 참고 자료의 해당 조건을 확인했다는 의미다.

## 실행한 범위

| 분류 | 실제 확인 | 범위 |
| --- | --- | --- |
| ARTIFACT | 계약·예제 데이터, 5개 메타스키마 거부, 네 파생물 freshness | 서버나 일반 JSON Schema 구현 검증 없음 |
| ARTIFACT | 정본 JSON의 거부 7사례와 정상 1사례 | 이 참고 loader가 중복 키·비유한 수·잘못된 문자 등을 거부하는지 |
| ARTIFACT | behavior digest의 서식 변경·입력 변경·revision 변경 | callback의 의미는 자동 증명하지 않음 |
| ARTIFACT | HTML 세 snapshot·coverage ID 연결·출처 45개·기존 피드백 43개·문서 링크 | HTML5 파서·접근성 엔진·Doctor 실행 없음 |
| ARTIFACT | 11사례 × 4구성의 비교 양식 | 44개 슬롯 모두 NOT_RUN/null, 실제 폼 목록도 비어 있음 |
| REFERENCE_TYPES | 역할 조립과 의도적 타입 거부 9개, 넓은 projector 허용 반례 | 설치된 tsc 5.8.3의 국소 결과 |
| WIRE_REFERENCE | 입력·정수·Unicode·canonical 처리 15사례 | HTTP stream·미들웨어·CSRF 미포함 |
| STATE_REFERENCE | 상태 판정 24사례, 동기 반환 4사례, URL 속성 사실 7사례 | 복사한 snapshot과 인자에 대한 순수 함수 실행 |
| SQL_ILLUSTRATION | 한 메모리 연결의 제약·CAS·rollback·정상 정리·불일치 보존 | Bun·운영 DB·장애 복구 미실행 |
| SQL_SNAPSHOT_REFERENCE | 임시 WAL 파일 두 연결의 순서 제어 관찰 3개 | 같은 Python 프로세스의 결정적 순서, 실제 동시 HTTP 시험 없음 |

원시 로그는 [타입](logs/tsc-reference.txt), [파생물](logs/generated-types.txt), [wire](logs/wire-reference.json), [상태·동기·URL](logs/state-reference.json), [단일 연결 SQL](logs/sqlite-reference.json), [두 연결 snapshot](logs/sqlite-snapshot-reference.json)에 있다. 사례 수는 서로 다른 검사 수준을 섞은 제품 통과 점수로 합산하지 않는다.

## 이전 결함의 실제 재현

[네 재현 기록](../evidence/v04-reproductions.json)은 v0.4 ZIP의 원문·참고 코드를 대상으로 했다. 넓은 Result의 async execute가 tsc를 통과한 사실, network-path를 메타스키마가 허용한 사실, 결과 없는 consumed 기록을 cleanup이 삭제한 사실, 실제 form ID와 coverage의 불일치를 각각 남겼다. v0.5의 기대값을 v0.4 관찰로 작성하지 않았다. 이는 공개 서비스 취약점 발견이나 익스플로잇 실행 기록이 아니다.

수정 후에는 같은 계열의 반례를 타입·메타스키마·정리·연결 검사에 반영했다. 타입의 추가 속성 허용처럼 언어 자체의 한계는 남겨 두고 runtime 출력 schema 검사가 필요하다고 명시했다.

## 두 연결 관찰을 해석하는 범위

첫 연결이 OPEN을 읽은 상태에서 두 번째 연결이 초안·소비 시각·결과를 commit했다. 첫 연결의 기존 read transaction은 OPEN snapshot을 계속 봤고, 읽기를 종료하고 새 transaction을 시작하자 완료 상태와 결과를 함께 읽었다. 별도 writer 예약이 있어도 이미 완료한 결과의 읽기는 가능했다.

이 관찰은 fresh snapshot을 요구하는 설계 근거다. 실제 HTTP coordinator, 여러 worker의 writer 경합, 5초 재시도 예산, 전원 장애, WAL의 운영 안전성, 현재 버전 SQLite의 배포 적합성을 시험하지 않았다. 잠금 동작은 설치된 SQLite 3.46.1과 해당 임시 환경에서 확인했다.

## 브라우저와 제품 미실행

[v0.4 차단 기록](../evidence/history/native-dom-attempt-v0.4.json)은 첫 navigation의 `net::ERR_BLOCKED_BY_ADMINISTRATOR`로 16개 합성 사례가 미실행됐다는 이력이다. v0.5에서는 정책을 우회하거나 다른 주소로 다시 시도하지 않았다. URL 참고 함수의 성공도 브라우저 제출 시험의 성공으로 바꾸지 않는다.

| 대상 | 현재 상태 |
| --- | --- |
| 실제 사용자 폼 조사와 B/L/S/D 비교 | NOT_RUN |
| Doctor·HTTP wrapper·renderer·인증 연동 | 미구현·미실행 |
| Bun SQLite와 PostgreSQL 어댑터 | 미구현·미실행 |
| 목표 최신 TypeScript | NOT_RUN |
| 브라우저·접근성 엔진 | NOT_RUN |
| 처리량·탐지율·운영 보안·개발비 절감 | 미측정 |

## 배포 파일

PACKAGE_MANIFEST.json에 최종 파일 목록을 담고 SHA256SUMS는 자기 자신을 제외한 파일을 포함한다. ZIP의 CRC와 내부 해시는 패키징에서 확인한다. 체크섬은 파일 일치 자료이며 전자서명이나 제품 보안 보증이 아니다.
