#!/usr/bin/env bun
/**
 * WDK Spike CLI driver — exercises the U0 verification scenarios against a
 * deployed Vercel preview (or local `next dev` instance).
 *
 * The actual workflow definitions live in `src/lib/workflows/spike/*.ts` so
 * the WDK Next.js plugin transforms them at build time. The driver routes
 * at `/api/internal/wdk-spike/[scenario]` invoke them with `start()`. This
 * script POSTs to those routes and aggregates results.
 *
 * Required env:
 *   - `WDK_SPIKE_BASE_URL` — base URL (e.g., https://agentplane-xxx.vercel.app
 *     or http://localhost:3001)
 *   - `WDK_SPIKE_TOKEN` — bearer token matching the deploy's WDK_SPIKE_TOKEN
 *     env var (gates the spike route)
 *
 * Optional:
 *   - `WDK_SPIKE_LONG_IDLE_MS` — scenario 7 sleep duration (default 5000;
 *     bump to 1800000 = 30min for the deployed-preview verification)
 *
 * Plan reference: U0 in docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md
 */

interface ScenarioResult {
  scenario: number;
  status: "verified" | "unverified" | "failed";
  notes: string;
  details?: unknown;
}

const baseUrl = process.env.WDK_SPIKE_BASE_URL;
const token = process.env.WDK_SPIKE_TOKEN;
const longIdleMs = process.env.WDK_SPIKE_LONG_IDLE_MS
  ? Number(process.env.WDK_SPIKE_LONG_IDLE_MS)
  : 5_000;

if (!baseUrl) {
  console.error(
    "WDK_SPIKE_BASE_URL is required (e.g., https://agentplane-xxx.vercel.app or http://localhost:3001)",
  );
  process.exit(2);
}
if (!token) {
  console.error("WDK_SPIKE_TOKEN is required");
  process.exit(2);
}

const results: ScenarioResult[] = [];

async function runSpikeScenario(
  id: number,
  name: string,
  query: Record<string, string> = {},
): Promise<void> {
  const url = new URL(`/api/internal/wdk-spike/${id}`, baseUrl);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, v);
  }
  console.log(`\n→ Scenario ${id}: ${name}`);
  console.log(`  POST ${url.toString()}`);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });
    const text = await response.text();
    if (response.status === 404) {
      results.push({
        scenario: id,
        status: "failed",
        notes:
          "Spike route returned 404. Either the deploy doesn't have WDK_SPIKE_TOKEN set, or the route hasn't been deployed yet. Confirm the env var on Vercel and that the latest commit is deployed.",
      });
      return;
    }
    let parsed: ScenarioResult;
    try {
      parsed = JSON.parse(text) as ScenarioResult;
    } catch {
      results.push({
        scenario: id,
        status: "failed",
        notes: `Non-JSON response (status ${response.status}): ${text.slice(0, 200)}`,
      });
      return;
    }
    results.push(parsed);
  } catch (err) {
    results.push({
      scenario: id,
      status: "failed",
      notes: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }
}

async function scenario8_local(): Promise<void> {
  // Local CLI-side verification: package install + workflow/next entry point.
  try {
    const nextEntry = require.resolve("workflow/next");
    results.push({
      scenario: 8,
      status: "verified",
      notes: `workflow/next entry resolved at ${nextEntry}`,
    });
  } catch (err) {
    results.push({
      scenario: 8,
      status: "failed",
      notes:
        (err instanceof Error ? err.message : String(err)) +
        " — Next.js framework integration may need explicit registration in next.config.ts",
    });
  }
}

async function run(): Promise<void> {
  console.log("WDK spike CLI driver");
  console.log(`  base URL:      ${baseUrl}`);
  console.log(`  long-idle ms:  ${longIdleMs}`);

  await runSpikeScenario(1, "createHook + resumeHook with custom token");
  await runSpikeScenario(
    2,
    "Hook resumed before iterator parks (queue holds value)",
  );
  await runSpikeScenario(3, "getWritable inside step + getReadable from outside");
  await runSpikeScenario(
    4,
    "Reconnect by runId + startIndex (no duplicate, no skip)",
  );
  await runSpikeScenario(5, "getRun(runId).cancel() during hook iteration");
  await runSpikeScenario(6, "Step retry with stable stepId");
  await runSpikeScenario(7, "Long-idle workflow (function compute not held)", {
    sleepMs: String(longIdleMs),
  });
  await scenario8_local();

  reportResults();
}

function reportResults(): void {
  console.log("\n=== WDK SPIKE RESULTS ===");
  for (const r of results) {
    const tag =
      r.status === "verified"
        ? "✓"
        : r.status === "unverified"
          ? "?"
          : "✗";
    console.log(`${tag}  Scenario ${r.scenario} (${r.status})`);
    console.log(`     ${r.notes}`);
  }

  const failed = results.filter((r) => r.status === "failed");
  const unverified = results.filter((r) => r.status === "unverified");
  console.log(
    `\nSummary: ${results.length - failed.length - unverified.length} verified, ${unverified.length} unverified, ${failed.length} failed`,
  );

  // Hard gate per plan: items 1, 2, 5, 7 are blockers
  const blockingIds = [1, 2, 5, 7];
  const blockingFailures = results.filter(
    (r) => blockingIds.includes(r.scenario) && r.status === "failed",
  );
  if (blockingFailures.length > 0) {
    console.error(
      "\n!!! BLOCKING SCENARIOS FAILED — Pattern A may not be viable on this WDK version. Plan returns to brainstorm to evaluate Pattern B.",
    );
    process.exit(1);
  }
  if (failed.length > 0) {
    console.error(
      "\n!!! Non-blocking scenarios failed; document mitigations in docs/research/wdk-spike-results.md",
    );
    process.exit(2);
  }
  console.log("\nAll blocking scenarios verified. U2 may proceed.");
}

run().catch((err) => {
  console.error("Spike runner crashed:", err);
  process.exit(99);
});
