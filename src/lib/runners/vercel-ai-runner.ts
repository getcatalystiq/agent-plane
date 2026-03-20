/**
 * Vercel AI SDK runner script builder.
 *
 * Generates an ES module string that runs inside a Vercel Sandbox.
 * Uses Vercel AI SDK's streamText() with tool support for non-Claude models
 * (and optionally Claude models when the user opts in).
 *
 * Events are normalized to the same NDJSON format as the Claude Agent SDK runner.
 *
 * Note: The sandbox__bash tool uses execSync deliberately — this runs inside
 * an isolated Vercel Sandbox with network restrictions. The sandbox boundary
 * provides security, not the exec method.
 */
import type { SandboxConfig } from "../sandbox";

/**
 * Build a system prompt that includes a skill index for on-demand reading.
 * Skills are injected as files into the workspace; the system prompt lists
 * their names so the agent can read them with sandbox__read_file when needed.
 */
export function buildSkillIndex(
  skills: SandboxConfig["agent"]["skills"],
  pluginFiles?: Array<{ path: string; content: string }>,
): string {
  const lines: string[] = [];

  if (skills.length > 0) {
    lines.push("## Available Skills");
    lines.push("Read these files with sandbox__read_file when relevant:");
    for (const skill of skills) {
      for (const file of skill.files) {
        lines.push(`- /vercel/sandbox/workspace/.skills/${skill.folder}/${file.path}`);
      }
    }
  }

  if (pluginFiles && pluginFiles.length > 0) {
    lines.push("## Available Plugin Files");
    lines.push("Read these files with sandbox__read_file when relevant:");
    for (const f of pluginFiles) {
      lines.push(`- /vercel/sandbox/workspace/${f.path}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : "";
}

export function buildVercelAiRunnerScript(config: SandboxConfig): string {
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
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { execSync } from 'child_process';

const modelId = ${JSON.stringify(config.agent.model)};
const prompt = ${JSON.stringify(config.prompt)};
const runId = process.env.AGENT_PLANE_RUN_ID;
const platformUrl = process.env.AGENT_PLANE_PLATFORM_URL;
const runToken = process.env.AGENT_PLANE_RUN_TOKEN;
const maxTurns = ${config.agent.max_turns || 10};
const systemPrompt = ${JSON.stringify(systemPrompt)};

// --- Per-run transcript (session concurrency safe) ---
const transcriptPath = '/vercel/sandbox/transcript-' + runId + '.ndjson';
writeFileSync(transcriptPath, '');

function emit(event) {
  const line = JSON.stringify(event);
  console.log(line);
  appendFileSync(transcriptPath, line + '\\n');
}

// --- Workspace-restricted file system tools ---
const WORKSPACE = '/vercel/sandbox/workspace';
mkdirSync(WORKSPACE, { recursive: true });

function validatePath(rawPath) {
  const resolved = resolve(rawPath);
  if (!resolved.startsWith(WORKSPACE + '/') && resolved !== WORKSPACE) {
    throw new Error('Path outside allowed workspace: ' + rawPath);
  }
  return resolved;
}

// --- Tool definitions (Zod schemas via AI SDK) ---
const { z } = await import('zod');

const builtinTools = {
  sandbox__read_file: {
    description: 'Read a file from the workspace',
    parameters: z.object({ path: z.string().describe('Absolute path to file') }),
    execute: async ({ path: p }) => {
      try { return readFileSync(validatePath(p), 'utf-8'); }
      catch (e) { return 'Error: ' + e.message; }
    }
  },
  sandbox__write_file: {
    description: 'Write content to a file in the workspace',
    parameters: z.object({
      path: z.string().describe('Absolute path to file'),
      content: z.string().describe('File content'),
    }),
    execute: async ({ path: p, content }) => {
      const resolved = validatePath(p);
      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, content);
      return 'File written: ' + p;
    }
  },
  sandbox__list_files: {
    description: 'List files in a workspace directory',
    parameters: z.object({ path: z.string().describe('Absolute path to directory') }),
    execute: async ({ path: p }) => {
      try { return readdirSync(validatePath(p), { recursive: true }).join('\\n'); }
      catch (e) { return 'Error: ' + e.message; }
    }
  },
  sandbox__bash: {
    description: 'Execute a shell command in the workspace directory',
    parameters: z.object({ command: z.string().describe('Shell command to execute') }),
    execute: async ({ command }) => {
      try {
        return execSync(command, {
          cwd: WORKSPACE,
          timeout: 30000,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
        });
      } catch (e) {
        return 'Error (exit ' + (e.status || '?') + '): ' + (e.stderr || e.message);
      }
    }
  },
  sandbox__web_fetch: {
    description: 'Fetch a URL (HTTPS only) and return its text content',
    parameters: z.object({ url: z.string().describe('HTTPS URL to fetch') }),
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
  sandbox__complete_task: {
    description: 'Call this when you have completed the task. Provide the final result summary.',
    parameters: z.object({ result: z.string().describe('Final result summary') }),
    execute: async ({ result }) => {
      emit({ type: 'assistant', content: [{ type: 'text', text: result }] });
      return 'Task marked complete.';
    }
  },
};

// --- Dynamic imports (catchable by main's error handler) ---
const { createMCPClient } = await import('@ai-sdk/mcp');

// --- MCP tools (parallel initialization) ---
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
        // Stdio transport (AgentCo bridge)
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
        transport = new StdioClientTransport({ command: cfg.command, args: cfg.args || [] });
      } else if (cfg.url) {
        // HTTP Streamable transport (recommended for production MCP servers)
        transport = { type: 'http', url: cfg.url, headers: cfg.headers || {} };
      } else {
        throw new Error('MCP server ' + name + ' has no url or command');
      }

      const client = await createMCPClient({ transport });
      mcpClients.push(client);
      const t = await client.tools();

      // Detect namespace collisions with built-in tools
      for (const toolName of Object.keys(t)) {
        if (builtinTools[toolName]) {
          emit({ type: 'mcp_error', server: name, error: 'Tool name collision: ' + toolName + ' (skipped)' });
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

  emit({
    type: 'run_started',
    run_id: runId,
    agent_id: process.env.AGENT_PLANE_AGENT_ID,
    model: modelId,
    timestamp: new Date().toISOString(),
    mcp_server_count: Object.keys(mcpTools).length,
    mcp_server_names: Object.keys(mcpTools),
    mcp_errors: ${JSON.stringify(mcpErrors)},
  });

  const allTools = { ...builtinTools, ...mcpTools };
  const startTime = Date.now();

  try {
    const result = await streamText({
      model,
      system: systemPrompt || undefined,
      prompt,
      tools: allTools,
      stopWhen: stepCountIs(maxTurns),
      onStepFinish: ({ toolCalls, toolResults }) => {
        // Single emission site for tool events (NOT duplicated in fullStream)
        if (toolCalls) {
          for (const tc of toolCalls) {
            emit({ type: 'tool_use', tool: tc.toolName, input: tc.args, tool_use_id: tc.toolCallId });
          }
        }
        if (toolResults) {
          for (const tr of toolResults) {
            emit({ type: 'tool_result', tool_use_id: tr.toolCallId, result: tr.result });
          }
        }
      },
    });

    // Stream text deltas ONLY — tool events come from onStepFinish
    let fullText = '';
    for await (const chunk of result.fullStream) {
      if (chunk.type === 'text-delta') {
        fullText += chunk.textDelta;
        // text_delta: streamed to stdout only, NOT written to transcript
        console.log(JSON.stringify({ type: 'text_delta', text: chunk.textDelta }));
      }
    }

    // Emit assistant event with full text (mirrors Claude SDK runner format)
    if (fullText) {
      emit({ type: 'assistant', message: { content: [{ type: 'text', text: fullText }] } });
    }

    const totalUsage = await result.totalUsage;
    const steps = await result.steps;
    const durationMs = Date.now() - startTime;

    // Capture generation ID for cost lookup (AI Gateway returns it in response)
    let generationId = null;
    try {
      const response = await result.response;
      generationId = response?.id || null;
    } catch {}

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
    const msg = error instanceof Error ? error.message : String(error);
    // Detect tool-use not supported by the model (match specific provider error patterns)
    if (msg.includes('does not support tools') || msg.includes('tool_use is not supported') || msg.includes('does not support function')) {
      emit({ type: 'error', code: 'tool_use_not_supported', error: 'Model ' + modelId + ' does not support tool use. Try a model that supports function calling.' });
    } else {
      emit({ type: 'error', code: 'execution_error', error: msg.slice(0, 500) });
    }
  } finally {
    // Close MCP clients
    for (const client of mcpClients) {
      try { await client.close(); } catch {}
    }

    // Upload transcript to platform
    if (platformUrl && runToken) {
      try {
        const transcript = readFileSync(transcriptPath, 'utf-8');
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
}

main().catch(e => {
  emit({ type: 'error', code: 'runner_crash', error: e.message });
  process.exit(1);
});
`;
}
