export interface DesktopMcpGrant {
  id: string; label: string; scope: { type: 'team' | 'project'; id: string }; submitTasks: boolean; budgetTeamId: string | null;
  createdAt: string; revokedAt: string | null; generationKey: string;
}
export interface DesktopMcpStatus {
  available: boolean; revision: number; generationKey: string; grants: DesktopMcpGrant[];
  error: string | null;
}
export interface DesktopMcpCreateInput {
  revision: number; label: string; scope: DesktopMcpGrant['scope']; submitTasks: boolean; budgetTeamId: string | null;
}
export interface DesktopMcpConfiguration {
  mcpServers: { agent_company: { command: string; args: string[]; env: { AGENT_COMPANY_MCP_TOKEN: string } } };
}
export interface DesktopMcpCreated { status: DesktopMcpStatus; configuration: DesktopMcpConfiguration }
