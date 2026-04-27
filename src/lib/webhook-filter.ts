// Webhook payload filter evaluator. Pure helpers; no DB. The Zod schema for
// the rule shape lives in src/lib/validation.ts so the route, the lib, and
// the admin UI all reference the same definition.
//
// Sequencing (in src/app/api/webhooks/[sourceId]/route.ts):
//   rate-limit → load source → verify signature → parse JSON
//   → content-dedupe (src/lib/webhook-dedupe.ts)
//   → filter (this module)
//   → createRun via after()

import type {
  FilterCondition,
  FilterOperator,
  FilterRules,
} from "./validation";

export type { FilterCondition, FilterOperator, FilterRules };

// ─── Display labels (UI dropdown) ─────────────────────────────────────────────
//
// Locked here so client + server agree on what each operator looks like to
// admins. Snake_case never reaches the dropdown.

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  equals: "Equals",
  not_equals: "Does not equal",
  contains: "Contains",
  not_contains: "Does not contain",
  exists: "Exists (any value)",
  not_exists: "Is missing",
};

// Operators that require a `value`. Mirrors the Zod refine in validation.ts;
// the UI uses this to hide the value input when an existence operator is
// selected.
export const VALUE_REQUIRED_OPERATORS: ReadonlySet<FilterOperator> = new Set([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
]);

// Defense-in-depth: the Zod schema caps conditions at 50 on save, but the
// evaluator must not loop unbounded if a row is written directly to the DB.
const CONDITION_HARD_CAP = 50;

// ─── Dot-path walker ──────────────────────────────────────────────────────────
//
// Inline (10 lines, no dependency). Returns `undefined` for any miss — wrong
// type mid-path, missing field, malformed payload. Callers decide how to
// interpret undefined per-operator.

function walkDotPath(payload: unknown, path: string): unknown {
  if (payload === null || typeof payload !== "object") return undefined;
  const segments = path.split(".");
  let cursor: unknown = payload;
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

// ─── Per-condition evaluation ────────────────────────────────────────────────
//
// Locked coercion policy:
//   - String comparisons (equals/not_equals/contains/not_contains) are
//     case-sensitive. No whitespace trim.
//   - For equals/not_equals: the literal "true"/"false" string in the rule
//     coerces to boolean. A numeric-string in the rule compares numerically
//     iff the payload field is also a number.
//   - contains/not_contains works on strings (substring) and arrays (element
//     match). Anything else returns false (no throw).
//   - exists/not_exists treats null and undefined as missing.

function coerceForComparison(
  value: string,
  payloadField: unknown,
): { kind: "boolean"; v: boolean } | { kind: "number"; v: number } | { kind: "string"; v: string } {
  if (value === "true") return { kind: "boolean", v: true };
  if (value === "false") return { kind: "boolean", v: false };
  if (typeof payloadField === "number") {
    const n = Number(value);
    if (Number.isFinite(n)) return { kind: "number", v: n };
  }
  return { kind: "string", v: value };
}

function evaluateEquals(
  payloadField: unknown,
  ruleValue: string,
): boolean {
  if (payloadField === undefined || payloadField === null) return false;
  const coerced = coerceForComparison(ruleValue, payloadField);
  if (coerced.kind === "boolean") return payloadField === coerced.v;
  if (coerced.kind === "number") return payloadField === coerced.v;
  // string comparison — case-sensitive, no trim
  return typeof payloadField === "string" && payloadField === coerced.v;
}

function evaluateContains(
  payloadField: unknown,
  ruleValue: string,
): boolean {
  if (typeof payloadField === "string") {
    return payloadField.includes(ruleValue);
  }
  if (Array.isArray(payloadField)) {
    return payloadField.some((el) => {
      if (typeof el === "string") return el === ruleValue;
      if (typeof el === "number") return String(el) === ruleValue;
      return false;
    });
  }
  return false;
}

function evaluateCondition(
  condition: FilterCondition,
  payload: unknown,
): boolean {
  const fieldValue = walkDotPath(payload, condition.keyPath);

  switch (condition.operator) {
    case "exists":
      return fieldValue !== undefined && fieldValue !== null;
    case "not_exists":
      return fieldValue === undefined || fieldValue === null;
    case "equals":
      return evaluateEquals(fieldValue, condition.value ?? "");
    case "not_equals":
      return !evaluateEquals(fieldValue, condition.value ?? "");
    case "contains":
      return evaluateContains(fieldValue, condition.value ?? "");
    case "not_contains":
      return !evaluateContains(fieldValue, condition.value ?? "");
  }
}

// ─── Rule-set evaluation ─────────────────────────────────────────────────────

export interface FilterMatch {
  matched: true;
}

export interface FilterMismatch {
  matched: false;
  failingCondition?: FilterCondition;
  error?: string;
}

export type FilterEvaluation = FilterMatch | FilterMismatch;

/**
 * Evaluate a filter rule set against a parsed payload.
 *
 * Semantics:
 *   - null rules → matched (no filter configured).
 *   - empty conditions → matched (rule object exists but no conditions yet).
 *   - AND: all conditions must match.
 *   - OR: at least one condition must match.
 *
 * The evaluator owns try/catch end-to-end. Any internal throw returns
 * `{ matched: false, error: <message> }` — the route never sees an exception.
 */
export function evaluateFilter(
  rules: FilterRules | null | undefined,
  payload: unknown,
): FilterEvaluation {
  if (!rules) return { matched: true };
  if (rules.conditions.length === 0) return { matched: true };

  if (rules.conditions.length > CONDITION_HARD_CAP) {
    return {
      matched: false,
      error: `condition_cap_exceeded: ${rules.conditions.length} > ${CONDITION_HARD_CAP}`,
    };
  }

  try {
    if (rules.combinator === "AND") {
      for (const condition of rules.conditions) {
        if (!evaluateCondition(condition, payload)) {
          return { matched: false, failingCondition: condition };
        }
      }
      return { matched: true };
    }

    // OR
    for (const condition of rules.conditions) {
      if (evaluateCondition(condition, payload)) {
        return { matched: true };
      }
    }
    return {
      matched: false,
      failingCondition: rules.conditions[0],
    };
  } catch (err) {
    return {
      matched: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Build a human-readable `filtered_reason` string for the audit row and log
 * line. Routes use this to populate `webhook_deliveries.filtered_reason`.
 */
export function describeMismatchReason(evaluation: FilterMismatch): string {
  if (evaluation.error) return `evaluator_error: ${evaluation.error}`;
  const c = evaluation.failingCondition;
  if (!c) return "condition_no_match";
  const op = c.operator;
  const valuePart =
    op === "exists" || op === "not_exists" ? "" : ` "${c.value ?? ""}"`;
  return `condition_no_match: ${c.keyPath} ${op}${valuePart}`;
}
