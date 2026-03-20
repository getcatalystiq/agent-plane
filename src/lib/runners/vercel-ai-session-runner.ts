/**
 * Vercel AI SDK session runner script builder.
 *
 * Generates a per-message ES module for sessions using the Vercel AI SDK.
 * Manages conversation history via session-history.json instead of
 * Claude Agent SDK's resume feature.
 *
 * Note: The sandbox__bash tool uses execSync deliberately — this runs inside
 * an isolated Vercel Sandbox with network restrictions. The sandbox boundary
 * provides security, not the exec method.
 */
import type { SandboxConfig } from "../sandbox";
import { buildSkillIndex } from "./vercel-ai-runner";

interface SessionRunnerConfig {
  agent: SandboxConfig["agent"];
  prompt: string;
  maxTurns: number;
  maxBudgetUsd: number;
  hasSkillsOrPlugins: boolean;
  hasMcp: boolean;
  mcpErrors: string[];
  pluginFiles?: Array<{ path: string; content: string }>;
}

export function buildVercelAiSessionRunnerScript(config: SessionRunnerConfig): string {
  const systemPromptParts: string[] = [];

  if (config.agent.description) {
    systemPromptParts.push(config.agent.description);
  }

  const skillIndex = buildSkillIndex(config.agent.skills, config.pluginFiles);
  if (skillIndex) {
    systemPromptParts.push(skillIndex);
  }

  const systemPrompt = systemPromptParts.join("\n\n");
  const mcpErrors = config.mcpErrors || [];

  // The returned string is an ES module that runs inside the sandbox.
  // execSync is used intentionally for the bash tool — security is provided
  // by the Vercel Sandbox boundary (network allowlist, isolated filesystem).
  return `
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { execSync } from 'child_process';

const modelId = ${JSON.stringify(config.agent.model)};
const prompt = ${JSON.stringify(config.prompt)};
const runId = process.env.AGENT_PLANE_RUN_ID;
const platformUrl = process.env.AGENT_PLANE_PLATFORM_URL;
const runToken = process.env.AGENT_PLANE_RUN_TOKEN;
const maxTurns = ${config.maxTurns || 10};
const systemPrompt = ${JSON.stringify(systemPrompt)};

// --- Per-run transcript ---
const transcriptPath = '/vercel/sandbox/transcript-' + runId + '.ndjson';
writeFileSync(transcriptPath, '');

function emit(event) {
  const line = JSON.stringify(event);
  console.log(line);
  appendFileSync(transcriptPath, line + '\\n');
}

// --- Session history management ---
const HISTORY_PATH = '/vercel/sandbox/session-history.json';
const MAX_TOOL_RESULT_SIZE = 50_000;

function loadHistory() {
  if (!existsSync(HISTORY_PATH)) {
    return { runner: 'vercel-ai-sdk', messages: [], metadata: { model: modelId, totalTokens: 0, turnCount: 0 } };
  }
  try {
    return JSON.parse(readFileSync(HISTORY_PATH, 'utf-8'));
  } catch {
    return { runner: 'vercel-ai-sdk', messages: [], metadata: { model: modelId, totalTokens: 0, turnCount: 0 } };
  }
}

function saveHistory(history) {
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

function truncateToolResult(result) {
  if (typeof result === 'string' && result.length > MAX_TOOL_RESULT_SIZE) {
    return result.slice(0, MAX_TOOL_RESULT_SIZE) + '\\n... (truncated)';
  }
  return result;
}

// --- Workspace-restricted tools ---
const WORKSPACE = '/vercel/sandbox/workspace';
mkdirSync(WORKSPACE, { recursive: true });

function validatePath(rawPath) {
  const resolved = resolve(rawPath);
  if (!resolved.startsWith(WORKSPACE + '/') && resolved !== WORKSPACE) {
    throw new Error('Path outside allowed workspace: ' + rawPath);
  }
  return resolved;
}

const { z } = await import('zod');

const builtinTools = {
  sandbox__read_file: {
    description: 'Read a file from the workspace',
    parameters: z.object({ path: z.string() }),
    execute: async ({ path: p }) => {
      try { return readFileSync(validatePath(p), 'utf-8'); }
      catch (e) { return 'Error: ' + e.message; }
    }
  },
  sandbox__write_file: {
    description: 'Write content to a file in the workspace',
    parameters: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path: p, content }) => {
      const resolved = validatePath(p);
      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, content);
      return 'File written: ' + p;
    }
  },
  sandbox__list_files: {
    description: 'List files in a workspace directory',
    parameters: z.object({ path: z.string() }),
    execute: async ({ path: p }) => {
      try { return readdirSync(validatePath(p), { recursive: true }).join('\\n'); }
      catch (e) { return 'Error: ' + e.message; }
    }
  },
  sandbox__bash: {
    description: 'Execute a shell command in the workspace directory',
    parameters: z.object({ command: z.string() }),
    execute: async ({ command }) => {
      try {
        return execSync(command, { cwd: WORKSPACE, timeout: 30000, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
      } catch (e) {
        return 'Error (exit ' + (e.status || '?') + '): ' + (e.stderr || e.message);
      }
    }
  },
  sandbox__web_fetch: {
    description: 'Fetch a URL (HTTPS only) and return its text content',
    parameters: z.object({ url: z.string() }),
    execute: async ({ url }) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return 'Error: only HTTPS URLs allowed';
        const host = parsed.hostname;
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1'
            || host.startsWith('10.') || host.startsWith('192.168.')
            || /^172\\.(1[6-9]|2[0-9]|3[01])\\./.test(host)
            || host.startsWith('169.254.')) {
          return 'Error: private/internal URLs not allowed';
        }
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 15000);
        const res = await fetch(url, { signal: controller.signal });
        const text = await res.text();
        return text.slice(0, 1_000_000);
      } catch (e) {
        return 'Error: ' + e.message;
      }
    }
  },
};

// --- Dynamic imports (catchable by main's error handler) ---
const { createMCPClient } = await import('@ai-sdk/mcp');

// --- MCP tools ---
const mcpServersJson = process.env.MCP_SERVERS_JSON;
const mcpClients = [];
let mcpTools = {};

if (mcpServersJson) {
  const servers = JSON.parse(mcpServersJson);
  const entries = Object.entries(servers);
  const results = await Promise.allSettled(
    entries.map(async ([name, cfg]) => {
      let transport;
      if (cfg.command) {
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
        transport = new StdioClientTransport({ command: cfg.command, args: cfg.args || [] });
      } else if (cfg.url) {
        transport = { type: 'http', url: cfg.url, headers: cfg.headers || {} };
      } else {
        throw new Error('MCP server ' + name + ' has no url or command');
      }
      const client = await createMCPClient({ transport });
      mcpClients.push(client);
      const t = await client.tools();
      for (const toolName of Object.keys(t)) {
        if (builtinTools[toolName]) {
          emit({ type: 'mcp_error', server: name, error: 'Tool name collision: ' + toolName });
          delete t[toolName];
        }
      }
      return t;
    })
  );
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      mcpTools = { ...mcpTools, ...results[i].value };
    } else {
      emit({ type: 'mcp_error', server: entries[i][0], error: results[i].reason?.message || 'Connection failed' });
    }
  }
}

// --- Main execution ---
async function main() {
  const { streamText, stopWhen, stepCountIs, createGateway } = await import('ai');
  const gateway = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY ?? '' });
  const model = gateway(modelId);

  const history = loadHistory();
  history.messages.push({ role: 'user', content: prompt });

  emit({
    type: 'run_started',
    run_id: runId,
    agent_id: process.env.AGENT_PLANE_AGENT_ID,
    model: modelId,
    timestamp: new Date().toISOString(),
    mcp_server_count: Object.keys(mcpTools).length,
    mcp_errors: ${JSON.stringify(mcpErrors)},
  });

  const allTools = { ...builtinTools, ...mcpTools };
  const startTime = Date.now();

  try {
    const result = await streamText({
      model,
      system: systemPrompt || undefined,
      messages: history.messages,
      tools: allTools,
      stopWhen: stepCountIs(maxTurns),
      onStepFinish: ({ toolCalls, toolResults }) => {
        if (toolCalls) {
          for (const tc of toolCalls) {
            emit({ type: 'tool_use', tool: tc.toolName, input: tc.args, tool_use_id: tc.toolCallId });
          }
        }
        if (toolResults) {
          for (const tr of toolResults) {
            emit({ type: 'tool_result', tool_use_id: tr.toolCallId, result: truncateToolResult(tr.result) });
          }
        }
      },
    });

    for await (const chunk of result.fullStream) {
      if (chunk.type === 'text-delta') {
        console.log(JSON.stringify({ type: 'text_delta', text: chunk.textDelta }));
      }
    }

    // Append assistant response to history
    const responseMessages = await result.response;
    if (responseMessages?.messages) {
      history.messages.push(...responseMessages.messages);
    }

    const totalUsage = await result.totalUsage;
    const steps = await result.steps;
    const durationMs = Date.now() - startTime;

    history.metadata.totalTokens += (totalUsage?.inputTokens || 0) + (totalUsage?.outputTokens || 0);
    history.metadata.turnCount++;
    saveHistory(history);

    let generationId = null;
    try { generationId = responseMessages?.id || null; } catch {}

    emit({
      type: 'result',
      subtype: 'success',
      total_cost_usd: null,
      num_turns: steps?.length || 0,
      duration_ms: durationMs,
      usage: {
        input_tokens: totalUsage?.inputTokens || 0,
        output_tokens: totalUsage?.outputTokens || 0,
      },
      model: modelId,
      runner: 'vercel-ai-sdk',
      generation_id: generationId,
    });
  } catch (error) {
    emit({ type: 'error', code: 'execution_error', error: error.message });
  } finally {
    for (const client of mcpClients) {
      try { await client.close(); } catch {}
    }
    if (platformUrl && runToken) {
      try {
        const transcript = readFileSync(transcriptPath, 'utf-8');
        await fetch(platformUrl + '/api/internal/runs/' + runId + '/transcript', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + runToken, 'Content-Type': 'application/x-ndjson' },
          body: transcript,
        });
      } catch {}
    }
  }
}

main().catch(e => {
  emit({ type: 'error', code: 'runner_crash', error: e.message });
  process.exit(1);
});
`;
}
