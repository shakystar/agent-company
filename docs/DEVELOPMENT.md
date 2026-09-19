# 개발 안내

## 소스 구성

- `src/`: React 화면
- `server/`, `shared/`: 제어 서버와 공유 계약
- `worker/`: Docker 작업 실행기와 격리 프로필
- `desktop/src-tauri/`: Windows Tauri 앱
- `desktop/providers/`, `desktop/notices/`: 공급자 출처와 외부 구성요소 고지
- `scripts/`, `tests/`: 빌드·검증 스크립트와 테스트

개발 중인 소스의 첫 공개 스냅샷입니다. 기존 베타 설치 파일과의 소스 일치 여부는 검증하지 않았습니다. 운영 DB, 인증정보, 작업 산출물, 개인 업무 기록, 빌드 캐시와 설치 묶음은 포함하지 않습니다. `docs/launches/studio-refinement.md`는 기존 회귀 테스트가 읽는 브리프입니다. 다른 과거 운영 캠페인의 입력·기록은 포함하지 않으므로 해당 캠페인 스크립트의 실제 실행에는 별도의 입력이 필요합니다.

## 개발 화면과 검사

Node.js 24에서 `npm ci` 후 `npm run dev`로 시작합니다. 화면은 `http://127.0.0.1:5173`, API는 `http://127.0.0.1:4310`입니다. `npm run check`는 타입 검사·테스트·웹 빌드를 수행합니다. 테스트의 조건부 생략과 실제 컨테이너·모델 검증은 별개입니다.

`.env.example`을 `.env`로 복사해 실행 환경을 설정할 수 있습니다. 기본 `AGENT_AUTH=none`에서는 모델을 호출하지 않으며, 사용자 데이터는 `.data/`에 저장됩니다. 실제 에이전트 실행에는 Docker와 모델 인증이 필요합니다. Windows에서 WSL Docker를 사용할 경우 `AGENT_DOCKER_WSL_DISTRO`로 대상을 지정합니다.

`npm run worker:build`로 작업 이미지를 만들고 `npm run doctor`로 구성을 확인합니다. 격리 설정은 [worker 보안 안내](../worker/security/README.md)에 있습니다. `smoke:*`와 `verify:*` 스크립트 중 실제 모델·컨테이너를 사용하는 검사는 기본 검사와 구분합니다.

## Windows 앱 빌드

Windows x64, Node.js 24, Rust MSVC 도구체인과 Windows 빌드 도구가 필요합니다. 기본 네이티브 컴파일 명령은 `npm run build:desktop-native`입니다. 서버 payload는 `npm run build:desktop`으로 준비하며, 전체 설치본에는 별도로 검증한 Codex 실행 파일과 worker package가 필요합니다. 명령 인자와 검증 조건은 `scripts/desktop-build-options.ts`, `scripts/build-desktop-worker.ts`, `scripts/stage-desktop-native.ts`, `scripts/build-desktop-installer.ts`에 있습니다.

공급자 실행 파일, Docker 이미지 archive, 인증정보는 이 저장소에 동봉하지 않습니다. 빌드 도구는 파일 출처·해시·용량 조건을 검사합니다. 기본 검사 통과는 설치본 빌드·서명·깨끗한 PC 설치 성공을 의미하지 않습니다. 네이티브 제어 모듈의 별도 검사는 [native-checks](../desktop/native-checks/README.md)를 따릅니다.

## 라이선스

앱 코드는 루트의 [MIT LICENSE](../LICENSE)를 따릅니다. 외부 구성요소의 원문 고지는 `desktop/notices/`, `desktop/providers/`, `worker/security/LICENSE.moby`에 보존합니다. Tauri 설치 템플릿의 출처와 변경은 [고지](../THIRD_PARTY_NOTICES.md)에 기록합니다.
