# 현재 결정과 보존된 피드백

v0.2·v0.3의 피드백 43개는 [원본 결정 이력](../evidence/feedback-decisions.json)에 보존했다. 이번 개정은 새로운 외부 피드백으로 가장하지 않고 [이번 자체 검토](../evidence/self-review.json)를 따로 기록했다. 구현자는 아래 현재 결정을 우선한다.

| ID | 현재 결정 | 재검토 조건 |
| --- | --- | --- |
| ADR-001 | 작업명 Boundary Contracts, 새 UI 언어 제외 | 실제 제품 범위가 바뀔 때 |
| ADR-002 | wrapper·Doctor를 독립 선택, 기존 lint·작은 script도 최종 결과 | 실제 P0 효과·관리 비용 |
| ADR-003 | 서버 generator는 후속 조건부 | 반복 수동 연결이 측정됐을 때 |
| ADR-004 | 정본 하나, 나머지는 파생 | 기존 exporter 의미·freshness를 확인했을 때 |
| ADR-005 | 첫 폼은 native HTML·flat scalar·URL 인코딩 | 실제 첫 기능을 막는 미지원 요구 |
| ADR-006 | 선택 runtime은 Bun SQLite 단일 호스트 | 실제 앱이 다른 DB를 요구할 때 |
| ADR-007 | 현재 권한·실제 CAS·intent 완료 원자성 | 별도 async profile을 설계할 때 |
| ADR-008 | 전역 정보흐름·새 상태 관리 제외 | 독립 연구로만 다룸 |
| ADR-009 | stable CLI typecheck, 베타 API 비필수 | 안정 API·필요성 검증 |
| ADR-010 | 표준 parser·기존 lint·접근성 엔진 재사용 | 기존 기능으로 해결되지 않는 구체 문제 |
| ADR-011 | 부분 범위·미실행·증거 출처를 출력에 포함 | 항상 유지 |
| ADR-012 | 이전 논쟁·근거 없는 점수를 구현 근거로 사용하지 않음 | 항상 유지 |
| ADR-013 | B/L/S/D 동일 조건 비교 | 기존 도구와 편의 비용을 함께 측정 |
| ADR-014 | 검사-only projection은 runtime과 독립 | DB 없는 도입 유지 |
| ADR-015 | sync와 async 역할 profile 분리 | Promise union으로 동기 의미를 흐리지 않음 |
| ADR-016 | 기존 엔진 공로와 Doctor 추가 발견을 구분 | 실제 비교 로그가 있을 때만 추가 발견 판정 |
| ADR-017 | 실제 폼 적합성 조사부터 | 맞는 사례가 없으면 종료 |
| ADR-018 | form identity와 의도 action을 별도 binding | 잘못된 action 때문에 분석 누락 방지 |
| ADR-019 | local-native snapshot·규칙별 상태·severity 분리 | 자동으로 앱 전체 보장으로 확대하지 않음 |
| ADR-020 | GET read-only, CSRF 보호 POST로 intent 발급 | 추가 사용자 단계 비용이 문제면 별도 안전한 발급 설계 검토 |
| ADR-021 | intent에 표시할 revision·behavior digest 저장 | 재가격·계약 변경 시 명시적 재시작 |
| ADR-022 | source hash·behavior digest·input hash 분리 | 역할마다 다른 변경 의미 보존 |
| ADR-023 | 초안 intent UNIQUE·결과 참조 FK·공개 JSON 중복 제거 | 삭제·이식 시 업무 기록 정책과 함께 검토 |
| ADR-024 | FULL·strict binding·commit 오류 분리 | 실제 배포 내구성 요구와 측정에 따라 변경 |

후속 제안이 이 결정과 충돌하면 ADR을 갱신하고 영향 문서·예제·계약을 함께 바꾼다. 오래된 피드백 문장을 현재 규약처럼 복사하지 않는다.

## v0.5의 결정

| ID | 결정 | 근거 |
| --- | --- | --- |
| ADR-025 | OPEN·완료·만료·모순을 같은 상태 판정으로 처리 | GET·POST·422 재렌더의 충돌 방지 |
| ADR-026 | 완료 재응답은 읽기 snapshot, 최초 쓰기만 새 IMMEDIATE | 불필요한 writer 예약 제거와 오래된 read 승격 방지 |
| ADR-027 | 동기 역할은 SyncResult와 런타임 반환 검사를 함께 사용 | v0.4 broad object의 async 허용 재현 |
| ADR-028 | resolvePage는 start·form·receipt·failure를 반환 | PageView 또는 null로 표현할 수 없던 응답 명시 |
| ADR-029 | 불일치 상태는 500·증거 보존, 정상 만료만 정리 | consumed row의 누락 결과가 지워지던 SQL 수정 |
| ADR-030 | JSON 중복 키와 경로 정규화를 정본 해석에서 확인 | 도구마다 다른 입력 의미 방지 |
| ADR-031 | 분석 경로 0개를 완전 분석으로 표시하지 않음 | false green 방지, 예제 target도 교차 확인 |

v0.4의 12개 결정은 [별도 이력](../evidence/history/self-review-v0.4.json)에 유지했다. [실제 반례 기록](../evidence/v04-reproductions.json)은 설계상의 추론과 구분한다. 이 변경을 근거로 P0의 실제 사용자 조사나 제품 가치 실험을 수행했다고 표시하지 않는다.
