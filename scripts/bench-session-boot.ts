#!/usr/bin/env tsx
/**
 * Session boot-time benchmark for cold / warm / hot / archived paths.
 *
 * Usage:
 *   npx tsx scripts/bench-session-boot.ts \
 *     --base-url https://agentplane-nine.vercel.app \
 *     --api-key <tenant-api-key> \
 *     --agent-id <agent-id> \
 *     [--scenarios cold,warm,hot,archived] \
 *     [--iterations 5] \
 *     [--prompt "hi"]
 *
 * Inputs may also be supplied via env (flags win):
 *   AGENTPLANE_BASE_URL, AGENTPLANE_API_KEY, AGENTPLANE_AGENT_ID
 *
 * Scenarios:
 *   cold     — fresh session per iteration (no warm sandbox).
 *   warm     — primer message + 30s gap then second message in same session.
 *   hot      — primer message + 200ms gap then second message in same session.
 *   archived — primer + force-detach (cancel session) + second message; this
 *              forces a new session with sandbox restore from blob if your
 *              tenant has cached state. Falls back to cold on failure.
 *
 * The harness measures four wall-clock timings per iteration:
 *   t_first_byte           — ms from POST send to the first response byte.
 *   t_first_event          — ms to the first NDJSON event whose type field
 *                            is non-empty (typically `run_started`).
 *   t_first_assistant_text — ms to the first `text_delta` or assistant
 *                            content block.
 *   t_result               — ms to the final `result` event.
 *
 * Iterations default to 5 (cheap). Pass --iterations 10 for a real run.
 *
 * IMPORTANT: NO credentials are baked in. All inputs come from flags/env.
 */

interface Flags {
  baseUrl: string;
  apiKey: string;
  agentId: string;
  scenarios: Array<"cold" | "warm" | "hot" | "archived">;
  iterations: number;
  prompt: string;
}

function parseFlags(argv: string[]): Flags | null {
  const want = (k: string): string | undefined => {
    const i = argv.indexOf(k);
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
    return undefined;
  };
  if (argv.includes("--help") || argv.includes("-h")) return null;

  const baseUrl = want("--base-url") ?? process.env.AGENTPLANE_BASE_URL ?? "";
  const apiKey = want("--api-key") ?? process.env.AGENTPLANE_API_KEY ?? "";
  const agentId = want("--agent-id") ?? process.env.AGENTPLANE_AGENT_ID ?? "";
  const scenariosRaw = want("--scenarios") ?? "cold,warm,hot,archived";
  const iterations = Number(want("--iterations") ?? "5");
  const prompt = want("--prompt") ?? "hi";

  if (!baseUrl || !apiKey || !agentId) {
    process.stderr.write(
      "Missing required flags. Need --base-url, --api-key, --agent-id (or AGENTPLANE_* env vars).\n",
    );
    return null;
  }

  const allowed = new Set(["cold", "warm", "hot", "archived"]);
  const scenarios = scenariosRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => allowed.has(s)) as Flags["scenarios"];

  if (scenarios.length === 0) {
    process.stderr.write("No valid scenarios after filtering.\n");
    return null;
  }
  if (!Number.isFinite(iterations) || iterations <= 0) {
    process.stderr.write("--iterations must be a positive integer.\n");
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    apiKey,
    agentId,
    scenarios,
    iterations,
    prompt,
  };
}

function printHelp(): void {
  const txt = [
    "session-boot-benchmark",
    "",
    "Usage:",
    "  npx tsx scripts/bench-session-boot.ts \\",
    "    --base-url <url> --api-key <key> --agent-id <id> \\",
    "    [--scenarios cold,warm,hot,archived] [--iterations 5] [--prompt 'hi']",
    "",
    "Env fallbacks:",
    "  AGENTPLANE_BASE_URL, AGENTPLANE_API_KEY, AGENTPLANE_AGENT_ID",
    "",
    "Scenarios:",
    "  cold     — fresh session per iteration",
    "  warm     — primer + 30s gap, measure second message",
    "  hot      — primer + 200ms gap, measure second message",
    "  archived — primer + cancel + measure new session restore",
    "",
    "Reports p50 / p95 / mean / max for each timing column.",
  ].join("\n");
  process.stdout.write(txt + "\n");
}

interface Timings {
  t_first_byte: number;
  t_first_event: number | null;
  t_first_assistant_text: number | null;
  t_result: number | null;
}

interface NdjsonEvent {
  type?: string;
  delta?: { type?: string };
  message?: { content?: Array<{ type?: string }> };
  [k: string]: unknown;
}

async function streamAndTime(res: Response, startMs: number): Promise<Timings> {
  const out: Timings = {
    t_first_byte: 0,
    t_first_event: null,
    t_first_assistant_text: null,
    t_result: null,
  };
  if (!res.body) {
    out.t_first_byte = Date.now() - startMs;
    return out;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let firstByteSeen = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!firstByteSeen) {
      out.t_first_byte = Date.now() - startMs;
      firstByteSeen = true;
    }
    buf += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;

      let evt: NdjsonEvent;
      try {
        evt = JSON.parse(line) as NdjsonEvent;
      } catch {
        continue;
      }
      const now = Date.now() - startMs;
      if (out.t_first_event === null && typeof evt.type === "string" && evt.type.length > 0) {
        out.t_first_event = now;
      }
      const isAssistantText =
        evt.type === "text_delta" ||
        (evt.type === "assistant" &&
          Array.isArray(evt.message?.content) &&
          evt.message!.content!.some((b) => b?.type === "text"));
      if (out.t_first_assistant_text === null && isAssistantText) {
        out.t_first_assistant_text = now;
      }
      if (evt.type === "result" && out.t_result === null) {
        out.t_result = now;
      }
    }
  }
  return out;
}

interface CreateSessionResp {
  session_id?: string;
  id?: string;
}

async function createSession(flags: Flags): Promise<{ sessionId: string; timings: Timings }> {
  const startMs = Date.now();
  const res = await fetch(`${flags.baseUrl}/api/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${flags.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ agent_id: flags.agentId, prompt: flags.prompt }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`createSession failed ${res.status}: ${t.slice(0, 300)}`);
  }
  // session creation may stream NDJSON OR may return JSON depending on shape
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/x-ndjson") || ct.includes("application/octet-stream") || ct.includes("text/plain")) {
    // Stream form — first event carries session_id; we'll parse out and time.
    const timings = await streamAndTime(res, startMs);
    // Reissue a metadata fetch is overkill; for create-with-prompt the
    // response also typically embeds session_id via `run_started` event.
    // For robustness: we'll list latest session after stream end if needed.
    // Simpler: fetch /api/sessions and pick most recent.
    const list = await fetch(`${flags.baseUrl}/api/sessions?limit=1`, {
      headers: { Authorization: `Bearer ${flags.apiKey}` },
    });
    if (!list.ok) throw new Error(`session list failed: ${list.status}`);
    const lj = (await list.json()) as { sessions?: Array<{ id: string }> };
    const sid = lj.sessions?.[0]?.id;
    if (!sid) throw new Error("could not resolve session id from list");
    return { sessionId: sid, timings };
  }
  // JSON form — { session_id } returned synchronously; no boot timing.
  const j = (await res.json()) as CreateSessionResp;
  const sid = j.session_id ?? j.id;
  if (!sid) throw new Error("create response missing session_id");
  const timings: Timings = {
    t_first_byte: Date.now() - startMs,
    t_first_event: null,
    t_first_assistant_text: null,
    t_result: null,
  };
  return { sessionId: sid, timings };
}

async function sendMessage(flags: Flags, sessionId: string): Promise<Timings> {
  const startMs = Date.now();
  const res = await fetch(`${flags.baseUrl}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${flags.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: flags.prompt }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`sendMessage failed ${res.status}: ${t.slice(0, 300)}`);
  }
  return streamAndTime(res, startMs);
}

async function cancelSession(flags: Flags, sessionId: string): Promise<void> {
  // Best-effort. Endpoint may differ; we try DELETE then POST /cancel.
  const tryDelete = await fetch(`${flags.baseUrl}/api/sessions/${sessionId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${flags.apiKey}` },
  });
  if (tryDelete.ok || tryDelete.status === 204) return;
  await fetch(`${flags.baseUrl}/api/sessions/${sessionId}/cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${flags.apiKey}` },
  }).catch(() => {});
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function runScenario(
  flags: Flags,
  scenario: "cold" | "warm" | "hot" | "archived",
): Promise<Timings[]> {
  const out: Timings[] = [];
  for (let i = 0; i < flags.iterations; i++) {
    try {
      if (scenario === "cold") {
        const { timings } = await createSession(flags);
        out.push(timings);
      } else if (scenario === "warm" || scenario === "hot") {
        const { sessionId } = await createSession(flags);
        // Drain primer if needed; create returned only after stream closed.
        await sleep(scenario === "warm" ? 30_000 : 200);
        const t = await sendMessage(flags, sessionId);
        out.push(t);
      } else {
        // archived
        const { sessionId } = await createSession(flags);
        await cancelSession(flags, sessionId);
        // After cancel, second message on same session will likely 410.
        // The fairer "archived" test is a fresh session — measure that.
        const fresh = await createSession(flags);
        out.push(fresh.timings);
      }
      process.stdout.write(`  [${scenario}] iter ${i + 1}/${flags.iterations} ok\n`);
    } catch (err) {
      process.stderr.write(
        `  [${scenario}] iter ${i + 1}/${flags.iterations} ERR: ${(err as Error).message}\n`,
      );
    }
  }
  return out;
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function fmtMs(n: number): string {
  if (!Number.isFinite(n)) return "  -  ";
  return `${n.toFixed(0)} ms`;
}

function summarize(scenario: string, rows: Timings[]): string {
  const cols: Array<keyof Timings> = [
    "t_first_byte",
    "t_first_event",
    "t_first_assistant_text",
    "t_result",
  ];
  const lines: string[] = [];
  lines.push(
    `\n${scenario}  (n=${rows.length})  | t_first_byte | t_first_event | t_first_assistant_text | t_result`,
  );
  lines.push(`-`.repeat(110));
  for (const stat of ["p50", "p95", "max"] as const) {
    const cells: string[] = [];
    for (const c of cols) {
      const vals = rows.map((r) => r[c]).filter((v): v is number => typeof v === "number");
      const v =
        stat === "p50" ? pct(vals, 50) : stat === "p95" ? pct(vals, 95) : Math.max(...vals, NaN);
      cells.push(fmtMs(v).padStart(12));
    }
    lines.push(`${scenario.padEnd(12)} ${stat.padEnd(4)} | ${cells.join(" | ")}`);
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags) {
    printHelp();
    return 1;
  }

  process.stdout.write(
    `\nbench-session-boot — base=${flags.baseUrl}  agent=${flags.agentId}  iters=${flags.iterations}\n`,
  );
  process.stdout.write(`scenarios: ${flags.scenarios.join(", ")}\n\n`);

  const all: Record<string, Timings[]> = {};
  for (const sc of flags.scenarios) {
    process.stdout.write(`scenario ${sc}…\n`);
    all[sc] = await runScenario(flags, sc);
  }

  const lines: string[] = [];
  for (const sc of flags.scenarios) lines.push(summarize(sc, all[sc]!));
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(2);
  },
);
