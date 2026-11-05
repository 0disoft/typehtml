# v0.4에서 v0.5로

이 문서는 설계·참고 구현의 이전 안내다. 운영 제품이나 자동 DB migration이 제공된다는 뜻으로 읽지 않는다. 이전 ZIP은 그대로 보존한다.

## 정본과 파생물

계약 format을 `boundary-contract/0.5-draft`로 올리고 예제의 `operationRevision`을 2로 올린다. `guards.idempotency`의 statePolicy·readConsistency·replayLock·corruption과 `page.resolver`를 추가한다. 입력·응답의 정본은 계속 JSON 한 곳이다.

```text
python validation/generate_reference_types.py
python validation/verify_package.py --report-dir validation/logs
```

네 파생물을 한꺼번에 갱신한다. 원본 SHA만 수정하거나 생성 타입을 수동 편집하지 않는다. 중복 키·잘못된 문자·불허 숫자·canonical이 아닌 fixed path는 기존에 받아들였더라도 새 규약에서 거부한다.

## 역할과 페이지

`loadPage`를 `resolvePage`로 바꾸고 start·form·receipt·failure를 명시한다. wrapper는 상태별 고정 status와 same-origin 영수증 경로만 렌더한다. 역할 반환 타입에 SyncResult를 적용하고 실제 동기 역할을 호출한 직후 assertSynchronous와 결과 스키마 검증을 수행한다. 타입 cast로 검사를 우회하지 않는다.

함수가 Promise를 반환한 사실은 이미 실행한 부수효과를 취소하지 않는다. transaction 종료 시 실행 핸들을 무효화하고, 미대기 작업이나 외부 I/O는 신뢰 코드 계약 위반으로 다룬다.

## 열린 요청과 완료 요청

v0.4 열린 intent의 의미 digest는 새 값과 달라진다. 새 handler에서 이를 검증하기 전에 현재 권한과 보존 상태를 확인하고, 의미 불일치는 409와 새 시작 화면으로 안내한다. 저장된 digest를 강제로 새 값으로 바꾸거나 만료를 연장하지 않는다.

완료된 intent의 GET은 현재 영수증 권한으로 이미 저장된 업무 결과를 읽을 수 있다. POST의 오래된 의미는 409로 처리하며 기존 완료 결과를 지우거나 새 작업으로 다시 실행하지 않는다. 장기간 접근은 인증된 영수증 GET이 담당한다.

## 저장 규칙

새 SQL은 consumed_at이 발급 시각 이상이고 열린 요청 만료보다 이르다는 제약을 추가한다. 실제 서비스에 적용할 때는 먼저 read-only 불일치 조회를 수행하고 기존 데이터를 분류한다. SQLite CHECK를 붙이려면 별도 table 재구성이 필요할 수 있으며 이 ZIP은 그 migration을 실행하지 않는다.

결과가 없는 consumed 행, 열린 intent에 연결된 업무 결과, 잘못된 범위·참조·해시는 자동 삭제하거나 정상 OPEN으로 바꾸지 않는다. 운영자가 원인을 조사할 기록으로 남긴다. cleanup은 정상 만료만 처리하고 완성된 업무 초안은 유지한다.

## 증거의 이전

v0.4 자체 검토와 브라우저 차단 기록은 `evidence/history`에 있다. 새 validation 로그와 섞어서 이번 실행으로 집계하지 않는다. P0 결과는 계속 NOT_RUN이며 이번 참고 실행을 그 자리에 넣지 않는다.
