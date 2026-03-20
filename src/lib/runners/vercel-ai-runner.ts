/**
 * Vercel AI SDK runner script builder (one-shot runs).
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
import {
  buildPreamble,
  buildToolDefinitions,
  buildMcpSetup,
  buildStreamHandling,
} from "./vercel-ai-shared";

/**
 * Build a system prompt that lists available skills by name and description.
 * Following the Vercel AI SDK skill pattern: skills are listed in the system
 * prompt, and loaded on-demand via the load_skill tool.
 */
export function buildSkillsPrompt(
  skills: SandboxConfig["agent"]["skills"],
  pluginFiles?: Array<{ path: string; content: string }>,
): string {
  const lines: string[] = [];

  if (skills.length > 0) {
    lines.push("## Available Skills");
    lines.push("Use the `load_skill` tool to load a skill's full instructions when relevant.");
    lines.push("");
    for (const skill of skills) {
      const mainFile = skill.files.find(f => f.path.endsWith(".md")) ?? skill.files[0];
      // Extract first line of content as description
      const firstLine = mainFile?.content?.split("\n").find(l => l.trim() && !l.startsWith("#") && !l.startsWith("---"))?.trim();
      const desc = firstLine ? ` — ${firstLine.slice(0, 120)}` : "";
      lines.push(`- \`${skill.folder}\`${desc}`);
    }
  }

  if (pluginFiles && pluginFiles.length > 0) {
    const agentFiles = pluginFiles.filter(f => f.path.includes("/agents/"));
    const skillFiles = pluginFiles.filter(f => f.path.includes("/skills/"));

    if (skillFiles.length > 0) {
      if (lines.length === 0) {
        lines.push("## Available Skills");
        lines.push("Use the `load_skill` tool to load a skill's full instructions when relevant.");
        lines.push("");
      }
      for (const f of skillFiles) {
        const name = f.path.split("/").pop()?.replace(/\.md$/, "") ?? f.path;
        lines.push(`- \`${name}\` (plugin)`);
      }
    }

    if (agentFiles.length > 0) {
      lines.push("");
      lines.push("## Agent Instructions (always active)");
      for (const f of agentFiles) {
        lines.push(f.content);
      }
    }
  }

  return lines.length > 0 ? lines.join("\n") : "";
}

/**
 * Build the JSON skill registry that the load_skill tool uses to look up skills.
 */
export function buildSkillRegistry(
  skills: SandboxConfig["agent"]["skills"],
  pluginFiles?: Array<{ path: string; content: string }>,
): Array<{ name: string; path: string; content: string }> {
  const registry: Array<{ name: string; path: string; content: string }> = [];

  for (const skill of skills) {
    const mainFile = skill.files.find(f => f.path.endsWith(".md")) ?? skill.files[0];
    if (mainFile) {
      registry.push({
        name: skill.folder,
        path: `/vercel/sandbox/workspace/.skills/${skill.folder}/${mainFile.path}`,
        content: mainFile.content,
      });
    }
  }

  if (pluginFiles) {
    for (const f of pluginFiles) {
      if (f.path.includes("/skills/")) {
        const name = f.path.split("/").pop()?.replace(/\.md$/, "") ?? f.path;
        registry.push({
          name,
          path: `/vercel/sandbox/workspace/${f.path}`,
          content: f.content,
        });
      }
    }
  }

  return registry;
}

export function buildVercelAiRunnerScript(config: SandboxConfig): string {
  const systemPromptParts: string[] = [];

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
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { execSync } from 'child_process';

const modelId = ${JSON.stringify(config.agent.model)};
const prompt = ${JSON.stringify(config.prompt)};
const maxTurns = ${config.agent.max_turns || 10};
const systemPrompt = ${JSON.stringify(systemPrompt)};

${buildPreamble()}
${buildToolDefinitions(JSON.stringify(skillRegistry), { includeCompleteTask: true })}
${buildMcpSetup(JSON.stringify(mcpErrors))}

// --- Main execution ---
async function main() {
  const { streamText, stopWhen, stepCountIs, createGateway } = await import('ai');
  const gateway = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY ?? '' });
  const model = gateway(modelId);

  emit({
    type: 'run_started',
    run_id: process.env.AGENT_PLANE_RUN_ID,
    agent_id: process.env.AGENT_PLANE_AGENT_ID,
    model: modelId,
    timestamp: new Date().toISOString(),
    mcp_server_count: Object.keys(mcpTools).length,
    mcp_server_names: Object.keys(mcpTools),
    mcp_errors: configuredMcpErrors,
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
        if (toolCalls) {
          for (const tc of toolCalls) {
            emit({ type: 'tool_use', tool_name: tc.toolName, name: tc.toolName, input: tc.args, tool_use_id: tc.toolCallId });
          }
        }
        if (toolResults) {
          for (const tr of toolResults) {
            emit({ type: 'tool_result', tool_use_id: tr.toolCallId, result: truncateToolResult(tr.result) });
          }
        }
      },
    });

${buildStreamHandling("oneshot")}
}

main().catch(e => {
  emit({ type: 'error', code: 'runner_crash', error: e.message });
  process.exit(1);
});
`;
}
