// ============================================================================
// Memory Store — per-agent JSONL experience logs with search
// ============================================================================

import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AgentId, MemoryRecord } from '../types.js';

interface HandoffLog {
  from: AgentId;
  to: AgentId;
  task: string;
  ts: number;
}

export class MemoryStore {
  private basePath: string;
  private cache = new Map<AgentId, MemoryRecord[]>();

  constructor(basePath: string = './shared/memory') {
    this.basePath = basePath;
    if (!existsSync(basePath)) {
      mkdirSync(basePath, { recursive: true });
    }
  }

  private getFilePath(agentId: AgentId): string {
    return join(this.basePath, `${agentId}.jsonl`);
  }

  private loadRecords(agentId: AgentId): MemoryRecord[] {
    if (this.cache.has(agentId)) {
      return this.cache.get(agentId)!;
    }

    const filePath = this.getFilePath(agentId);
    if (!existsSync(filePath)) {
      this.cache.set(agentId, []);
      return [];
    }

    const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
    const records = lines.map(line => {
      try {
        return JSON.parse(line) as MemoryRecord;
      } catch {
        return null;
      }
    }).filter((r): r is MemoryRecord => r !== null);

    this.cache.set(agentId, records);
    return records;
  }

  async append(agentId: AgentId, record: MemoryRecord): Promise<void> {
    const filePath = this.getFilePath(agentId);
    appendFileSync(filePath, JSON.stringify(record) + '\n');

    // Update cache
    const records = this.loadRecords(agentId);
    records.push(record);
  }

  async search(agentId: AgentId, query: string, topK: number = 3): Promise<MemoryRecord[]> {
    const records = this.loadRecords(agentId);

    if (records.length === 0) return [];

    // Simple keyword-based relevance scoring
    const queryTokens = this.tokenize(query);

    const scored = records.map(record => {
      const recordText = [
        record.taskDescription,
        record.thoughtSummary,
        record.lessonsLearned,
      ].join(' ');
      const recordTokens = this.tokenize(recordText);

      const overlap = queryTokens.filter(t => recordTokens.includes(t)).length;
      const score = overlap / Math.max(queryTokens.length, 1);

      return { record, score };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored
      .slice(0, topK)
      .filter(s => s.score > 0)
      .map(s => s.record);
  }

  async getRelevant(agentId: AgentId, task: string): Promise<string> {
    const records = await this.search(agentId, task, 3);

    if (records.length === 0) return '';

    return records.map(r =>
      `Task: ${r.taskDescription}\nReasoning: ${r.thoughtSummary}\nLesson: ${r.lessonsLearned}`
    ).join('\n---\n');
  }

  logHandoff(handoff: HandoffLog): void {
    const filePath = join(this.basePath, 'handoffs.jsonl');
    appendFileSync(filePath, JSON.stringify(handoff) + '\n');
  }

  getRecordCount(agentId: AgentId): number {
    return this.loadRecords(agentId).length;
  }

  getAllRecords(agentId: AgentId): MemoryRecord[] {
    return [...this.loadRecords(agentId)];
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2);
  }
}
