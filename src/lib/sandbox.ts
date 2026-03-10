import path from "path";
import { Sandbox, Snapshot, type Command } from "@vercel/sandbox";
import { logger } from "./logger";
import type { McpServerConfig } from "./mcp";

// --- SDK Snapshot Cache ---
// Pre-built snapshot with @anthropic-ai/claude-agent-sdk installed.
// Created lazily on first cold start, then reused for all subsequent sandboxes.
// Eliminates ~3-4s npm install on every cold start.
let sdkSnapshotId: string | null = null;
let sdkSnapshotPromise: Promise<string> | null = null;

async function getOrCreateSdkSnapshot(): Promise<string> {
  if (sdkSnapshotId) return sdkSnapshotId;

  // Deduplicate concurrent snapshot creation requests
  if (sdkSnapshotPromise) return sdkSnapshotPromise;

  sdkSnapshotPromise = (async () => {
    // Check if we already have a valid snapshot
    try {
      const result = await Snapshot.list({ limit: 10 });
      // Find a recent, valid snapshot (created status means it's usable)
      const existing = result.json.snapshots.find((s: { status: string }) => s.status === "created");
      if (existing) {
        sdkSnapshotId = existing.id;
        logger.info("Reusing existing SDK snapshot", { snapshot_id: existing.id });
        return existing.id;
      }
    } catch (err) {
      logger.warn("Failed to list snapshots, will create new", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Create a fresh sandbox, install SDK, snapshot it
    logger.info("Creating SDK snapshot (one-time operation)");
    const sandbox = await Sandbox.create({
      runtime: "node22",
      resources: { vcpus: 2 },
      timeout: 120_000,
    });

    const installCmd = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "@anthropic-ai/claude-agent-sdk"],
    });
    if (installCmd.exitCode !== 0) {
      const stderr = await installCmd.stderr();
      await sandbox.stop();
      throw new Error(`SDK install failed during snapshot creation: ${stderr.slice(0, 500)}`);
    }

    // snapshot() stops the sandbox automatically
    const snapshot = await sandbox.snapshot();
    sdkSnapshotId = snapshot.snapshotId;
    logger.info("SDK snapshot created", { snapshot_id: snapshot.snapshotId });
    return snapshot.snapshotId;
  })();

  try {
    return await sdkSnapshotPromise;
  } finally {
    sdkSnapshotPromise = null;
  }
}

/** Invalidate the cached snapshot (e.g. if sandbox creation from it fails). */
function invalidateSdkSnapshot() {
  sdkSnapshotId = null;
}

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
    skills: Array<{ folder: string; files: Array<{ path: string; content: string }> }>;
  };
  tenantId: string;
  runId: string;
  prompt: string;
  platformApiUrl: string;
  runToken?: string;
  maxRuntimeSeconds?: number;
  aiGatewayApiKey: string;
  mcpServers?: Record<string, McpServerConfig>;
  mcpErrors?: string[];
  pluginFiles?: Array<{ path: string; content: string }>;
}

export interface SandboxInstance {
  id: string;
  stop: () => Promise<void>;
  logs: () => AsyncIterable<string>;
}

/**
 * Create a sandbox from the SDK snapshot, with fallback to fresh creation + install.
 */
async function createSandboxFromSnapshot(opts: {
  resources: { vcpus: number };
  timeout: number;
  networkPolicy: { allow: string[] };
}): Promise<Sandbox> {
  try {
    const snapshotId = await getOrCreateSdkSnapshot();
    return await Sandbox.create({
      source: { type: "snapshot", snapshotId },
      resources: opts.resources,
      timeout: opts.timeout,
      networkPolicy: opts.networkPolicy,
    });
  } catch (err) {
    // Snapshot may be expired or invalid — fall back to fresh sandbox
    logger.warn("Snapshot-based sandbox creation failed, falling back to fresh install", {
      error: err instanceof Error ? err.message : String(err),
    });
    invalidateSdkSnapshot();
    const sandbox = await Sandbox.create({
      runtime: "node22",
      resources: opts.resources,
      timeout: opts.timeout,
      networkPolicy: opts.networkPolicy,
    });
    await installSdk(sandbox, "fallback");
    return sandbox;
  }
}

/** Install the Claude Agent SDK in a sandbox. */
async function installSdk(sandbox: Sandbox, contextId: string): Promise<void> {
  const installCmd = await sandbox.runCommand({
    cmd: "npm",
    args: ["install", "@anthropic-ai/claude-agent-sdk"],
  });
  if (installCmd.exitCode !== 0) {
    const installErrors = await installCmd.stderr();
    logger.error("SDK install failed", {
      context_id: contextId,
      exitCode: installCmd.exitCode,
      stderr: installErrors.slice(0, 1000),
    });
  }
}

export async function createSandbox(config: SandboxConfig): Promise<SandboxInstance> {

  logger.info("Creating sandbox", {
    run_id: config.runId,
    agent_id: config.agent.id,
    tenant_id: config.tenantId,
    has_git_source: !!config.agent.git_repo_url,
  });

  // Extract hostnames from custom MCP servers for network policy
  const mcpHostnames = Object.values(config.mcpServers ?? {}).map(
    (s) => new URL(s.url).hostname,
  );

  const networkPolicy = {
    allow: [
      "ai-gateway.vercel.sh",
      "*.composio.dev",
      "*.firecrawl.dev",
      "*.githubusercontent.com",
      "registry.npmjs.org",
      new URL(config.platformApiUrl).hostname,
      ...mcpHostnames,
    ],
  };

  // Git repos can't use snapshots (need fresh clone)
  const useSnapshot = !config.agent.git_repo_url;

  let sandbox: Sandbox;
  if (useSnapshot) {
    sandbox = await createSandboxFromSnapshot({
      resources: { vcpus: 2 },
      timeout: (config.maxRuntimeSeconds ?? 600) * 1000,
      networkPolicy,
    });
  } else {
    const sourceConfig = {
      type: "git" as const,
      url: config.agent.git_repo_url!,
      depth: 1,
      revision: config.agent.git_branch || "main",
    };
    sandbox = await Sandbox.create({
      runtime: "node22",
      resources: { vcpus: 2 },
      timeout: (config.maxRuntimeSeconds ?? 600) * 1000,
      source: sourceConfig,
      networkPolicy,
    });
    // Git source sandboxes still need SDK installed
    await installSdk(sandbox, config.runId);
  }

  // Build the runner script
  const runnerScript = buildRunnerScript(config);

  // Write skill files into .claude/skills/<folder>/
  const skillsRoot = "/vercel/sandbox/.claude/skills";
  const skillFiles = config.agent.skills.flatMap((skill) =>
    skill.files.map((file) => {
      const resolved = path.resolve(skillsRoot, skill.folder, file.path);
      // Defense-in-depth: verify resolved path stays under skills root
      if (!resolved.startsWith(skillsRoot + "/")) {
        throw new Error(`Skill path escapes skills root: ${skill.folder}/${file.path}`);
      }
      return { path: resolved, content: Buffer.from(file.content) };
    }),
  );

  // Resolve plugin files (pre-fetched paths like .claude/skills/plugin-name-file.md)
  const sandboxRoot = "/vercel/sandbox";
  const pluginFiles = (config.pluginFiles ?? []).map((f) => {
    const resolved = path.resolve(sandboxRoot, f.path);
    if (!resolved.startsWith(sandboxRoot + "/")) {
      throw new Error(`Plugin path escapes sandbox root: ${f.path}`);
    }
    return { path: resolved, content: Buffer.from(f.content) };
  });

  // Write runner + skill + plugin files to sandbox
  await sandbox.writeFiles([
    { path: "/vercel/sandbox/runner.mjs", content: Buffer.from(runnerScript) },
    ...skillFiles,
    ...pluginFiles,
  ]);

  // Build env vars for the runner command
  const env: Record<string, string> = {
    AGENTPLANE_RUN_ID: config.runId,
    AGENTPLANE_AGENT_ID: config.agent.id,
    AGENTPLANE_TENANT_ID: config.tenantId,
    AGENTPLANE_PLATFORM_URL: config.platformApiUrl,
  };

  env.ANTHROPIC_BASE_URL = "https://ai-gateway.vercel.sh";
  env.ANTHROPIC_AUTH_TOKEN = config.aiGatewayApiKey;
  env.ANTHROPIC_API_KEY = "";
  // Disable ToolSearch: the Agent SDK's tool_reference content blocks require
  env.ENABLE_TOOL_SEARCH = "true";
  if (config.runToken) {
    env.AGENTPLANE_RUN_TOKEN = config.runToken;
  }
  if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    env.MCP_SERVERS_JSON = JSON.stringify(config.mcpServers);
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
  let buffer = "";
  for await (const log of command.logs()) {
    buffer += log.data;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) yield line;
    }
  }
  if (buffer.trim()) yield buffer;
}

function buildRunnerScript(config: SandboxConfig): string {
  const hasSkills = config.agent.skills.length > 0;
  const hasPluginContent = (config.pluginFiles ?? []).length > 0;
  const hasMcp = config.mcpServers && Object.keys(config.mcpServers).length > 0;
  const agentConfig = {
    model: config.agent.model,
    permissionMode: config.agent.permission_mode,
    // Don't restrict allowedTools when MCP servers are present,
    // otherwise MCP tool names (mcp__*) get blocked
    ...(hasMcp ? {} : { allowedTools: config.agent.allowed_tools }),
    maxTurns: config.agent.max_turns,
    maxBudgetUsd: config.agent.max_budget_usd,
    ...((hasSkills || hasPluginContent) ? { settingSources: ["project"] } : {}),
  };

  return `
import { query } from '@anthropic-ai/claude-agent-sdk';
import { writeFileSync, appendFileSync } from 'fs';

const config = ${JSON.stringify(agentConfig)};
const prompt = ${JSON.stringify(config.prompt)};
const runId = process.env.AGENTPLANE_RUN_ID;
const platformUrl = process.env.AGENTPLANE_PLATFORM_URL;
const runToken = process.env.AGENTPLANE_RUN_TOKEN;

// Build MCP servers config from JSON env var
const mcpServers = process.env.MCP_SERVERS_JSON
  ? JSON.parse(process.env.MCP_SERVERS_JSON)
  : {};

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
    mcp_server_count: Object.keys(mcpServers).length,
    mcp_errors: ${JSON.stringify(config.mcpErrors || [])},
  });

  try {
    const options = {
      model: config.model,
      permissionMode: config.permissionMode,
      ...(config.allowedTools ? { allowedTools: config.allowedTools } : {}),
      maxTurns: config.maxTurns,
      maxBudgetUsd: config.maxBudgetUsd,
      ...(config.settingSources ? { settingSources: config.settingSources } : {}),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      includePartialMessages: true,
    };

    for await (const message of query({ prompt, options })) {
      if (message.type === 'stream_event') {
        const ev = message.event;
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          // Stream text deltas to stdout only — not written to transcript
          console.log(JSON.stringify({ type: 'text_delta', text: ev.delta.text }));
        }
      } else {
        emit(message);
      }
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

// --- Session Sandbox ---

export interface SessionSandboxConfig {
  agent: SandboxConfig["agent"];
  tenantId: string;
  sessionId: string;
  platformApiUrl: string;
  aiGatewayApiKey: string;
  mcpServers?: Record<string, McpServerConfig>;
  mcpErrors?: string[];
  pluginFiles?: Array<{ path: string; content: string }>;
  maxIdleTimeoutMs?: number; // default 30 min
}

export interface SessionSandboxInstance extends SandboxInstance {
  sandboxRef: Sandbox;
  runMessage(opts: {
    prompt: string;
    sdkSessionId: string | null;
    runId: string;
    runToken: string;
    maxTurns: number;
    maxBudgetUsd: number;
  }): Promise<{ logs: () => AsyncIterable<string> }>;
  extendTimeout(ms: number): Promise<void>;
  writeSessionFile(sdkSessionId: string, content: Buffer): Promise<void>;
  readSessionFile(sdkSessionId: string): Promise<Buffer | null>;
  /** Update the MCP server config for subsequent runMessage() calls (hot path). */
  updateMcpConfig(servers: Record<string, McpServerConfig>, errors: string[]): void;
}

const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
// SDK stores session files at this path (must match session-files.ts SESSION_FILE_DIR)
const SESSION_FILE_DIR = "/vercel/sandbox/.claude/projects/vercel/sandbox";

export async function createSessionSandbox(config: SessionSandboxConfig): Promise<SessionSandboxInstance> {
  const sourceConfig = config.agent.git_repo_url
    ? {
        type: "git" as const,
        url: config.agent.git_repo_url,
        depth: 1,
        revision: config.agent.git_branch || "main",
      }
    : undefined;

  logger.info("Creating session sandbox", {
    session_id: config.sessionId,
    agent_id: config.agent.id,
    tenant_id: config.tenantId,
  });

  const mcpHostnames = Object.values(config.mcpServers ?? {}).map(
    (s) => new URL(s.url).hostname,
  );

  const timeoutMs = config.maxIdleTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;

  const networkPolicy = {
    allow: [
      "ai-gateway.vercel.sh",
      "*.composio.dev",
      "*.firecrawl.dev",
      "*.githubusercontent.com",
      "registry.npmjs.org",
      new URL(config.platformApiUrl).hostname,
      ...mcpHostnames,
    ],
  };

  // Git repos can't use snapshots (need fresh clone)
  const useSnapshot = !config.agent.git_repo_url;
  let sandbox: Sandbox;

  if (useSnapshot) {
    sandbox = await createSandboxFromSnapshot({
      resources: { vcpus: 2 },
      timeout: timeoutMs,
      networkPolicy,
    });
  } else {
    sandbox = await Sandbox.create({
      runtime: "node22",
      resources: { vcpus: 2 },
      timeout: timeoutMs,
      source: sourceConfig!,
      networkPolicy,
    });
    // Git source sandboxes still need SDK installed
    await installSdk(sandbox, config.sessionId);
  }

  // Write skill files
  const skillsRoot = "/vercel/sandbox/.claude/skills";
  const skillFiles = config.agent.skills.flatMap((skill) =>
    skill.files.map((file) => {
      const resolved = path.resolve(skillsRoot, skill.folder, file.path);
      if (!resolved.startsWith(skillsRoot + "/")) {
        throw new Error(`Skill path escapes skills root: ${skill.folder}/${file.path}`);
      }
      return { path: resolved, content: Buffer.from(file.content) };
    }),
  );

  const sandboxRoot = "/vercel/sandbox";
  const pluginFiles = (config.pluginFiles ?? []).map((f) => {
    const resolved = path.resolve(sandboxRoot, f.path);
    if (!resolved.startsWith(sandboxRoot + "/")) {
      throw new Error(`Plugin path escapes sandbox root: ${f.path}`);
    }
    return { path: resolved, content: Buffer.from(f.content) };
  });

  // Write skill + plugin files (no runner yet)
  if (skillFiles.length > 0 || pluginFiles.length > 0) {
    await sandbox.writeFiles([...skillFiles, ...pluginFiles]);
  }

  logger.info("Session sandbox created", {
    session_id: config.sessionId,
    sandbox_id: sandbox.sandboxId,
  });

  const hasMcp = config.mcpServers && Object.keys(config.mcpServers).length > 0;
  const hasSkills = config.agent.skills.length > 0;
  const hasPluginContent = (config.pluginFiles ?? []).length > 0;

  // Build base env for all messages
  const baseEnv: Record<string, string> = {
    AGENTPLANE_AGENT_ID: config.agent.id,
    AGENTPLANE_TENANT_ID: config.tenantId,
    AGENTPLANE_PLATFORM_URL: config.platformApiUrl,
    ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
    ANTHROPIC_AUTH_TOKEN: config.aiGatewayApiKey,
    ANTHROPIC_API_KEY: "",
    ENABLE_TOOL_SEARCH: "true",
  };
  if (hasMcp) {
    baseEnv.MCP_SERVERS_JSON = JSON.stringify(config.mcpServers);
  }

  return buildSessionSandboxInstance(sandbox, config, baseEnv, !!hasMcp, hasSkills, hasPluginContent);
}

function buildSessionSandboxInstance(
  sandbox: Sandbox,
  config: SessionSandboxConfig,
  baseEnv: Record<string, string>,
  hasMcp: boolean,
  hasSkills: boolean,
  hasPluginContent: boolean,
): SessionSandboxInstance {
  // Mutable reference so updateMcpConfig can modify for subsequent runMessage calls
  let currentHasMcp = hasMcp;
  let currentMcpErrors = config.mcpErrors ?? [];

  return {
    id: sandbox.sandboxId,
    sandboxRef: sandbox,
    stop: async () => {
      try {
        await sandbox.stop();
      } catch (err) {
        logger.warn("Failed to stop session sandbox", {
          sandbox_id: sandbox.sandboxId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    logs: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: "" }) }) }),
    extendTimeout: async (ms: number) => {
      try {
        await sandbox.extendTimeout(ms);
      } catch (err) {
        logger.error("Failed to extend sandbox timeout", {
          sandbox_id: sandbox.sandboxId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    writeSessionFile: async (sdkSessionId: string, content: Buffer) => {
      await sandbox.writeFiles([{ path: `${SESSION_FILE_DIR}/${sdkSessionId}.jsonl`, content }]);
    },
    readSessionFile: async (sdkSessionId: string) => {
      try {
        return await sandbox.readFileToBuffer({ path: `${SESSION_FILE_DIR}/${sdkSessionId}.jsonl` });
      } catch (err) {
        logger.warn("Failed to read session file from sandbox", {
          sandbox_id: sandbox.sandboxId,
          sdk_session_id: sdkSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
    updateMcpConfig: (servers, errors) => {
      if (Object.keys(servers).length > 0) {
        baseEnv.MCP_SERVERS_JSON = JSON.stringify(servers);
        currentHasMcp = true;
      }
      currentMcpErrors = errors;
    },
    runMessage: async (opts) => {
      const runnerScript = buildSessionRunnerScript({
        agent: config.agent,
        prompt: opts.prompt,
        sdkSessionId: opts.sdkSessionId,
        maxTurns: opts.maxTurns,
        maxBudgetUsd: opts.maxBudgetUsd,
        hasSkillsOrPlugins: hasSkills || hasPluginContent,
        hasMcp: currentHasMcp,
        mcpErrors: currentMcpErrors,
      });

      const runnerFilename = `runner-${opts.runId}.mjs`;
      await sandbox.writeFiles([
        { path: `/vercel/sandbox/${runnerFilename}`, content: Buffer.from(runnerScript) },
      ]);

      const env = {
        ...baseEnv,
        AGENTPLANE_RUN_ID: opts.runId,
        AGENTPLANE_RUN_TOKEN: opts.runToken,
      };

      const command = await sandbox.runCommand({
        cmd: "node",
        args: [runnerFilename],
        env,
        detached: true,
      });

      return {
        logs: () => streamLogs(command),
      };
    },
  };
}

interface SessionRunnerConfig {
  agent: SandboxConfig["agent"];
  prompt: string;
  sdkSessionId: string | null;
  maxTurns: number;
  maxBudgetUsd: number;
  hasSkillsOrPlugins: boolean;
  hasMcp: boolean;
  mcpErrors: string[];
}

function buildSessionRunnerScript(config: SessionRunnerConfig): string {
  const agentConfig = {
    model: config.agent.model,
    permissionMode: config.agent.permission_mode,
    // Don't restrict allowedTools when MCP servers are present
    ...(config.hasMcp ? {} : { allowedTools: config.agent.allowed_tools }),
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
    ...(config.hasSkillsOrPlugins ? { settingSources: ["project"] } : {}),
    includePartialMessages: true,
  };

  return `
import { query } from '@anthropic-ai/claude-agent-sdk';
import { writeFileSync, appendFileSync } from 'fs';

const config = ${JSON.stringify(agentConfig)};
const prompt = ${JSON.stringify(config.prompt)};
const sdkSessionId = ${JSON.stringify(config.sdkSessionId)};

const mcpServers = process.env.MCP_SERVERS_JSON
  ? JSON.parse(process.env.MCP_SERVERS_JSON)
  : {};

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
    run_id: process.env.AGENTPLANE_RUN_ID,
    agent_id: process.env.AGENTPLANE_AGENT_ID,
    model: config.model,
    timestamp: new Date().toISOString(),
    session_id: sdkSessionId,
    mcp_server_count: Object.keys(mcpServers).length,
    mcp_errors: ${JSON.stringify(config.mcpErrors)},
  });

  const options = {
    ...config,
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(sdkSessionId ? { resume: sdkSessionId } : {}),
  };

  try {
    for await (const message of query({ prompt, options })) {
      if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
        emit({ type: 'session_info', sdk_session_id: message.session_id });
      }
      if (message.type === 'stream_event') {
        const ev = message.event;
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          console.log(JSON.stringify({ type: 'text_delta', text: ev.delta.text }));
        }
      } else {
        emit(message);
      }
    }
  } catch (err) {
    emit({
      type: 'error',
      error: err.message || String(err),
      code: 'execution_error',
      timestamp: new Date().toISOString(),
    });
  }

  // Upload transcript for detached runs
  if (process.env.AGENTPLANE_PLATFORM_URL && process.env.AGENTPLANE_RUN_TOKEN) {
    try {
      const { readFileSync } = await import('fs');
      const transcript = readFileSync(transcriptPath);
      await fetch(process.env.AGENTPLANE_PLATFORM_URL + '/api/internal/runs/' + process.env.AGENTPLANE_RUN_ID + '/transcript', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + process.env.AGENTPLANE_RUN_TOKEN,
          'Content-Type': 'application/x-ndjson',
        },
        body: transcript,
      });
    } catch (err) {
      console.error('Failed to upload transcript:', err.message);
    }
  }
}

main().catch(err => { console.error('Runner fatal error:', err); process.exit(1); });
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

export async function reconnectSessionSandbox(
  sandboxId: string,
  config: SessionSandboxConfig,
): Promise<SessionSandboxInstance | null> {
  // Step 1: Try to reconnect — if sandbox is gone, return null
  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.get({ sandboxId });
  } catch {
    // Sandbox truly gone — expected "not found" case
    return null;
  }

  // Step 2: Build config — errors here should NOT be silently swallowed
  try {
    const hasMcp = config.mcpServers ? Object.keys(config.mcpServers).length > 0 : false;
    const hasSkills = config.agent.skills.length > 0;
    const hasPluginContent = (config.pluginFiles ?? []).length > 0;

    const baseEnv: Record<string, string> = {
      AGENTPLANE_AGENT_ID: config.agent.id,
      AGENTPLANE_TENANT_ID: config.tenantId,
      AGENTPLANE_PLATFORM_URL: config.platformApiUrl,
      ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
      ANTHROPIC_AUTH_TOKEN: config.aiGatewayApiKey,
      ANTHROPIC_API_KEY: "",
      ENABLE_TOOL_SEARCH: "true",
    };
    if (hasMcp) {
      baseEnv.MCP_SERVERS_JSON = JSON.stringify(config.mcpServers);
    }
    return buildSessionSandboxInstance(sandbox, config, baseEnv, hasMcp, hasSkills, hasPluginContent);
  } catch (err) {
    logger.error("Failed to build session sandbox config after reconnect", {
      sandbox_id: sandboxId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
