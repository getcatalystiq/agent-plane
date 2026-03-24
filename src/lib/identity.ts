/**
 * Identity Parsing — SoulSpec-aligned markdown -> AgentIdentity JSONB
 *
 * AgentPlane is the sole parser. AgentCo only validates the pre-parsed JSONB.
 *
 * Parses SOUL.md and IDENTITY.md markdown content into the structured
 * AgentIdentity type used by governance, MCP tools, and card metadata.
 *
 * Security: Object.create(null) for all parsed objects, prototype pollution
 * prevention, size limit enforcement, validation warnings.
 */

// ── Shared Helpers ──

export function buildIdentityPrefix(agent: { soul_md?: string | null; identity_md?: string | null }): string {
  return [agent.soul_md, agent.identity_md].filter(Boolean).join("\n\n");
}

export function prependIdentity(prompt: string, agent: { soul_md?: string | null; identity_md?: string | null }): string {
  const prefix = buildIdentityPrefix(agent);
  return prefix ? `${prefix}\n\n${prompt}` : prompt;
}

export const IDENTITY_METADATA_KEY = 'soulspec:identity';

// ── Enum Constants ──

export const COMMUNICATION_VERBOSITY = ["concise", "detailed"] as const;
export type CommunicationVerbosity = (typeof COMMUNICATION_VERBOSITY)[number];

export const COMMUNICATION_TONE = ["direct", "diplomatic"] as const;
export type CommunicationTone = (typeof COMMUNICATION_TONE)[number];

export const DECISION_AUTONOMY = ["low", "moderate", "high", "full"] as const;
export type DecisionAutonomy = (typeof DECISION_AUTONOMY)[number];

export const RISK_TOLERANCE = ["conservative", "moderate", "bold"] as const;
export type RiskTolerance = (typeof RISK_TOLERANCE)[number];

export const COLLABORATION_MODE = ["async-handoff", "iterative", "autonomous", "pair"] as const;
export type CollaborationMode = (typeof COLLABORATION_MODE)[number];

export const ESCALATION_ACTIONS = ["escalate", "handle_independently"] as const;
export type EscalationAction = (typeof ESCALATION_ACTIONS)[number];

// ── Types ──

export interface EscalationPreference {
  condition: string;
  action: EscalationAction;
}

export interface Soul {
  voice?: string;
  values?: string;
  stance?: string;
  essence?: string;
}

export interface AgentIdentity {
  communication_verbosity?: CommunicationVerbosity;
  communication_tone?: CommunicationTone;
  decision_autonomy?: DecisionAutonomy;
  risk_tolerance?: RiskTolerance;
  escalation_preferences?: EscalationPreference[];
  collaboration_mode?: CollaborationMode;
  boundaries?: string[];
  soul?: Soul;
}

export interface ParseWarning {
  file: "soul_md" | "identity_md";
  message: string;
}

export interface ParseResult {
  identity: AgentIdentity | null;
  warnings: ParseWarning[];
}

type SoulSections = Record<string, string[]>;
type IdentityFields = Record<string, string>;

// ── Dangerous keys for prototype pollution prevention ──

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// ── Size limits ──

const MAX_IDENTITY_PAYLOAD_BYTES = 25600; // 25KB

// ── Expected sections for validation warnings ──

// Section headers are normalized: lowercased, non-alphanumeric replaced with "_".
// "## Voice & Tone" → "voice_tone", "## Values" → "values", etc.
// Authors must use the exact headers: "## Voice & Tone", "## Values", "## Stance", "## Boundaries", "## Essence"
const EXPECTED_SOUL_SECTIONS = ["voice_tone", "values", "stance", "boundaries", "essence"];
const EXPECTED_IDENTITY_FIELDS = [
  "communication_verbosity",
  "communication_tone",
  "decision_autonomy",
  "risk_tolerance",
  "collaboration_mode",
];

// ── Parsers ──

export function parseSoulMd(content: string): { sections: SoulSections; warnings: ParseWarning[] } {
  const sections: SoulSections = Object.create(null);
  const warnings: ParseWarning[] = [];
  let currentSection: string | null = null;

  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) {
      currentSection = line.slice(3).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
      if (DANGEROUS_KEYS.has(currentSection)) {
        currentSection = null;
        continue;
      }
      sections[currentSection] = [];
    } else if (currentSection && line.trim()) {
      sections[currentSection].push(line.trim());
    }
  }

  for (const key of EXPECTED_SOUL_SECTIONS) {
    if (!sections[key] || sections[key].length === 0) {
      warnings.push({ file: "soul_md", message: `Missing '${sectionKeyToLabel(key)}' section` });
    }
  }

  return { sections, warnings };
}

export function parseIdentityMd(content: string): { fields: IdentityFields; escalationLines: string[]; warnings: ParseWarning[] } {
  const fields: IdentityFields = Object.create(null);
  const escalationLines: string[] = [];
  const warnings: ParseWarning[] = [];
  const kvPattern = /^-\s+\*\*(.+?):\*\*\s*(.+)$/;

  let inEscalation = false;
  for (const line of content.split("\n")) {
    if (line.startsWith("## Escalation Preferences")) { inEscalation = true; continue; }
    if (line.startsWith("## ")) { inEscalation = false; }

    if (inEscalation && line.trim().startsWith("-")) {
      escalationLines.push(line);
      continue;
    }

    const match = line.match(kvPattern);
    if (match) {
      const key = match[1].trim().toLowerCase().replace(/\s+/g, "_");
      if (DANGEROUS_KEYS.has(key)) continue;
      fields[key] = match[2].trim();
    }
  }

  for (const key of EXPECTED_IDENTITY_FIELDS) {
    if (!fields[key]) {
      warnings.push({ file: "identity_md", message: `Missing '${fieldKeyToLabel(key)}' field` });
    }
  }

  // Validate enum values
  const enumValidations: Array<{ key: string; values: readonly string[] }> = [
    { key: "communication_verbosity", values: COMMUNICATION_VERBOSITY },
    { key: "communication_tone", values: COMMUNICATION_TONE },
    { key: "decision_autonomy", values: DECISION_AUTONOMY },
    { key: "risk_tolerance", values: RISK_TOLERANCE },
    { key: "collaboration_mode", values: COLLABORATION_MODE },
  ];

  for (const { key, values } of enumValidations) {
    if (fields[key] && !values.includes(fields[key] as never)) {
      warnings.push({
        file: "identity_md",
        message: `'${fieldKeyToLabel(key)}' value '${fields[key]}' is not valid — expected: ${values.join(", ")}`,
      });
    }
  }

  return { fields, escalationLines, warnings };
}

export function parseEscalationPreferences(lines: string[], warnings?: ParseWarning[]): EscalationPreference[] {
  return lines.slice(0, 10).map(line => {
    const cleanLine = line.replace(/^-\s*/, "");
    // Accept both -> and → as arrow separators
    const parts = cleanLine.split(/\s*(?:->|→)\s*/);
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    const condition = parts[0].trim().slice(0, 500);
    const rawAction = parts[1].trim().toLowerCase().replace(/\s+/g, "_");
    const action = rawAction === "escalate" ? "escalate" as const : "handle_independently" as const;
    if (rawAction !== "escalate" && rawAction !== "handle_independently" && warnings) {
      warnings.push({
        file: "identity_md",
        message: `Escalation action '${rawAction}' not recognized — defaulting to handle_independently`,
      });
    }
    return { condition, action };
  }).filter((e): e is EscalationPreference => e !== null);
}

// ── Main derivation function ──

export function deriveIdentity(soulMd: string | null, identityMd: string | null): ParseResult {
  const allWarnings: ParseWarning[] = [];

  if (!soulMd && !identityMd) {
    return { identity: null, warnings: [] };
  }

  const soulSections: SoulSections = Object.create(null);
  const identityFields: IdentityFields = Object.create(null);
  let escalationPrefs: EscalationPreference[] = [];

  if (soulMd) {
    const { sections, warnings } = parseSoulMd(soulMd);
    Object.assign(soulSections, sections);
    allWarnings.push(...warnings);
  }

  if (identityMd) {
    const { fields, escalationLines, warnings } = parseIdentityMd(identityMd);
    Object.assign(identityFields, fields);
    escalationPrefs = parseEscalationPreferences(escalationLines, allWarnings);
    allWarnings.push(...warnings);
  }

  // Build identity object — only include fields that have values
  const identity: AgentIdentity = {};

  if (identityFields.communication_verbosity && COMMUNICATION_VERBOSITY.includes(identityFields.communication_verbosity as never)) {
    identity.communication_verbosity = identityFields.communication_verbosity as AgentIdentity["communication_verbosity"];
  }
  if (identityFields.communication_tone && COMMUNICATION_TONE.includes(identityFields.communication_tone as never)) {
    identity.communication_tone = identityFields.communication_tone as AgentIdentity["communication_tone"];
  }
  if (identityFields.decision_autonomy && DECISION_AUTONOMY.includes(identityFields.decision_autonomy as never)) {
    identity.decision_autonomy = identityFields.decision_autonomy as AgentIdentity["decision_autonomy"];
  }
  if (identityFields.risk_tolerance && RISK_TOLERANCE.includes(identityFields.risk_tolerance as never)) {
    identity.risk_tolerance = identityFields.risk_tolerance as AgentIdentity["risk_tolerance"];
  }
  if (identityFields.collaboration_mode && COLLABORATION_MODE.includes(identityFields.collaboration_mode as never)) {
    identity.collaboration_mode = identityFields.collaboration_mode as AgentIdentity["collaboration_mode"];
  }

  if (escalationPrefs.length > 0) {
    identity.escalation_preferences = escalationPrefs;
  }

  // Boundaries from SOUL.md
  const rawBoundaries = soulSections.boundaries?.map(b => b.replace(/^-\s*/, "").slice(0, 500)).slice(0, 20);
  if (rawBoundaries && rawBoundaries.length > 0) {
    identity.boundaries = rawBoundaries;
  }

  // Soul block from SOUL.md
  const soul: Soul = {};
  if (soulSections.voice_tone) soul.voice = soulSections.voice_tone.join(" ").slice(0, 2000);
  if (soulSections.values) soul.values = soulSections.values.join(" ").slice(0, 2000);
  if (soulSections.stance) soul.stance = soulSections.stance.join(" ").slice(0, 2000);
  if (soulSections.essence) soul.essence = soulSections.essence.join(" ").slice(0, 2000);
  if (Object.keys(soul).length > 0) {
    identity.soul = soul;
  }

  // Return null if nothing was populated
  if (Object.keys(identity).length === 0) {
    return { identity: null, warnings: allWarnings };
  }

  // Enforce size limit — reject oversized payloads
  if (JSON.stringify(identity).length > MAX_IDENTITY_PAYLOAD_BYTES) {
    allWarnings.push({
      file: "identity_md",
      message: "Identity payload exceeds 25KB limit",
    });
    return { identity: null, warnings: allWarnings };
  }

  return { identity, warnings: allWarnings };
}

// ── Label helpers for warnings ──

function sectionKeyToLabel(key: string): string {
  const map: Record<string, string> = {
    voice_tone: "Voice & Tone",
    values: "Values",
    stance: "Stance",
    boundaries: "Boundaries",
    essence: "Essence",
  };
  return map[key] || key;
}

function fieldKeyToLabel(key: string): string {
  return key.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
