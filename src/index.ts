// ============================================================================
// Main entry point — bootstraps the entire agent team system
// ============================================================================

import { execSync } from 'node:child_process';
import { MemoryStore } from './memory/store.js';
import { MessageBus } from './message-bus/bus.js';
import { SessionManager } from './acp/session-manager.js';
import { Coordinator } from './coordinator/coordinator.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { DashboardServer } from './dashboard/server.js';
import { discoverAgents, loadModels } from './agents/discovery.js';
import { AgentId } from './types.js';

function isCopilotAvailable(): boolean {
  // Try multiple possible binary names / locations
  const candidates = ['copilot', 'gh copilot'];
  for (const cmd of candidates) {
    try {
      execSync(`${cmd} --version`, { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      // Try next candidate
    }
  }
  return false;
}

async function main() {
  const forceDemo = process.argv.includes('--demo');
  const forceReal = process.argv.includes('--real');

  let demoMode: boolean;
  if (forceDemo) {
    demoMode = true;
  } else if (forceReal) {
    demoMode = false;
  } else {
    demoMode = !isCopilotAvailable();
  }

  if (demoMode) {
    console.log('🎭 Demo mode — Copilot CLI not detected, using simulated agents');
    console.log('   To connect real agents: npm start -- --real\n');
  } else {
    console.log('🚀 Live mode — connecting to Copilot CLI via ACP\n');
  }

  // 1. Discover agents from /agents directory
  console.log('🔍 Discovering agents...');
  const agentConfigs = discoverAgents('./agents');

  if (agentConfigs.length === 0) {
    console.error('❌ No agents discovered! Make sure ./agents/ contains subdirectories with .github/copilot-instructions.md');
    process.exit(1);
  }

  console.log(`   Found ${agentConfigs.length} agent(s)\n`);

  // 2. Load available models
  const availableModels = loadModels('./shared/registry/models.json');
  console.log(`📋 Loaded ${availableModels.length} available models\n`);

  // 3. Initialize core services
  const memory = new MemoryStore('./shared/memory');
  const messageBus = new MessageBus();
  const sessionManager = new SessionManager(agentConfigs, memory, demoMode);

  // Wire session manager events to the message bus
  sessionManager.on('status_change', (agentId: string, status: string) => {
    messageBus.publishStatusChange(agentId as AgentId, status);
  });
  sessionManager.on('task_start', (agentId: string, taskDescription: string) => {
    messageBus.publishTaskStart(agentId as AgentId, taskDescription);
  });

  // 4. Initialize coordinator (routes handoffs between agents)
  const coordinator = new Coordinator(sessionManager, messageBus, memory);

  // 5. Initialize orchestrator (passive observer + anomaly detection)
  const orchestrator = new Orchestrator(messageBus, coordinator, {
    stallThresholdMs: 5 * 60 * 1000,
    goalDriftThreshold: 0.4,
  });

  // 6. Start the dashboard server
  const dashboard = new DashboardServer(
    messageBus,
    orchestrator,
    sessionManager,
    availableModels,
    './dashboard/public',
  );

  const port = parseInt(process.env.DASHBOARD_PORT || '3000', 10);
  dashboard.start(port);

  // 7. Start all agent ACP sessions
  console.log('📡 Initializing agents...');
  try {
    await sessionManager.initializeAll();
    console.log('✅ All agents initialized\n');
  } catch (err) {
    console.error('⚠️  Some agents failed to initialize:', err);
    console.log('   Dashboard is still running for visibility.\n');
  }

  // 8. Start the orchestrator's periodic checks
  orchestrator.start();

  const agentNames = agentConfigs.map(c => `${c.name} (${c.role})`).join(', ');
  console.log(`🎯 Agent Team is live!`);
  console.log(`   Dashboard: http://localhost:${port}`);
  console.log(`   Agents: ${agentNames}`);
  console.log(`   Mode: ${demoMode ? 'Demo (simulated)' : 'Live (Copilot ACP)'}`);
  console.log(`   Orchestrator: Passive observer with advisory channel\n`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n🛑 Shutting down...');
    orchestrator.stop();
    dashboard.stop();
    await sessionManager.shutdownAll();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(console.error);
