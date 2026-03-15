// ============================================================================
// Orchestrator — passive observer with narrow intervention channel
// ============================================================================

import { EventEmitter } from 'node:events';
import { MessageBus, BusEvent } from '../message-bus/bus.js';
import { Coordinator } from '../coordinator/coordinator.js';
import {
  AgentId,
  TaskEntry,
  InterventionRecord,
  InterventionTrigger,
} from '../types.js';

interface OrchestratorConfig {
  stallThresholdMs: number;       // How long before a task is considered stalled
  goalDriftThreshold: number;     // 0-1, lower = more drift allowed
  maxThoughtHistory: number;      // Rolling thought summaries per task
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  stallThresholdMs: 5 * 60 * 1000,   // 5 minutes
  goalDriftThreshold: 0.4,
  maxThoughtHistory: 3,
};

export class Orchestrator extends EventEmitter {
  private messageBus: MessageBus;
  private coordinator: Coordinator;
  private config: OrchestratorConfig;
  private taskRegistry = new Map<string, TaskEntry>();
  private interventionLog: InterventionRecord[] = [];
  private stallCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    messageBus: MessageBus,
    coordinator: Coordinator,
    config: Partial<OrchestratorConfig> = {},
  ) {
    super();
    this.messageBus = messageBus;
    this.coordinator = coordinator;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // READ PATH — subscribe to all events passively
    this.messageBus.on('event', this.handleEvent.bind(this));
  }

  start(): void {
    // Periodic stall check
    this.stallCheckInterval = setInterval(() => {
      this.checkForStalls();
      this.checkForDeadlocks();
    }, 30_000);
  }

  stop(): void {
    if (this.stallCheckInterval) {
      clearInterval(this.stallCheckInterval);
      this.stallCheckInterval = null;
    }
  }

  // --- READ PATH (always on, passive) ---

  private handleEvent(event: BusEvent): void {
    const taskKey = event.agentId;

    switch (event.type) {
      case 'thought':
        this.updateTaskThought(taskKey, event.agentId, (event.data as { text: string }).text);
        break;

      case 'output':
        this.updateTaskStatus(taskKey, event.agentId, 'working');
        break;

      case 'tool_call':
        this.updateTaskStatus(taskKey, event.agentId, 'working');
        break;

      case 'handoff':
        this.updateTaskStatus(taskKey, event.agentId, 'waiting_handoff');
        break;
    }

    // Forward everything to dashboard
    this.emit('dashboard_event', event);
  }

  private updateTaskThought(taskKey: string, agentId: AgentId, thought: string): void {
    const task = this.getOrCreateTask(taskKey, agentId);
    task.lastEventAt = Date.now();
    task.status = 'thinking';
    task.thoughtSummary.push(thought);

    // Keep rolling window
    if (task.thoughtSummary.length > this.config.maxThoughtHistory) {
      task.thoughtSummary = task.thoughtSummary.slice(-this.config.maxThoughtHistory);
    }

    // Compute goal drift
    task.goalDrift = this.computeGoalDrift(task);

    if (task.goalDrift < this.config.goalDriftThreshold) {
      this.triggerIntervention(agentId, 'goal_drift',
        `Your current thinking appears to have drifted from the original task: "${task.taskDescription}". Consider refocusing.`
      );
    }
  }

  private updateTaskStatus(taskKey: string, agentId: AgentId, status: TaskEntry['status']): void {
    const task = this.getOrCreateTask(taskKey, agentId);
    task.lastEventAt = Date.now();
    task.status = status;
  }

  private getOrCreateTask(taskKey: string, agentId: AgentId): TaskEntry {
    if (!this.taskRegistry.has(taskKey)) {
      this.taskRegistry.set(taskKey, {
        id: taskKey,
        agentId,
        taskDescription: '',
        startedAt: Date.now(),
        lastEventAt: Date.now(),
        status: 'thinking',
        thoughtSummary: [],
        handoffs: [],
        goalDrift: 1.0,
      });
    }
    return this.taskRegistry.get(taskKey)!;
  }

  // --- ANOMALY DETECTION ---

  private checkForStalls(): void {
    const now = Date.now();
    for (const [, task] of this.taskRegistry) {
      if (
        task.status === 'working' &&
        now - task.lastEventAt > this.config.stallThresholdMs
      ) {
        task.status = 'stalled';
        this.triggerIntervention(task.agentId, 'stalled',
          `You appear to have stalled on your current task. Original goal: "${task.taskDescription}". Consider whether you're blocked and need to hand off.`
        );
      }
    }
  }

  private checkForDeadlocks(): void {
    const waitingAgents = Array.from(this.taskRegistry.values())
      .filter(t => t.status === 'waiting_handoff');

    // Check for circular waits
    for (const a of waitingAgents) {
      for (const b of waitingAgents) {
        if (a.agentId !== b.agentId) {
          const aWaitingForB = a.handoffs.some(
            h => h.to === b.agentId && h.status === 'pending'
          );
          const bWaitingForA = b.handoffs.some(
            h => h.to === a.agentId && h.status === 'pending'
          );

          if (aWaitingForB && bWaitingForA) {
            this.triggerIntervention(a.agentId, 'deadlock',
              `Deadlock detected: you and ${b.agentId} are waiting on each other. Consider proceeding with your best assumptions.`
            );
            this.triggerIntervention(b.agentId, 'deadlock',
              `Deadlock detected: you and ${a.agentId} are waiting on each other. Consider proceeding with your best assumptions.`
            );
          }
        }
      }
    }
  }

  private computeGoalDrift(task: TaskEntry): number {
    if (!task.taskDescription || task.thoughtSummary.length === 0) return 1.0;

    const goalTokens = this.tokenize(task.taskDescription);
    const thoughtTokens = this.tokenize(task.thoughtSummary.join(' '));

    if (goalTokens.length === 0) return 1.0;

    const overlap = goalTokens.filter(t => thoughtTokens.includes(t)).length;
    return overlap / goalTokens.length;
  }

  // --- WRITE PATH (rare, high-threshold, advisory only) ---

  private triggerIntervention(agentId: AgentId, trigger: InterventionTrigger, suggestion: string): void {
    if (!this.meetsInterventionThreshold(agentId, trigger)) return;

    const record: InterventionRecord = {
      agentId,
      reason: trigger,
      suggestion,
      ts: Date.now(),
    };

    this.interventionLog.push(record);
    this.messageBus.publishIntervention(agentId, trigger, suggestion);

    // Advisory injection — agent is free to ignore
    this.coordinator.injectContext(agentId,
      `[ORCHESTRATOR NOTE] ${suggestion}`
    ).catch(() => {
      // Non-critical — log and move on
    });

    this.emit('intervention', record);
  }

  private meetsInterventionThreshold(agentId: AgentId, trigger: InterventionTrigger): boolean {
    // Don't spam interventions — at most one per trigger type per agent per 5 minutes
    const recentCutoff = Date.now() - 5 * 60 * 1000;
    const recentSame = this.interventionLog.filter(
      r => r.agentId === agentId && r.reason === trigger && r.ts > recentCutoff
    );
    return recentSame.length === 0;
  }

  // --- PUBLIC API ---

  getTaskRegistry(): TaskEntry[] {
    return Array.from(this.taskRegistry.values());
  }

  getInterventionLog(): InterventionRecord[] {
    return [...this.interventionLog];
  }

  registerTask(agentId: AgentId, taskDescription: string): void {
    const task = this.getOrCreateTask(agentId, agentId);
    task.taskDescription = taskDescription;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2);
  }
}
