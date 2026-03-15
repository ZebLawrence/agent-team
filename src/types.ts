// ============================================================================
// Core type definitions for the Copilot Agent Team
// ============================================================================

// AgentId is now a plain string — agents are discovered dynamically at startup
export type AgentId = string;

export type TaskStatus = 'thinking' | 'working' | 'waiting_handoff' | 'complete' | 'stalled';

export type HandoffOutcome = 'resolved' | 'pending' | 'bounced';

export type ContentType = 'thought' | 'text' | 'tool_use';

// --- ACP Protocol Types ---

export interface AcpSessionParams {
  cwd: string;
  mcpServers: AcpMcpServer[];
}

export interface AcpMcpServer {
  name: string;
  command: string;
  args?: string[];
}

export interface AcpPromptContent {
  type: 'text';
  text: string;
}

export interface AcpPromptParams {
  prompt: AcpPromptContent[];
}

export interface AcpSessionUpdate {
  sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk' | 'agent_message_end' | 'session_end' | string;
  content: {
    type: ContentType;
    text?: string;
    name?: string;        // for tool_use
    input?: unknown;      // for tool_use
  };
}

export interface AcpPermissionRequest {
  tool: string;
  input: unknown;
}

export interface AcpPermissionResponse {
  outcome: { outcome: 'approved' | 'denied' };
}

// --- Handoff Types ---

export interface Handoff {
  to: AgentId;
  task: string;
  context: string;
  returnTo: AgentId;
  returnExpectation: string;
}

export interface HandoffRecord {
  id: string;
  from: AgentId;
  to: AgentId;
  task: string;
  context: string;
  returnTo: AgentId;
  returnExpectation: string;
  status: HandoffOutcome;
  createdAt: number;
  resolvedAt?: number;
}

// --- Memory Types ---

export interface MemoryRecord {
  ts: number;
  taskDescription: string;
  thoughtSummary: string;
  handoffsInitiated: {
    to: AgentId;
    reason: string;
    outcome: HandoffOutcome;
  }[];
  outcome: 'complete' | 'partial' | 'failed';
  lessonsLearned: string;
}

// --- Task Registry Types ---

export interface TaskEntry {
  id: string;
  agentId: AgentId;
  taskDescription: string;
  startedAt: number;
  lastEventAt: number;
  status: TaskStatus;
  thoughtSummary: string[];
  handoffs: HandoffRecord[];
  goalDrift: number;
}

// --- Orchestrator Types ---

export interface InterventionRecord {
  agentId: AgentId;
  reason: string;
  suggestion: string;
  ts: number;
}

export type InterventionTrigger = 'stalled' | 'deadlock' | 'goal_drift' | 'guidance_request';

// --- Dashboard Event Types ---

export interface DashboardEvent {
  type: 'thought' | 'output' | 'tool_call' | 'handoff' | 'status_change' | 'intervention' | 'memory';
  agentId: AgentId;
  data: unknown;
  ts: number;
}

// --- Agent Configuration ---

export interface AgentConfig {
  id: AgentId;
  name: string;
  role: string;
  emoji: string;
  color: string;
  model: string;
  cwd: string;
  mcpServers: AcpMcpServer[];
  handoffTargets: string[];
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}
