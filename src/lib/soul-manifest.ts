/**
 * Shared helpers to build a SoulManifest and files map from an agent row.
 *
 * Used by validate-soul, import-soul, export-soul, and publish-soul routes.
 */

import type { SoulManifest } from "@/lib/clawsouls";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toKebab(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Manifest builder
// ---------------------------------------------------------------------------

interface ManifestAgent {
  name: string;
  description: string | null;
  model: string;
  soul_spec_version: string | null;
}

export function buildSoulManifest(agent: ManifestAgent): SoulManifest {
  return {
    specVersion: agent.soul_spec_version ?? "0.5",
    name: toKebab(agent.name),
    displayName: agent.name,
    version: "1.0.0",
    description: agent.description ?? "",
    author: { name: "AgentPlane" },
    license: "Apache-2.0",
    tags: [],
    category: "development",
    files: {},
    compatibility: {
      models: [agent.model],
    },
  };
}

// ---------------------------------------------------------------------------
// Files builder
// ---------------------------------------------------------------------------

interface FilesAgent {
  soul_md: string | null;
  identity_md: string | null;
  style_md: string | null;
  agents_md: string | null;
  heartbeat_md: string | null;
  user_template_md: string | null;
  examples_good_md: string | null;
  examples_bad_md: string | null;
}

const FILE_MAP: Array<[keyof FilesAgent, string]> = [
  ["soul_md", "SOUL.md"],
  ["identity_md", "IDENTITY.md"],
  ["style_md", "STYLE.md"],
  ["agents_md", "AGENTS.md"],
  ["heartbeat_md", "HEARTBEAT.md"],
  ["user_template_md", "USER_TEMPLATE.md"],
  ["examples_good_md", "examples/good-outputs.md"],
  ["examples_bad_md", "examples/bad-outputs.md"],
];

/**
 * Build a `Record<filename, content>` from non-null agent SoulSpec columns.
 */
export function buildSoulFiles(agent: FilesAgent): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [col, filename] of FILE_MAP) {
    const value = agent[col];
    if (value) {
      files[filename] = value;
    }
  }
  return files;
}

/**
 * Reverse mapping: given a files record (keyed by filename), return DB column
 * values. Missing files map to `null`.
 */
export function filesToColumns(
  files: Record<string, string>,
): Record<string, string | null> {
  const cols: Record<string, string | null> = {};
  for (const [col, filename] of FILE_MAP) {
    cols[col] = files[filename] ?? null;
  }
  return cols;
}
