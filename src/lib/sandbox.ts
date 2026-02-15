import { Sandbox, type Command } from "@vercel/sandbox";
import { logger } from "./logger";

export interface SandboxConfig {
  agent: {
    id: string;
    name: string;
    git_repo_url: string | null;
    git_branch: string;
    model: string;
    permission_mode: string;
    allowed_tools: string[];
    max_turns: number;
    max_budget_usd: number;
  };
  tenantId: string;
  runId: string;
  prompt: string;
  platformApiUrl: string;
  runToken?: string;
  anthropicApiKey?: string;
  composioMcpUrl?: string;
  composioMcpHeaders?: Record<string, string>;
}

export interface SandboxInstance {
  id: string;
  stop: () => Promise<void>;
  logs: () => AsyncIterable<string>;
}

export async function createSandbox(config: SandboxConfig): Promise<SandboxInstance> {

  const sourceConfig = config.agent.git_repo_url
    ? {
        type: "git" as const,
        url: config.agent.git_repo_url,
        depth: 1,
        revision: config.agent.git_branch || "main",
      }
    : undefined;

  logger.info("Creating sandbox", {
    run_id: config.runId,
    agent_id: config.agent.id,
    tenant_id: config.tenantId,
    has_git_source: !!config.agent.git_repo_url,
  });

  const sandbox = await Sandbox.create({
    runtime: "node22",
    resources: { vcpus: 2 },
    timeout: 10 * 60 * 1000, // 10 minutes
    ...(sourceConfig ? { source: sourceConfig } : {}),
    networkPolicy: {
      allow: [
        "api.anthropic.com",
        "backend.composio.dev",
        "*.githubusercontent.com",
        "registry.npmjs.org",
        new URL(config.platformApiUrl).hostname,
      ],
    },
  });

  // Build the runner script
  const runnerScript = buildRunnerScript(config);

  // Write runner to sandbox working directory so it can resolve npm packages
  await sandbox.writeFiles([
    { path: "/vercel/sandbox/runner.mjs", content: Buffer.from(runnerScript) },
  ]);

  // Install Claude Agent SDK
  const installCmd = await sandbox.runCommand({
    cmd: "npm",
    args: ["install", "@anthropic-ai/claude-agent-sdk"],
  });
  const installOutput = await installCmd.stdout();
  const installErrors = await installCmd.stderr();
  logger.info("SDK install result", {
    exitCode: installCmd.exitCode,
    stdout: installOutput.slice(0, 500),
    stderr: installErrors.slice(0, 500),
  });
  if (installCmd.exitCode !== 0) {
    logger.error("SDK install failed", {
      exitCode: installCmd.exitCode,
      stderr: installErrors.slice(0, 1000),
    });
  }

  // Build env vars for the runner command
  const env: Record<string, string> = {
    AGENTPLANE_RUN_ID: config.runId,
    AGENTPLANE_AGENT_ID: config.agent.id,
    AGENTPLANE_TENANT_ID: config.tenantId,
    AGENTPLANE_PLATFORM_URL: config.platformApiUrl,
  };

  if (config.anthropicApiKey) {
    env.ANTHROPIC_API_KEY = config.anthropicApiKey;
  }
  if (config.runToken) {
    env.AGENTPLANE_RUN_TOKEN = config.runToken;
  }
  if (config.composioMcpUrl) {
    env.COMPOSIO_MCP_URL = config.composioMcpUrl;
  }
  if (config.composioMcpHeaders) {
    env.COMPOSIO_MCP_HEADERS = JSON.stringify(config.composioMcpHeaders);
  }

  // Start the runner in detached mode
  const command = await sandbox.runCommand({
    cmd: "node",
    args: ["runner.mjs"],
    env,
    detached: true,
  });

  logger.info("Sandbox started", {
    run_id: config.runId,
    sandbox_id: sandbox.sandboxId,
  });

  return {
    id: sandbox.sandboxId,
    stop: async () => {
      try {
        await sandbox.stop();
      } catch (err) {
        logger.warn("Failed to stop sandbox", {
          sandbox_id: sandbox.sandboxId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    logs: () => streamLogs(command),
  };
}

async function* streamLogs(command: Command): AsyncIterable<string> {
  for await (const log of command.logs()) {
    yield log.data;
  }
}

function buildRunnerScript(config: SandboxConfig): string {
  const agentConfig = {
    model: config.agent.model,
    permissionMode: config.agent.permission_mode,
    allowedTools: config.agent.allowed_tools,
    maxTurns: config.agent.max_turns,
    maxBudgetUsd: config.agent.max_budget_usd,
  };

  return `
import { query } from '@anthropic-ai/claude-agent-sdk';
import { writeFileSync, appendFileSync } from 'fs';

const config = ${JSON.stringify(agentConfig)};
const prompt = ${JSON.stringify(config.prompt)};
const runId = process.env.AGENTPLANE_RUN_ID;
const platformUrl = process.env.AGENTPLANE_PLATFORM_URL;
const runToken = process.env.AGENTPLANE_RUN_TOKEN;

// Build MCP servers config
const mcpServers = {};
if (process.env.COMPOSIO_MCP_URL) {
  const headers = process.env.COMPOSIO_MCP_HEADERS
    ? JSON.parse(process.env.COMPOSIO_MCP_HEADERS)
    : {};
  mcpServers.composio = {
    type: 'http',
    url: process.env.COMPOSIO_MCP_URL,
    headers,
  };
}

const transcriptPath = '/vercel/sandbox/transcript.ndjson';
writeFileSync(transcriptPath, '');

function emit(event) {
  const line = JSON.stringify(event);
  console.log(line);
  appendFileSync(transcriptPath, line + '\\n');
}

async function main() {
  emit({
    type: 'run_started',
    run_id: runId,
    agent_id: process.env.AGENTPLANE_AGENT_ID,
    model: config.model,
    timestamp: new Date().toISOString(),
  });

  try {
    const options = {
      model: config.model,
      permissionMode: config.permissionMode,
      allowedTools: config.allowedTools,
      maxTurns: config.maxTurns,
      maxBudgetUsd: config.maxBudgetUsd,
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    };

    for await (const message of query({ prompt, options })) {
      emit(message);
    }
  } catch (err) {
    emit({
      type: 'error',
      error: err.message || String(err),
      code: 'execution_error',
      timestamp: new Date().toISOString(),
    });
  }

  // Upload transcript for long-running/detached runs
  if (platformUrl && runToken) {
    try {
      const { readFileSync } = await import('fs');
      const transcript = readFileSync(transcriptPath);
      await fetch(platformUrl + '/api/internal/runs/' + runId + '/transcript', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + runToken,
          'Content-Type': 'application/x-ndjson',
        },
        body: transcript,
      });
    } catch (err) {
      console.error('Failed to upload transcript:', err.message);
    }
  }
}

main().catch(err => {
  console.error('Runner fatal error:', err);
  process.exit(1);
});
`;
}

export async function reconnectSandbox(sandboxId: string): Promise<SandboxInstance | null> {
  try {
    const sandbox = await Sandbox.get({ sandboxId });
    return {
      id: sandbox.sandboxId,
      stop: () => sandbox.stop(),
      logs: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: "" }) }) }),
    };
  } catch {
    return null;
  }
}
