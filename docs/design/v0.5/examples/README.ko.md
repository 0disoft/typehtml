# 예제 상태와 읽는 순서

`order.boundary.json`만 수동 정본이다. 타입·draft 폼 projection·begin 폼 projection·behavior digest는 정본에서 함께 파생한다. `page-view.json`과 `public-receipt.json`은 가상 데이터이며 실제 주문 정보가 아니다.

HTML 세 파일은 읽기 전용 시작 화면, 서버가 발급한 intent의 수량 화면, 422 오류 화면의 참고 snapshot이다. `start.html`의 POST가 intent를 발급하도록 설계했다. 실제 renderer나 동작하는 사이트는 아직 없다.

`doctor.config.json`은 문서 URL·독립 form ID·예정 action ID를 명시한다. 기대 action URL 자체로 폼을 찾지 않아 오래된 URL도 검사 대상으로 남는다. 이 ZIP에는 앱 source route graph가 없다. coverage의 실제 route 개수·실행 값은 null과 NOT_RUN이다.

`request-cases.json`의 HTTP 결과는 설계한 기대값이다. `coverage.expected.json`과 `diagnostic-attribution.expected.json`도 예시 형식이며 실행 로그가 아니다. confirmed는 예시 진단 안의 확실성이고 제품에서 확인한 결함을 뜻하지 않는다. BC013의 확실성과 warning 심각도도 별개다.

실제 실행은 [검증 기록](../validation/REPORT.ko.md)에만 모은다. browser용 16개 합성 사례는 reference 폴더에 있다. v0.4에서 첫 navigation이 차단된 기록은 history에 보존하며 v0.5에서는 재시도하지 않았다.

422 snapshot은 fresh 상태 판정에서 여전히 OPEN인 경우에만 사용하는 예시다. 완료·만료·충돌한 요청에 이 화면을 재사용하지 않는다. 페이지의 실제 resolver 타입은 reference의 PageResolution을 따른다.
