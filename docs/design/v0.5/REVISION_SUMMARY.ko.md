# v0.5 개정 요약

기능을 늘리지 않고 기존 실행 규약의 모순을 고쳤다. 핵심은 모든 경로에서 같은 intent 상태를 판단하는 것이다. 오래된 화면의 입력 오류, 다른 탭의 완료, 계약 변경, 결과 보존 만료가 겹쳐도 임의의 순서로 422·303·409를 선택하지 않도록 한다.

## 이번에 바뀐 결정

| 영역 | v0.5 결정 |
| --- | --- |
| 상태 우선순위 | 현재 권한·기록 일관성·해당 상태의 TTL·계약 의미·입력 순서로 판단한다. 422 직전에는 fresh snapshot으로 다시 판정한다. |
| 완료 재응답 | 완료한 intent의 GET은 현재 영수증 권한으로 조회한다. POST는 같은 의미와 같은 입력인 경우만 재응답하며 잘못된 재입력을 422 편집 폼으로 돌리지 않는다. |
| 읽기와 쓰기 | 완료 조회는 read transaction으로 처리한다. 신규 쓰기만 새 IMMEDIATE에서 정책·Grant·revision·유일성을 재검사한다. |
| 동기 역할 | 넓은 object 제네릭이 Promise를 허용하는 타입 구멍에 SyncResult와 반환값 가드를 추가한다. 임의 callback의 부수효과를 증명한다고 주장하지 않는다. |
| 페이지 계약 | View|null을 resolvePage의 start·form·receipt·failure로 교체해 완료·만료·충돌 화면을 타입에 표현한다. |
| 손상 기록 | consumed인데 결과가 없는 상태를 500으로 분류하고 정상 정리에서 제외한다. 완료 행을 REPLACE로 덮어쓰지 않는다. |
| HTML 목적지 | 빈 action·빈 formaction·base URL을 구분한다. route path의 network-path·정규화 차이를 거부하고 0개 제출 경로를 성공으로 처리하지 않는다. |
| JSON과 근거 | 정본 JSON의 중복 키 등을 거부한다. coverage의 잘못된 form ID를 고치고 문서·예시·실행 증거를 다시 연결한다. |

이전 버전에서 네 가지를 실제로 재현했다. 넓은 Result 타입의 async 함수가 tsc를 통과했고, 메타스키마가 `//other.example/action` 형태를 허용했고, 정리 SQL이 결과 없는 consumed 기록을 삭제했으며, coverage 예시 세 행이 존재하지 않는 form ID를 가리켰다. 재현 대상은 배포된 제품이 아닌 v0.4 참고 자료다. [재현 기록](evidence/v04-reproductions.json)

## 범위와 다음 단계

P0의 B/L/S/D 비교, 세 주요 변경 과제, 11개 전체 사례와 44개 결과 슬롯을 그대로 유지한다. 현재 수정은 구현 규약 보강이며 Doctor의 독점적 효용을 입증한 결과가 아니다. 새 언어·서버 생성기·동적 폼 전체 추론·새 DB adapter는 계속 제외한다.

계약 형식은 `boundary-contract/0.5-draft`, 주문 작업의 `operationRevision`은 2다. 서버 처리 의미가 바뀌므로 v0.4의 열린 intent를 조용히 새 의미로 실행하지 않는다. 상세 이전 방법은 [마이그레이션](MIGRATION.ko.md)에 있다.

## 실행과 미실행의 구분

참고 코드 검사는 타입·입력·상태·URL·동기 반환·JSON·제한된 Python SQLite 동작을 대상으로 한다. 실제 실행 결과와 버전은 [검증 보고서](validation/REPORT.ko.md)에 모았다. 실제 HTTP 서버·Bun adapter·Doctor·브라우저·사용자 폼 조사·P0·성능은 실행하지 않았다. 참고 검사 통과를 제품 보안 검증으로 집계하지 않는다.
