import { describe, it, expect } from "vitest";
import {
  evaluateFilter,
  describeMismatchReason,
  OPERATOR_LABELS,
  VALUE_REQUIRED_OPERATORS,
} from "@/lib/webhook-filter";
import { FilterRulesSchema } from "@/lib/validation";
import type { FilterRules } from "@/lib/webhook-filter";

const rule = (
  combinator: "AND" | "OR",
  conditions: FilterRules["conditions"],
): FilterRules => ({ combinator, conditions });

describe("evaluateFilter — null/empty rule sets", () => {
  it("null rules → matched", () => {
    expect(evaluateFilter(null, { anything: 1 })).toEqual({ matched: true });
  });

  it("undefined rules → matched", () => {
    expect(evaluateFilter(undefined, {})).toEqual({ matched: true });
  });

  it("empty conditions → matched", () => {
    expect(evaluateFilter(rule("AND", []), {})).toEqual({ matched: true });
    expect(evaluateFilter(rule("OR", []), {})).toEqual({ matched: true });
  });
});

describe("evaluateFilter — equals", () => {
  it("matches a string equality", () => {
    const r = rule("AND", [
      { keyPath: "data.action", operator: "equals", value: "create" },
    ]);
    expect(evaluateFilter(r, { data: { action: "create" } })).toMatchObject({
      matched: true,
    });
  });

  it("is case-sensitive on strings", () => {
    const r = rule("AND", [
      { keyPath: "data.action", operator: "equals", value: "create" },
    ]);
    const result = evaluateFilter(r, { data: { action: "Create" } });
    expect(result.matched).toBe(false);
  });

  it("does not trim whitespace", () => {
    const r = rule("AND", [
      { keyPath: "data.x", operator: "equals", value: "42" },
    ]);
    expect(evaluateFilter(r, { data: { x: " 42 " } }).matched).toBe(false);
  });

  it("coerces 'true'/'false' to boolean", () => {
    const r = rule("AND", [
      { keyPath: "active", operator: "equals", value: "true" },
    ]);
    expect(evaluateFilter(r, { active: true }).matched).toBe(true);
    expect(evaluateFilter(r, { active: false }).matched).toBe(false);
  });

  it("coerces numeric strings when payload is number", () => {
    const r = rule("AND", [
      { keyPath: "count", operator: "equals", value: "42" },
    ]);
    expect(evaluateFilter(r, { count: 42 }).matched).toBe(true);
    expect(evaluateFilter(r, { count: 43 }).matched).toBe(false);
    // payload string "42" still matches by string comparison
    expect(evaluateFilter(r, { count: "42" }).matched).toBe(true);
  });

  it("returns not-matched on missing path (failure-open)", () => {
    const r = rule("AND", [
      { keyPath: "data.x", operator: "equals", value: "1" },
    ]);
    expect(evaluateFilter(r, { data: {} }).matched).toBe(false);
    expect(evaluateFilter(r, {}).matched).toBe(false);
  });
});

describe("evaluateFilter — not_equals", () => {
  it("inverts equals", () => {
    const r = rule("AND", [
      { keyPath: "data.action", operator: "not_equals", value: "remove" },
    ]);
    expect(
      evaluateFilter(r, { data: { action: "create" } }).matched,
    ).toBe(true);
    expect(
      evaluateFilter(r, { data: { action: "remove" } }).matched,
    ).toBe(false);
  });

  it("returns matched on missing path (not-equals to anything is true when field absent)", () => {
    // Per the locked policy, equals on missing returns false; therefore
    // not_equals on missing returns true. Documented at U2 in the plan.
    const r = rule("AND", [
      { keyPath: "data.action", operator: "not_equals", value: "create" },
    ]);
    expect(evaluateFilter(r, {}).matched).toBe(true);
  });
});

describe("evaluateFilter — contains / not_contains", () => {
  it("substring match on strings", () => {
    const r = rule("AND", [
      {
        keyPath: "data.url",
        operator: "contains",
        value: "linear.app",
      },
    ]);
    expect(
      evaluateFilter(r, { data: { url: "https://linear.app/x/issue/Y" } })
        .matched,
    ).toBe(true);
    expect(
      evaluateFilter(r, { data: { url: "https://other.example/x" } }).matched,
    ).toBe(false);
  });

  it("element match on arrays", () => {
    const r = rule("AND", [
      { keyPath: "data.labels", operator: "contains", value: "bug" },
    ]);
    expect(
      evaluateFilter(r, { data: { labels: ["enhancement", "bug"] } }).matched,
    ).toBe(true);
    expect(
      evaluateFilter(r, { data: { labels: ["enhancement"] } }).matched,
    ).toBe(false);
  });

  it("returns false on non-string non-array fields, no throw", () => {
    const r = rule("AND", [
      { keyPath: "count", operator: "contains", value: "1" },
    ]);
    expect(evaluateFilter(r, { count: 42 }).matched).toBe(false);
    expect(evaluateFilter(r, { count: { nested: true } }).matched).toBe(false);
  });

  it("not_contains inverts contains", () => {
    const r = rule("AND", [
      { keyPath: "title", operator: "not_contains", value: "DRAFT" },
    ]);
    expect(evaluateFilter(r, { title: "Real ticket" }).matched).toBe(true);
    expect(evaluateFilter(r, { title: "DRAFT issue" }).matched).toBe(false);
  });
});

describe("evaluateFilter — exists / not_exists", () => {
  it("exists matches present non-null fields", () => {
    const r = rule("AND", [
      { keyPath: "event.bot_id", operator: "exists" },
    ]);
    expect(evaluateFilter(r, { event: { bot_id: "B123" } }).matched).toBe(true);
    expect(evaluateFilter(r, { event: { bot_id: null } }).matched).toBe(false);
    expect(evaluateFilter(r, { event: {} }).matched).toBe(false);
  });

  it("not_exists matches missing/null fields", () => {
    const r = rule("AND", [
      { keyPath: "event.bot_id", operator: "not_exists" },
    ]);
    expect(evaluateFilter(r, { event: {} }).matched).toBe(true);
    expect(evaluateFilter(r, { event: { bot_id: null } }).matched).toBe(true);
    expect(evaluateFilter(r, {}).matched).toBe(true);
    expect(evaluateFilter(r, { event: { bot_id: "B" } }).matched).toBe(false);
  });
});

describe("evaluateFilter — combinators", () => {
  it("AND requires all conditions to match", () => {
    const r = rule("AND", [
      { keyPath: "action", operator: "equals", value: "create" },
      { keyPath: "type", operator: "equals", value: "Issue" },
    ]);
    expect(
      evaluateFilter(r, { action: "create", type: "Issue" }).matched,
    ).toBe(true);
    const partial = evaluateFilter(r, { action: "create", type: "Comment" });
    expect(partial.matched).toBe(false);
    if (!partial.matched) {
      expect(partial.failingCondition?.keyPath).toBe("type");
    }
  });

  it("OR requires at least one match", () => {
    const r = rule("OR", [
      { keyPath: "action", operator: "equals", value: "opened" },
      { keyPath: "action", operator: "equals", value: "reopened" },
    ]);
    expect(evaluateFilter(r, { action: "opened" }).matched).toBe(true);
    expect(evaluateFilter(r, { action: "reopened" }).matched).toBe(true);
    expect(evaluateFilter(r, { action: "closed" }).matched).toBe(false);
  });
});

describe("evaluateFilter — adversarial input", () => {
  it("does not throw on null payload", () => {
    const r = rule("AND", [
      { keyPath: "x", operator: "equals", value: "1" },
    ]);
    expect(evaluateFilter(r, null).matched).toBe(false);
  });

  it("does not throw on primitive payload", () => {
    const r = rule("AND", [
      { keyPath: "x", operator: "equals", value: "1" },
    ]);
    expect(evaluateFilter(r, "not an object").matched).toBe(false);
    expect(evaluateFilter(r, 42).matched).toBe(false);
  });

  it("does not throw when traversing through a primitive mid-path", () => {
    const r = rule("AND", [
      { keyPath: "data.url", operator: "equals", value: "x" },
    ]);
    expect(evaluateFilter(r, { data: "string" }).matched).toBe(false);
  });

  it("returns error when conditions exceed hard cap", () => {
    const conditions = Array.from({ length: 51 }, (_, i) => ({
      keyPath: `f${i}`,
      operator: "exists" as const,
    }));
    const r = rule("AND", conditions);
    const result = evaluateFilter(r, {});
    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.error).toContain("condition_cap_exceeded");
    }
  });
});

describe("describeMismatchReason", () => {
  it("describes a normal mismatch", () => {
    expect(
      describeMismatchReason({
        matched: false,
        failingCondition: {
          keyPath: "data.action",
          operator: "equals",
          value: "create",
        },
      }),
    ).toBe('condition_no_match: data.action equals "create"');
  });

  it("describes an evaluator error", () => {
    expect(
      describeMismatchReason({
        matched: false,
        error: "boom",
      }),
    ).toBe("evaluator_error: boom");
  });

  it("omits value for existence operators", () => {
    expect(
      describeMismatchReason({
        matched: false,
        failingCondition: { keyPath: "x", operator: "exists" },
      }),
    ).toBe("condition_no_match: x exists");
  });
});

describe("OPERATOR_LABELS / VALUE_REQUIRED_OPERATORS", () => {
  it("provides a label for every operator", () => {
    for (const op of [
      "equals",
      "not_equals",
      "contains",
      "not_contains",
      "exists",
      "not_exists",
    ] as const) {
      expect(OPERATOR_LABELS[op]).toBeTruthy();
    }
  });

  it("VALUE_REQUIRED_OPERATORS excludes existence operators", () => {
    expect(VALUE_REQUIRED_OPERATORS.has("equals")).toBe(true);
    expect(VALUE_REQUIRED_OPERATORS.has("contains")).toBe(true);
    expect(VALUE_REQUIRED_OPERATORS.has("exists")).toBe(false);
    expect(VALUE_REQUIRED_OPERATORS.has("not_exists")).toBe(false);
  });
});

describe("FilterRulesSchema (Zod)", () => {
  it("accepts a valid rule set", () => {
    const result = FilterRulesSchema.safeParse({
      combinator: "AND",
      conditions: [
        { keyPath: "data.action", operator: "equals", value: "create" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty conditions (length 0)", () => {
    const result = FilterRulesSchema.safeParse({
      combinator: "AND",
      conditions: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid keyPath (special chars)", () => {
    const result = FilterRulesSchema.safeParse({
      combinator: "AND",
      conditions: [
        { keyPath: "data.url!", operator: "equals", value: "x" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects double-dot keyPath", () => {
    const result = FilterRulesSchema.safeParse({
      combinator: "AND",
      conditions: [{ keyPath: "data..x", operator: "equals", value: "y" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown operator", () => {
    const result = FilterRulesSchema.safeParse({
      combinator: "AND",
      conditions: [{ keyPath: "x", operator: "in", value: "a,b" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects > 50 conditions", () => {
    const result = FilterRulesSchema.safeParse({
      combinator: "AND",
      conditions: Array.from({ length: 51 }, () => ({
        keyPath: "x",
        operator: "exists",
      })),
    });
    expect(result.success).toBe(false);
  });

  it("requires value for equals", () => {
    const result = FilterRulesSchema.safeParse({
      combinator: "AND",
      conditions: [{ keyPath: "x", operator: "equals" }],
    });
    expect(result.success).toBe(false);
  });

  it("does not require value for exists", () => {
    const result = FilterRulesSchema.safeParse({
      combinator: "AND",
      conditions: [{ keyPath: "x", operator: "exists" }],
    });
    expect(result.success).toBe(true);
  });
});
