import { logger } from "@/lib/logger";
import { PromptRejectedError } from "@/lib/errors";
import { scanForInjection, type ScanResult } from "@/lib/safety/injection-scanner";

/**
 * Write-time scan for admin-authored content (SoulSpec, schedule prompts,
 * skills, plugin pushes). Mirrors the dispatch-time scanner but with a
 * fixed `enforce` policy regardless of the tenant's `injection_enforce_mode`.
 *
 * Rationale (see U5 of the plan): the dispatch-time `log_only` default
 * exists because a runtime-blocked prompt has user-visible impact (a webhook
 * delivery fails, an API call returns 400). A write-time-blocked save has
 * admin-visible impact only — the form returns an error to a logged-in
 * admin who can adjust their input. Admin UX can absorb this without
 * breaking automation, so the FP cost is bounded to the admin's session
 * and the security gain is keeping malicious content out of persistent
 * storage where it would feed every dispatch via filesystem injection.
 *
 * - On `high` confidence: throws `PromptRejectedError`. The route's
 *   `withErrorHandler` returns 400 with the opaque body. The caller
 *   should NOT have written the row yet — a thrown error means roll back.
 * - On `medium` / `low`: returns the `WriteScanVerdict` so the caller can
 *   include the audit triple (`injection_detected`, `injection_confidence`,
 *   `injection_patterns`) in its UPDATE / INSERT.
 * - On clean: returns a `false`-detected verdict for column writes.
 */
export interface WriteScanVerdict {
  injection_detected: boolean;
  injection_confidence: ScanResult["confidence"] | null;
  injection_patterns: string[] | null;
}

export interface ScanContext {
  tenantId: string;
  surface: string;
}

/**
 * Scan a single field. Throws on `high`; returns the audit verdict otherwise.
 */
export function scanWriteContent(
  content: string | null | undefined,
  ctx: ScanContext,
): WriteScanVerdict {
  if (!content || content.length === 0) {
    return EMPTY_VERDICT;
  }

  const scan = scanForInjection(content);

  if (scan.detected && scan.confidence === "high") {
    logger.warn("injection_scan_blocked", {
      tenant_id: ctx.tenantId,
      gate: "write",
      surface: ctx.surface,
      confidence: scan.confidence,
      patterns: scan.patterns,
      content_length: content.length,
    });
    throw new PromptRejectedError();
  }

  if (scan.detected) {
    logger.info("injection_scan_logged", {
      tenant_id: ctx.tenantId,
      gate: "write",
      surface: ctx.surface,
      confidence: scan.confidence,
      patterns: scan.patterns,
      content_length: content.length,
    });
    return {
      injection_detected: true,
      injection_confidence: scan.confidence,
      injection_patterns: scan.patterns,
    };
  }

  return EMPTY_VERDICT;
}

/**
 * Scan multiple named fields. Throws on the FIRST `high`-confidence detection
 * (subsequent fields are not scanned because the save is going to fail
 * regardless). The returned verdict is the highest-confidence non-`high`
 * detection across fields, or the empty verdict if all fields are clean.
 *
 * The error response does NOT name which field failed — preserves the
 * opacity invariant. Callers needing the field-level signal can read the
 * structured log.
 */
export function scanWriteFields(
  fields: ReadonlyArray<{ surface: string; content: string | null | undefined }>,
  tenantId: string,
): WriteScanVerdict {
  let aggregateVerdict: WriteScanVerdict = EMPTY_VERDICT;

  for (const { surface, content } of fields) {
    const verdict = scanWriteContent(content, { tenantId, surface });
    aggregateVerdict = mergeVerdicts(aggregateVerdict, verdict);
  }

  return aggregateVerdict;
}

const EMPTY_VERDICT: WriteScanVerdict = {
  injection_detected: false,
  injection_confidence: null,
  injection_patterns: null,
};

function rank(c: WriteScanVerdict["injection_confidence"]): number {
  if (c === null) return 0;
  return c === "high" ? 3 : c === "medium" ? 2 : 1;
}

function mergeVerdicts(a: WriteScanVerdict, b: WriteScanVerdict): WriteScanVerdict {
  if (!a.injection_detected) return b;
  if (!b.injection_detected) return a;
  // Both detected — pick the higher confidence and merge patterns.
  const winner = rank(a.injection_confidence) >= rank(b.injection_confidence) ? a : b;
  const merged = new Set<string>([
    ...(a.injection_patterns ?? []),
    ...(b.injection_patterns ?? []),
  ]);
  return {
    injection_detected: true,
    injection_confidence: winner.injection_confidence,
    injection_patterns: [...merged],
  };
}
