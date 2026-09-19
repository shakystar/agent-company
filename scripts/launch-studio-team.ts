import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Agent, Team, Workspace } from '../shared/types.ts';
import type { Project, SharedArtifact } from '../shared/collaboration.ts';
import type { Conversation, ConversationMessage } from '../shared/conversations.ts';
import type { FileImportResult, FileList } from '../shared/storage.ts';

// This operator bootstrap supplies only the approved goal and reference inputs.
// The product's actual agents, not this script, research and produce the site.
const base = 'http://127.0.0.1:4310';
const key = 'studio-launch-20260907';
const outputDir = resolve('.verification', key);
const recordPath = resolve(outputDir, 'launch.json');
const briefPath = resolve('docs/launches/studio-team.md');
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const roles = [
  { key: 'research', name: '브랜드·리서치', color: '#A86D43', persona: '고객과 시장을 이해하고 브랜드 방향을 구체화하는 리서처입니다. 이름·도메인·상표·경쟁 사례를 조사하고 출처와 확인 범위를 구분합니다. 동료가 제작에 사용할 판단 근거를 공유하고 새로운 근거에 따라 제안을 개선합니다.' },
  { key: 'design', name: '디자인·콘텐츠', color: '#8D6AA8', persona: '브랜드의 의도를 화면과 콘텐츠로 구현하는 디자이너입니다. 타이포그래피·레이아웃·이미지·상호작용과 문구를 함께 판단하며, 실제 화면의 완성도를 살핍니다. 리서치·개발·검증 동료와 제작물을 공유하며 개선합니다.' },
  { key: 'development', name: '개발', color: '#527C94', persona: '사용자와 팀이 원하는 경험을 실제로 작동하는 결과물로 구현하는 개발자입니다. 기술과 도구는 과제에 맞게 선택하고 디자인 의도를 구현에 연결합니다. 동료가 실행하고 검증할 수 있는 산출물과 근거를 공유합니다.' },
  { key: 'quality', name: '품질 검증', color: '#64846D', persona: '실제 사용 경험과 납품 가능성을 독립적으로 검증하는 동료입니다. 직접 관찰한 결과와 미검증 사항을 구분하고, 결함의 재현 조건과 영향을 제작 동료에게 전달합니다. 기능 성공과 디자인에 대한 판단을 구분하며 재수정 결과를 확인합니다.' },
] as const;

interface LaunchRecord {
  key: string;
  createdAt: string;
  briefSha256: string;
  initialAgentIds: string[];
  initialRunIds: string[];
  agentIds: Record<string, string>;
  teamId?: string;
  projectId?: string;
  conversationId?: string;
  conversationKey: string;
  startKeys: Record<string, string>;
  startedMessages: Record<string, string>;
  references: Array<{ path: string; fileId: string; sha256: string }>;
  ready?: boolean;
}
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api${path}`, {
    method, headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
  return value as T;
}
async function save(record: LaunchRecord) {
  const temporary = `${recordPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, recordPath);
}
function one<T>(items: T[], label: string): T | undefined {
  if (items.length > 1) throw new Error(`${label}: 동일 실행 표식이 중복됩니다. 임의로 선택하지 않습니다.`);
  return items[0];
}
async function load(): Promise<LaunchRecord> {
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as LaunchRecord;
  if (record.key !== key) throw new Error('팀 실행 기록의 식별자가 다릅니다.');
  return record;
}
async function prepare() {
  const brief = await readFile(briefPath, 'utf8');
  let workspace = await request<Workspace>('/workspace');
  if (workspace.runtime.mode !== 'docker' || !workspace.runtime.available || !workspace.runtime.authenticated) {
    throw new Error('승인된 실제 Docker 실행 환경이 준비되지 않았습니다.');
  }
  const sources = [
    ['modkit-labs.github.io', 'README.md'], ['modkit-labs.github.io', 'index.html'],
    ['modkit-labs.github.io', 'demo/index.html'],
    ['modkit-templates', 'README.md'], ['modkit-templates', 'clinic/README.md'],
    ['modkit-templates', 'clinic/index.html'], ['modkit-templates', 'clinic/privacy.html'],
    ['modkit-templates', 'clinic/nonbenefit.html'], ['modkit-templates', 'clinic/api/contact.js'],
    ['modkit-templates', 'clinic/vercel.json'],
  ];
  const inputs = await Promise.all(sources.map(async ([repository, path]) => {
    const source = resolve('..', repository, path);
    const stat = await lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`참고자료가 일반 파일이 아닙니다: ${source}`);
    const bytes = await readFile(source);
    return { path: `references/${repository}/${path}`, bytes, sha256: digest(bytes) };
  }));
  await mkdir(outputDir, { recursive: true });
  let record: LaunchRecord;
  try { record = await load(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    record = { key, createdAt: new Date().toISOString(), briefSha256: digest(brief),
      initialAgentIds: workspace.agents.map(item => item.id), initialRunIds: workspace.runs.map(item => item.id),
      agentIds: {}, conversationKey: randomUUID(), startKeys: {}, startedMessages: {}, references: [] };
    await writeFile(resolve(outputDir, 'initial-model-budget.json'), `${JSON.stringify(await request('/model-budget'), null, 2)}\n`, { flag: 'wx' });
    await save(record);
  }
  if (record.briefSha256 !== digest(brief)) throw new Error('기존 실행 목표가 변경됐습니다. 새 입력을 조용히 덮어쓰지 않습니다.');
  for (const role of roles) {
    workspace = await request<Workspace>('/workspace');
    const description = `사용자 승인 4인 제작 팀 · ${role.name} [${key}/${role.key}]`;
    let agent = one(workspace.agents.filter(item => item.description === description), role.name);
    if (record.agentIds[role.key] && agent?.id !== record.agentIds[role.key]) throw new Error('기존 팀원의 식별자가 달라졌습니다.');
    agent ??= await request<Agent>('/agents', 'POST', { name: role.name, description, persona: role.persona,
      color: role.color, model: workspace.runtime.model, allowWeb: true, repositoryIds: [] });
    record.agentIds[role.key] = agent.id;
    record.startKeys[role.key] ??= randomUUID();
    await save(record);
  }
  workspace = await request<Workspace>('/workspace');
  const memberIds = roles.map(role => record.agentIds[role.key]);
  const teamDescription = `대표 사이트와 대표 작품을 제작하는 사용자 승인 협력팀 [${key}]`;
  let team = one(workspace.teams.filter(item => item.description === teamDescription), '제작 팀');
  if (record.teamId && team?.id !== record.teamId) throw new Error('기존 팀 식별자가 다릅니다.');
  team ??= await request<Team>('/teams', 'POST', { name: '웹 제작 스튜디오', description: teamDescription, memberIds, workflow: brief });
  if (team.memberIds.length !== 4 || memberIds.some(id => !team!.memberIds.includes(id))) throw new Error('승인된 4인 구성이 달라졌습니다.');
  record.teamId = team.id; await save(record);
  const projectDescription = `대표 사이트·대표 작품 완성. 제작과 분담은 실제 팀이 수행하며, 플랫폼은 협업·성장·재개를 지원합니다. [${key}]`;
  let project = one((workspace.projects ?? []).filter(item => item.description === projectDescription), '제작 프로젝트');
  if (record.projectId && project?.id !== record.projectId) throw new Error('기존 프로젝트 식별자가 다릅니다.');
  project ??= await request<Project>('/collaboration/project_create', 'POST', { name: '대표 사이트·대표 작품', description: projectDescription, teamIds: [team.id] });
  record.projectId = project.id; await save(record);
  const scope = { type: 'project' as const, id: project.id };
  const files = await request<FileList>(`/files?scopeType=project&scopeId=${project.id}`);
  for (const input of inputs) {
    let file = one(files.files.filter(item => item.path === input.path), input.path);
    if (file && file.sha256 !== input.sha256) throw new Error(`기존 참고자료가 달라졌습니다: ${input.path}`);
    if (!file) {
      const mediaType = input.path.endsWith('.html') ? 'text/html' : input.path.endsWith('.json') ? 'application/json' : 'text/plain';
      file = (await request<FileImportResult>('/files/import', 'POST', { scope, path: input.path, mediaType, base64: input.bytes.toString('base64') })).file;
      files.files.push(file);
    }
    if (!record.references.some(item => item.path === input.path)) record.references.push({ path: input.path, fileId: file.id, sha256: file.sha256 });
    await save(record);
  }
  const artifacts: SharedArtifact[] = [];
  let artifactOffset: number | null = 0;
  while (artifactOffset !== null) {
    const page: { items: SharedArtifact[]; nextOffset: number | null } = await request('/collaboration/artifact_list', 'POST', { scope, offset: artifactOffset });
    artifacts.push(...page.items);
    artifactOffset = page.nextOffset;
  }
  const existing = one(artifacts.filter(item => item.name === 'brief.md'), '공동 목표');
  if (existing) {
    const full = await request<SharedArtifact>('/collaboration/artifact_read', 'POST', { artifactId: existing.id });
    if (full.content !== brief) throw new Error('공동 목표의 기존 내용을 보존합니다.');
  } else await request('/collaboration/artifact_publish', 'POST', { scope, name: 'brief.md', mediaType: 'text/markdown', content: brief });
  const conversation = await request<Conversation>('/conversations', 'POST', { scope, title: '대표 사이트·작품 제작 작업실',
    budgetProjectId: project.id, budgetTeamId: team.id, idempotencyKey: record.conversationKey });
  if (record.conversationId && record.conversationId !== conversation.id) throw new Error('공동 대화 식별자가 달라졌습니다.');
  record.conversationId = conversation.id; record.ready = true; await save(record);
  console.log(JSON.stringify({ status: 'prepared-not-started', agents: record.agentIds, teamId: team.id, projectId: project.id,
    references: record.references.length, conversationUrl: `${base}/#conversation/${conversation.id}` }, null, 2));
}
async function start() {
  const record = await load();
  if (!record.ready || !record.teamId || !record.projectId || !record.conversationId) throw new Error('준비 완료 기록이 없습니다.');
  const workspace = await request<Workspace>('/workspace');
  const team = workspace.teams.find(item => item.id === record.teamId);
  if (!team || team.memberIds.length !== 4 || roles.some(role => !team.memberIds.includes(record.agentIds[role.key]))) throw new Error('승인된 팀 구성이 다릅니다.');
  // Discovery is a new, explicit operator feature. Do not silently proceed if an
  // older running controller lacks it, and never change the user's budget here.
  const enabled = await request<Team & { autoDiscoverTasks?: boolean }>(`/teams/${team.id}`, 'PATCH', { autoDiscoverTasks: true });
  if (enabled.autoDiscoverTasks !== true) throw new Error('실제 운영 서버에 열린 과제 자동 탐색이 연결되지 않았습니다.');
  for (const role of roles) {
    const message = await request<ConversationMessage>(`/conversations/${record.conversationId}/messages`, 'POST', {
      mode: 'task', recipientAgentId: record.agentIds[role.key], idempotencyKey: record.startKeys[role.key],
      content: `사용자가 이 4인 팀의 실행을 승인했습니다. 공동 목표는 대표 사이트와 대표 작품 완성입니다. 프로젝트 ${record.projectId}의 공유 자료 brief.md와 필요한 references/ 파일을 읽고, 자신의 페르소나에 맞게 실제 작업을 시작하십시오. 필요한 조사·분담·후속 과제와 제작 방식은 동료와 협의하며 스스로 결정합니다. 이 대화 ${record.conversationId}에서 결정과 결과를 공유하면 사용자도 같은 흐름에 참여할 수 있습니다. 원래 프로젝트·팀 귀속 안에서 공동 작업판을 만들고 자청하며 동료 요청을 이어갑니다. 필요한 기능이 플랫폼에 없으면 구체적인 필요와 오류를 사용자에게 보고하되 독립적으로 가능한 작업은 계속합니다. 플랫폼 운영자가 사이트를 대신 만드는 검증이 아니라 여러분이 실제로 제작하는 첫 운영입니다.`,
    });
    record.startedMessages[role.key] = message.id; await save(record);
  }
  console.log(JSON.stringify({ status: 'start-messages-recorded', conversationUrl: `${base}/#conversation/${record.conversationId}`,
    messages: record.startedMessages, note: '실제 실행·결과는 작업실과 inspect에서 별도 확인합니다.' }, null, 2));
}
async function inspect() {
  const record = await load();
  const workspace = await request<Workspace>('/workspace');
  const agentIds = Object.values(record.agentIds);
  const runIds = workspace.runs.filter(item => agentIds.includes(item.agentId)).map(item => item.id);
  const report = { inspectedAt: new Date().toISOString(), conversationUrl: `${base}/#conversation/${record.conversationId}`,
    runtime: workspace.runtime,
    agents: workspace.agents.filter(item => agentIds.includes(item.id)).map(({ id, name, status, version }) => ({ id, name, status, version })),
    team: workspace.teams.find(item => item.id === record.teamId),
    runs: workspace.runs.filter(item => agentIds.includes(item.agentId)).map(({ id, agentId, status, progress, error, result, budgetProjectId, budgetTeamId, modelBudgetBlock }) =>
      ({ id, agentId, status, progress, error, result: result.slice(0, 1200), budgetProjectId, budgetTeamId, modelBudgetBlock })),
    tasks: workspace.teamTasks?.filter(item => item.scope.id === record.projectId || item.scope.id === record.teamId),
    modelAttempts: workspace.modelAttempts?.filter(item => runIds.includes(item.runId)),
    conversation: record.conversationId ? await request(`/conversations/${record.conversationId}`) : null,
    preservedOriginalAgents: record.initialAgentIds.every(id => workspace.agents.some(item => item.id === id)),
    preservedOriginalRuns: record.initialRunIds.every(id => workspace.runs.some(item => item.id === id)),
    modelBudget: await request('/model-budget'),
  };
  await mkdir(dirname(recordPath), { recursive: true });
  await writeFile(resolve(outputDir, `inspection-${Date.now()}.json`), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ ...report, team: report.team && { id: report.team.id, memberIds: report.team.memberIds,
    autoDiscoverTasks: (report.team as Team & { autoDiscoverTasks?: boolean }).autoDiscoverTasks } }, null, 2));
}
const mode = process.argv[2];
if (mode === 'prepare') await prepare();
else if (mode === 'start') await start();
else if (mode === 'inspect') await inspect();
else throw new Error('사용법: npx tsx scripts/launch-studio-team.ts prepare|start|inspect');
