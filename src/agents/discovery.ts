// ============================================================================
// Agent Discovery — scans /agents folder and builds agent configs from
// frontmatter in each agent's copilot-instructions.md
// ============================================================================

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AgentConfig, ModelInfo, AcpMcpServer } from '../types.js';

interface AgentFrontmatter {
  name: string;
  role: string;
  model: string;
  emoji: string;
  color: string;
  tools: string[];
  handoffTargets: string[];
}

/**
 * Parse YAML-like frontmatter from a markdown file.
 * Handles simple key: value pairs and YAML arrays (both inline and indented).
 * Does NOT require a full YAML parser — keeps dependencies minimal.
 */
function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const lines = match[1].split('\n');
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trimEnd();

    // Array continuation line (starts with "  - ")
    if (/^\s+-\s+/.test(trimmed) && currentKey && currentArray) {
      const value = trimmed.replace(/^\s+-\s+/, '').trim();
      currentArray.push(value);
      continue;
    }

    // Flush any pending array
    if (currentKey && currentArray) {
      result[currentKey] = currentArray;
      currentKey = null;
      currentArray = null;
    }

    // Key-value pair
    const kvMatch = trimmed.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    let value = kvMatch[2].trim();

    // Inline YAML array: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1);
      result[key] = inner
        ? inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''))
        : [];
      continue;
    }

    // Empty value with array coming on next lines
    if (value === '' || value === '[]') {
      currentKey = key;
      currentArray = [];
      if (value === '[]') {
        result[key] = [];
        currentKey = null;
        currentArray = null;
      }
      continue;
    }

    // Strip surrounding quotes
    value = value.replace(/^["']|["']$/g, '');

    // Handle unicode escape sequences like \U0001F3D7\uFE0F
    value = value.replace(/\\U([0-9A-Fa-f]{8})/g, (_, hex) => {
      return String.fromCodePoint(parseInt(hex, 16));
    });
    value = value.replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) => {
      return String.fromCodePoint(parseInt(hex, 16));
    });

    result[key] = value;
  }

  // Flush any remaining array
  if (currentKey && currentArray) {
    result[currentKey] = currentArray;
  }

  return result;
}

/**
 * Extract the markdown body (everything after the frontmatter) from a file.
 */
function extractBody(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

/**
 * Load available models from models.json.
 */
export function loadModels(modelsPath: string): ModelInfo[] {
  try {
    const raw = readFileSync(modelsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return (parsed.models || parsed.availableModels || []) as ModelInfo[];
  } catch (err) {
    console.error(`Failed to load models from ${modelsPath}:`, err);
    return [];
  }
}

/**
 * Discover all agents by scanning a directory. Each subdirectory is expected
 * to have a .github/copilot-instructions.md with YAML frontmatter defining
 * the agent metadata.
 *
 * Returns an array of AgentConfig objects ready for use by the system.
 */
export function discoverAgents(agentsDir: string): AgentConfig[] {
  if (!existsSync(agentsDir)) {
    console.error(`Agents directory not found: ${agentsDir}`);
    return [];
  }

  const entries = readdirSync(agentsDir);
  const agents: AgentConfig[] = [];

  for (const entry of entries) {
    const entryPath = join(agentsDir, entry);

    // Must be a directory
    if (!statSync(entryPath).isDirectory()) continue;

    // Look for .github/copilot-instructions.md
    const instructionsPath = join(entryPath, '.github', 'copilot-instructions.md');
    if (!existsSync(instructionsPath)) {
      console.warn(`Skipping ${entry}: no .github/copilot-instructions.md found`);
      continue;
    }

    try {
      const content = readFileSync(instructionsPath, 'utf-8');
      const frontmatter = parseFrontmatter(content);

      if (!frontmatter) {
        console.warn(`Skipping ${entry}: no frontmatter found in copilot-instructions.md`);
        continue;
      }

      const fm = frontmatter as unknown as AgentFrontmatter;

      if (!fm.name || !fm.role) {
        console.warn(`Skipping ${entry}: frontmatter missing required 'name' or 'role' fields`);
        continue;
      }

      // The directory name IS the agent id
      const agentId = entry;

      // Parse MCP servers from tools array (format: "name:command:arg1,arg2")
      const mcpServers: AcpMcpServer[] = [];
      if (Array.isArray(fm.tools)) {
        for (const tool of fm.tools) {
          if (typeof tool === 'string' && tool.includes(':')) {
            const [name, command, ...argParts] = tool.split(':');
            mcpServers.push({
              name,
              command,
              args: argParts.length > 0 ? argParts.join(':').split(',') : undefined,
            });
          }
        }
      }

      const config: AgentConfig = {
        id: agentId,
        name: fm.name,
        role: fm.role,
        emoji: fm.emoji || '🤖',
        color: fm.color || '#8b8fa3',
        model: fm.model || 'claude-sonnet-4.6',
        cwd: `./agents/${agentId}`,
        mcpServers,
        handoffTargets: Array.isArray(fm.handoffTargets) ? fm.handoffTargets : [],
      };

      agents.push(config);
      console.log(`  Discovered agent: ${fm.name} (${agentId}) — ${fm.role}, model: ${fm.model || 'default'}`);
    } catch (err) {
      console.warn(`Skipping ${entry}: error reading instructions —`, err);
    }
  }

  return agents;
}

/**
 * Build a lookup record from the discovered agents array.
 */
export function buildAgentLookup(agents: AgentConfig[]): Record<string, AgentConfig> {
  const lookup: Record<string, AgentConfig> = {};
  for (const agent of agents) {
    lookup[agent.id] = agent;
  }
  return lookup;
}
