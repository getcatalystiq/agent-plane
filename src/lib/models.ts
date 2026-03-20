/**
 * Model detection and runner routing.
 *
 * The runner is an explicit agent-level choice:
 * - Claude/Anthropic models: user picks runner (Claude Agent SDK default, or Vercel AI SDK)
 * - Non-Claude models: always Vercel AI SDK (auto-set)
 */

export type RunnerType = "claude-agent-sdk" | "vercel-ai-sdk";

/** Returns the default runner for a model (used when agent has no explicit runner set). */
export function defaultRunnerForModel(model: string): RunnerType {
  if (!model.includes("/") || model.startsWith("anthropic/")) {
    return "claude-agent-sdk";
  }
  return "vercel-ai-sdk";
}

/** Returns whether the model supports the Claude Agent SDK runner. */
export function supportsClaudeRunner(model: string): boolean {
  return !model.includes("/") || model.startsWith("anthropic/");
}

/** Resolves the effective runner: agent's explicit choice, or default for model. */
export function resolveEffectiveRunner(
  model: string,
  agentRunner: RunnerType | null | undefined,
): RunnerType {
  // Non-Anthropic models can only use Vercel AI SDK — ignore stored runner
  if (!supportsClaudeRunner(model)) return "vercel-ai-sdk";
  if (agentRunner) return agentRunner;
  return defaultRunnerForModel(model);
}

/** Returns true if the permission mode is compatible with the given runner. */
export function isPermissionModeAllowed(
  runner: RunnerType,
  permissionMode: string,
): boolean {
  if (runner === "vercel-ai-sdk") {
    return permissionMode === "default" || permissionMode === "bypassPermissions";
  }
  return true;
}

