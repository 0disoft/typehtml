# 참고 코드의 범위

역할 타입과 아홉 개의 의도적 타입 거부를 설치된 tsc로 확인한다. 넓은 object 제네릭의 async 함수도 거부하는 예제가 포함된다. 반대로 넓은 projector 반환의 추가 속성은 TypeScript 구조적 호환성 때문에 허용되는 예제를 남겼다. 실제 공개 출력 스키마 검사가 필요한 이유다.

`intent-decisions.ts`는 하나의 인증·범위 확인된 DB snapshot을 받아 상태 결과를 선택하는 순수 함수다. 이 함수가 권한을 조회하거나 HTTP 요청을 보호하지 않는다. 신규 쓰기는 fresh IMMEDIATE에서 상태·정책·Grant·CAS를 다시 확인해야 한다. `sync-result.ts`는 동기 역할의 Promise·thenable 반환을 거부하지만 이미 시작한 비동기 부수효과를 취소하지 않는다.

`native-target.ts`는 추출된 속성 사실의 URL 의미를 확인한다. HTML AST를 읽거나 브라우저 제출을 실행하지 않는다. `wire-semantics.ts`는 byte 파싱·정수·Unicode 길이·canonical 입력의 작은 참고 구현이다. HTTP stream·인증·CSRF·업무 스키마 처리는 포함하지 않는다.

SQL 자료는 단일 Python SQLite 메모리 연결에서 제약·rollback·정리·불일치 보존을 확인한다. 별도 임시 WAL 파일의 두 연결에서는 읽기 snapshot과 완료 결과 조회를 순서대로 관찰한다. 이는 Bun adapter·다중 HTTP 요청의 경쟁·durability·장애 복구 검증이 아니다.

브라우저용 16개 합성 사례는 이전 자료로 남겼다. v0.4의 navigation 차단 기록은 history에 있으며 이번에는 재시도하지 않았다. 실제 확인 범위는 [검증 보고서](../validation/REPORT.ko.md)에서 구분한다.

```text
python validation/generate_reference_types.py --check
python validation/verify_package.py --report-dir validation/logs
```

Python jsonschema·tsc·Node가 필요하다. 없는 도구는 자동 설치하지 않는다. 파생물 갱신은 첫 명령의 `--check`를 빼서 수행한다. 이 생성기는 알려진 한 계약의 문서용 도구이며 일반 서버 생성기가 아니다.
