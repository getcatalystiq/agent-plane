import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

const SOULSPEC_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "STYLE.md",
  "AGENTS.md",
  "HEARTBEAT.md",
  "USER_TEMPLATE.md",
  "examples/good-outputs.md",
  "examples/bad-outputs.md",
] as const;

type SoulSpecFile = (typeof SOULSPEC_FILES)[number];

const FALLBACK_MODEL = "anthropic/claude-sonnet-4-5-20250514";

interface AgentContext {
  name: string;
  description: string | null;
  model: string;
  composio_toolkits: string[];
  skills: Array<{ folder: string; files: Array<{ path: string }> }>;
  plugins: Array<{ plugin_name: string }>;
  allowed_tools: string[];
}

function buildPrompt(
  agent: AgentContext,
  existingContent?: Record<string, string | null>,
): string {
  const toolsList = agent.allowed_tools.length > 0
    ? agent.allowed_tools.join(", ")
    : "none configured";

  const toolkitsList = agent.composio_toolkits.length > 0
    ? agent.composio_toolkits.join(", ")
    : "none";

  const skillsList = agent.skills.length > 0
    ? agent.skills.map((s) => `- ${s.folder} (${s.files.map((f) => f.path).join(", ")})`).join("\n")
    : "none";

  const pluginsList = agent.plugins.length > 0
    ? agent.plugins.map((p) => `- ${p.plugin_name}`).join("\n")
    : "none";

  const hasExisting = existingContent && Object.values(existingContent).some((v) => v !== null && v !== undefined);

  let prompt = `You are an expert at crafting SoulSpec v0.5 identity files for AI agents. Your task is to generate all 8 SoulSpec files for an agent based on its configuration.

## SoulSpec v0.5 Format

SoulSpec defines an agent's identity, personality, and behavioral guidelines through 8 markdown files. Each file serves a specific purpose:

### 1. SOUL.md — Core Soul Definition
The master file that ties everything together. Required sections:
- **Name**: The agent's name
- **Version**: SoulSpec version (0.5)
- **Purpose**: A clear, concise statement of what this agent does
- **Core Values**: 3-5 fundamental principles that guide the agent's behavior
- **Boundaries**: What the agent will NOT do or engage with

### 2. IDENTITY.md — Personality & Character
Defines who the agent is as a persona. Required sections:
- **Persona**: A brief character description (background, expertise, demeanor)
- **Tone**: How the agent communicates (e.g., professional, friendly, technical)
- **Expertise**: Domains of knowledge the agent excels in
- **Quirks**: Optional personality traits that make the agent memorable

### 3. STYLE.md — Communication Style Guide
Governs how the agent writes and formats responses. Required sections:
- **Voice**: Active/passive, formal/casual, first/third person preferences
- **Formatting**: Preferred use of markdown, lists, code blocks, headers
- **Length**: Default response length preferences (concise vs. detailed)
- **Vocabulary**: Preferred terminology, jargon level, words to avoid

### 4. AGENTS.md — Multi-Agent Collaboration
Defines how this agent interacts with other agents. Required sections:
- **Role**: This agent's role in a multi-agent system
- **Delegation**: What tasks this agent can delegate and to whom
- **Escalation**: When and how to escalate to humans or other agents
- **Protocols**: Communication protocols with other agents

### 5. HEARTBEAT.md — Health & Self-Monitoring
Defines the agent's self-awareness and monitoring behavior. Required sections:
- **Status Reporting**: How and when the agent reports its status
- **Error Handling**: How the agent responds to failures
- **Self-Assessment**: Criteria for evaluating its own performance
- **Recovery**: Steps to take when things go wrong

### 6. USER_TEMPLATE.md — User Interaction Template
Defines how the agent adapts to different users. Required sections:
- **Greeting**: How the agent introduces itself
- **Adaptation**: How the agent adjusts to user expertise level
- **Preferences**: How to handle user preferences and history
- **Feedback**: How the agent solicits and incorporates feedback

### 7. examples/good-outputs.md — Positive Examples
3-5 examples of ideal agent responses that demonstrate the desired behavior, tone, and quality. Each example should include:
- A brief scenario/prompt
- The ideal response
- Why this is a good example

### 8. examples/bad-outputs.md — Anti-patterns
3-5 examples of responses the agent should AVOID. Each example should include:
- A brief scenario/prompt
- The bad response
- Why this is problematic and what to do instead

## Agent Configuration

- **Name**: ${agent.name}
- **Description**: ${agent.description || "No description provided"}
- **Model**: ${agent.model}
- **Tools**: ${toolsList}
- **Composio Toolkits**: ${toolkitsList}
- **Skills**:
${skillsList}
- **Plugins**:
${pluginsList}
`;

  if (hasExisting) {
    prompt += `\n## Existing Content (Refine and Improve)

The agent already has some SoulSpec content. Refine the existing content while preserving the author's intent. Improve clarity, fill gaps, and ensure consistency across all files.

`;
    for (const file of SOULSPEC_FILES) {
      const key = file;
      const content = existingContent[key];
      if (content) {
        prompt += `### ${file}\n\`\`\`markdown\n${content}\n\`\`\`\n\n`;
      }
    }
  }

  prompt += `## Instructions

Generate all 8 SoulSpec files based on the agent configuration above.${hasExisting ? " Refine the existing content where provided, and generate fresh content for any missing files." : ""} Make the content specific and actionable — avoid generic boilerplate. Tailor everything to this agent's purpose, tools, and capabilities.

Respond with a JSON object where each key is the file path and the value is the full markdown content. The keys must be exactly:
${SOULSPEC_FILES.map((f) => `- "${f}"`).join("\n")}

Return ONLY valid JSON, no markdown code fences.`;

  return prompt;
}

export async function generateSoulFiles(
  agent: AgentContext,
  existingContent?: Record<string, string | null>,
): Promise<{ files: Record<string, string>; model_used: string }> {
  const env = getEnv();
  const prompt = buildPrompt(agent, existingContent);

  let model = agent.model || FALLBACK_MODEL;
  let response = await callGateway(env.AI_GATEWAY_API_KEY, model, prompt);

  // If the primary model fails (e.g., no JSON mode support), fall back
  if (!response.ok && model !== FALLBACK_MODEL) {
    logger.warn("Primary model failed for soul generation, falling back", { model, status: response.status });
    model = FALLBACK_MODEL;
    response = await callGateway(env.AI_GATEWAY_API_KEY, model, prompt);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    throw new Error(`AI Gateway returned ${response.status}: ${text}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("AI Gateway returned empty content");
  }

  const parsed = JSON.parse(content);
  validateSoulFiles(parsed);

  return { files: parsed as Record<string, string>, model_used: model };
}

async function callGateway(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<Response> {
  return fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_tokens: 8000,
    }),
  });
}

function validateSoulFiles(parsed: unknown): asserts parsed is Record<SoulSpecFile, string> {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Response is not a JSON object");
  }

  const obj = parsed as Record<string, unknown>;
  const missing: string[] = [];

  for (const file of SOULSPEC_FILES) {
    if (typeof obj[file] !== "string") {
      missing.push(file);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Response missing required files: ${missing.join(", ")}`);
  }
}
