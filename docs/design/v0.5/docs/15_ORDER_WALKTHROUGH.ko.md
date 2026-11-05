# 주문 초안 한 건을 끝내고 다시 확인하는 흐름

이 문서는 런타임 실행 예상을 설명한다. Hono 서버·Bun 어댑터를 실행한 기록은 [검증 보고서](../validation/REPORT.ko.md)에 없으며, 아래 흐름을 실제 요청 결과로 표시하지 않는다. 실제 결제·재고 예약은 범위 밖이다.

## 시작과 표시

사용자가 `/orders/new?productId=p_100`을 연다. 인증된 principal과 현재 상품 정책을 확인하고 resolvePage가 start를 반환한다. renderer는 시작 폼과 CSRF를 제공한다. 업무 intent는 생성하지 않는다.

시작 POST는 동일 origin·본문 한도·CSRF·발급 제한을 확인한다. prepareIntent가 동기 transaction에서 회원·상품·발급 정책을 검사하고, coordinator가 revision 7·현재 behavior digest를 저장한다. intent는 새 URL로 303 이동한다. 그 GET의 form variant는 현재 OPEN 상태와 같은 revision의 상품만 표시한다.

## 입력 오류와 다른 탭의 완료

수량 21은 정상적인 구조의 전송값이지만 이 예제의 최대 20을 넘는다. 오류 후보가 생겨도 즉시 HTML을 만들지 않는다. fresh read snapshot의 상태 판정을 다시 확인한다. 여전히 OPEN·권한 유효·같은 계약·revision이면 422에 허용한 raw 값과 필드 오류를 표시한다.

그 사이 다른 탭이 같은 intent를 완료했다면 이 잘못된 입력 요청은 409다. 완료한 주문을 수정하는 폼을 만들지 않는다. 사용자는 현재 권한으로 영수증을 조회할 수 있다. 이 분기는 [참고 함수](../reference/intent-decisions.ts)에서 순수 데이터로 확인하며 실제 HTTP 경쟁을 실행한 결과는 아니다.

## 최초 완료

수량 2가 유효하면 읽기 transaction을 닫고 BEGIN IMMEDIATE를 획득한다. current clock·intent·회원·상품·digest·발급 revision을 다시 검사한다. 다른 요청이 먼저 완료했으면 현재 완료 분기로 전환한다. OPEN이면 정책·Grant·CAS를 확인해 초안·소비 시각·결과 참조·감사를 같은 transaction에 기록한다.

공개 projector와 output schema, 고정 영수증 Location을 확인한 뒤 commit한다. 동기 역할이 Promise나 thenable을 반환하면 coordinator가 실패시키고 rollback한다. private 필드가 있는 전체 Draft를 반환해도 tsc가 반드시 막지는 않으므로 런타임 output 검증을 생략하지 않는다.

## 화면에 보인 가격이 바뀐 경우

intent가 revision 7을 가리키는데 가격 수정으로 현재 revision이 8이면 OPEN 제출은 QUOTE_CHANGED 409다. 방금 읽은 revision 8을 기존 intent에 덮어쓰지 않는다. 새 작업은 명시적 시작 POST로만 진행한다.

이미 완료한 초안의 영수증은 작성 당시 금액을 가진다. 나중의 상품 가격 변경은 그 영수증 재응답을 막지 않는다. 현재 영수증 권한과 결과 보존을 확인한다.

## 재응답·계약 변경·정리

완료한 같은 입력의 POST는 fresh read snapshot으로 권한과 hash를 확인하고 같은 영수증으로 303 이동한다. writer lock과 execute는 필요 없다. 입력이 달라졌거나 계약 의미가 바뀌었으면 409이며, 완료한 intent GET은 현재 권한으로 영수증을 찾아준다.

유효 결과가 남아 있으면 OPEN TTL보다 result TTL을 우선한다. 보존이 끝난 정상 임시 자료만 정리하고 실제 초안은 남긴다. consumed인데 결과가 없는 비정상 상태는 500·내부 경보로 분리하고 자동 정리로 지우지 않는다. ID를 새 작업에 재사용하지 않는다.

## 구현자가 확인할 경계

| 확인 | 대상 |
| --- | --- |
| 폼과 서버 연결 | form ID·submitter·유효 목적지·entry 공급 |
| 페이지 처리 | start·form·receipt·failure union |
| 입력 순서 | HTTP·CSRF → scoped 상태 → 필요한 입력 검사 → 최종 상태 확인 |
| 최초 업무 | fresh IMMEDIATE·현재 정책·Grant·CAS·원자 commit |
| 재응답 | fresh read snapshot·현재 receipt 권한·같은 입력 hash |
| 정리 | 정상 만료만 삭제, 상태 불일치 자료 보존 |

이 흐름은 선택 runtime 설계다. 첫 제품 비교 P0에는 DB나 이 coordinator 구현을 요구하지 않는다.
