# 첫 구현의 내부 API 계약

## 배포 준비

- `GET /api/deployment`: `phase`(running/draining/ready/blocked), 요청·준비 완료 시각, 진행 중 Run ID, 보존된 미완료 수, 차단 사유를 반환합니다.
- `POST /api/deployment/prepare` (`{}`): 현재 모델 턴의 종료를 기다리며 새 실행을 보류합니다. 응답은 준비 요청의 수락이며 실제 전환 완료가 아닙니다.
- `POST /api/deployment/resume` (`{}`): 저장된 이미지의 존재·귀속을 확인한 뒤 보류를 해제합니다. 기존 모델 사용 장부와 사용자 정지 상태를 초기화하지 않습니다.
- 준비 중에는 health/workspace/deployment 조회와 prepare/resume 외 새 API 입장을 409로 거부합니다. 설치형의 기존 로그인 상태 조회·취소는 정리 경로로 허용합니다. 이미 처리 중인 요청·현재 worker 도구·대기 중 로그인 자식은 완료·정리까지 기다립니다.
- `GET /api/workspace`의 `deployment`에도 같은 상태가 포함됩니다. 보류와 준비 완료 시각은 재시작 시 실제 환경을 다시 검사합니다.

응답은 shared/types.ts의 객체입니다. 오류는 `{ error: string }`이며 적절한 HTTP 상태를 사용합니다. 개인용 서버는 기본 localhost 바인딩입니다.

## 설치형 계정 초기 설정

CLI에는 이 API와 기능 표지가 없습니다. 설치형 workspace 응답의 `desktop.accountSetup=true`가 기능 표지입니다. 모든 요청은 기존 실행별 desktop 인증·출처 검사를 적용합니다. 상태 형식은 `shared/desktop-setup.ts`의 `DesktopSetupStatus`이며, 계정 상태/일회성 로그인 코드를 일반 workspace·활동·백업에 포함하지 않습니다.

| 요청 | 본문 | 동작 |
|---|---|---|
| GET /api/desktop/setup | — | 현재 revision·단계·동봉 구성·계정·로그인 대기·고정 오류 |
| POST /api/desktop/setup/check | revision | 저장된 계정 조회와 자식 종료 확인 |
| POST /api/desktop/setup/login | revision, method=chatgptDeviceCode | 공식 device code 요청 |
| POST /api/desktop/setup/login | revision, method=apiKey, apiKey | 키를 비공개 pipe로 저장한 뒤 계정 조회; 실제 키 유효성/모델 호출은 별도 |
| POST /api/desktop/setup/cancel | revision, attemptId(UUID) | 현재 로그인만 취소; 직전 완료와 경합한 새 인증도 해제 후 조회 |
| POST /api/desktop/setup/logout | revision | 계정 해제 후 미연결 확인 |

변경 응답은 갱신된 상태이며, 연결 실패는 HTTP 200의 `phase=failed`/`error`에도 표시됩니다. 잘못된 입력은 400, 오래된 revision·다른 시도·동시 변경·실행 중/종료 중 변경은 409입니다. 로그인 대기 중 외부 입장 lease를 유지해 배포 준비가 자식 종료를 기다립니다. 준비 보류 중에도 GET 상태와 기존 시도의 cancel은 허용합니다. `executionReady=false`는 초기 계정 설정이 모델 실행을 활성화하지 않음을 표시합니다. 이 설치 묶음용 실제 로그인·worker 모델 실행은 아직 검증하지 않았습니다.

## 작업실과 에이전트

| 요청 | 본문 | 응답 |
|---|---|---|
| GET /api/workspace | — | Workspace |
| GET /api/health | — | 상태 |
| POST /api/operator-requests | requesterAgentId, scope, links?, category, title, reason, requestedAction, requestedScope, verificationCriteria, idempotencyKey | OperatorRequest |
| POST /api/operator-requests/from-message | messageId | 원문과 연결한 요청 초안; 같은 메시지는 중복 생성하지 않음 |
| POST /api/operator-requests/:id/revise | expectedVersion, scope, links, category, title, reason, requestedAction, requestedScope, verificationCriteria | 새 본문 버전; 기존 결정·검증 무효화 |
| POST /api/operator-requests/:id/decide | expectedVersion, status(needs_information/approved/rejected), reason | 대표 결정 |
| POST /api/operator-requests/:id/progress | expectedVersion, status(in_progress/verification_pending/failed), detail | 처리 상태 |
| POST /api/operator-requests/:id/verify | expectedVersion, method(github/environment/manual), resourceId?, evidence, detail | 서비스 확인 또는 운영자 확인 기록; passed 입력 금지 |
| POST /api/operator-requests/:id/withdraw | expectedVersion, reason | 철회 기록 |
| POST /api/operator-requests/:id/consult | content, idempotencyKey(UUID) | conversationId, message; 명시적 상담 |
| POST /api/agents | CreateAgentInput | Agent |
| PATCH /api/agents/:id | CreateAgentInput 일부 + status | Agent |
| POST /api/agents/:id/fork | name, persona?, snapshotId? | Agent |
| POST /api/agents/:id/snapshots | label? | Snapshot |
| POST /api/agents/:id/restore | snapshotId, restoreMemory?, restoreSkills?, restoreFiles? | Agent |
| GET /api/agents/:id/files | query: path?, read=true? | 파일 목록 또는 {path,text,bytes} |
| POST /api/agents/:id/runs | prompt | Run |
| POST /api/runs/:id/cancel | — | Run |
| POST /api/runs/:id/resume | {} | 예산 대기 Run의 재개 요청 |
| POST /api/runs/:id/steer | message | Run |
| POST /api/agents/:id/memories | kind, title, content | Memory |
| PATCH /api/memories/:id | kind?, title?, content? | Memory |
| POST /api/agents/:id/skills | name, description, content | Skill |
| POST /api/skills/:id/review | sourceRunId | 독립 회귀 검토 Run(202) |
| POST /api/teams | name, description?, workflow?, memberIds | Team |
| PATCH /api/teams/:id | name?, description?, workflow?, memberIds? | Team |
| POST /api/teams/:id/proposals | proposedByAgentId, memberIds, reason | Approval |
| POST /api/approvals/:id/resolve | approved | Approval |
| POST /api/connections | repository, access | Connection |
| POST /api/collaboration/:operation | shared/collaboration.ts의 작업별 입력 | 협업 객체 또는 페이지 |
| POST /api/team-tasks/:id/run | agentId, expectedVersion | 자청 상태와 함께 생성된 Run |
| POST /api/objectives | idempotencyKey, teamId, scope, title, purpose, constraints?, conditions | Objective(201) |
| PATCH /api/objectives/:id | expectedVersion, title?, purpose?, constraints?, conditions? | Objective |
| POST /api/objectives/:id/control | expectedVersion, action: pause/resume/cancel/reevaluate | Objective |
| POST /api/objectives/:id/confirm | expectedVersion, conditionId, note | Objective |
| GET /api/objectives/:id/evaluations/:evaluationId/evidence/:evidenceId | — | 평가 당시 원문과 해시를 포함한 ObjectiveEvidence |

목적의 `scope`는 지정 팀 또는 그 팀이 접근 가능한 프로젝트입니다. `conditions`는 1~20개의 `{id,text,requiresUserConfirmation}`이며 ID는 중복할 수 없습니다. 동일한 생성 키·본문은 기존 목적을 반환하고 다른 본문은 409입니다. 조건 확인·편집·제어는 로컬 사용자 API이며 worker 도구에 제공하지 않습니다.

Workspace의 `objectives`, `objectiveEvaluations`에서 상태·대기 이유·조건별 판단·근거 참조·생성 과제를 확인합니다. 평가의 전체 고정 입력은 내부 DB에 보존하며 원문은 개별 근거 API로 조회합니다. 평가는 `interactionMode=discuss`와 `objectiveEvaluationId`로 구분하고, 후속 Run·TeamTask는 `objectiveId`를 유지합니다.

근거의 `hashEncoding=utf8`은 원문 UTF-8 바이트의 SHA-256입니다. 이 필드가 없는 과거 근거는 JSON 문자열 표현의 해시이며 원문 파일 해시와 구분합니다. 과거 평가 입력은 변환하거나 덮어쓰지 않습니다.

편집은 관련 미완료 실행·열린 과제가 없는 일시정지 목적에서만 허용합니다. 버전 충돌은 409이며 기존 내용을 보존합니다. 편집하면 사용자 확인을 초기화합니다. 완료 조건의 사용자 확인은 현재 목적 버전에서만 기록합니다. 재평가는 예산을 초기화하지 않습니다. 목적 취소·권한 철회·예산 대기는 기존 실행과 도구 경계에서도 적용합니다.

운영자가 화면에서 직접 편집한 팀 구성은 즉시 반영합니다. 에이전트 제안은 pending 승인으로 저장하며 승인 전에는 팀을 변경하지 않습니다.

활성 Run은 시작 시 Agent·Memory·Skill을 스냅샷으로 고정합니다. 한 Agent에는 활성 Run 하나만 허용합니다. 종료 시 결과·성장·스냅샷을 트랜잭션으로 저장합니다. 실패·취소 시 자동 성장을 적용하지 않습니다.

Workspace의 `resources`는 worker 예산의 capacity·reserved·available·running·waiting입니다. OS 실제 점유량이 아니라 실행 한도의 예약 상태입니다. Run은 attempt·recoveryReason·nextAttemptAt·progress·resources·cleanupPending을 추가로 제공합니다. 재개용 전체 입력·체크포인트는 내부 DB 상태이며 workspace 응답에는 노출하지 않습니다.

실행기는 RuntimeDriver로 주입합니다. 테스트는 명시적인 테스트 실행기를 주입하고, 제품 기본 실행기는 실제 컨테이너 실행기입니다. 실행 환경이 준비되지 않으면 성공을 만들어내지 않고 실행 불가 이유를 반환합니다.

## 성장과 실행별 사용 기록

Workspace는 `skillRevisions`, `growthReviews`, `repairJobs`, `modelAttempts`를 제공합니다. 스킬의 `activeRevisionId`가 실행 버전을 가리킵니다. Run.kind는 task/review/repair이며 레거시 미설정은 task입니다. 비교 fingerprint·기준/후보/판정 attempt 연결과 모델 판정·실제 적용 결정을 구분합니다.

ModelAttempt.phase는 task/trial/evaluate/repair입니다. 각 실행에 모델·시각·소요 시간·완료/실패/취소 상태·오류·명령 관찰을 저장합니다. usage.status는 reported/partial/unknown이며 미상 토큰은 null입니다. Run 합계는 관측한 값의 합계이므로 완전한 청구량을 뜻하지 않습니다. 실패·취소한 시도의 관측치도 보존합니다.

회귀 검토의 sourceRunId는 같은 에이전트의 성공 과제여야 하며, 원래 입력·모델·페르소나와 재생 가능한 파일 조건을 검사합니다. 현재 활성 스킬을 기준 버전과 비교합니다. 모델의 문제 보고만으로 복귀하지 않으며 검토 실행에는 추가 지시를 받지 않습니다.

`modelBudgetPaused=true`인 queued Run만 `/resume`으로 재개 요청할 수 있습니다. 저장된 체크포인트의 재개 안전성과 기존 모델 시작 게이트를 다시 적용하며 예산을 증액하거나 기록을 초기화하지 않습니다. 다른 상태는 409입니다. 개발 캠페인 게이트는 운영자의 금액·토큰 예산 설정 API와 별개입니다.

## 개인 파일과 동료 협업

Agent.workspaceRunId는 마지막 성공 작업 또는 성공한 파일 반입의 파일 버전입니다. Run.workspaceSourceRunId는 시작 전에 고정한 계승 원본입니다. 스냅샷의 Agent에도 해당 참조가 보존됩니다. restoreFiles 기본값은 true이며 과거 볼륨을 덮어쓰지 않고 참조를 되돌립니다. 조회는 마지막 성공 버전만 제공하며 현재 실행의 부분 파일·세션·인증은 공개하지 않습니다.

## 파일 입출력·운영 API

| 경로 | 입력 | 응답 |
|---|---|---|
| GET /api/storage | — | StorageStatus(사용량·예산·대기·백업·복원 준비본) |
| POST /api/storage/backups | {} | 갱신된 StorageStatus |
| PATCH /api/storage/backups/:id | pinned | 갱신된 StorageStatus |
| POST /api/storage/restores | backupId | 검증된 RestoreRecord |
| POST /api/storage/restores/:id/activate | {} | 전환 후 paused=true인 StorageStatus |
| POST /api/storage/resume | {} | 사용자 재개 허용 후 StorageStatus |
| GET /api/files | query: scopeType, scopeId | FileRecord 목록 |
| POST /api/files/import | scope:{type:agent/team/project,id}, path, mediaType, base64 | file, workspaceRunId? |
| GET /api/files/:id/download | — | 공유 바이너리 attachment |
| GET /api/agents/:id/files/download | query: path | 개인 파일 attachment |

파일당 최대 16MiB, 동시 HTTP 반입 연결은 2개입니다. 반입 요청만 별도의 bodyLimit를 사용하며 기존 3MB 일반 API 제한·Origin/Host 검사를 유지합니다. 개인 반입은 과거 파일을 덮어쓰지 않고 새 fileVersions 참조로 승격합니다. 전송 중 오류는 이미 성공한 파일을 되돌리지 않습니다.

`file_list`와 `file_read`는 worker의 Run에서 행위자를 결정하고 현재 공유 범위를 검사합니다. 목록은 offset/limit(최대 100), 읽기는 id/offset/maxBytes(최대 256KiB)를 받습니다. 읽기는 contentBase64/nextOffset/done을 반환합니다. 개인 파일은 자신의 workspace에서 읽습니다.

백업·복원 중 충돌은 409, 저장 예산 부족은 507입니다. 저장 기능 미설정은 status.enabled=false이며 실제 동작은 503으로 거부합니다. 복원은 별도 세대를 검증한 후 활성 포인터를 전환하고, 전역 paused 상태를 DB에 보존합니다. 구세대에 대기하던 변경은 409이며 이전 DB에만 저장한 뒤 성공을 반환하지 않습니다.

협업 operation은 project_create/update, collaboration_context/members, artifact_list/read/publish, task_list/create/claim/release/complete, message_list/send/acknowledge/complete입니다. 공통 scope는 {type:team|project,id}입니다. 공유 자료 수정과 과제 상태 변경에는 expectedVersion이 필요합니다. 메시지는 idempotencyKey를 사용하며 replyToId로 기존 대화에 답장합니다.

HTTP API의 행위자는 사용자(null)입니다. senderAgentId를 입력해 에이전트로 가장할 수 없습니다. 에이전트 도구의 행위자는 실행 관리자가 Run에서 결정하며 도구 호출 때마다 현재 구성원 권한을 검사합니다. project_create/update는 사용자 전용입니다. 사용자 지정 과제 시작은 자청 상태 변경과 Run 생성을 한 트랜잭션으로 처리하며 실제 실행 실패와 과제 완료는 별개입니다.

Run.waitingFor는 {messageId,reason}입니다. peer_wait는 본인이 보낸 요청만 기다리며 요청 수신 확인 자체로 재개하지 않습니다. 답장 또는 처리 완료로 기존 작업을 이어가며, 사용자 추가 지시는 대기를 해제합니다. 사용자 취소 뒤 동료 답장은 기록만 남기고 자동 실행하지 않습니다. 사용자가 새로 보낸 명시적 답장은 새 작업으로 처리할 수 있습니다.

Workspace에는 projects/sharedArtifacts/teamTasks/messages가 추가됩니다. 실행 입력·체크포인트와 전달 Run/발신 Run 매핑은 내부 데이터이며 공개 응답에 포함하지 않습니다. 메시지 전달 상태는 요청 또는 과제의 완료를 의미하지 않습니다.

## 산출물 버전 고정·미리보기·검수

입력·응답 형식은 `shared/artifact-preview.ts`, 검수 의견 입력은 `shared/artifact-preview-feedback.ts`를 따릅니다. HTTP 행위자는 사용자이며, 개인 작업 볼륨이나 다른 공유 범위를 묶음에 자동 포함하지 않습니다.

| 경로 | 입력 | 응답 |
|---|---|---|
| POST /api/artifact-previews | scope:{type:team/project,id}, prefix, versions?:[{artifactId,version}] | ArtifactPreviewManifest(201) |
| GET /api/artifact-previews | query: scopeType=team/project, scopeId | 해당 범위의 ArtifactPreviewManifest 배열(200) |
| POST /api/artifact-previews/:id/open | entrypoint? 또는 {} | ArtifactPreviewSession(200) |
| DELETE /api/artifact-previews/:id/session | — | {closed:true}(200) |
| GET /api/artifact-previews/:id/download | — | application/zip attachment(200) |
| POST /api/artifact-previews/:id/feedback | conversationId, content, mode?, recipientAgentId?, idempotencyKey | ConversationMessage(202) |

`prefix`는 공유 산출물 이름의 폴더 경로입니다. 빈 문자열은 해당 공유 범위 전체이며, 그 외에는 `prefix/` 아래 모든 파일을 선택합니다. `versions`를 생략하면 생성 시점의 각 최신 버전을 고정합니다. 지정하면 선택 경로의 전체 파일 ID 집합과 정확히 일치해야 하며, 각 파일의 현재 또는 보존된 과거 버전을 선택합니다. 파일 추가·누락·중복 참조나 사라진 버전은 409입니다. 동일 scope·prefix·sourceHash의 기존 묶음은 새로 복제하지 않고 같은 명세를 반환하며, 이 경우에도 생성 경로의 HTTP 응답은 201입니다.

`ArtifactPreviewManifest`는 `schemaVersion:1`, `id`, `scope`, `prefix`, `createdAt`, `sourceHash`, `totalBytes`, `entries`, `entrypoints`입니다. 각 entry는 `artifactId`, `version`, prefix를 제외한 상대 `path`, `mediaType`, UTF-8 `bytes`, `sha256`을 보존합니다. 본문은 기존 공유 산출물의 버전 이력을 참조하며 명세에 복제하지 않습니다. `sourceHash`는 선택 범위·경로·버전·파일 해시를 포함하는 묶음 식별자이며 GitHub 커밋 SHA나 품질 판정이 아닙니다. 최대 200개 파일·16MiB이며 HTML 진입 페이지가 하나 이상 필요합니다. ZIP에는 고정한 원본 파일과 `__agent_company_preview_manifest__.json`을 포함합니다. 열기·파일 응답·다운로드 때 고정 원문의 범위·버전·해시를 다시 검사합니다.

`ArtifactPreviewSession`은 `{manifestId,origin,url,entrypoint,expiresAt}`입니다. `entrypoint`는 명세의 HTML 목록에서 선택하며 생략하면 첫 항목을 엽니다. 기존 유효 세션을 다시 열면 같은 주소 공간과 만료 시각을 사용합니다. 기본 만료는 1시간, 동시에 열린 묶음은 최대 4개입니다. 종료는 명세·원문을 삭제하지 않으며 이미 닫힌 세션에도 `{closed:true}`를 반환합니다. 세션은 서버 종료·복원 전환 시 닫히며 이후 명시적으로 다시 열어야 합니다. 버전 고정·열기·다운로드 자체로 모델을 시작하지 않습니다.

미리보기 HTML은 제어 API와 다른 `127.0.0.2`의 묶음별 포트에서 정적으로 응답합니다. Host·Origin·초기 iframe 요청 출처·경로를 검사하고 GET/HEAD만 허용합니다. CSP와 iframe sandbox는 `allow-scripts allow-same-origin allow-forms`를 사용하며 `form-action 'none'`은 유지합니다. 로컬 submit 이벤트를 사용하는 데모는 허용하지만 실제 폼 전송·외부 fetch·worker·하위 iframe은 허용하지 않습니다. 백엔드 실행이나 네트워크 프록시는 제공하지 않습니다. 일반 브라우저에서 모든 자기 창 외부 탐색을 차단한다는 보장은 아니며, 브라우저 저장소는 서버 백업에 포함되지 않고 세션 종료만으로 삭제되지 않습니다. 포트 재사용과 같은 호스트의 쿠키 공유도 별도 브라우저 프로필 수준의 격리로 보장하지 않습니다.

검수 의견의 `content`는 공백 정리 후 1~12,000자이며 `mode`는 `discuss`(기본) 또는 `task`입니다. 서버가 선택한 명세 ID·scope·prefix·sourceHash·고정 시각을 본문 앞에 붙입니다. 대상 대화는 묶음과 같은 공유 범위여야 하며, `recipientAgentId`를 지정하면 현재 대화 참여자여야 합니다.

`recipientAgentId`가 없으면 서버가 `recordOnly:true`, `deliveries:[]`로 기록합니다. 새 Run이나 실행 중 작업의 추가 지시를 만들지 않으며, 이후 대화 조회에는 표시됩니다. `recordOnly`는 입력 필드가 아닙니다. 에이전트를 지정한 `discuss` 또는 `task`는 기존 대화 전달 경로로 처리하며, `task`에는 수신 에이전트가 필수입니다. 같은 대화·사용자·`idempotencyKey`의 동일 요청은 기존 메시지를 반환하고, 본문·mode·수신자·기록 전용 여부가 다른 재사용은 409입니다. 202 응답이나 delivery 상태는 실제 모델 시작·수정 완료를 뜻하지 않습니다.

제어 API 오류는 기존 `{error:string}` 형식입니다. 잘못된 입력·진입 페이지는 400, 금지된 출처·다른 범위 대화·허용되지 않은 참여자는 403, 없는 범위·묶음·대화는 404, 버전/해시/멱등키 충돌·복원/정비 중 작업은 409, 묶음 크기·파일 수 초과는 413, 열린 세션 한도는 429, 저장 예산 부족은 507입니다. 별도 미리보기 주소는 오류 본문을 노출하지 않으며 만료 처리 중 요청은 410, 종료된 listener는 연결 실패일 수 있습니다.

## GitHub 기존 PR 수정 도구

`github_revise`는 HTTP 운영자 쓰기 API가 아니라 실행 중인 에이전트의 GitHub 도구입니다. 입력은 `{connectionId,number,operationId,expectedHeadSha,files:[{path,content}],message}`이며 응답은 `{number,url,branch,headSha,commitUrl,unchanged,replayed}`입니다. `number`는 PR 번호, `expectedHeadSha`는 먼저 조회한 그 PR 작업 브랜치의 SHA입니다. 파일은 1~100개, 요청 전체 JSON은 UTF-8 128KiB 이하이며 `operationId`는 소문자 영숫자로 시작하는 소문자 영숫자·하이픈 1~60자입니다.

현재 및 실행 시작 시 쓰기 권한, 같은 프로젝트·원팀·연결 세대의 원래 `github_publish` 완료 영수증, 미병합 상태의 열린 PR과 원래 기본 브랜치를 확인합니다. 조건을 만족하는 새 Run이나 동료도 기존 PR 브랜치에 수정 커밋을 추가할 수 있습니다. 새 PR·대체 브랜치를 만들지 않으며 삭제된 브랜치를 재생성하지 않습니다. 병합·기본 브랜치 직접쓰기·파일 삭제·워크플로 변경은 지원하지 않습니다.

수정 내용마다 새 `operationId`를 사용하고 응답 유실 때는 같은 Run에서 동일 ID·동일 입력으로 재확인합니다. 원장과 원격 커밋 확인으로 중복 커밋을 방지하며 다른 입력으로 같은 작업 키를 재사용할 수 없습니다. 권한·귀속 불일치는 403, HEAD 변경·닫힌 PR·원래 영수증 불일치는 409, 수정 transport나 완료 영수증 조회 미설정은 503입니다. 상담 실행에는 쓰기 도구를 허용하지 않으며 설정·도구 노출과 실제 원격 수정 성공은 구분합니다.
