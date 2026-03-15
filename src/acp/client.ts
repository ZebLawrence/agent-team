// ============================================================================
// ACP Client Wrapper — manages Copilot CLI agent processes via ACP protocol
// ============================================================================

import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { resolve as resolvePath } from 'node:path';
import {
  AgentId,
  AcpSessionParams,
  AcpPromptParams,
  AcpSessionUpdate,
  AcpPermissionRequest,
  AcpPermissionResponse,
} from '../types.js';

// Start client request IDs high to avoid collisions with server-initiated
// request IDs (which start at 0 and count up).
let nextRequestId = 10000;

const REQUEST_TIMEOUT_MS = 300_000; // 5 minutes — agents doing real work (tool calls, file reads) need time

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

function log(agentId: AgentId, ...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${agentId}]`, ...args);
}

export class AcpClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private pendingRequests = new Map<number, PendingRequest>();
  private sessionId: string | null = null;
  private _agentId: AgentId;
  private _model: string;
  private stderrBuffer: string[] = [];

  constructor(public readonly agentId: AgentId, model: string = 'gpt-4o') {
    super();
    this._agentId = agentId;
    this._model = model;
  }

  get isConnected(): boolean {
    return this.process !== null && !this.process.killed;
  }

  get model(): string {
    return this._model;
  }

  /**
   * Change the model for this agent. This takes effect on the NEXT session/prompt.
   * The Copilot CLI process needs to be restarted with the new --model flag for
   * the change to apply to the underlying ACP server.
   */
  async changeModel(newModel: string): Promise<void> {
    if (newModel === this._model) return;
    const oldModel = this._model;
    this._model = newModel;
    log(this._agentId, `Model changed: ${oldModel} → ${newModel} (restart required)`);
  }

  async start(cwd: string): Promise<void> {
    const args = ['--acp', '--stdio', '--yolo', `--model=${this._model}`];
    log(this._agentId, `Spawning: copilot ${args.join(' ')} (cwd: ${cwd})`);

    // shell: true is required on Windows so that spawn can resolve
    // binaries installed via npm/scoop/winget that live on the user
    // PATH but aren't directly resolvable by the Node child_process
    // path lookup (which skips PATHEXT / shell-level resolution).
    this.process = spawn('copilot', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],  // Capture stderr too
      shell: process.platform === 'win32',
    });

    // Capture stderr for diagnostics
    if (this.process.stderr) {
      const stderrRl = createInterface({ input: this.process.stderr });
      stderrRl.on('line', (line) => {
        this.stderrBuffer.push(line);
        if (this.stderrBuffer.length > 50) this.stderrBuffer.shift();
        log(this._agentId, `[stderr] ${line}`);
      });
    }

    this.process.on('exit', (code, signal) => {
      log(this._agentId, `Process exited: code=${code}, signal=${signal}`);
      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Agent ${this._agentId} process exited (code ${code})`));
        this.pendingRequests.delete(id);
      }
      this.emit('exit', { agentId: this._agentId, code });
    });

    this.process.on('error', (err) => {
      log(this._agentId, `Process error: ${err.message}`);
      this.emit('error', { agentId: this._agentId, error: err });
    });

    // Parse NDJSON from stdout
    const rl = createInterface({ input: this.process.stdout! });
    rl.on('line', (line) => {
      log(this._agentId, `[stdout] ${line.substring(0, 200)}${line.length > 200 ? '...' : ''}`);
      try {
        const msg = JSON.parse(line);
        this.handleMessage(msg);
      } catch {
        // Non-JSON output — already logged above
      }
    });

    // Wait a moment for the process to start before sending initialize
    await new Promise(resolve => setTimeout(resolve, 500));

    if (this.process.killed || this.process.exitCode !== null) {
      const stderr = this.stderrBuffer.join('\n');
      throw new Error(
        `Agent ${this._agentId}: copilot process exited immediately.\n` +
        (stderr ? `  stderr: ${stderr}` : '  (no stderr output)')
      );
    }

    // Initialize the ACP connection
    log(this._agentId, 'Sending initialize request...');
    try {
      const initResult = await this.sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      log(this._agentId, 'Initialize response:', JSON.stringify(initResult));
    } catch (err) {
      const stderr = this.stderrBuffer.join('\n');
      throw new Error(
        `Agent ${this._agentId}: ACP initialize failed — ${(err as Error).message}\n` +
        (stderr ? `  stderr: ${stderr}` : '')
      );
    }
  }

  async newSession(params: AcpSessionParams): Promise<string> {
    // Copilot ACP requires absolute paths
    const absoluteParams = {
      ...params,
      cwd: resolvePath(params.cwd),
    };
    log(this._agentId, `Creating new session (cwd: ${absoluteParams.cwd})...`);
    const result = await this.sendRequest('session/new', absoluteParams) as { sessionId: string };
    this.sessionId = result.sessionId;
    log(this._agentId, `Session created: ${this.sessionId}`);
    return this.sessionId;
  }

  async prompt(sessionId: string, params: AcpPromptParams): Promise<void> {
    log(this._agentId, `Sending prompt to session ${sessionId}...`);
    await this.sendRequest('session/prompt', {
      sessionId,
      ...params,
    });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.sendRequest('session/cancel', { sessionId });
  }

  async stop(): Promise<void> {
    if (this.process && !this.process.killed) {
      log(this._agentId, 'Stopping process...');
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }

  getStderr(): string[] {
    return [...this.stderrBuffer];
  }

  private async sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (!this.process?.stdin) {
      throw new Error(`Agent ${this._agentId}: process not started`);
    }

    const id = nextRequestId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        const stderr = this.stderrBuffer.slice(-5).join('\n');
        reject(new Error(
          `Agent ${this._agentId}: request "${method}" timed out after ${REQUEST_TIMEOUT_MS / 1000}s.\n` +
          `  This usually means the Copilot CLI started but didn't respond to the ACP request.\n` +
          (stderr ? `  Recent stderr: ${stderr}` : '  (no stderr output)')
        ));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const payload = JSON.stringify(request) + '\n';
      log(this._agentId, `>> ${method} (id=${id})`);
      this.process!.stdin!.write(payload);
    });
  }

  private handleMessage(msg: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest): void {
    const hasId = 'id' in msg && msg.id !== undefined && msg.id !== null;
    const hasMethod = 'method' in msg && typeof (msg as { method?: string }).method === 'string';

    // ---- Server-to-client REQUESTS (have both id AND method) ----
    // These are requests FROM the ACP server that expect a response from us.
    // Must be checked BEFORE responses, because both have 'id'.
    if (hasId && hasMethod) {
      const rpcReq = msg as JsonRpcRequest;
      log(this._agentId, `<< Server request: ${rpcReq.method} (id=${rpcReq.id})`);

      switch (rpcReq.method) {
        case 'session/request_permission':
        case 'requestPermission':
          this.handlePermissionRequest(rpcReq);
          break;

        default:
          // Unknown server request — respond with empty result so it doesn't hang
          log(this._agentId, `Unknown server request "${rpcReq.method}", auto-acknowledging`);
          this.sendResponse(rpcReq.id, {});
          break;
      }
      return;
    }

    // ---- Client-to-server RESPONSES (have id but NO method) ----
    if (hasId && !hasMethod) {
      const rpcResp = msg as JsonRpcResponse;
      const pending = this.pendingRequests.get(rpcResp.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(rpcResp.id);
        if ('error' in rpcResp && rpcResp.error) {
          log(this._agentId, `<< Error (id=${rpcResp.id}): ${rpcResp.error.message}`);
          pending.reject(new Error(rpcResp.error.message));
        } else {
          log(this._agentId, `<< Response (id=${rpcResp.id})`);
          pending.resolve(rpcResp.result);
        }
      } else {
        log(this._agentId, `<< Response (id=${rpcResp.id}) — no pending request (stale/unexpected)`);
      }
      return;
    }

    // ---- NOTIFICATIONS (have method but NO id) ----
    if (hasMethod) {
      const notification = msg as JsonRpcNotification;
      log(this._agentId, `<< Notification: ${notification.method}`);
      switch (notification.method) {
        case 'session/update': {
          // Copilot ACP wraps the update: params = { sessionId, update: { sessionUpdate, content } }
          const params = notification.params as { sessionId?: string; update?: AcpSessionUpdate } | AcpSessionUpdate;
          const update = ('update' in params && params.update) ? params.update : params as AcpSessionUpdate;
          this.emit('session/update', this._agentId, update);
          break;
        }
      }
    }
  }

  private sendResponse(id: number, result: unknown): void {
    if (!this.process?.stdin) return;
    const reply: JsonRpcResponse = { jsonrpc: '2.0', id, result };
    const payload = JSON.stringify(reply) + '\n';
    log(this._agentId, `>> Response (id=${id})`);
    this.process.stdin.write(payload);
  }

  private handlePermissionRequest(msg: JsonRpcRequest): void {
    const params = msg.params as AcpPermissionRequest | undefined;
    log(this._agentId, `Permission request: ${JSON.stringify(params).substring(0, 200)}`);

    // Auto-approve all permission requests so the agent can proceed
    const response: AcpPermissionResponse = { outcome: { outcome: 'approved' } };
    this.emit('permission_request', this._agentId, params);
    this.sendResponse(msg.id, response);
  }
}
