export const INJECTION_SCANNER_VERSION = "v1";

export type InjectionConfidence = "high" | "medium" | "low";

export interface ScanResult {
  detected: boolean;
  confidence: InjectionConfidence;
  patterns: string[];
  sanitizedInput?: string;
}

interface PatternEntry {
  name: string;
  pattern: RegExp;
  confidence: InjectionConfidence;
}

const INJECTION_PATTERNS: readonly PatternEntry[] = [
  {
    name: "instruction_override",
    pattern: /ignore\s+(all\s+)?(previous|prior|above|your)\s+(instructions|rules|guidelines|prompts)/i,
    confidence: "high",
  },
  {
    name: "role_hijack",
    pattern: /you\s+are\s+now\s+a?\s*(new|different|my|an?)\s/i,
    confidence: "high",
  },
  {
    name: "system_prompt_leak",
    pattern: /(reveal|show|display|output|print)\s+(your|the|system)\s+(system\s+)?(prompt|instructions|rules)/i,
    confidence: "high",
  },
  {
    name: "chatml_injection",
    pattern: /<\|im_(start|end)\|>|<\|system\|>|\[INST\]|\[\/INST\]/i,
    confidence: "high",
  },
  {
    name: "exfiltration",
    pattern: /(send|post|transmit|exfiltrate|upload)\s+(all|the|this|your)\s+(data|info|content|secrets|keys|tokens)/i,
    confidence: "medium",
  },
  {
    name: "base64_block",
    pattern: /[A-Za-z0-9+/]{200,}={1,2}/,
    confidence: "low",
  },
];

const WINDOW_BYTES = 10 * 1024;
const WINDOW_STRIDE = 5 * 1024;
const SANITIZED_PREVIEW = 500;
const ZERO_WIDTH_RE = /[\u200B-\u200F\u2028-\u202F\uFEFF]/g;

function rankConfidence(c: InjectionConfidence): number {
  return c === "high" ? 3 : c === "medium" ? 2 : 1;
}

function maxConfidence(a: InjectionConfidence, b: InjectionConfidence): InjectionConfidence {
  return rankConfidence(a) >= rankConfidence(b) ? a : b;
}

function scanWindow(window: string): { hits: PatternEntry[]; cleaned: string } {
  const cleaned = window.normalize("NFKD").replace(ZERO_WIDTH_RE, "");
  const hits: PatternEntry[] = [];
  for (const entry of INJECTION_PATTERNS) {
    if (entry.pattern.test(cleaned)) {
      hits.push(entry);
    }
  }
  return { hits, cleaned };
}

export function scanForInjection(input: string): ScanResult {
  if (input.length === 0) {
    return { detected: false, confidence: "low", patterns: [] };
  }

  const allHits: PatternEntry[] = [];
  let firstCleaned = "";

  if (input.length <= WINDOW_BYTES) {
    const { hits, cleaned } = scanWindow(input);
    allHits.push(...hits);
    firstCleaned = cleaned;
  } else {
    let offset = 0;
    let firstWindow = true;
    while (offset < input.length) {
      const end = Math.min(offset + WINDOW_BYTES, input.length);
      const window = input.substring(offset, end);
      const { hits, cleaned } = scanWindow(window);
      allHits.push(...hits);
      if (firstWindow) {
        firstCleaned = cleaned;
        firstWindow = false;
      }
      if (end === input.length) break;
      offset += WINDOW_STRIDE;
    }
  }

  if (allHits.length === 0) {
    return { detected: false, confidence: "low", patterns: [] };
  }

  const seen = new Set<string>();
  const patterns: string[] = [];
  let confidence: InjectionConfidence = "low";
  for (const hit of allHits) {
    if (!seen.has(hit.name)) {
      seen.add(hit.name);
      patterns.push(hit.name);
    }
    confidence = maxConfidence(confidence, hit.confidence);
  }

  return {
    detected: true,
    confidence,
    patterns,
    sanitizedInput: firstCleaned.substring(0, SANITIZED_PREVIEW),
  };
}
