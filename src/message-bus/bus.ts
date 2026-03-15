// ============================================================================
// Message Bus — inter-agent communication layer and event distribution
// ============================================================================

import { EventEmitter } from 'node:events';
import {
  AgentId,
  AcpSessionUpdate,
  HandoffRecord,
  DashboardEvent,
} from '../types.js';

export type BusEventType =
  | 'thought'
  | 'output'
  | 'tool_call'
  | 'handoff'
  | 'raw_update'
  | 'status_change'
  | 'task_start'
  | 'intervention'
  | 'memory';

export interface BusEvent {
  type: BusEventType;
  agentId: AgentId;
  data: unknown;
  ts: number;
}

export class MessageBus extends EventEmitter {
  private eventLog: BusEvent[] = [];
  private maxLogSize = 10000;

  publishThought(agentId: AgentId, text: string): void {
    this.publish({
      type: 'thought',
      agentId,
      data: { text },
      ts: Date.now(),
    });
  }

  publishOutput(agentId: AgentId, text: string): void {
    this.publish({
      type: 'output',
      agentId,
      data: { text },
      ts: Date.now(),
    });
  }

  publishToolCall(agentId: AgentId, toolCall: { name: string; input: unknown }): void {
    this.publish({
      type: 'tool_call',
      agentId,
      data: toolCall,
      ts: Date.now(),
    });
  }

  publishHandoff(record: HandoffRecord): void {
    this.publish({
      type: 'handoff',
      agentId: record.from,
      data: record,
      ts: Date.now(),
    });
  }

  publishRawUpdate(agentId: AgentId, update: AcpSessionUpdate): void {
    this.publish({
      type: 'raw_update',
      agentId,
      data: update,
      ts: Date.now(),
    });
  }

  publishTaskStart(agentId: AgentId, taskDescription: string): void {
    this.publish({
      type: 'task_start',
      agentId,
      data: { taskDescription },
      ts: Date.now(),
    });
  }

  publishStatusChange(agentId: AgentId, status: string): void {
    this.publish({
      type: 'status_change',
      agentId,
      data: { status },
      ts: Date.now(),
    });
  }

  publishIntervention(agentId: AgentId, reason: string, suggestion: string): void {
    this.publish({
      type: 'intervention',
      agentId,
      data: { reason, suggestion },
      ts: Date.now(),
    });
  }

  private publish(event: BusEvent): void {
    // Store in log
    this.eventLog.push(event);
    if (this.eventLog.length > this.maxLogSize) {
      this.eventLog = this.eventLog.slice(-this.maxLogSize / 2);
    }

    // Emit to all subscribers
    this.emit('event', event);
    this.emit(`event:${event.type}`, event);
    this.emit(`agent:${event.agentId}`, event);
  }

  getRecentEvents(count: number = 50): BusEvent[] {
    return this.eventLog.slice(-count);
  }

  getAgentEvents(agentId: AgentId, count: number = 50): BusEvent[] {
    return this.eventLog
      .filter(e => e.agentId === agentId)
      .slice(-count);
  }

  getEventsByType(type: BusEventType, count: number = 50): BusEvent[] {
    return this.eventLog
      .filter(e => e.type === type)
      .slice(-count);
  }

  toDashboardEvents(events?: BusEvent[]): DashboardEvent[] {
    const source = events ?? this.eventLog;
    return source.map(e => ({
      type: e.type === 'raw_update' ? 'output' : e.type as DashboardEvent['type'],
      agentId: e.agentId,
      data: e.data,
      ts: e.ts,
    }));
  }
}
