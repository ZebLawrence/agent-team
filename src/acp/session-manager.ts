// ============================================================================
// Agent Session Manager — lifecycle management for all agent ACP sessions
// ============================================================================

import { EventEmitter } from 'node:events';
import { AcpClient } from './client.js';
import { MockAcpClient } from './mock-client.js';
import { MemoryStore } from '../memory/store.js';
import {
  AgentId,
  AgentConfig,
  AcpSessionUpdate,
} from '../types.js';

type AnyClient = AcpClient | MockAcpClient;

interface ManagedAgent {
  config: AgentConfig;
  client: AnyClient;
  sessionId: string | null;
  status: 'idle' | 'starting' | 'ready' | 'busy' | 'error' | 'disconnected';
}

export class SessionManager extends EventEmitter {
  private agents = new Map<AgentId, ManagedAgent>();
  private agentConfigs: AgentConfig[];
  private memory: MemoryStore;
  private demoMode: boolean;
  private stopDemoLoop: (() => void) | null = null;

  constructor(agentConfigs: AgentConfig[], memory: MemoryStore, demoMode = false) {
    super();
    this.agentConfigs = agentConfigs;
    this.memory = memory;
    this.demoMode = demoMode;
  }

  async initializeAll(): Promise<void> {
    if (this.demoMode) {
      await Promise.all(this.agentConfigs.map(config => this.initializeMockAgent(config.id, config)));
      this.startDemo();
    } else {
      await Promise.all(this.agentConfigs.map(config => this.initializeAgent(config.id, config)));
    }
  }

  // --- Real agent initialization ---

  private async initializeAgent(id: AgentId, config: AgentConfig): Promise<void> {
    const client = new AcpClient(id, config.model);

    const managed: ManagedAgent = {
      config,
      client,
      sessionId: null,
      status: 'starting',
    };

    this.agents.set(id, managed);

    client.on('session/update', (agentId: AgentId, update: AcpSessionUpdate) => {
      this.emit('session/update', agentId, update);
    });

    client.on('permission_request', (agentId: AgentId, request: unknown) => {
      this.emit('permission_request', agentId, request);
    });

    client.on('exit', (info: { agentId: AgentId; code: number | null }) => {
      managed.status = 'disconnected';
      this.emit('agent_exit', info);
    });

    client.on('error', (info: { agentId: AgentId; error: Error }) => {
      managed.status = 'disconnected';
      this.emit('agent_error', info);
    });

    try {
      await client.start(config.cwd);
      const sessionId = await client.newSession({
        cwd: config.cwd,
        mcpServers: config.mcpServers,
      });
      managed.sessionId = sessionId;
      managed.status = 'ready';
      this.emit('agent_ready', id);
    } catch (err) {
      managed.status = 'disconnected';
      this.emit('agent_error', { agentId: id, error: err });
    }
  }

  // --- Mock agent initialization (demo mode) ---

  private async initializeMockAgent(id: AgentId, config: AgentConfig): Promise<void> {
    const client = new MockAcpClient(id);

    const managed: ManagedAgent = {
      config,
      client,
      sessionId: null,
      status: 'starting',
    };

    this.agents.set(id, managed);

    client.on('session/update', (agentId: AgentId, update: AcpSessionUpdate) => {
      this.emit('session/update', agentId, update);
    });

    await client.start(config.cwd);
    const sessionId = await client.newSession({
      cwd: config.cwd,
      mcpServers: config.mcpServers,
    });
    managed.sessionId = sessionId;
    managed.status = 'ready';
    this.emit('agent_ready', id);
  }

  private startDemo(): void {
    const mockAgents = new Map<AgentId, MockAcpClient>();
    for (const [id, managed] of this.agents) {
      mockAgents.set(id, managed.client as MockAcpClient);
    }

    this.stopDemoLoop = MockAcpClient.startDemoLoop(mockAgents, (handoff) => {
      // Emit handoff as a session/update from the source agent
      this.emit('session/update', handoff.from, {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: JSON.stringify({ handoff }),
        },
      });
    });
  }

  async promptAgent(agentId: AgentId, taskDescription: string): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed || !managed.sessionId) {
      throw new Error(`Agent ${agentId} is not ready`);
    }

    managed.status = 'busy';
    this.emit('status_change', agentId, 'busy');

    const relevantMemory = await this.memory.search(agentId, taskDescription, 3);
    let promptText = '';

    if (relevantMemory.length > 0) {
      promptText += `[MEMORY CONTEXT — relevant past experience]\n`;
      promptText += relevantMemory.map(r =>
        `Task: ${r.taskDescription}\nReasoning: ${r.thoughtSummary}\nLesson: ${r.lessonsLearned}`
      ).join('\n---\n');
      promptText += `\n[END MEMORY]\n\n`;
    }

    promptText += taskDescription;

    try {
      await managed.client.prompt(managed.sessionId, {
        prompt: [{ type: 'text', text: promptText }],
      });
      // Agent turn completed successfully
      managed.status = 'ready';
      this.emit('status_change', agentId, 'ready');
    } catch (err) {
      managed.status = 'error';
      this.emit('status_change', agentId, 'error');
      throw err;
    }
  }

  async injectContext(agentId: AgentId, message: string): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed || !managed.sessionId) {
      throw new Error(`Agent ${agentId} is not ready`);
    }

    await managed.client.prompt(managed.sessionId, {
      prompt: [{ type: 'text', text: message }],
    });
  }

  getModel(agentId: AgentId): string {
    const managed = this.agents.get(agentId);
    if (!managed) return 'unknown';
    if (managed.client instanceof AcpClient) {
      return (managed.client as AcpClient).model;
    }
    // Mock client — return the config model
    return managed.config.model;
  }

  getAllModels(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [id] of this.agents) {
      result[id] = this.getModel(id);
    }
    return result;
  }

  /**
   * Change the model for an agent. Requires restarting the Copilot CLI process
   * since --model is a startup flag.
   */
  async changeAgentModel(agentId: AgentId, newModel: string): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed) throw new Error(`Agent ${agentId} not found`);

    if (this.demoMode) {
      // In demo mode, just update the config
      managed.config.model = newModel;
      this.emit('model_change', agentId, newModel);
      return;
    }

    if (managed.status === 'busy') {
      throw new Error(`Agent ${agentId} is busy — wait for the current task to complete`);
    }

    const config = managed.config;
    config.model = newModel;

    // Stop the existing process
    managed.status = 'starting';
    this.emit('status_change', agentId, 'starting');

    try {
      await managed.client.stop();
    } catch {
      // Ignore stop errors
    }

    // Create a new client with the new model
    const client = new AcpClient(agentId, newModel);
    managed.client = client;

    // Re-wire events
    client.on('session/update', (aId: AgentId, update: AcpSessionUpdate) => {
      this.emit('session/update', aId, update);
    });
    client.on('permission_request', (aId: AgentId, request: unknown) => {
      this.emit('permission_request', aId, request);
    });
    client.on('exit', (info: { agentId: AgentId; code: number | null }) => {
      managed.status = 'disconnected';
      this.emit('agent_exit', info);
    });
    client.on('error', (info: { agentId: AgentId; error: Error }) => {
      managed.status = 'disconnected';
      this.emit('agent_error', info);
    });

    try {
      await client.start(config.cwd);
      const sessionId = await client.newSession({
        cwd: config.cwd,
        mcpServers: config.mcpServers,
      });
      managed.sessionId = sessionId;
      managed.status = 'ready';
      this.emit('status_change', agentId, 'ready');
      this.emit('model_change', agentId, newModel);
    } catch (err) {
      managed.status = 'error';
      this.emit('status_change', agentId, 'error');
      throw err;
    }
  }

  getStatus(agentId: AgentId): ManagedAgent['status'] | 'unknown' {
    return this.agents.get(agentId)?.status ?? 'unknown';
  }

  getAllStatuses(): Record<string, ManagedAgent['status'] | 'unknown'> {
    const result: Record<string, ManagedAgent['status'] | 'unknown'> = {};
    for (const [id] of this.agents) {
      result[id] = this.getStatus(id);
    }
    return result;
  }

  getAgentConfigs(): AgentConfig[] {
    return this.agentConfigs;
  }

  getAgentIds(): string[] {
    return this.agentConfigs.map(c => c.id);
  }

  async shutdownAll(): Promise<void> {
    if (this.stopDemoLoop) this.stopDemoLoop();
    const entries = Array.from(this.agents.entries());
    await Promise.all(entries.map(([, managed]) => managed.client.stop()));
    this.agents.clear();
  }
}
