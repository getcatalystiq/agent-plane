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
import { buildIdentityPrefix } from "../identity";
import { buildSkillsPrompt, buildSkillRegistry } from "./vercel-ai-runner";
import {
  buildPreamble,
  buildToolDefinitions,
  buildMcpSetup,
  buildAgentExecution,
} from "./vercel-ai-shared";

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

  const identityPrefix = buildIdentityPrefix(config.agent);
  if (identityPrefix) {
    systemPromptParts.push(identityPrefix);
  }

  if (config.agent.description) {
    systemPromptParts.push(config.agent.description);
  }

  const skillsPrompt = buildSkillsPrompt(config.agent.skills, config.pluginFiles);
  if (skillsPrompt) {
    systemPromptParts.push(skillsPrompt);
  }

  const systemPrompt = systemPromptParts.join("\n\n");
  const mcpErrors = config.mcpErrors || [];
  const skillRegistry = buildSkillRegistry(config.agent.skills, config.pluginFiles);

  return `
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { execSync } from 'child_process';

const modelId = ${JSON.stringify(config.agent.model)};
const prompt = ${JSON.stringify(config.prompt)};
const maxTurns = ${config.maxTurns || 10};
const systemPrompt = ${JSON.stringify(systemPrompt)};

${buildPreamble()}

// --- Session history management ---
const HISTORY_PATH = '/vercel/sandbox/session-history.json';

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

${buildToolDefinitions(JSON.stringify(skillRegistry))}
${buildMcpSetup(JSON.stringify(mcpErrors))}

// --- Main execution ---
async function main() {
  const { ToolLoopAgent, stepCountIs, hasToolCall, createGateway } = await import('ai');
  const gateway = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY ?? '' });
  const model = gateway(modelId);

  const history = loadHistory();
  history.messages.push({ role: 'user', content: prompt });

  emit({
    type: 'run_started',
    run_id: process.env.AGENT_PLANE_RUN_ID,
    agent_id: process.env.AGENT_PLANE_AGENT_ID,
    model: modelId,
    timestamp: new Date().toISOString(),
    mcp_server_count: Object.keys(mcpTools).length,
    mcp_errors: configuredMcpErrors,
  });

  const allTools = { ...builtinTools, ...mcpTools };
  const startTime = Date.now();

${buildAgentExecution("session")}
}

main().catch(e => {
  emit({ type: 'error', code: 'runner_crash', error: e.message });
  process.exit(1);
});
`;
}
