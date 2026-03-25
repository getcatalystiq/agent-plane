/**
 * Identity Parsing — SoulSpec v0.5 compliant
 *
 * Parses SOUL.md, IDENTITY.md, and STYLE.md markdown content into the
 * structured AgentIdentity type used by governance, MCP tools, and card metadata.
 *
 * Security: Object.create(null) for all parsed objects, prototype pollution
 * prevention, size limit enforcement, validation warnings.
 */

// ── Types ──

export interface SoulBlock {
  personality?: string;
  tone?: string;
  principles?: string;
  worldview?: string;
  expertise?: string;
  opinions?: string;
  boundaries?: string;
}

export interface IdentityBlock {
  name?: string;
  role?: string;
  creature?: string;
  emoji?: string;
  vibe?: string;
  avatar?: string;
}

export interface StyleBlock {
  sentence_structure?: string;
  vocabulary?: string;
  tone?: string;
  formatting?: string;
  rhythm?: string;
  anti_patterns?: string;
}

export interface AgentIdentity {
  soul?: SoulBlock;
  identity?: IdentityBlock;
  style?: StyleBlock;
  has_agents_md: boolean;
  has_heartbeat_md: boolean;
  has_user_template_md: boolean;
  has_examples: boolean;
  disclosure_summary: string | null;
}

export interface ParseWarning {
  file: string;
  message: string;
}

export interface ParseResult {
  identity: AgentIdentity | null;
  warnings: ParseWarning[];
}

// ── Constants ──

export const IDENTITY_METADATA_KEY = 'soulspec:identity';
export const IDENTITY_METADATA_KEY_V2 = 'soulspec:identity:v2';

// ── Dangerous keys for prototype pollution prevention ──

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// ── Size limits ──

const MAX_IDENTITY_PAYLOAD_BYTES = 25600; // 25KB

// ── Known sections/fields for validation ──

const REQUIRED_SOUL_SECTIONS = new Set(["personality", "tone", "principles"]);
const KNOWN_SOUL_SECTIONS = new Set(["personality", "tone", "principles", "worldview", "expertise", "opinions", "boundaries"]);

const KNOWN_IDENTITY_FIELDS = new Set(["name", "role", "creature", "emoji", "vibe", "avatar"]);

const KNOWN_STYLE_SECTIONS = new Set(["sentence_structure", "vocabulary", "tone", "formatting", "rhythm", "anti_patterns"]);

// ── Parsers ──

export function parseSoulMd(content: string): { sections: Record<string, string[]>; warnings: ParseWarning[] } {
  const sections: Record<string, string[]> = Object.create(null);
  const warnings: ParseWarning[] = [];
  let currentSection: string | null = null;

  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) {
      const normalized = line.slice(3).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
      if (DANGEROUS_KEYS.has(normalized)) {
        currentSection = null;
        continue;
      }
      if (!KNOWN_SOUL_SECTIONS.has(normalized)) {
        warnings.push({ file: "soul_md", message: `Unrecognized section '${line.slice(3).trim()}' — ignored` });
        currentSection = null;
        continue;
      }
      currentSection = normalized;
      sections[currentSection] = [];
    } else if (currentSection && line.trim()) {
      sections[currentSection].push(line.trim());
    }
  }

  for (const key of REQUIRED_SOUL_SECTIONS) {
    if (!sections[key] || sections[key].length === 0) {
      warnings.push({ file: "soul_md", message: `ERROR: Missing required section '${sectionKeyToLabel(key)}'` });
    }
  }

  return { sections, warnings };
}

export function parseIdentityMd(content: string): { fields: Record<string, string>; warnings: ParseWarning[] } {
  const fields: Record<string, string> = Object.create(null);
  const warnings: ParseWarning[] = [];
  const kvPattern = /^-\s+\*\*(.+?):\*\*\s*(.+)$/;

  for (const line of content.split("\n")) {
    const match = line.match(kvPattern);
    if (match) {
      const key = match[1].trim().toLowerCase().replace(/\s+/g, "_");
      if (DANGEROUS_KEYS.has(key)) continue;
      if (!KNOWN_IDENTITY_FIELDS.has(key)) continue;
      fields[key] = match[2].trim();
    }
  }

  if (!fields.creature) {
    warnings.push({ file: "identity_md", message: "ERROR: Missing required field 'creature'" });
  }

  return { fields, warnings };
}

export function parseStyleMd(content: string): { sections: Record<string, string>; warnings: ParseWarning[] } {
  const sections: Record<string, string> = Object.create(null);
  const warnings: ParseWarning[] = [];
  let currentSection: string | null = null;
  let currentLines: string[] = [];

  function flushSection() {
    if (currentSection && currentLines.length > 0) {
      sections[currentSection] = currentLines.join("\n");
    }
    currentLines = [];
  }

  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) {
      flushSection();
      const normalized = line.slice(3).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
      if (DANGEROUS_KEYS.has(normalized)) {
        currentSection = null;
        continue;
      }
      if (!KNOWN_STYLE_SECTIONS.has(normalized)) {
        warnings.push({ file: "style_md", message: `Unrecognized section '${line.slice(3).trim()}' — ignored` });
        currentSection = null;
        continue;
      }
      currentSection = normalized;
    } else if (currentSection && line.trim()) {
      currentLines.push(line.trim());
    }
  }
  flushSection();

  return { sections, warnings };
}

// ── Disclosure summary extraction ──

function extractDisclosureSummary(soulMd: string): string | null {
  const lines = soulMd.split("\n");
  let pastTitle = false;
  const paragraphLines: string[] = [];

  for (const line of lines) {
    // Skip the title line
    if (!pastTitle) {
      if (line.startsWith("# ")) {
        pastTitle = true;
        continue;
      }
      // If there's no title, start collecting from the first non-empty line
      if (line.trim()) {
        paragraphLines.push(line.trim());
        continue;
      }
      continue;
    }

    // Skip blank lines before the first paragraph
    if (paragraphLines.length === 0 && !line.trim()) continue;

    // Stop at blank line after we've started collecting, or at next heading
    if (paragraphLines.length > 0 && (!line.trim() || line.startsWith("#"))) break;
    if (line.startsWith("#")) break;

    if (line.trim()) {
      paragraphLines.push(line.trim());
    }
  }

  if (paragraphLines.length === 0) return null;
  const text = paragraphLines.join(" ").slice(0, 200);
  return text || null;
}

// ── Main derivation function ──

export function deriveIdentity(
  soulMd: string | null,
  identityMd: string | null,
  styleMd: string | null,
  agentsMd: string | null,
  heartbeatMd: string | null,
  userTemplateMd: string | null,
  examplesGoodMd: string | null,
  examplesBadMd: string | null,
): ParseResult {
  const allWarnings: ParseWarning[] = [];

  // If ALL inputs are null, return null identity
  if (!soulMd && !identityMd && !styleMd && !agentsMd && !heartbeatMd && !userTemplateMd && !examplesGoodMd && !examplesBadMd) {
    return { identity: null, warnings: [] };
  }

  // Parse SOUL.md
  let soulBlock: SoulBlock | undefined;
  if (soulMd) {
    const { sections, warnings } = parseSoulMd(soulMd);
    allWarnings.push(...warnings);

    const soul: SoulBlock = Object.create(null);
    for (const key of KNOWN_SOUL_SECTIONS) {
      if (sections[key] && sections[key].length > 0) {
        (soul as Record<string, string>)[key] = sections[key].join("\n");
      }
    }
    if (Object.keys(soul).length > 0) {
      soulBlock = soul;
    }
  }

  // Parse IDENTITY.md
  let identityBlock: IdentityBlock | undefined;
  if (identityMd) {
    const { fields, warnings } = parseIdentityMd(identityMd);
    allWarnings.push(...warnings);

    const ident: IdentityBlock = Object.create(null);
    for (const key of KNOWN_IDENTITY_FIELDS) {
      if (fields[key]) {
        (ident as Record<string, string>)[key] = fields[key];
      }
    }
    if (Object.keys(ident).length > 0) {
      identityBlock = ident;
    }
  }

  // Parse STYLE.md
  let styleBlock: StyleBlock | undefined;
  if (styleMd) {
    const { sections, warnings } = parseStyleMd(styleMd);
    allWarnings.push(...warnings);

    const style: StyleBlock = Object.create(null);
    for (const key of KNOWN_STYLE_SECTIONS) {
      if (sections[key]) {
        (style as Record<string, string>)[key] = sections[key];
      }
    }
    if (Object.keys(style).length > 0) {
      styleBlock = style;
    }
  }

  // Build AgentIdentity
  const identity: AgentIdentity = {
    has_agents_md: !!(agentsMd && agentsMd.trim()),
    has_heartbeat_md: !!(heartbeatMd && heartbeatMd.trim()),
    has_user_template_md: !!(userTemplateMd && userTemplateMd.trim()),
    has_examples: !!((examplesGoodMd && examplesGoodMd.trim()) || (examplesBadMd && examplesBadMd.trim())),
    disclosure_summary: soulMd ? extractDisclosureSummary(soulMd) : null,
  };

  if (soulBlock) identity.soul = soulBlock;
  if (identityBlock) identity.identity = identityBlock;
  if (styleBlock) identity.style = styleBlock;

  // Return null if nothing meaningful was populated
  const hasContent = soulBlock || identityBlock || styleBlock
    || identity.has_agents_md || identity.has_heartbeat_md
    || identity.has_user_template_md || identity.has_examples
    || identity.disclosure_summary;

  if (!hasContent) {
    return { identity: null, warnings: allWarnings };
  }

  // Enforce size limit
  if (JSON.stringify(identity).length > MAX_IDENTITY_PAYLOAD_BYTES) {
    allWarnings.push({
      file: "identity",
      message: "Identity payload exceeds 25KB limit",
    });
    return { identity: null, warnings: allWarnings };
  }

  return { identity, warnings: allWarnings };
}

// ── Prompt helpers ──

export type DisclosureLevel = 1 | 2 | 3;

export function buildIdentityPrefix(
  agent: {
    soul_md?: string | null;
    identity_md?: string | null;
    style_md?: string | null;
    agents_md?: string | null;
    heartbeat_md?: string | null;
    examples_good_md?: string | null;
    examples_bad_md?: string | null;
  },
  level: DisclosureLevel = 2,
): string {
  if (level === 1) {
    if (!agent.soul_md) return "";
    return extractDisclosureSummary(agent.soul_md) ?? "";
  }

  if (level === 2) {
    return [agent.identity_md, agent.soul_md, agent.style_md, agent.agents_md]
      .filter(Boolean)
      .join("\n\n");
  }

  // Level 3: Level 2 + heartbeat + examples
  return [
    agent.identity_md,
    agent.soul_md,
    agent.style_md,
    agent.agents_md,
    agent.heartbeat_md,
    agent.examples_good_md,
    agent.examples_bad_md,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function prependIdentity(
  prompt: string,
  agent: {
    soul_md?: string | null;
    identity_md?: string | null;
    style_md?: string | null;
    agents_md?: string | null;
    heartbeat_md?: string | null;
    examples_good_md?: string | null;
    examples_bad_md?: string | null;
  },
  level: DisclosureLevel = 2,
): string {
  const prefix = buildIdentityPrefix(agent, level);
  return prefix ? `${prefix}\n\n${prompt}` : prompt;
}

// ── Label helpers for warnings ──

function sectionKeyToLabel(key: string): string {
  return key.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
