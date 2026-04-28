import path from "path";
import { Sandbox, Snapshot, type Command } from "@vercel/sandbox";
import { logger } from "./logger";
import { getEnv } from "./env";
import type { McpServerConfig, CallbackData } from "./mcp";
import { resolveEffectiveRunner } from "./models";
import { prependIdentity } from "./identity";
import type { RunnerType } from "./models";
import { buildVercelAiRunnerScript } from "./runners/vercel-ai-runner";
import { buildVercelAiSessionRunnerScript } from "./runners/vercel-ai-session-runner";

// --- SDK Snapshot Cache ---
// Pre-built snapshot with @anthropic-ai/claude-agent-sdk installed.
// Managed by the refresh-snapshot cron job (runs daily).
// On cold start, the most recent valid snapshot is looked up from the API.
// Falls back to fresh npm install if no snapshot exists.
const SNAPSHOT_MAX_AGE_MS = 25 * 60 * 60 * 1000; // 25 hours (cron runs every 24h, 1h grace)

let sdkSnapshotId: string | null = null;
let sdkSnapshotCreatedAt: number | null = null;

/**
 * Find the most recent valid SDK snapshot from Vercel.
 * Returns the snapshot ID or null if none found / all expired.
 */
async function findSdkSnapshot(): Promise<string | null> {
  // Return cached if fresh
  if (sdkSnapshotId && sdkSnapshotCreatedAt && Date.now() - sdkSnapshotCreatedAt < SNAPSHOT_MAX_AGE_MS) {
    return sdkSnapshotId;
  }

  try {
    const result = await Snapshot.list({ limit: 10 });
    const now = Date.now();
    const existing = result.json.snapshots.find(
      (s: { status: string; createdAt: number }) =>
        s.status === "created" && now - s.createdAt < SNAPSHOT_MAX_AGE_MS,
    );
    if (existing) {
      sdkSnapshotId = existing.id;
      sdkSnapshotCreatedAt = existing.createdAt;
      logger.info("Found SDK snapshot", {
        snapshot_id: existing.id,
        age_hours: ((now - existing.createdAt) / 3600_000).toFixed(1),
      });
      return existing.id;
    }
  } catch (err) {
    logger.warn("Failed to list snapshots", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  sdkSnapshotId = null;
  sdkSnapshotCreatedAt = null;
  return null;
}

/** Invalidate the cached snapshot (e.g. if sandbox creation from it fails). */
function invalidateSdkSnapshot() {
  sdkSnapshotId = null;
  sdkSnapshotCreatedAt = null;
}

/**
 * Create a fresh SDK snapshot. Called by the refresh-snapshot cron job.
 * Returns the new snapshot ID and cleans up old snapshots.
 */
export async function refreshSdkSnapshot(): Promise<{ snapshotId: string; cleaned: number }> {
  logger.info("Creating fresh SDK snapshot");
  const sandbox = await Sandbox.create({
    runtime: "node22",
    resources: { vcpus: 2 },
    timeout: 120_000,
  });

  const installCmd = await sandbox.runCommand({
    cmd: "npm",
    args: ["install", "@anthropic-ai/claude-agent-sdk", "ai", "@ai-sdk/mcp", "@modelcontextprotocol/sdk", "zod", "braintrust"],
  });
  if (installCmd.exitCode !== 0) {
    const stderr = await installCmd.stderr();
    await sandbox.stop();
    throw new Error(`SDK install failed during snapshot creation: ${stderr.slice(0, 500)}`);
  }

  // snapshot() stops the sandbox automatically
  const snapshot = await sandbox.snapshot();
  const newId = snapshot.snapshotId;

  // Update process-level cache
  sdkSnapshotId = newId;
  sdkSnapshotCreatedAt = Date.now();
  logger.info("SDK snapshot created", { snapshot_id: newId });

  // Clean up old snapshots (keep only the new one)
  let cleaned = 0;
  try {
    const result = await Snapshot.list({ limit: 20 });
    for (const s of result.json.snapshots) {
      if (s.id !== newId && s.status === "created") {
        try {
          const old = await Snapshot.get({ snapshotId: s.id });
          await old.delete();
          cleaned++;
          logger.info("Deleted old SDK snapshot", { snapshot_id: s.id });
        } catch {
          // Best-effort cleanup
        }
      }
    }
  } catch (err) {
    logger.warn("Failed to clean up old snapshots", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { snapshotId: newId, cleaned };
}

export interface SandboxConfig {
  agent: {
    id: string;
    name: string;
    description?: string | null;
    soul_md?: string | null;
    identity_md?: string | null;
    style_md?: string | null;
    agents_md?: string | null;
    heartbeat_md?: string | null;
    git_repo_url: string | null;
    git_branch: string;
    model: string;
    runner: RunnerType | null;
    permission_mode: string;
    allowed_tools: string[];
    max_turns: number;
    max_budget_usd: number;
    skills: Array<{ folder: string; files: Array<{ path: string; content: string }> }>;
  };
  tenantId: string;
  /**
   * The session_message id this runner is executing. Both the upload URL
   * (`/api/internal/messages/:messageId/transcript`) and the bound HMAC token
   * key off this value, so a stolen or stale messageId token cannot accept
   * an upload for a different message.
   */
  messageId: string;
  prompt: string;
  platformApiUrl: string;
  /** Bearer token minted via generateMessageToken(messageId). */
  messageToken?: string;
  maxRuntimeSeconds?: number;
  aiGatewayApiKey: string;
  auth?: import("@/lib/tenant-auth").SandboxAuth;
  mcpServers?: Record<string, McpServerConfig>;
  mcpErrors?: string[];
  pluginFiles?: Array<{ path: string; content: string }>;
  /** Additional hostnames to allow in the sandbox network policy (e.g. A2A callback URLs). */
  extraAllowedHostnames?: string[];
  /** AgentCo callback data for MCP bridge injection. */
  callbackData?: CallbackData;
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
  const snapshotId = await findSdkSnapshot();

  if (snapshotId) {
    try {
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
    }
  }

  // No snapshot or snapshot failed — fresh sandbox + npm install
  const sandbox = await Sandbox.create({
    runtime: "node22",
    resources: opts.resources,
    timeout: opts.timeout,
    networkPolicy: opts.networkPolicy,
  });
  await installSdk(sandbox, "fallback");
  return sandbox;
}

/** Install SDKs (Claude Agent SDK + Vercel AI SDK) in a sandbox. */
async function installSdk(sandbox: Sandbox, contextId: string): Promise<void> {
  const installCmd = await sandbox.runCommand({
    cmd: "npm",
    args: ["install", "@anthropic-ai/claude-agent-sdk", "ai", "@ai-sdk/mcp", "@modelcontextprotocol/sdk", "zod", "braintrust"],
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
    message_id: config.messageId,
    agent_id: config.agent.id,
    tenant_id: config.tenantId,
    has_git_source: !!config.agent.git_repo_url,
  });

  // Extract hostnames from custom MCP servers for network policy
  const mcpHostnames = Object.values(config.mcpServers ?? {})
    .filter((s): s is Extract<typeof s, { url: string }> => "url" in s)
    .map((s) => new URL(s.url).hostname);

  const networkPolicy = {
    allow: [
      "ai-gateway.vercel.sh",
      "*.claude.ai",
      "api.anthropic.com",
      "*.composio.dev",
      "*.firecrawl.dev",
      "*.githubusercontent.com",
      "html.duckduckgo.com",
      "api.braintrust.dev",
      "registry.npmjs.org",
      new URL(config.platformApiUrl).hostname,
      ...mcpHostnames,
      ...(config.extraAllowedHostnames ?? []),
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
    await installSdk(sandbox, config.messageId);
  }

  // Build the runner script based on effective runner type
  const effectiveRunner = resolveEffectiveRunner(config.agent.model, config.agent.runner);
  const runnerScript = effectiveRunner === "vercel-ai-sdk"
    ? buildVercelAiRunnerScript(config)
    : buildRunnerScript(config);

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

  // Build AgentCo bridge files if callback data is present
  const bridgeFiles: Array<{ path: string; content: Buffer }> = [];
  if (config.callbackData && config.callbackData.tools.length > 0) {
    bridgeFiles.push(
      { path: "/vercel/sandbox/agentco-bridge.mjs", content: Buffer.from(buildBridgeScript()) },
      { path: "/vercel/sandbox/agentco-tools.json", content: Buffer.from(JSON.stringify(config.callbackData.tools)) },
    );
  }

  // Inject SoulSpec identity files into .soul/ directory
  const soulFiles: Array<{ path: string; content: Buffer }> = [];
  const soulFileMap: Array<[string, string | null | undefined]> = [
    ['.soul/SOUL.md', config.agent.soul_md],
    ['.soul/IDENTITY.md', config.agent.identity_md],
    ['.soul/STYLE.md', config.agent.style_md],
    ['.soul/AGENTS.md', config.agent.agents_md],
    ['.soul/HEARTBEAT.md', config.agent.heartbeat_md],
  ];
  for (const [filePath, content] of soulFileMap) {
    if (content) {
      soulFiles.push({ path: `/vercel/sandbox/${filePath}`, content: Buffer.from(content) });
    }
  }

  // Write runner + skill + plugin + bridge + soul files to sandbox
  await sandbox.writeFiles([
    { path: "/vercel/sandbox/runner.mjs", content: Buffer.from(runnerScript) },
    ...skillFiles,
    ...pluginFiles,
    ...bridgeFiles,
    ...soulFiles,
  ]);

  // Build env vars for the runner command
  const env: Record<string, string> = {
    AGENT_PLANE_MESSAGE_ID: config.messageId,
    // AGENT_PLANE_RUN_ID is preserved as an alias for the runner-internal
    // transcript path naming (transcript-<id>.ndjson), so the in-sandbox
    // template can stay neutral about which name we emit upstream.
    AGENT_PLANE_RUN_ID: config.messageId,
    AGENT_PLANE_AGENT_ID: config.agent.id,
    AGENT_PLANE_TENANT_ID: config.tenantId,
    AGENT_PLANE_PLATFORM_URL: config.platformApiUrl,
  };

  if (config.auth) {
    const { buildSandboxAuthEnv } = await import("@/lib/tenant-auth");
    Object.assign(env, buildSandboxAuthEnv(config.auth));
  } else {
    env.ANTHROPIC_BASE_URL = "https://ai-gateway.vercel.sh";
    env.ANTHROPIC_AUTH_TOKEN = config.aiGatewayApiKey;
    env.ANTHROPIC_API_KEY = "";
    env.AI_GATEWAY_API_KEY = config.aiGatewayApiKey;
  }
  env.ENABLE_TOOL_SEARCH = "true";
  const braintrustKey = getEnv().BRAINTRUST_API_KEY;
  if (braintrustKey) {
    env.BRAINTRUST_API_KEY = braintrustKey;
  }
  if (config.messageToken) {
    env.AGENT_PLANE_MESSAGE_TOKEN = config.messageToken;
  }
  // Build MCP servers config — inject agentco bridge alongside other servers
  const mcpServersForRunner: Record<string, unknown> = { ...config.mcpServers };
  if (config.callbackData && config.callbackData.tools.length > 0) {
    mcpServersForRunner['agentco'] = {
      command: 'node',
      args: ['/vercel/sandbox/agentco-bridge.mjs'],
      env: {
        AGENTCO_CALLBACK_URL: config.callbackData.url,
        AGENTCO_CALLBACK_TOKEN: config.callbackData.token,
      },
    };
    env.AGENTCO_CALLBACK_URL = config.callbackData.url;
    env.AGENTCO_CALLBACK_TOKEN = config.callbackData.token;
  }
  if (Object.keys(mcpServersForRunner).length > 0) {
    env.MCP_SERVERS_JSON = JSON.stringify(mcpServersForRunner);
  }

  // Start the runner in detached mode
  const command = await sandbox.runCommand({
    cmd: "node",
    args: ["runner.mjs"],
    env,
    detached: true,
  });

  logger.info("Sandbox started", {
    message_id: config.messageId,
    sandbox_id: sandbox.sandboxId,
    has_callback_bridge: bridgeFiles.length > 0,
    callback_url: config.callbackData?.url,
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

/**
 * Build the AgentCo callback bridge — a stdio MCP server that translates
 * MCP tools/call into A2A JSON-RPC message/send to AgentCo's callback URL.
 * Reads config from env vars (AGENTCO_CALLBACK_URL, AGENTCO_CALLBACK_TOKEN)
 * and tool schemas from agentco-tools.json.
 */
function buildBridgeScript(): string {
  return `import { createInterface } from 'readline';
import { readFileSync, existsSync } from 'fs';

function log(msg) { process.stderr.write('[agentco-bridge] ' + msg + '\\n'); }

let callbackUrl, callbackToken, tools;
try {
  callbackUrl = process.env.AGENTCO_CALLBACK_URL;
  callbackToken = process.env.AGENTCO_CALLBACK_TOKEN;
  log('Starting. callback_url=' + (callbackUrl || 'MISSING'));

  const toolsPath = '/vercel/sandbox/agentco-tools.json';
  if (!existsSync(toolsPath)) {
    log('ERROR: tools file not found at ' + toolsPath);
    process.exit(1);
  }

  const rawTools = JSON.parse(readFileSync(toolsPath, 'utf-8'));
  tools = rawTools.map(t => {
    const params = t.parameters || {};
    const properties = {};
    const required = [];
    for (const [key, val] of Object.entries(params)) {
      const { required: isReq, ...rest } = val;
      properties[key] = rest;
      if (isReq) required.push(key);
    }
    return {
      name: t.name,
      description: t.description || '',
      inputSchema: {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
    };
  });
  log('Loaded ' + tools.length + ' tools');
} catch (err) {
  log('FATAL init error: ' + (err.message || String(err)));
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, terminal: false });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleToolCall(id, params) {
  const { name, arguments: args } = params;

  const body = {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method: 'message/send',
    params: {
      message: {
        messageId: crypto.randomUUID(),
        role: 'user',
        parts: [
          {
            kind: 'data',
            data: { tool: name, arguments: args || {} },
            mediaType: 'application/json',
          },
        ],
      },
    },
  };

  try {
    const res = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + callbackToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      sendResult(id, {
        content: [{ type: 'text', text: 'AgentCo error (' + res.status + '): ' + text.slice(0, 500) }],
        isError: true,
      });
      return;
    }

    const data = await res.json();

    if (data.error) {
      sendResult(id, {
        content: [{ type: 'text', text: 'AgentCo error: ' + (data.error.message || JSON.stringify(data.error)) }],
        isError: true,
      });
      return;
    }

    // Extract result from A2A response
    const result = data.result;
    let text = '';

    // Try artifacts first (task response)
    if (result?.artifacts) {
      for (const artifact of result.artifacts) {
        for (const part of artifact.parts || []) {
          if (part.kind === 'text' && part.text) text += part.text;
          if (part.kind === 'data' && part.data) {
            text += JSON.stringify(part.data.result ?? part.data, null, 2);
          }
        }
      }
    }

    // Try direct message parts
    if (!text && result?.parts) {
      for (const part of result.parts) {
        if (part.kind === 'text' && part.text) text += part.text;
        if (part.kind === 'data' && part.data) {
          text += JSON.stringify(part.data.result ?? part.data, null, 2);
        }
      }
    }

    // Fallback: stringify the whole result, or report empty
    if (!text) {
      text = result != null ? JSON.stringify(result, null, 2) : '(empty response from AgentCo)';
    }

    sendResult(id, { content: [{ type: 'text', text }] });
  } catch (err) {
    sendResult(id, {
      content: [{ type: 'text', text: 'Bridge error: ' + (err.message || String(err)) }],
      isError: true,
    });
  }
}

rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log('Malformed input: ' + line.slice(0, 100));
    return;
  }

  const { id, method, params } = msg;
  log('Received: ' + method + (id ? ' id=' + id : ''));

  switch (method) {
    case 'initialize':
      sendResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agentco-bridge', version: '1.0.0' },
      });
      break;

    case 'notifications/initialized':
      // No response needed for notifications
      break;

    case 'ping':
      sendResult(id, {});
      break;

    case 'tools/list':
      sendResult(id, { tools });
      break;

    case 'tools/call':
      await handleToolCall(id, params);
      break;

    default:
      if (id) {
        sendError(id, -32601, 'Method not found: ' + method);
      }
      break;
  }
});

rl.on('close', () => process.exit(0));
`;
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

// --- Claude Agent SDK Runner Shared Snippets ---

function claudeSdkPreamble(): string {
  return `
import { writeFileSync, appendFileSync } from 'fs';

// --- Braintrust tracing (optional, must init before SDK import) ---
if (process.env.BRAINTRUST_API_KEY) {
  try {
    const bt = await import('braintrust');
    bt.initLogger({
      projectName: 'AgentPlane',
      apiKey: process.env.BRAINTRUST_API_KEY,
      asyncFlush: true,
    });
  } catch (e) {
    // Braintrust not available or init failed — continue without tracing
  }
}

const { query } = await import('@anthropic-ai/claude-agent-sdk');

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

`;
}

function claudeSdkStreamLoop(): string {
  // Tracks whether the SDK iterator yielded a terminal `result` message. If
  // the iterator ends without one (e.g. Anthropic 5-hour subscription bucket
  // exhausted with overage disabled — the SDK silently exits the iterator
  // instead of throwing), we synthesize an error event so the platform
  // finalizer marks the run failed with a clear cause. Without this, the
  // partial-execution state was being hidden behind a green checkmark.
  return `
    let __gotResult = false;
    let __lastRateLimit = null;
    for await (const message of query({ prompt, options })) {
      if (message.type === 'system' && message.subtype === 'init') {
        if (message.mcp_servers) emit({ type: 'mcp_status', servers: message.mcp_servers });
        if (message.session_id) emit({ type: 'session_info', sdk_session_id: message.session_id });
      }
      if (message.type === 'rate_limit_event') {
        __lastRateLimit = message.rate_limit_info || null;
      }
      if (message.type === 'result') {
        __gotResult = true;
      }
      if (message.type === 'stream_event') {
        const ev = message.event;
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          console.log(JSON.stringify({ type: 'text_delta', text: ev.delta.text }));
        }
      } else if (message.type === 'result' && process.env.AGENT_PLANE_BILLING_SOURCE === 'subscription') {
        emit({ ...message, cost_usd: 0, total_cost_usd: 0 });
      } else {
        emit(message);
      }
    }

    if (!__gotResult) {
      let __code = 'sdk_iterator_truncated';
      let __error = 'Claude Agent SDK iterator ended without emitting a final result event';
      if (__lastRateLimit) {
        const __s = __lastRateLimit.status;
        const __overage = __lastRateLimit.overageStatus;
        if (__s === 'rejected' || (__s === 'allowed_warning' && __overage === 'rejected')) {
          __code = 'rate_limit_exhausted';
          __error = 'Anthropic rate limit reached ('
            + (__lastRateLimit.rateLimitType || 'unknown') + ', overage=' + __overage
            + ', resets at epoch ' + __lastRateLimit.resetsAt + ')';
        }
      }
      emit({
        type: 'error',
        code: __code,
        error: __error,
        timestamp: new Date().toISOString(),
        rate_limit_info: __lastRateLimit,
      });
    }
`;
}

function claudeSdkErrorAndCleanup(): string {
  return `
  } catch (err) {
    emit({
      type: 'error',
      error: err.message || String(err),
      code: 'execution_error',
      timestamp: new Date().toISOString(),
    });
  }

  if (process.env.AGENT_PLANE_PLATFORM_URL && process.env.AGENT_PLANE_MESSAGE_TOKEN) {
    try {
      const { readFileSync } = await import('fs');
      const transcript = readFileSync(transcriptPath);
      await fetch(process.env.AGENT_PLANE_PLATFORM_URL + '/api/internal/messages/' + process.env.AGENT_PLANE_MESSAGE_ID + '/transcript', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + process.env.AGENT_PLANE_MESSAGE_TOKEN,
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

// --- Claude Agent SDK One-Shot Runner ---

function buildRunnerScript(config: SandboxConfig): string {
  const hasSkills = config.agent.skills.length > 0;
  const hasPluginContent = (config.pluginFiles ?? []).length > 0;
  const hasMcp = config.mcpServers && Object.keys(config.mcpServers).length > 0;
  const hasCallback = config.callbackData && config.callbackData.tools.length > 0;
  const isSubscription = config.auth?.isSubscription ?? false;
  const agentConfig = {
    model: config.agent.model.replace(/(\d+)\.(\d+)/g, "$1-$2"),
    permissionMode: config.agent.permission_mode,
    ...(hasMcp || hasCallback ? {} : { allowedTools: config.agent.allowed_tools }),
    maxTurns: config.agent.max_turns,
    ...(!isSubscription ? { maxBudgetUsd: config.agent.max_budget_usd } : {}),
    ...((hasSkills || hasPluginContent) ? { settingSources: ["project"] } : {}),
  };

  const effectivePrompt = prependIdentity(config.prompt, config.agent);

  return `
${claudeSdkPreamble()}
const config = ${JSON.stringify(agentConfig)};
const prompt = ${JSON.stringify(effectivePrompt)};

async function main() {
  emit({
    type: 'run_started',
    message_id: process.env.AGENT_PLANE_MESSAGE_ID,
    agent_id: process.env.AGENT_PLANE_AGENT_ID,
    model: config.model,
    timestamp: new Date().toISOString(),
    mcp_server_count: Object.keys(mcpServers).length,
    mcp_server_names: Object.keys(mcpServers),
    mcp_errors: ${JSON.stringify(config.mcpErrors || [])},
  });

  try {
    const options = {
      ...config,
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      includePartialMessages: true,
    };

${claudeSdkStreamLoop()}
${claudeSdkErrorAndCleanup()}
`;
}

// --- Session Sandbox ---

export interface SessionSandboxConfig {
  agent: SandboxConfig["agent"];
  tenantId: string;
  sessionId: string;
  platformApiUrl: string;
  aiGatewayApiKey: string;
  auth?: import("@/lib/tenant-auth").SandboxAuth;
  mcpServers?: Record<string, McpServerConfig>;
  mcpErrors?: string[];
  pluginFiles?: Array<{ path: string; content: string }>;
  maxIdleTimeoutMs?: number; // default 30 min
  /** AgentCo callback data for MCP bridge injection. */
  callbackData?: CallbackData;
}

export interface SessionSandboxInstance extends SandboxInstance {
  sandboxRef: Sandbox;
  runMessage(opts: {
    prompt: string;
    sdkSessionId: string | null;
    /** Per-message id; runner emits this back via run_started.message_id. */
    messageId: string;
    /** Bearer token bound to this messageId; runner uses it for transcript upload. */
    messageToken: string;
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

  const mcpHostnames = Object.values(config.mcpServers ?? {})
    .filter((s): s is Extract<typeof s, { url: string }> => "url" in s)
    .map((s) => new URL(s.url).hostname);

  // Allow callback URL hostname for AgentCo bridge
  const callbackHostnames = config.callbackData?.url
    ? [new URL(config.callbackData.url).hostname]
    : [];

  const timeoutMs = config.maxIdleTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;

  const authHostnames = config.auth?.extraAllowedHostnames ?? [];
  logger.info("Creating session sandbox network policy", {
    session_id: config.sessionId,
    auth_hostnames: authHostnames,
    is_subscription: config.auth?.isSubscription ?? false,
    base_url: config.auth?.anthropicBaseUrl ?? "none",
  });

  const networkPolicy = {
    allow: [
      "ai-gateway.vercel.sh",
      "*.claude.ai",
      "api.anthropic.com",
      "*.composio.dev",
      "*.firecrawl.dev",
      "*.githubusercontent.com",
      "html.duckduckgo.com",
      "api.braintrust.dev",
      "registry.npmjs.org",
      new URL(config.platformApiUrl).hostname,
      ...mcpHostnames,
      ...callbackHostnames,
      ...authHostnames,
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

  logger.info("createSessionSandbox: callback data", {
    session_id: config.sessionId,
    has_callback: !!config.callbackData,
    tool_count: config.callbackData?.tools?.length ?? 0,
    url: config.callbackData?.url ?? "none",
  });

  const sandboxRoot = "/vercel/sandbox";
  const pluginFiles = (config.pluginFiles ?? []).map((f) => {
    const resolved = path.resolve(sandboxRoot, f.path);
    if (!resolved.startsWith(sandboxRoot + "/")) {
      throw new Error(`Plugin path escapes sandbox root: ${f.path}`);
    }
    return { path: resolved, content: Buffer.from(f.content) };
  });

  // Build AgentCo bridge files if callback data is present
  const bridgeFiles: Array<{ path: string; content: Buffer }> = [];
  if (config.callbackData && config.callbackData.tools.length > 0) {
    bridgeFiles.push(
      { path: "/vercel/sandbox/agentco-bridge.mjs", content: Buffer.from(buildBridgeScript()) },
      { path: "/vercel/sandbox/agentco-tools.json", content: Buffer.from(JSON.stringify(config.callbackData.tools)) },
    );
  }

  // Inject SoulSpec identity files into .soul/ directory.
  //
  // OPTIMIZATION B — identity files are written ONLY on cold create (here).
  // The reconnect path (`reconnectSessionSandbox` below) intentionally
  // skips this re-write because the files already live on the sandbox's
  // disk from the original cold create — the sandbox stays warm across
  // back-to-back messages and the .soul/ contents don't change mid-session.
  //
  // We accept always-injecting on cold start (size is bounded — at most 5
  // small markdown files + future USER_TEMPLATE / examples). The real hot
  // path is reconnect, which already pays zero cost for identity. Baking
  // identity into the SDK snapshot is a future optimization (would require
  // per-agent snapshots, deferred — too invasive for the win).
  const soulFiles: Array<{ path: string; content: Buffer }> = [];
  const soulFileMap: Array<[string, string | null | undefined]> = [
    ['.soul/SOUL.md', config.agent.soul_md],
    ['.soul/IDENTITY.md', config.agent.identity_md],
    ['.soul/STYLE.md', config.agent.style_md],
    ['.soul/AGENTS.md', config.agent.agents_md],
    ['.soul/HEARTBEAT.md', config.agent.heartbeat_md],
  ];
  for (const [filePath, content] of soulFileMap) {
    if (content) {
      soulFiles.push({ path: `/vercel/sandbox/${filePath}`, content: Buffer.from(content) });
    }
  }

  // Write skill + plugin + bridge + soul files (no runner yet)
  const allFiles = [...skillFiles, ...pluginFiles, ...bridgeFiles, ...soulFiles];
  if (allFiles.length > 0) {
    await sandbox.writeFiles(allFiles);
  }

  logger.info("Session sandbox created", {
    session_id: config.sessionId,
    sandbox_id: sandbox.sandboxId,
  });

  const hasCallbackBridge = !!(config.callbackData && config.callbackData.tools.length > 0);
  const hasMcp = (config.mcpServers && Object.keys(config.mcpServers).length > 0) || hasCallbackBridge;
  const hasSkills = config.agent.skills.length > 0;
  const hasPluginContent = (config.pluginFiles ?? []).length > 0;

  // Build base env for all messages
  const baseEnv: Record<string, string> = {
    AGENT_PLANE_AGENT_ID: config.agent.id,
    AGENT_PLANE_TENANT_ID: config.tenantId,
    AGENT_PLANE_PLATFORM_URL: config.platformApiUrl,
    ENABLE_TOOL_SEARCH: "true",
  };
  const braintrustKey = getEnv().BRAINTRUST_API_KEY;
  if (braintrustKey) {
    baseEnv.BRAINTRUST_API_KEY = braintrustKey;
  }
  if (config.auth) {
    const { buildSandboxAuthEnv } = await import("@/lib/tenant-auth");
    Object.assign(baseEnv, buildSandboxAuthEnv(config.auth));
  } else {
    baseEnv.ANTHROPIC_BASE_URL = "https://ai-gateway.vercel.sh";
    baseEnv.ANTHROPIC_AUTH_TOKEN = config.aiGatewayApiKey;
    baseEnv.ANTHROPIC_API_KEY = "";
    baseEnv.AI_GATEWAY_API_KEY = config.aiGatewayApiKey;
  }

  // Build MCP servers config — inject agentco bridge alongside other servers
  const mcpServersForSession: Record<string, unknown> = { ...config.mcpServers };
  if (config.callbackData && config.callbackData.tools.length > 0) {
    mcpServersForSession['agentco'] = {
      command: 'node',
      args: ['/vercel/sandbox/agentco-bridge.mjs'],
      env: {
        AGENTCO_CALLBACK_URL: config.callbackData.url,
        AGENTCO_CALLBACK_TOKEN: config.callbackData.token,
      },
    };
    baseEnv.AGENTCO_CALLBACK_URL = config.callbackData.url;
    baseEnv.AGENTCO_CALLBACK_TOKEN = config.callbackData.token;
  }
  if (Object.keys(mcpServersForSession).length > 0) {
    baseEnv.MCP_SERVERS_JSON = JSON.stringify(mcpServersForSession);
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
      // Try the canonical path first.
      try {
        const buf = await sandbox.readFileToBuffer({ path: `${SESSION_FILE_DIR}/${sdkSessionId}.jsonl` });
        if (buf && buf.length > 0) return buf;
      } catch {
        // fall through to discovery
      }
      // Fallback: discover via `find` — SDK versions / cwd encodings vary
      // (e.g. ~/.claude/projects/-vercel-sandbox/<sid>.jsonl). Cheaper than
      // losing the session backup on every message.
      try {
        const find = await sandbox.runCommand({
          cmd: "sh",
          args: [
            "-c",
            `find /vercel/sandbox/.claude $HOME/.claude /root/.claude -name '${sdkSessionId}.jsonl' -type f -print -quit 2>/dev/null`,
          ],
        });
        const stdout = (await find.stdout()).trim();
        if (find.exitCode === 0 && stdout) {
          const buf = await sandbox.readFileToBuffer({ path: stdout });
          if (buf && buf.length > 0) {
            logger.info("Session file located via fallback discovery", {
              sandbox_id: sandbox.sandboxId,
              sdk_session_id: sdkSessionId,
              discovered_path: stdout,
            });
            return buf;
          }
        }
      } catch (err) {
        logger.warn("Session file discovery fallback failed", {
          sandbox_id: sandbox.sandboxId,
          sdk_session_id: sdkSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return null;
    },
    updateMcpConfig: (servers, errors) => {
      if (Object.keys(servers).length > 0) {
        baseEnv.MCP_SERVERS_JSON = JSON.stringify(servers);
        currentHasMcp = true;
      }
      currentMcpErrors = errors;
    },
    runMessage: async (opts) => {
      const effectiveRunner = resolveEffectiveRunner(config.agent.model, config.agent.runner);
      const runnerScript = effectiveRunner === "vercel-ai-sdk"
        ? buildVercelAiSessionRunnerScript({
            agent: config.agent,
            prompt: opts.prompt,
            maxTurns: opts.maxTurns,
            maxBudgetUsd: opts.maxBudgetUsd,
            hasSkillsOrPlugins: hasSkills || hasPluginContent,
            hasMcp: currentHasMcp,
            mcpErrors: currentMcpErrors,
            pluginFiles: config.pluginFiles,
          })
        : buildSessionRunnerScript({
            agent: config.agent,
            prompt: opts.prompt,
            sdkSessionId: opts.sdkSessionId,
            maxTurns: opts.maxTurns,
            maxBudgetUsd: opts.maxBudgetUsd,
            isSubscription: config.auth?.isSubscription ?? false,
            hasSkillsOrPlugins: hasSkills || hasPluginContent,
            hasMcp: currentHasMcp,
            mcpErrors: currentMcpErrors,
          });

      const runnerFilename = `runner-${opts.messageId}.mjs`;
      await sandbox.writeFiles([
        { path: `/vercel/sandbox/${runnerFilename}`, content: Buffer.from(runnerScript) },
      ]);

      const env = {
        ...baseEnv,
        AGENT_PLANE_MESSAGE_ID: opts.messageId,
        // Alias kept for the in-sandbox transcript-<id>.ndjson convention.
        AGENT_PLANE_RUN_ID: opts.messageId,
        AGENT_PLANE_MESSAGE_TOKEN: opts.messageToken,
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
  isSubscription: boolean;
  hasSkillsOrPlugins: boolean;
  hasMcp: boolean;
  mcpErrors: string[];
}

function buildSessionRunnerScript(config: SessionRunnerConfig): string {
  const agentConfig = {
    model: config.agent.model.replace(/(\d+)\.(\d+)/g, "$1-$2"),
    permissionMode: config.agent.permission_mode,
    ...(config.hasMcp ? {} : { allowedTools: config.agent.allowed_tools }),
    maxTurns: config.maxTurns,
    ...(!config.isSubscription ? { maxBudgetUsd: config.maxBudgetUsd } : {}),
    ...(config.hasSkillsOrPlugins ? { settingSources: ["project"] } : {}),
    includePartialMessages: true,
  };

  const sessionEffectivePrompt = prependIdentity(config.prompt, config.agent);

  return `
${claudeSdkPreamble()}
const config = ${JSON.stringify(agentConfig)};
const prompt = ${JSON.stringify(sessionEffectivePrompt)};
const sdkSessionId = ${JSON.stringify(config.sdkSessionId)};

async function main() {
  emit({
    type: 'run_started',
    message_id: process.env.AGENT_PLANE_MESSAGE_ID,
    agent_id: process.env.AGENT_PLANE_AGENT_ID,
    model: config.model,
    timestamp: new Date().toISOString(),
    sdk_session_id: sdkSessionId,
    mcp_server_count: Object.keys(mcpServers).length,
    mcp_errors: ${JSON.stringify(config.mcpErrors)},
  });

  try {
    const options = {
      ...config,
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      ...(sdkSessionId ? { resume: sdkSessionId } : {}),
    };

${claudeSdkStreamLoop()}
${claudeSdkErrorAndCleanup()}
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

/**
 * Read-only reconnect that exposes just enough of SessionSandboxInstance to
 * back up the SDK session file. Used by the internal transcript route, which
 * has no agent/auth/MCP context — it just needs to pull the session JSONL
 * out of the still-running sandbox after the runner subprocess exits.
 *
 * The returned instance throws on any non-read methods so misuse fails loudly.
 */
export async function reconnectSessionSandboxForBackup(
  sandboxId: string,
): Promise<SessionSandboxInstance | null> {
  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.get({ sandboxId });
  } catch {
    return null;
  }
  const notSupported = () => {
    throw new Error("reconnectSessionSandboxForBackup: write/run methods not available on read-only handle");
  };
  return {
    id: sandbox.sandboxId,
    sandboxRef: sandbox,
    stop: () => sandbox.stop(),
    logs: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: "" }) }) }),
    extendTimeout: async (ms: number) => {
      try { await sandbox.extendTimeout(ms); } catch { /* best effort */ }
    },
    runMessage: notSupported,
    writeSessionFile: notSupported,
    updateMcpConfig: notSupported,
    readSessionFile: async (sdkSessionId: string) => {
      try {
        const buf = await sandbox.readFileToBuffer({
          path: `/vercel/sandbox/.claude/projects/vercel/sandbox/${sdkSessionId}.jsonl`,
        });
        if (buf && buf.length > 0) return buf;
      } catch {
        // fall through to discovery
      }
      try {
        const find = await sandbox.runCommand({
          cmd: "sh",
          args: [
            "-c",
            `find /vercel/sandbox/.claude $HOME/.claude /root/.claude -name '${sdkSessionId}.jsonl' -type f -print -quit 2>/dev/null`,
          ],
        });
        const stdout = (await find.stdout()).trim();
        if (find.exitCode === 0 && stdout) {
          const buf = await sandbox.readFileToBuffer({ path: stdout });
          if (buf && buf.length > 0) return buf;
        }
      } catch {
        /* swallow — caller handles null */
      }
      return null;
    },
  };
}

export async function reconnectSessionSandbox(
  sandboxId: string,
  config: SessionSandboxConfig,
): Promise<SessionSandboxInstance | null> {
  // OPTIMIZATION B — by design this path does NOT re-inject skills, plugins,
  // bridge files, or .soul/ identity files. They were all written by
  // `createSessionSandbox` on the original cold create and persist on the
  // sandbox's disk for the lifetime of the sandbox (sessions don't mutate
  // identity mid-session). The dispatcher (`runMessageStream`) sets
  // `skipPluginRefresh` when the previous MCP refresh is still fresh, which
  // mirrors this — only the MCP tokens are rotated on reconnect via
  // `updateMcpConfig` on the returned handle.
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
      AGENT_PLANE_AGENT_ID: config.agent.id,
      AGENT_PLANE_TENANT_ID: config.tenantId,
      AGENT_PLANE_PLATFORM_URL: config.platformApiUrl,
      ENABLE_TOOL_SEARCH: "true",
    };
    if (config.auth) {
      const { buildSandboxAuthEnv } = await import("@/lib/tenant-auth");
      Object.assign(baseEnv, buildSandboxAuthEnv(config.auth));
    } else {
      baseEnv.ANTHROPIC_BASE_URL = "https://ai-gateway.vercel.sh";
      baseEnv.ANTHROPIC_AUTH_TOKEN = config.aiGatewayApiKey;
      baseEnv.ANTHROPIC_API_KEY = "";
      baseEnv.AI_GATEWAY_API_KEY = config.aiGatewayApiKey;
    }
    // Build MCP servers — inject agentco bridge alongside other servers
    const mcpServersForReconnect: Record<string, unknown> = { ...config.mcpServers };
    if (config.callbackData && config.callbackData.tools.length > 0) {
      mcpServersForReconnect['agentco'] = {
        command: 'node',
        args: ['/vercel/sandbox/agentco-bridge.mjs'],
        env: {
          AGENTCO_CALLBACK_URL: config.callbackData.url,
          AGENTCO_CALLBACK_TOKEN: config.callbackData.token,
        },
      };
      baseEnv.AGENTCO_CALLBACK_URL = config.callbackData.url;
      baseEnv.AGENTCO_CALLBACK_TOKEN = config.callbackData.token;
    }
    if (Object.keys(mcpServersForReconnect).length > 0) {
      baseEnv.MCP_SERVERS_JSON = JSON.stringify(mcpServersForReconnect);
    }
    return buildSessionSandboxInstance(sandbox, config, baseEnv, hasMcp || !!config.callbackData, hasSkills, hasPluginContent);
  } catch (err) {
    logger.error("Failed to build session sandbox config after reconnect", {
      sandbox_id: sandboxId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
