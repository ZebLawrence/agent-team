// ============================================================================
// Coordinator — routes messages between agents, intercepts handoffs
// ============================================================================

import { EventEmitter } from 'node:events';
import { SessionManager } from '../acp/session-manager.js';
import { MessageBus } from '../message-bus/bus.js';
import { MemoryStore } from '../memory/store.js';
import {
  AgentId,
  AcpSessionUpdate,
  Handoff,
  HandoffRecord,
} from '../types.js';

let handoffCounter = 0;

const FLUSH_DEBOUNCE_MS = 300; // Debounce output so fragments merge into readable text

interface AgentBuffer {
  text: string;               // Accumulated text chunks
  flushTimer: ReturnType<typeof setTimeout> | null;
  handoffsRouted: number;     // Track how many handoffs we've already extracted
}

export class Coordinator extends EventEmitter {
  private sessionManager: SessionManager;
  private messageBus: MessageBus;
  private memory: MemoryStore;
  private activeHandoffs = new Map<string, HandoffRecord>();
  private agentBuffers = new Map<AgentId, AgentBuffer>();

  constructor(
    sessionManager: SessionManager,
    messageBus: MessageBus,
    memory: MemoryStore,
  ) {
    super();
    this.sessionManager = sessionManager;
    this.messageBus = messageBus;
    this.memory = memory;

    // Listen for all session updates from the session manager
    this.sessionManager.on('session/update', this.handleSessionUpdate.bind(this));
  }

  private getBuffer(agentId: AgentId): AgentBuffer {
    let buf = this.agentBuffers.get(agentId);
    if (!buf) {
      buf = { text: '', flushTimer: null, handoffsRouted: 0 };
      this.agentBuffers.set(agentId, buf);
    }
    return buf;
  }

  private handleSessionUpdate(agentId: AgentId, update: AcpSessionUpdate): void {
    // Copilot ACP sends two chunk types:
    //   agent_thought_chunk — pre-response reasoning (the "why")
    //   agent_message_chunk — actual output (text, tool_use)
    const chunkType = update.sessionUpdate;

    if (chunkType === 'agent_thought_chunk') {
      // Thought chunks are always text content — pass through immediately
      this.messageBus.publishThought(agentId, update.content.text ?? '');

    } else if (chunkType === 'agent_message_chunk') {
      switch (update.content.type) {
        case 'thought':
          // Some ACP versions send thoughts inside message chunks too
          this.messageBus.publishThought(agentId, update.content.text ?? '');
          break;

        case 'text': {
          const text = update.content.text ?? '';
          this.bufferText(agentId, text);
          break;
        }

        case 'tool_use':
          this.messageBus.publishToolCall(agentId, {
            name: update.content.name ?? 'unknown',
            input: update.content.input,
          });
          break;
      }

    } else if (chunkType === 'tool_call') {
      // Copilot sends tool_call as a top-level sessionUpdate type (not inside agent_message_chunk)
      const title = (update.content as Record<string, unknown>).title as string | undefined;
      const toolCallId = (update.content as Record<string, unknown>).toolCallId as string | undefined;
      this.messageBus.publishToolCall(agentId, {
        name: title ?? update.content.name ?? 'tool',
        input: toolCallId ?? update.content.input,
      });

    } else if (chunkType === 'tool_call_update') {
      // Progress updates on a running tool call — just log, don't clutter feed
      // (e.g., status: 'running', 'complete')

    } else if (chunkType === 'agent_message_end' || chunkType === 'session_end') {
      // Message or session ended — flush any remaining buffered text
      this.flushBuffer(agentId, true);
    }

    // Raw updates go directly to the orchestrator via EventEmitter,
    // NOT the message bus — keeps the dashboard stream clean.
    this.emit('raw_update', agentId, update);
  }

  /**
   * Buffer incoming text chunks per-agent.
   * After each append, scan the accumulated buffer for complete handoff JSON.
   * Use a debounce timer to flush non-handoff text as readable output.
   */
  private bufferText(agentId: AgentId, chunk: string): void {
    const buf = this.getBuffer(agentId);
    buf.text += chunk;

    // Try to extract handoffs from the accumulated buffer
    this.tryExtractHandoffs(agentId, buf);

    // Debounce the flush so tiny fragments merge into readable text
    if (buf.flushTimer) {
      clearTimeout(buf.flushTimer);
    }
    buf.flushTimer = setTimeout(() => {
      this.flushBuffer(agentId, false);
    }, FLUSH_DEBOUNCE_MS);
  }

  /**
   * Scan the buffer for complete handoff JSON blocks.
   * When found, route them and remove from the buffer.
   */
  private tryExtractHandoffs(agentId: AgentId, buf: AgentBuffer): void {
    // Keep scanning as long as we find handoffs
    let found = true;
    while (found) {
      found = false;
      const handoffResult = this.extractHandoffWithPosition(buf.text);

      if (handoffResult) {
        const { handoff, startIndex, endIndex } = handoffResult;

        // Flush any text BEFORE the handoff block as output
        const preText = buf.text.substring(0, startIndex).trim();
        if (preText) {
          this.messageBus.publishOutput(agentId, preText);
        }

        // Remove the handoff block (and preceding text) from the buffer
        buf.text = buf.text.substring(endIndex);
        buf.handoffsRouted++;

        // Route the handoff
        this.routeHandoff(agentId, handoff);
        found = true; // Check for more handoffs in remaining text
      }
    }
  }

  /**
   * Flush buffered text as output to the dashboard.
   * @param final — if true, flush everything (message ended); otherwise leave
   *   a trailing incomplete-looking fragment in the buffer in case it's the
   *   start of a handoff JSON block.
   */
  private flushBuffer(agentId: AgentId, final: boolean): void {
    const buf = this.agentBuffers.get(agentId);
    if (!buf) return;

    if (buf.flushTimer) {
      clearTimeout(buf.flushTimer);
      buf.flushTimer = null;
    }

    if (final) {
      // Message ended — flush everything remaining
      const text = buf.text.trim();
      if (text) {
        this.messageBus.publishOutput(agentId, text);
      }
      // Reset the buffer
      buf.text = '';
      buf.handoffsRouted = 0;
    } else {
      // Mid-stream flush: only flush text if it doesn't look like a
      // handoff JSON block is being built up. Check for opening markers.
      const text = buf.text;

      // If we see signs of a JSON block starting (``` or {" with "handoff"),
      // don't flush — wait for more data.
      const jsonBlockStart = text.lastIndexOf('```');
      const braceStart = text.lastIndexOf('{"');
      const handoffHint = text.includes('"handoff"') || text.includes('"hand');

      if (jsonBlockStart >= 0 || (braceStart >= 0 && handoffHint)) {
        // Looks like a handoff block might be forming — flush only text
        // before the potential start marker
        const safeEnd = Math.min(
          jsonBlockStart >= 0 ? jsonBlockStart : text.length,
          braceStart >= 0 && handoffHint ? braceStart : text.length,
        );
        const safeText = text.substring(0, safeEnd).trim();
        if (safeText) {
          this.messageBus.publishOutput(agentId, safeText);
        }
        buf.text = text.substring(safeEnd);
      } else {
        // No handoff markers — flush everything
        const trimmed = text.trim();
        if (trimmed) {
          this.messageBus.publishOutput(agentId, trimmed);
        }
        buf.text = '';
      }
    }
  }

  /**
   * Extract handoff JSON from text, returning the handoff and its position.
   * Looks for ```json ... ``` blocks or bare JSON objects containing "handoff".
   */
  extractHandoffWithPosition(text: string): { handoff: Handoff; startIndex: number; endIndex: number } | null {
    // Pattern 1: fenced JSON code blocks
    const fencedPattern = /```(?:json)?\s*\n?\s*(\{[\s\S]*?"handoff"[\s\S]*?\})\s*\n?\s*```/;
    const fencedMatch = text.match(fencedPattern);
    if (fencedMatch && fencedMatch.index !== undefined) {
      try {
        const parsed = JSON.parse(fencedMatch[1]);
        if (parsed.handoff?.to && parsed.handoff?.task) {
          return {
            handoff: parsed.handoff as Handoff,
            startIndex: fencedMatch.index,
            endIndex: fencedMatch.index + fencedMatch[0].length,
          };
        }
      } catch {
        // Not valid JSON yet — might still be streaming
      }
    }

    // Pattern 2: bare JSON objects (not inside fences)
    // Use a more careful approach — find balanced braces
    const bareStart = text.indexOf('{"handoff"');
    if (bareStart === -1) return null;

    // Try to find the matching closing brace
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = bareStart; i < text.length; i++) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }
      if (ch === '"' && !escape) {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const jsonStr = text.substring(bareStart, i + 1);
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.handoff?.to && parsed.handoff?.task) {
              return {
                handoff: parsed.handoff as Handoff,
                startIndex: bareStart,
                endIndex: i + 1,
              };
            }
          } catch {
            // Invalid JSON
          }
          break;
        }
      }
    }

    return null;
  }

  // Keep the old method for backward compatibility (tests, etc.)
  extractHandoff(text: string): Handoff | null {
    const result = this.extractHandoffWithPosition(text);
    return result ? result.handoff : null;
  }

  private async routeHandoff(fromAgentId: AgentId, handoff: Handoff): Promise<void> {
    const id = `handoff-${++handoffCounter}-${Date.now()}`;
    const record: HandoffRecord = {
      id,
      from: fromAgentId,
      to: handoff.to,
      task: handoff.task,
      context: handoff.context,
      returnTo: handoff.returnTo,
      returnExpectation: handoff.returnExpectation,
      status: 'pending',
      createdAt: Date.now(),
    };

    this.activeHandoffs.set(id, record);
    this.messageBus.publishHandoff(record);

    // Get relevant memory for the target agent
    const memoryContext = await this.memory.getRelevant(handoff.to, handoff.task);

    // Build the handoff prompt
    const promptText = [
      `[HANDOFF from ${fromAgentId}]`,
      handoff.context,
      '',
      `Task: ${handoff.task}`,
      '',
      `When complete, format your response so it can be returned to ${handoff.returnTo}.`,
      `Expected: ${handoff.returnExpectation}`,
      '',
      memoryContext ? `---\nRelevant past experience:\n${memoryContext}` : '',
    ].filter(Boolean).join('\n');

    try {
      await this.sessionManager.promptAgent(handoff.to, promptText);

      // Log the handoff in memory
      this.memory.logHandoff({
        from: fromAgentId,
        to: handoff.to,
        task: handoff.task,
        ts: Date.now(),
      });
    } catch (err) {
      record.status = 'bounced';
      this.messageBus.publishHandoff(record);
      this.emit('handoff_error', { record, error: err });
    }
  }

  resolveHandoff(handoffId: string): void {
    const record = this.activeHandoffs.get(handoffId);
    if (record) {
      record.status = 'resolved';
      record.resolvedAt = Date.now();
      this.messageBus.publishHandoff(record);
    }
  }

  getActiveHandoffs(): HandoffRecord[] {
    return Array.from(this.activeHandoffs.values()).filter(h => h.status === 'pending');
  }

  async injectContext(agentId: AgentId, message: string): Promise<void> {
    await this.sessionManager.injectContext(agentId, message);
  }
}
