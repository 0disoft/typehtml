# 0.1.0-alpha.1 패키지 검증

검증일: 2026-11-07 (Windows)

## 제공 범위

- MIT 라이선스의 `@0disoft/typehtml@0.1.0-alpha.1` 설치 패키지.
- 평면 문자열·정수 폼의 타입 추론, 엄격한 요청 검증, 인증·CSRF·인가·실행·공개 출력 연결 API.
- Node/Bun CLI, 안전한 프로젝트 초기화, 정적 폼 정의의 타입·검증 자료 생성, Doctor 검사.
- Bun으로 실행하는 독립 시작 프로젝트와 별도 Bun SQLite 주문 참조 구현.
- ESM JavaScript와 TypeScript 선언, 시작 안내 및 API 문서.

## 실행한 검증

환경: Node.js 24.14.0, Bun 1.4.4, TypeScript 7.0.2.

| 명령 | 결과 |
| --- | --- |
| `bun test` | 41개 파일, 380개 테스트 통과, 실패 0, expect 3,007개 |
| `bun run typecheck` | 통과. `scripts/`도 검사 대상에 포함 |
| `bun run generate:check` | 이전 검증 결과 재사용. 이번 전체 테스트의 생성물 최신 상태 검사도 통과 |
| `bun run pack` | ESM·타입 선언 빌드 후 설치용 tgz 생성 |
| `bun run package:smoke` | 저장소 밖의 새 npm·Bun 소비자에서 10개 항목 통과 |
| `git diff --check` | 통과 |

`package:smoke`는 실제 설치된 패키지로 다음 동작을 확인한다.

1. npm과 Bun의 CLI 실행 파일 및 Node/Bun 직접 실행.
2. 두 설치 방식에서 Node/Bun의 루트·contract·doctor·runtime import와 303/422/403 응답.
3. Bun 전용 주문 참조의 Node 거절, Bun import, 동봉 계약 및 메모리 SQLite 저장소.
4. `skipLibCheck: false`, `allowImportingTsExtensions: false`, Bun ambient 타입 없이 설치된 선언과 정상·오류 타입 추론 검사.
5. 설치된 CLI로 독립 프로젝트 생성, Node로 생성·최신 상태 확인·Doctor 실행(경로 1개, finding 0개).
6. 독립 Bun 서버의 GET 200, 원본 값을 보존하는 422, 성공 303, 공개 결과 페이지 200.

검증 서버는 종료했고 임시 소비자 디렉터리는 정리했다. 테스트용 시작 프로젝트에만 로컬 tgz 의존성 경로를 넣었으며, 실제 생성기는 배포 패키지 이름과 버전을 사용한다.

최종 설치 파일: `artifacts/0disoft-typehtml-0.1.0-alpha.1.tgz`

SHA-256: `8c77f2eeefd84e8906e661e2c6931cca02b2587e9e5b71a5be03047d5bb355b4`

이번 성능 개선의 조건별 측정과 동작 변경은 [성능 확장성 검증](PERFORMANCE_SCALING.ko.md)에 기록했다.

## 남은 한계

- npm 공개 업로드와 Git push는 실행하지 않았다. 검증 시점에는 npm 인증도 없었다.
- Node 22+와 Bun 1.4+를 지원 대상으로 선언했지만, 이번 실제 실행 환경은 위 버전과 Windows뿐이다. Node 22 및 다른 OS의 실행 결과는 없다.
- 시작 프로젝트 서버와 SQLite 주문 참조는 Bun을 요구한다. 일반 폼 API와 CLI는 Node에서도 검증했다.
- 일반 폼 처리기는 애플리케이션의 데이터베이스 트랜잭션, 영속 중복 실행 방지, 외부 효과 복구를 제공하지 않는다.
- 공개 API는 alpha 단계다. 정식 프레임워크 수준의 기능 범위·호환성 안정성·제품 적합성이 검증되었다는 의미는 아니다.
- 기존 P0a/P0b 비교 및 물리 전원 차단 검증 상태는 변경하지 않았다. 자세한 범위는 기존 v0.5 감사 및 P0 결정 기록을 따른다.
