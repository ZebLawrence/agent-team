// ============================================================================
// Dashboard WebSocket Server — real-time event streaming to the UI
// ============================================================================

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { MessageBus, BusEvent } from '../message-bus/bus.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { SessionManager } from '../acp/session-manager.js';
import { AgentId, AgentConfig, ModelInfo } from '../types.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export class DashboardServer {
  private httpServer: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private messageBus: MessageBus;
  private orchestrator: Orchestrator;
  private sessionManager: SessionManager;
  private availableModels: ModelInfo[];
  private staticDir: string;

  constructor(
    messageBus: MessageBus,
    orchestrator: Orchestrator,
    sessionManager: SessionManager,
    availableModels: ModelInfo[],
    staticDir: string = './dashboard/public',
  ) {
    this.messageBus = messageBus;
    this.orchestrator = orchestrator;
    this.sessionManager = sessionManager;
    this.availableModels = availableModels;
    this.staticDir = staticDir;

    this.httpServer = createServer(this.handleHttpRequest.bind(this));
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.setupWebSocket();
    this.setupEventForwarding();
  }

  start(port: number = 3000): void {
    this.httpServer.listen(port, () => {
      console.log(`Dashboard running at http://localhost:${port}`);
    });
  }

  stop(): void {
    this.wss.close();
    this.httpServer.close();
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    // API endpoints
    if (req.url?.startsWith('/api/')) {
      return this.handleApiRequest(req, res);
    }

    // Static files
    let filePath = join(this.staticDir, req.url === '/' ? 'index.html' : req.url!);

    if (!existsSync(filePath)) {
      filePath = join(this.staticDir, 'index.html');
    }

    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || 'text/plain';

    try {
      const content = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  }

  private handleApiRequest(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    switch (req.url) {
      case '/api/agents':
        res.end(JSON.stringify({
          agents: this.sessionManager.getAgentConfigs(),
          statuses: this.sessionManager.getAllStatuses(),
        }));
        break;

      case '/api/tasks':
        res.end(JSON.stringify(this.orchestrator.getTaskRegistry()));
        break;

      case '/api/interventions':
        res.end(JSON.stringify(this.orchestrator.getInterventionLog()));
        break;

      case '/api/events':
        res.end(JSON.stringify(this.messageBus.getRecentEvents(100)));
        break;

      default:
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);

      // Send initial state snapshot — agents are now dynamic
      ws.send(JSON.stringify({
        type: 'snapshot',
        data: {
          agents: this.sessionManager.getAgentConfigs(),
          statuses: this.sessionManager.getAllStatuses(),
          models: this.sessionManager.getAllModels(),
          availableModels: this.availableModels,
          tasks: this.orchestrator.getTaskRegistry(),
          recentEvents: this.messageBus.getRecentEvents(50),
        },
      }));

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleClientMessage(msg);
        } catch {
          // Ignore invalid messages
        }
      });
    });
  }

  private handleClientMessage(msg: { type: string; [key: string]: unknown }): void {
    switch (msg.type) {
      case 'prompt_agent':
        // Allow dashboard users to send tasks to agents
        if (msg.agentId && msg.task) {
          const agentId = msg.agentId as AgentId;
          const status = this.sessionManager.getStatus(agentId);

          if (status !== 'ready' && status !== 'busy') {
            // Agent not available — notify the client instead of crashing
            this.broadcast({
              type: 'error',
              data: {
                message: `Agent ${agentId} is not connected (status: ${status}). Run with --demo flag for simulated agents, or ensure Copilot CLI is installed.`,
                agentId,
              },
            });
            break;
          }

          this.sessionManager.promptAgent(agentId, msg.task as string)
            .catch((err: Error) => {
              this.broadcast({
                type: 'error',
                data: { message: err.message, agentId },
              });
            });
        }
        break;

      case 'get_agent_events':
        if (msg.agentId) {
          const events = this.messageBus.getAgentEvents(msg.agentId as AgentId, 100);
          this.broadcast({
            type: 'agent_events',
            agentId: msg.agentId,
            events,
          });
        }
        break;

      case 'change_model':
        if (msg.agentId && msg.model) {
          const changeAgentId = msg.agentId as AgentId;
          const newModel = msg.model as string;

          this.broadcast({
            type: 'event',
            data: {
              type: 'status_change',
              agentId: changeAgentId,
              data: { status: 'starting' },
              ts: Date.now(),
            },
          });

          this.sessionManager.changeAgentModel(changeAgentId, newModel)
            .then(() => {
              this.broadcast({
                type: 'model_change',
                agentId: changeAgentId,
                model: newModel,
              });
            })
            .catch((err: Error) => {
              this.broadcast({
                type: 'error',
                data: { message: `Model change failed: ${err.message}`, agentId: changeAgentId },
              });
            });
        }
        break;
    }
  }

  private setupEventForwarding(): void {
    this.messageBus.on('event', (event: BusEvent) => {
      this.broadcast({
        type: 'event',
        data: event,
      });
    });
  }

  private broadcast(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }
}
