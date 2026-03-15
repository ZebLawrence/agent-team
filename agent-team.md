# Agent team — multi-agent system using GitHub Copilot CLI ACP

A POC architecture for running multiple specialized Copilot CLI agents that communicate with each other, learn from experience, and are observed by a non-interventionist orchestrator.

---

## Overview

Each agent is a `copilot --acp --stdio` process scoped to its own folder. A coordinator process manages ACP connections, routes messages between agents, and injects memory context. An orchestrator sits above everything as a passive observer with a narrow, high-threshold intervention channel.

### Key protocol: ACP (Agent Client Protocol)

- JSON-RPC 2.0 over stdio or TCP
- GitHub Copilot CLI exposes itself as an ACP server via `copilot --acp --stdio`
- Key methods: `session/new`, `session/prompt`, `session/cancel`
- Key notifications: `session/update` — streams `thought`, `text`, and `tool_use` content chunks
- The `thought` content type is the window into agent reasoning — it streams *before* the actual response

---

## Folder structure

```
/agents
  /aria-architect/          ← system design, high-level decisions
  /rex-researcher/          ← research, documentation, analysis
  /felix-frontend/          ← UI/UX, components, accessibility
  /ben-backend/             ← APIs, databases, infrastructure
/orchestrator/              ← top-level observer + task registry
/shared/
  /message-bus/             ← inter-agent communication layer
  /memory/                  ← per-agent experience logs (JSONL)
  /registry/                ← agent capabilities manifest
```

---

## The four agents

Each agent has an isolated `cwd`, its own `.github/copilot-instructions.md`, and its own MCP server configuration.

### Aria — Architect
- **Domain:** System design, architecture decisions, API contracts, trade-off analysis
- **Personality:** Pragmatic, thinks in trade-offs, asks "what breaks?" before "what works?"
- **Handoff triggers:** Needs UI expertise → Felix. Needs API implementation → Ben. Needs research → Rex.

### Rex — Researcher
- **Domain:** Documentation, analysis, literature review, competitive research
- **Personality:** Thorough, citation-driven, flags uncertainty explicitly
- **Handoff triggers:** Findings need architecture implications → Aria. Findings need implementation → Ben or Felix.

### Felix — Frontend
- **Domain:** UI/UX, React components, accessibility, design systems
- **Personality:** User-empathy first, opinionated on DX, pushes back on complexity
- **Handoff triggers:** Needs API contract → Ben. Needs system-level decisions → Aria.

### Ben — Backend
- **Domain:** APIs, databases, infrastructure, performance, security
- **Personality:** Skeptical, asks about failure modes and scale, prefers explicit contracts
- **Handoff triggers:** Needs API design review → Aria. Needs frontend contract → Felix.

---

## Custom instructions template

Each agent's `.github/copilot-instructions.md` follows this pattern:

```markdown
You are [Name], a [role description]. [1-2 sentence personality].
Your domain: [list of owned areas].

When you need [X] expertise → emit a handoff to [Agent].
When you need [Y] expertise → emit a handoff to [Agent].

If you receive an [ORCHESTRATOR NOTE], consider it as advisory context.
You are not obligated to follow it. Your own domain judgment takes precedence.
If you disagree, say so and explain why.

Past decisions you've made:
[injected from memory store at session/new]
```

---

## Agent-to-agent handoff protocol

Agents cannot directly call each other — they don't know about each other. Handoffs work by convention: the agent emits a structured JSON block in its response, and the coordinator intercepts it.

### Handoff format (emitted by agent in response text)

```json
{
  "handoff": {
    "to": "ben-backend",
    "task": "Implement the /auth/refresh endpoint per the contract below",
    "context": "Aria defined the contract as: POST /auth/refresh, body: { refreshToken: string }, returns: { accessToken: string, expiresIn: number }",
    "returnTo": "aria-architect",
    "returnExpectation": "Confirm implementation matches contract, flag any deviations"
  }
}
```

### Coordinator handling

```typescript
acpClient.on('session/update', (agentId, update) => {
  if (update.content.type === 'text') {
    const handoff = extractHandoff(update.content.text);
    if (handoff) {
      routeHandoff(agentId, handoff);
      return;
    }
  }
  // Normal output handling...
  outputStream.push(agentId, update);
});

async function routeHandoff(fromAgentId: string, handoff: Handoff) {
  const targetSession = await getOrCreateSession(handoff.to);
  const memoryContext = await memory.getRelevant(handoff.to, handoff.task);

  await acpClient.prompt(targetSession.sessionId, {
    prompt: [{
      type: 'text',
      text: `[HANDOFF from ${fromAgentId}]\n${handoff.context}\n\nTask: ${handoff.task}\n\n---\nRelevant past experience:\n${memoryContext}`
    }]
  });

  memory.logHandoff({ from: fromAgentId, to: handoff.to, task: handoff.task, ts: Date.now() });
}
```

---

## Memory and learning

Each agent has a `shared/memory/[agent-name].jsonl` file. Every task completion appends a record. On each new session, the coordinator fetches the top-3 most relevant past entries and injects them as context.

### Memory record schema

```typescript
interface MemoryRecord {
  ts: number;
  taskDescription: string;
  thoughtSummary: string;        // 2-3 sentence summary of reasoning
  handoffsInitiated: {
    to: string;
    reason: string;
    outcome: 'resolved' | 'pending' | 'bounced';
  }[];
  outcome: 'complete' | 'partial' | 'failed';
  lessonsLearned: string;        // agent's own summary of what it learned
}
```

### Memory injection at session/new

```typescript
async function createAgentSession(agentId: string, taskDescription: string) {
  const relevantMemory = await memory.search(agentId, taskDescription, { topK: 3 });

  const session = await acpClient.newSession({
    cwd: `./agents/${agentId}`,
    mcpServers: agentConfig[agentId].mcpServers,
  });

  if (relevantMemory.length > 0) {
    await acpClient.prompt(session.sessionId, {
      prompt: [{
        type: 'text',
        text: `[MEMORY CONTEXT — relevant past experience]\n${relevantMemory.map(r =>
          `Task: ${r.taskDescription}\nReasoning: ${r.thoughtSummary}\nLesson: ${r.lessonsLearned}`
        ).join('\n---\n')}\n\n[END MEMORY]\n\nYour task: ${taskDescription}`
      }]
    });
  }

  return session;
}
```

Over time, agents "know" what others are good at because successful handoffs get recorded and inform future routing decisions.

---

## Observability

The `session/update` notification provides three content types per agent. Capture all three in real time.

| Content type | What it contains | Use in dashboard |
|---|---|---|
| `thought` | Pre-response reasoning | "Why" column — streams before output |
| `text` | Agent output | Main output stream |
| `tool_use` | Tool calls being made | Activity indicator, permission gate |

### Capturing all three streams

```typescript
acpClient.on('session/update', (agentId: string, update: SessionUpdate) => {
  const { sessionUpdate, content } = update;

  if (sessionUpdate === 'agent_message_chunk') {
    switch (content.type) {
      case 'thought':
        dashboard.pushThought(agentId, content.text);
        taskRegistry.updateThought(agentId, content.text);
        break;
      case 'text':
        dashboard.pushOutput(agentId, content.text);
        break;
      case 'tool_use':
        dashboard.pushToolCall(agentId, content);
        anomalyDetector.observe(agentId, { type: 'tool_call', tool: content.name });
        break;
    }
  }

  // Always fan to orchestrator read bus
  orchestratorBus.emit('agent:event', { agentId, update, ts: Date.now() });
});
```

---

## Orchestrator design

The orchestrator reads everything but writes almost nothing. It holds the high-level task registry and can inject advisory messages — but agents are explicitly instructed they may ignore them.

### Two distinct channels

**Read path (always on, passive):**
- Subscribes to a read-only tap of all `session/update` events via `orchestratorBus`
- Updates the task registry
- Runs the anomaly detector
- Pushes to the dashboard
- Never writes back through this channel

**Write path (rare, high-threshold, advisory only):**
- Sends an intervention as a `session/prompt` prefixed with `[ORCHESTRATOR NOTE]`
- Agents are free to disagree and must explain why if they do
- Interventions are logged separately for analysis

### Task registry schema

```typescript
interface TaskEntry {
  agentId: string;
  taskDescription: string;
  startedAt: number;
  lastEventAt: number;
  status: 'thinking' | 'working' | 'waiting_handoff' | 'complete' | 'stalled';
  thoughtSummary: string[];      // rolling last-3 thoughts
  handoffs: HandoffRecord[];     // who it talked to and why
  goalDrift: number;             // 0–1 score, computed from thought content vs original task
}
```

### Intervention triggers (keep this list short)

| Trigger | Threshold | Action |
|---|---|---|
| Task stalled | `lastEventAt` > N minutes, status still `working` | Inject reminder of original goal |
| Deadlock | Two agents waiting on each other's handoff, no progress | Suggest one agent proceed with assumptions |
| Goal drift | Thought content similarity to original task < 0.4 | Inject original task description |
| Agent requests guidance | Agent emits `{"guidance_request": true}` | Respond with advisory context |

### Intervention implementation

```typescript
// orchestrator.ts

orchestratorBus.on('agent:event', ({ agentId, update }) => {
  taskRegistry.record(agentId, update);
  anomalyDetector.observe(agentId, update);
  dashboard.push(agentId, update);
  // Nothing else. No writes. No decisions.
});

function intervene(agentId: string, reason: string, suggestion: string) {
  if (!meetsInterventionThreshold(agentId, reason)) return;

  coordinator.injectContext(agentId,
    `[ORCHESTRATOR NOTE] ${reason}. Suggestion: ${suggestion}`
  );

  interventionLog.push({ agentId, reason, suggestion, ts: Date.now() });
}
```

### What the orchestrator never does

- Reassign a task from one agent to another (agents decide handoffs themselves)
- Cancel an in-flight `session/prompt` (corrupts ACP session state)
- Inject into agent-to-agent handoff messages (those are private to the pair)
- Make tool call approval decisions (those stay with the coordinator)

The right mental model: the orchestrator is like a senior engineer in a shared Slack channel. They see everything, can post a message saying "hey Rex, looks like you might be going down a rabbit hole — here's the original goal again", but they don't pull the keyboard away.

---

## Starting an ACP session (TypeScript, using `@agentclientprotocol/sdk`)

```typescript
import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

async function startAgent(agentFolder: string) {
  const copilotProcess = spawn("copilot", ["--acp", "--stdio"], {
    cwd: agentFolder,
    stdio: ["pipe", "pipe", "inherit"],
  });

  const output = Writable.toWeb(copilotProcess.stdin) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(copilotProcess.stdout) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(output, input);

  const client: acp.Client = {
    async requestPermission(params) {
      // Route to your approval UI or auto-approve low-risk tools
      return { outcome: { outcome: "approved" } };
    },
    async sessionUpdate(params) {
      const { update } = params;
      if (update.sessionUpdate === "agent_message_chunk") {
        // Handle thought / text / tool_use chunks here
      }
    },
  };

  const connection = new acp.ClientSideConnection((_agent) => client, stream);
  await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });

  const session = await connection.newSession({
    cwd: agentFolder,
    mcpServers: [],
  });

  return { connection, session, process: copilotProcess };
}
```

---

## Further reading

- [ACP protocol overview](https://agentclientprotocol.com/protocol/overview)
- [ACP TypeScript SDK](https://agentclientprotocol.com/libraries/typescript)
- [GitHub Copilot CLI ACP server docs](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
- [Copilot CLI custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
- [Copilot CLI custom agents](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli)
