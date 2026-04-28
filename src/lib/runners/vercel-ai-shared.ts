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
 * Braintrust initialization snippet. Inserted early in the runner so
 * `initLogger` patches AI SDK calls before any LLM interaction.
 * Requires BRAINTRUST_API_KEY env var; silently skips if absent.
 */
export function buildBraintrustInit(): string {
  return `
// --- Braintrust tracing (optional) ---
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
`;
}

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
 */
export function buildToolDefinitions(
  skillRegistryJson: string,
): string {

  // Note: execSync is used deliberately — Vercel Sandbox provides security
  return `
// --- Skill registry (injected at build time) ---
const skillRegistry = ${skillRegistryJson};

// --- Tool definitions ---
const { z } = await import('zod');

const builtinTools = {
  load_skill: {
    description: 'Load a skill to get specialized instructions. Call with the "name" parameter set to the exact skill name from the Available Skills list.',
    parameters: z.object({
      name: z.string().optional().describe('The exact skill name to load'),
      skill_name: z.string().optional().describe('Alias for name'),
      skill_identifier: z.string().optional().describe('Alias for name'),
    }),
    execute: async ({ name, skill_name, skill_identifier }) => {
      const resolved = name || skill_name || skill_identifier;
      if (!resolved) {
        return { error: 'Missing skill name. Available: ' + skillRegistry.map(s => s.name).join(', ') + '. Call with: { "name": "<skill_name>" }' };
      }
      const skill = skillRegistry.find(s => s.name.toLowerCase() === resolved.toLowerCase());
      if (!skill) {
        return { error: 'Skill not found: ' + resolved + '. Available: ' + skillRegistry.map(s => s.name).join(', ') };
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
  sandbox__web_search: {
    description: 'Search the web and return results. Use this to find current information, documentation, or answers to questions.',
    parameters: z.object({
      query: z.string().describe('Search query'),
      num_results: z.number().optional().describe('Number of results (default 5, max 10)'),
    }),
    execute: async ({ query, num_results }) => {
      try {
        const n = Math.min(num_results || 5, 10);
        const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 15000);
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'AgentPlane/1.0' },
        });
        const html = await res.text();
        // Extract result snippets from DuckDuckGo HTML
        const results = [];
        const resultPattern = /class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\\/a>[\\s\\S]*?class="result__snippet"[^>]*>([^<]*)/g;
        let match;
        while ((match = resultPattern.exec(html)) !== null && results.length < n) {
          const href = match[1].startsWith('/') ? decodeURIComponent(match[1].replace(/^\\/l\\/\\?[^=]*=/, '').split('&')[0]) : match[1];
          results.push({ title: match[2].trim(), url: href, snippet: match[3].trim() });
        }
        if (results.length === 0) {
          return { query, results: [], note: 'No results found. Try rephrasing the query.' };
        }
        return { query, results };
      } catch (e) {
        return { error: 'Search failed: ' + e.message };
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
`;
}

/**
 * MCP client setup: dynamic import, server connection, tool discovery.
 *
 * @param mcpErrorsJson - JSON.stringify'd array of MCP error strings
 */
export function buildMcpSetup(mcpErrorsJson: string): string {
  return `
// --- MCP tools ---
const mcpClients = [];
let mcpTools = {};
const configuredMcpErrors = ${mcpErrorsJson};

try {
  const mcpServersJson = process.env.MCP_SERVERS_JSON;
  if (mcpServersJson) {
    const { createMCPClient } = await import('@ai-sdk/mcp');
    const servers = JSON.parse(mcpServersJson);
    const entries = Object.entries(servers);
    const results = await Promise.allSettled(
      entries.map(async ([name, cfg]) => {
        let transport;
        if (cfg.command) {
          const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
          transport = new StdioClientTransport({ command: cfg.command, args: cfg.args || [], env: { ...process.env, ...(cfg.env || {}) } });
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
} catch (mcpErr) {
  emit({ type: 'mcp_error', server: '__setup__', error: 'MCP setup failed: ' + (mcpErr.message || String(mcpErr)) });
}
`;
}

/**
 * Agent creation + stream consumption + result event emission.
 * Uses ToolLoopAgent with combined stop conditions (stepCount + hasToolCall).
 *
 * @param mode - 'session' includes history update after response
 */
export function buildAgentExecution(mode: "oneshot" | "session"): string {
  const promptArg = mode === "oneshot"
    ? `prompt`
    : `messages: history.messages`;

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

  return `
  try {
    // Create agent with ToolLoopAgent (AI SDK recommended pattern)
    const agent = new ToolLoopAgent({
      model,
      instructions: systemPrompt || undefined,
      tools: allTools,
      stopWhen: [
        stepCountIs(maxTurns),
        hasToolCall('sandbox__complete_task'),
      ],
      onStepFinish: ({ toolCalls, toolResults }) => {
        if (toolCalls) {
          for (const tc of toolCalls) {
            emit({ type: 'tool_use', tool_name: tc.toolName, name: tc.toolName, input: tc.input ?? tc.args ?? {}, tool_use_id: tc.toolCallId });
          }
        }
        if (toolResults) {
          for (const tr of toolResults) {
            const raw = tr.output ?? tr.result;
            const output = raw !== undefined && raw !== null ? raw : '(no output)';
            emit({ type: 'tool_result', tool_use_id: tr.toolCallId, tool_name: tr.toolName, result: truncateToolResult(typeof output === 'string' ? output : JSON.stringify(output)) });
          }
        }
      },
    });

    // Stream the agent's response
    const result = await agent.stream({ ${promptArg} });

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
      result: fullText || '',
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
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('does not support tools') || msg.includes('tool_use is not supported') || msg.includes('does not support function')) {
      emit({ type: 'error', code: 'tool_use_not_supported', error: 'Model ' + modelId + ' does not support tool use. Try a model that supports function calling.' });
    } else {
      emit({ type: 'error', code: 'execution_error', error: msg.slice(0, 500) });
    }
  } finally {
    for (const client of mcpClients) {
      try { await client.close(); } catch {}
    }
    const platformUrl = process.env.AGENT_PLANE_PLATFORM_URL;
    const messageToken = process.env.AGENT_PLANE_MESSAGE_TOKEN;
    if (platformUrl && messageToken) {
      try {
        const messageId = process.env.AGENT_PLANE_MESSAGE_ID;
        const transcript = readFileSync(transcriptPath, 'utf-8');
        await fetch(platformUrl + '/api/internal/messages/' + messageId + '/transcript', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + messageToken, 'Content-Type': 'application/x-ndjson' },
          body: transcript,
        });
      } catch {}
    }
  }
`;
}
