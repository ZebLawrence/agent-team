// ============================================================================
// Mock ACP Client — simulates agent activity for demo/development
// ============================================================================

import { EventEmitter } from 'node:events';
import { AgentId, AcpSessionParams, AcpPromptParams, AcpSessionUpdate } from '../types.js';

const DEMO_THOUGHTS: Record<AgentId, string[]> = {
  'aria-architect': [
    'Evaluating trade-offs between microservices and monolith for this scale...',
    'The API contract needs versioning from day one — breaking changes will be costly later.',
    'Considering event-driven architecture here. The coupling between auth and notifications is a red flag.',
    'We need to define clear bounded contexts before Ben starts on the database schema.',
    'What breaks if we go with eventual consistency? Need to think about the read model.',
  ],
  'rex-researcher': [
    'Surveying existing literature on JWT refresh token rotation patterns...',
    'Found three competing approaches in the OWASP guidelines — need to compare threat models.',
    'The latest benchmarks show Bun is 2.3x faster for this workload, but ecosystem maturity is a concern.',
    'Cross-referencing the API design against industry standards (OpenAPI 3.1, JSON:API)...',
    'Flagging uncertainty: the performance claims in this whitepaper lack reproducible benchmarks.',
  ],
  'felix-frontend': [
    'The design system needs a consistent spacing scale before I build more components.',
    'Accessibility audit: the color contrast on these buttons fails WCAG AA. Pushing back on this palette.',
    'This interaction pattern adds complexity without clear user value — suggesting a simpler flow.',
    'Building the auth form with progressive enhancement — should work without JS.',
    'The component tree is getting deep. Time to extract a shared layout context.',
  ],
  'ben-backend': [
    'Analyzing failure modes for the refresh token endpoint under concurrent requests...',
    'The database index on user_sessions needs to cover both token and expiry columns.',
    'Rate limiting strategy: sliding window with Redis, 100 req/min per user.',
    'Skeptical about the proposed caching layer — the invalidation logic will be fragile at scale.',
    'Setting up database migrations with rollback support. No irreversible schema changes.',
  ],
};

const DEMO_OUTPUTS: Record<AgentId, string[]> = {
  'aria-architect': [
    'Defined API contract: POST /auth/refresh → { accessToken, expiresIn }. Handing off to Ben for implementation.',
    'Architecture decision: going with event-driven notifications. Published ADR-004.',
    'System design review complete. Three components need attention before we proceed.',
  ],
  'rex-researcher': [
    'Research complete: JWT refresh rotation with token families is the recommended approach. See analysis doc.',
    'Competitive analysis shows 4 of 5 competitors use WebSocket for real-time updates.',
    'Documentation gap identified: we need an API versioning strategy doc.',
  ],
  'felix-frontend': [
    'Auth form component complete with validation, error states, and loading skeleton.',
    'Design system tokens exported: spacing, colors, typography. Available in shared/tokens.',
    'Accessibility fixes applied: all interactive elements now meet WCAG AA contrast requirements.',
  ],
  'ben-backend': [
    'Refresh token endpoint implemented with rotation and token family tracking.',
    'Database migration applied: added index on user_sessions(token, expires_at).',
    'Rate limiter middleware deployed: sliding window, 100 req/min, Redis-backed.',
  ],
};

const DEMO_TOOLS: Record<AgentId, string[]> = {
  'aria-architect': ['read_file: docs/architecture/adr-003.md', 'write_file: docs/architecture/adr-004.md', 'search: "bounded context"'],
  'rex-researcher': ['web_search: "JWT refresh token best practices 2025"', 'read_file: research/jwt-comparison.md', 'write_file: research/findings.md'],
  'felix-frontend': ['run_command: npm test -- --coverage', 'write_file: src/components/AuthForm.tsx', 'read_file: src/styles/tokens.ts'],
  'ben-backend': ['run_command: npm run migrate', 'write_file: src/routes/auth/refresh.ts', 'run_command: npm test -- auth'],
};

const DEMO_HANDOFFS = [
  { from: 'aria-architect' as AgentId, to: 'ben-backend' as AgentId, task: 'Implement POST /auth/refresh per the contract in ADR-004', context: 'Token rotation with family tracking' },
  { from: 'ben-backend' as AgentId, to: 'felix-frontend' as AgentId, task: 'Integrate refresh token flow in the auth form', context: 'Endpoint is live at /auth/refresh, returns { accessToken, expiresIn }' },
  { from: 'felix-frontend' as AgentId, to: 'aria-architect' as AgentId, task: 'Review the auth UX flow for security implications', context: 'Silent refresh on 401 with retry queue' },
  { from: 'aria-architect' as AgentId, to: 'rex-researcher' as AgentId, task: 'Research WebSocket vs SSE for real-time notification delivery', context: 'Need latency, browser support, and scaling characteristics' },
  { from: 'rex-researcher' as AgentId, to: 'ben-backend' as AgentId, task: 'Implement SSE endpoint for notifications based on research findings', context: 'SSE preferred: simpler, sufficient for uni-directional updates' },
];

// Fallbacks for dynamically-added agents not in the demo data
const GENERIC_DEMO_THOUGHTS = [
  'Analyzing the task requirements and constraints...',
  'Evaluating different approaches for the best outcome...',
  'Checking for edge cases and potential issues...',
];
const GENERIC_DEMO_OUTPUTS = [
  'Task analysis complete. Here are my findings and recommendations.',
  'Completed the requested work. Ready for review.',
];
const GENERIC_DEMO_TOOLS = [
  'read_file: README.md',
  'search: "relevant context"',
  'write_file: output.md',
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomDelay(min: number, max: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, min + Math.random() * (max - min)));
}

export class MockAcpClient extends EventEmitter {
  private running = false;
  private intervalIds: ReturnType<typeof setTimeout>[] = [];

  constructor(public readonly agentId: AgentId) {
    super();
  }

  get isConnected(): boolean {
    return this.running;
  }

  async start(_cwd: string): Promise<void> {
    this.running = true;
  }

  async newSession(_params: AcpSessionParams): Promise<string> {
    return `mock-session-${this.agentId}-${Date.now()}`;
  }

  async prompt(sessionId: string, params: AcpPromptParams): Promise<void> {
    // Simulate agent processing a task
    this.simulateActivity(sessionId);
  }

  async cancel(_sessionId: string): Promise<void> {
    // no-op
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const id of this.intervalIds) clearTimeout(id);
    this.intervalIds = [];
  }

  private async simulateActivity(sessionId: string): Promise<void> {
    const thoughts = DEMO_THOUGHTS[this.agentId] || GENERIC_DEMO_THOUGHTS;
    const tools = DEMO_TOOLS[this.agentId] || GENERIC_DEMO_TOOLS;
    const outputs = DEMO_OUTPUTS[this.agentId] || GENERIC_DEMO_OUTPUTS;

    // Thought phase
    await randomDelay(500, 1500);
    this.emitUpdate(sessionId, 'thought', { text: pick(thoughts) });

    // Tool call phase
    await randomDelay(800, 2000);
    const toolName = pick(tools);
    this.emitUpdate(sessionId, 'tool_use', { name: toolName.split(':')[0], input: toolName.split(': ')[1] });

    // More thinking
    await randomDelay(600, 1200);
    this.emitUpdate(sessionId, 'thought', { text: pick(thoughts) });

    // Output phase
    await randomDelay(1000, 2500);
    this.emitUpdate(sessionId, 'text', { text: pick(outputs) });
  }

  private emitUpdate(sessionId: string, contentType: string, content: Record<string, string>): void {
    const update: AcpSessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: contentType as 'thought' | 'text' | 'tool_use',
        ...content,
      },
    };
    this.emit('session/update', this.agentId, update);
  }

  // --- Static: run the full demo simulation ---

  static startDemoLoop(
    agents: Map<AgentId, MockAcpClient>,
    onHandoff: (handoff: typeof DEMO_HANDOFFS[0]) => void,
  ): () => void {
    let running = true;

    const loop = async () => {
      let handoffIndex = 0;

      while (running) {
        // Pick a random agent to do work
        const agentIds = Array.from(agents.keys());
        const activeId = pick(agentIds);
        const client = agents.get(activeId)!;

        await client.prompt(`demo-session-${activeId}`, {
          prompt: [{ type: 'text', text: 'Demo task' }],
        });

        // Occasionally trigger a handoff
        if (Math.random() < 0.35) {
          await randomDelay(1000, 2000);
          const handoff = DEMO_HANDOFFS[handoffIndex % DEMO_HANDOFFS.length];
          handoffIndex++;
          onHandoff(handoff);
        }

        // Wait between activity bursts
        await randomDelay(3000, 6000);
      }
    };

    loop().catch(() => {});

    return () => { running = false; };
  }
}
