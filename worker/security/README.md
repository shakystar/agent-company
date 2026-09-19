# Docker 내부 Codex 샌드박스

2026-09-06 사용자가 agent-company worker에 한정된 namespace 관련 보안 프로필 조정·검증을 승인했습니다. 호스트 설정·capability 추가·특권 모드·Codex 샌드박스 해제는 범위에 포함하지 않습니다.

## 프로필과 영향

`docker-29.1.3-default.json`은 [설치된 Docker 29.1.3의 공식 기본 프로필](https://raw.githubusercontent.com/moby/moby/docker-v29.1.3/vendor/github.com/moby/profiles/seccomp/default.json)을 JSON 서식만 정리한 기준입니다. 라이선스는 `LICENSE.moby`에 보존했습니다. 최신 Docker 보안 기본값을 뜻하지 않습니다.

`codex-userns.json`은 기존 규칙을 모두 보존하고 다음 허용만 덧붙입니다. 최초 규칙은 amd64와 Codex CLI 0.153.4의 실제 호출을 기준으로 합니다. 설치형 Windows 파일 bind 호환 규칙은 아래 별도 근거를 따릅니다.

| 호출 | 추가 허용 범위 |
|---|---|
| clone | NEWNS·NEWIPC·NEWUSER·NEWPID·NEWNET·SIGCHLD가 함께 있는 정확한 플래그 조합 |
| unshare | CLONE_NEWUSER만 |
| mount | 실제 관측한 플래그 조합만 |
| pivot_root | 내부 파일시스템 루트 전환 |
| umount2 | MNT_DETACH만 |

추가 허용은 bwrap 하나가 아니라 **해당 worker 컨테이너의 모든 프로세스와 자식 프로세스**에 적용됩니다. seccomp는 포인터가 가리키는 경로나 파일시스템 종류를 비교하지 못합니다. mount·pivot_root의 대상 경로를 이 프로필만으로 한정하지 못하며 커널의 namespace·capability 검사를 함께 사용합니다. [Linux seccomp 문서](https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html)

새 user namespace 안에서 namespaced capability를 사용할 수 있게 되므로 공유 WSL 커널의 namespace·mount 처리와 자원 소모에 노출되는 범위가 늘어납니다. 호스트 capability, 호스트 파일, Docker 소켓, 다른 에이전트 볼륨을 새로 제공하지 않습니다. 강한 악성 코드 격리 전체를 인증한 설정은 아닙니다.

`--user=1000:1000`, `--cap-drop=ALL`, `no-new-privileges`, 읽기 전용 루트, CPU·RAM·PID 제한은 유지합니다. `clone3`는 기존 ENOSYS이며 setns·bpf·keyctl 등 무관 syscall은 계속 차단합니다. Docker 데몬의 전역 프로필·WSL sysctl·AppArmor·Kubernetes 설정은 변경하지 않습니다.

## 선택과 검증

`AGENT_DOCKER_SANDBOX=codex-userns`가 명시된 새 worker 실행에만 적용됩니다. 미설정 또는 `default`는 Docker 기본 프로필이며 오류 시 다른 권한 모드로 자동 전환하지 않습니다. Docker 29.1.3/amd64 이외의 엔진은 재검증 전 실행을 거부합니다. worker는 정책 파일을 마운트하지 않으며, Docker CLI가 호스트의 파일을 읽어 해당 컨테이너에 전달합니다.

`scripts/probe-sandbox.ts`는 기본 프로필의 거부 위치 또는 제한 프로필의 실제 syscall을 추적합니다. 별도 `diagnostic.Dockerfile`의 이미지는 strace만 추가하며 운영 worker 이미지를 변경하지 않습니다. 설치된 CLI의 명령은 `codex sandbox -- COMMAND`이며, 현재 온라인 문서의 `sandbox linux` 형식과 차이가 있습니다.

`scripts/verify-sandbox.ts`는 인증·모델 호출 없이 실제 작업공간 쓰기, 외부 쓰기 차단, 네트워크 소켓 차단, UID·capability·자원 제한과 기존 syscall 차단을 검사합니다. `persistent` 인수는 검증 전용 named volume을 만들고 종료·소유권 확인 후 삭제합니다. Docker 자체의 network=none에 기대지 않고, 바깥에서 접속 가능한 컨테이너 내부 TCP listener에 샌드박스가 접근하지 못하는지 검사합니다.

모델 응답과 실제 도구 실행은 별도 검사입니다. `scripts/smoke-runtime.ts`는 ChatGPT 사용량이 발생하는 실제 모델 검사입니다. 세션 재개·자율 성장·팀 협업 전체의 검증을 대체하지 않습니다. 세부 결과는 `docs/STATUS.md`에 기록합니다.

## Windows 파일 bind 호환 — 2026-09-12

설치형은 전용 Windows `auth.json` 한 파일을 worker의 tmpfs Codex 홈에 연결합니다. Docker 내부에서 이 drvfs 파일은 `rw,noatime` mount로 나타납니다. 기존 프로필의 읽기 전용 재마운트 조합 `36903`에는 `NOATIME`이 없어, Codex가 내부 루트를 읽기 전용으로 구성할 때 해당 하위 mount에서 `Operation not permitted`로 실패했습니다. 실제 비모델 A/B에서 같은 0.154.0 이미지의 빈 홈은 성공하고 공개 가짜 파일 bind를 추가한 경우만 실패했습니다.

추가 규칙은 amd64 `mount`의 네 번째 인자가 정확히 **37927**인 경우 하나입니다. `RDONLY|NOSUID|NODEV|REMOUNT|NOATIME|BIND|SILENT`이며 기존 조합에 `NOATIME(1024)`만 추가합니다. 숫자는 실제 mountinfo와 [고정 upstream bind-mount.c](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/vendor/bubblewrap/bind-mount.c#L470)에서 계산했으며 직접 strace 관측값으로 기록하지 않습니다. 해당 파일과 주요 Linux sandbox 소스 5개는 0.153.4와 0.154.0에서 동일했습니다. 버전 전용 우회가 아니라 설치형 Windows 파일 mount 구성의 호환 수정입니다.

검증용 프로필 복사본에서 실제 작업공간 쓰기·재읽기, 외부 쓰기·내부 네트워크 접근·기존 privileged syscall 차단을 확인했습니다. 가짜 파일의 Windows 갱신·같은 inode 보존, 컨테이너가 살아 있는 동안 writer/home lease 해제 거부, 실제 자식 종료 뒤 계정 홈 재개도 확인했습니다. [검증 기록](../../.verification/desktop-native-resume-20260912/sandbox-candidate-983f0279-4a00-4368-828a-8d46e4b6b444/report.json)에 앞선 실패와 구분한 결과를 보존합니다. 실제 인증·모델·OAuth refresh 검사는 아니며 첫 검증기의 stdin 종료 지연은 실패로 별도 보존했습니다.

다른 플래그를 포함하는 mask 허용, capability 추가, 전역 설정 변경은 없습니다. 추가 허용도 컨테이너 전체에 적용되며 경로를 제한하지 못한다는 기존 seccomp 한계는 유지합니다. 제품 worker 9파일·이미지는 바뀌지 않지만 security 파일을 고정하는 설치용 worker package와 서버 payload는 표준 경로로 새로 생성해야 합니다.

적용 범위는 설치형 복사본과 저장소에서 실행 중인 제어 서버가 다릅니다. 설치형의 기존 payload 복사본은 바뀌지 않습니다. 반면 운영 4310처럼 저장소의 이 프로필 경로를 사용하는 제어 서버는 경로만 캐시하므로, 재시작하지 않아도 **다음 Docker 컨테이너를 만들 때 현재 파일의 새 규칙을 읽습니다**. 이미 생성된 컨테이너의 정책은 바뀌지 않습니다. 운영 프로세스·이미지 선택을 변경하지 않았다는 사실과 향후 운영 컨테이너의 허용 규칙 변화는 구분합니다.

이 영향을 추가 검증하기 위해 기존 불변 이미지 `ef684015…`의 실제 Codex 0.153.4를 현재 프로필과 새 소유 named volume에서 실행했습니다. [비모델 호환 검사](../../.verification/desktop-native-resume-20260912/sandbox-legacy-bb0fd492-1768-4b62-baa2-e4000adaa1bc/report.json)는 파일쓰기·재읽기, 외부쓰기·네트워크·기존 syscall 차단, UID·capability·자원 제한을 통과했습니다. 검증 컨테이너·볼륨만 소유권 확인 후 정리했고 운영 컨테이너·볼륨·계정은 참조하지 않았습니다. 실제 운영 모델이나 모든 과거 개인 환경을 재검증한 것은 아닙니다.

## 별도 Chromium 브라우저 프로필

2026-09-08 사용자가 브라우저 컨테이너에 필요한 내부 격리 호출의 전용 프로필 추가를 승인했습니다. `browser-userns.json`은 위 Docker 29.1.3 기본 규칙을 그대로 보존하고 Chromium 153.0.8010.12/amd64에서 확인한 규칙만 덧붙입니다. 기존 `codex-userns.json`을 재사용하거나 수정하지 않습니다.

| 호출 | 추가 허용 범위 | 근거 |
|---|---|---|
| clone | NEWUSER·SIGCHLD, `0x10000011` | 최초 user namespace 가능 여부 검사 |
| clone | NEWUSER·NEWPID·NEWNET·SIGCHLD, `0x70000011` | 격리 zygote 생성 |
| clone | NEWPID·SIGCHLD, `0x20000011` | renderer용 PID namespace 생성 |
| unshare | CLONE_NEWUSER, `0x10000000` | 중첩 user namespace 검사 |
| chroot | syscall 허용, 대상 경로는 커널 검사 | 자기 user namespace 진입 후 빈 fdinfo 디렉터리로 파일시스템 접근 축소 |

세 clone 조합과 unshare는 정확한 숫자 인수만 허용합니다. chroot는 seccomp가 포인터의 경로를 판독할 수 없어 `/proc/self/fdinfo`만으로 한정하지 못합니다. 해당 컨테이너의 모든 프로세스에 적용되는 규칙이며, 새 user namespace 안의 namespaced capability 사용 범위가 늘어납니다. 호스트 CAP_SYS_CHROOT·SYS_ADMIN이나 파일·볼륨 접근을 제공하지 않습니다. 컨테이너 바깥 capability 추가 없이 최상위 uid 1000의 chroot 거부와 보호 파일 읽기 거부를 따로 검사합니다.

mount·pivot_root·umount2·setns·clone3·bpf·keyctl은 기본 프로필 그대로입니다. 비root·capability 전체 제거·no-new-privileges·읽기 전용 root·호스트/인증 마운트 없음·network none·사설 IPC와 CPU/RAM/PID 제한을 유지합니다. 전역 Docker/WSL/AppArmor 설정은 변경하지 않습니다.

Playwright 1.63.0은 설치된 정식 Chromium의 headless 모드(`channel: 'chromium'`)와 `chromiumSandbox: true`를 사용합니다. 권한을 끄는 플래그는 추가하지 않습니다. `scripts/check-browser-isolation.mjs`는 실제 화면·상태 유지·외부 요청 차단·JPEG 캡처와 자체 `chrome://sandbox` 진단을 수행합니다. 이 검증은 브라우저 컨테이너의 기능·제한 검사이며 악성 코드 전체에 대한 격리 인증이나 모델의 시각 판단 품질 검사가 아닙니다.

버전별 소스와 실패·수정·재검증 근거는 `.verification/browser-20260908/approved-profile-*`에 보존합니다. 원인이 없는 추가 syscall 허용이나 실패 시 다른 권한 프로필로의 자동 전환은 하지 않습니다.
