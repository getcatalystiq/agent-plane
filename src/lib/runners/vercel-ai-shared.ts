/**
 * Shared code snippets for Vercel AI SDK runner scripts.
 *
 * Both the one-shot and session runners generate ES module strings
 * that run inside a Vercel Sandbox. This module provides functions
 * that return the shared code snippets (as strings) to avoid duplication.
 *
 * Note: execSync is used deliberately in sandbox tools — the Vercel Sandbox
 * boundary provides security (network allowlist, isolated filesystem),
 * not the exec method.
 */

/**
 * Common preamble: workspace setup, validatePath, emit function.
 * Assumes the caller has already emitted the static imports (fs, path, child_process).
 */
export function buildPreamble(): string {
  return `
// --- Transcript ---
const transcriptPath = '/vercel/sandbox/transcript-' + (process.env.AGENT_PLANE_RUN_ID || 'unknown') + '.ndjson';
writeFileSync(transcriptPath, '');

function emit(event) {
  const line = JSON.stringify(event);
  console.log(line);
  appendFileSync(transcriptPath, line + '\\n');
}

// --- Workspace-restricted file system ---
const WORKSPACE = '/vercel/sandbox/workspace';
mkdirSync(WORKSPACE, { recursive: true });

function validatePath(rawPath) {
  const resolved = resolve(rawPath);
  if (!resolved.startsWith(WORKSPACE + '/') && resolved !== WORKSPACE) {
    throw new Error('Path outside allowed workspace: ' + rawPath);
  }
  return resolved;
}

function truncateToolResult(result) {
  const MAX = 50000;
  if (typeof result === 'string' && result.length > MAX) {
    return result.slice(0, MAX) + '\\n... (truncated)';
  }
  return result;
}
`;
}

/**
 * Tool definitions shared between one-shot and session runners.
 * Returns the builtinTools object as a code string.
 *
 * @param skillRegistryJson - JSON.stringify'd skill registry array
 * @param opts.includeCompleteTask - one-shot runner includes sandbox__complete_task
 */
export function buildToolDefinitions(
  skillRegistryJson: string,
  opts?: { includeCompleteTask?: boolean },
): string {
  const completeTaskTool = opts?.includeCompleteTask
    ? `
  sandbox__complete_task: {
    description: 'Call this when you have completed the task. Provide the final result summary.',
    parameters: z.object({ result: z.string().describe('Final result summary') }),
    execute: async ({ result }) => {
      emit({ type: 'assistant', content: [{ type: 'text', text: result }] });
      return 'Task marked complete.';
    }
  },`
    : "";

  // Note: execSync is used deliberately — Vercel Sandbox provides security
  return `
// --- Skill registry (injected at build time) ---
const skillRegistry = ${skillRegistryJson};

// --- Tool definitions ---
const { z } = await import('zod');

const builtinTools = {
  load_skill: {
    description: 'Load a skill to get specialized instructions. Use this when a task matches an available skill listed in the system prompt.',
    parameters: z.object({
      name: z.string().describe('The skill name to load (from the Available Skills list)'),
    }),
    execute: async ({ name }) => {
      const skill = skillRegistry.find(s => s.name.toLowerCase() === name.toLowerCase());
      if (!skill) {
        return { error: 'Skill not found: ' + name + '. Available: ' + skillRegistry.map(s => s.name).join(', ') };
      }
      return { name: skill.name, skillDirectory: skill.path.replace(/\\/[^/]+$/, ''), content: skill.content };
    }
  },
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
    description: 'Run a shell command in the workspace directory',
    parameters: z.object({ command: z.string().describe('Shell command to run') }),
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
            || /^172\\\\.(1[6-9]|2[0-9]|3[01])\\\\/./.test(host)
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
  },${completeTaskTool}
};
`;
}

/**
 * MCP client setup: dynamic import, server connection, tool discovery.
 *
 * @param mcpErrorsJson - JSON.stringify'd array of MCP error strings
 */
export function buildMcpSetup(mcpErrorsJson: string): string {
  return `
// --- Dynamic imports ---
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

const configuredMcpErrors = ${mcpErrorsJson};
`;
}

/**
 * Stream consumption + result event emission.
 * Handles textStream iteration, assistant event, and result/error events.
 *
 * @param mode - 'oneshot' includes tool-use error detection; 'session' includes history update
 */
export function buildStreamHandling(mode: "oneshot" | "session"): string {
  const historyUpdate = mode === "session"
    ? `
    // Append assistant response to history
    const responseMessages = await result.response;
    if (responseMessages?.messages) {
      history.messages.push(...responseMessages.messages);
    }

    history.metadata.totalTokens += (totalUsage?.inputTokens || 0) + (totalUsage?.outputTokens || 0);
    history.metadata.turnCount++;
    saveHistory(history);
`
    : "";

  const errorHandler = mode === "oneshot"
    ? `
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('does not support tools') || msg.includes('tool_use is not supported') || msg.includes('does not support function')) {
      emit({ type: 'error', code: 'tool_use_not_supported', error: 'Model ' + modelId + ' does not support tool use. Try a model that supports function calling.' });
    } else {
      emit({ type: 'error', code: 'execution_error', error: msg.slice(0, 500) });
    }
`
    : `
    emit({ type: 'error', code: 'execution_error', error: error.message });
`;

  return `
    // Stream text (provider-agnostic)
    for await (const textPart of result.textStream) {
      if (textPart) {
        console.log(JSON.stringify({ type: 'text_delta', text: textPart }));
      }
    }

    // Get full text after stream completes
    const fullText = await result.text;

    // Emit assistant event with full text (mirrors Claude SDK runner format)
    if (fullText) {
      emit({ type: 'assistant', message: { content: [{ type: 'text', text: fullText }] } });
    } else {
      emit({ type: 'system', message: 'Model returned empty response (no text output)' });
    }

    const totalUsage = await result.totalUsage;
    const steps = await result.steps;
    const durationMs = Date.now() - startTime;
${historyUpdate}
    let generationId = null;
    try {
      const response = await result.response;
      generationId = response?.id || null;
    } catch {}

    emit({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0,
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
${errorHandler}
  } finally {
    for (const client of mcpClients) {
      try { await client.close(); } catch {}
    }
    const platformUrl = process.env.AGENT_PLANE_PLATFORM_URL;
    const runToken = process.env.AGENT_PLANE_RUN_TOKEN;
    if (platformUrl && runToken) {
      try {
        const runId = process.env.AGENT_PLANE_RUN_ID;
        const transcript = readFileSync(transcriptPath, 'utf-8');
        await fetch(platformUrl + '/api/internal/runs/' + runId + '/transcript', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + runToken, 'Content-Type': 'application/x-ndjson' },
          body: transcript,
        });
      } catch {}
    }
  }
`;
}
