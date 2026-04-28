# Session boot benchmark

Measures the wall-clock latency of the four primary session-message paths:
**cold**, **warm**, **hot**, and **archived**. Use this to validate the
`activeSessions` LRU cache (Optimization A) and to catch regressions in the
sandbox reconnect / restore-from-blob path.

The harness lives at `scripts/bench-session-boot.ts` and is wired into
`package.json` as `npm run bench:session`.

## Running

```bash
# Cheapest run (5 iterations per scenario):
npm run bench:session -- \
  --base-url https://agentplane-nine.vercel.app \
  --api-key "$AGENTPLANE_API_KEY" \
  --agent-id "$AGENT_ID"

# Real measurement (10 iterations):
npm run bench:session -- \
  --base-url https://agentplane-nine.vercel.app \
  --api-key "$AGENTPLANE_API_KEY" \
  --agent-id "$AGENT_ID" \
  --iterations 10

# Subset of scenarios:
npm run bench:session -- \
  --scenarios cold,hot \
  --base-url ... --api-key ... --agent-id ...
```

Inputs may be supplied via env (flags win):
`AGENTPLANE_BASE_URL`, `AGENTPLANE_API_KEY`, `AGENTPLANE_AGENT_ID`.

The script is safe to run against production — it creates and ends sessions
through the public API. There are NO baked-in credentials.

## Scenarios

| Scenario | Setup | What it measures |
|---|---|---|
| `cold` | New session per iteration. | Sandbox cold-start (snapshot pull, MCP wire-up, identity inject, runner spawn). |
| `warm` | Primer message, **30 s** gap, then second message in the same session. | DB-backed reconnect path: `Sandbox.get()` RPC + MCP token refresh. The 30 s gap intentionally exceeds `SANDBOX_HANDLE_FRESHNESS_MS` (30 s) so the LRU cache miss is forced. |
| `hot` | Primer + **200 ms** gap + second message in the same session. | Same-isolate back-to-back hit on the `activeSessions` LRU cache (Optimization A). The `Sandbox.get()` RPC is skipped. |
| `archived` | Primer, cancel session, then a fresh session. | Restore-from-blob path approximation. Note: this currently measures a fresh cold create after a cancel because there's no public "force-detach without cancel" endpoint. Treat its numbers as cold + cancel overhead, not a pure restore-from-blob. |

## Measured timings (per iteration)

- **t_first_byte** — ms from the request being sent to the first response byte arriving. Dominated by edge → origin RTT plus any synchronous setup before NDJSON streaming starts.
- **t_first_event** — ms to the first NDJSON event with a `type` field. Typically `run_started`. Measures runner spawn + first emit.
- **t_first_assistant_text** — ms to the first `text_delta` (Vercel AI SDK) or assistant content block (Claude Agent SDK). Measures model TTFT plus everything before it.
- **t_result** — ms to the terminal `result` event. End-to-end execution.

## Interpreting p50 / p95

For each scenario the harness reports **p50**, **p95**, and **max** across iterations.

- **p50** is the typical experience. Look here when comparing optimizations head-to-head.
- **p95** captures tail latency — sandbox cold-start variability, MCP token refresh stalls, edge cold-starts. The cache win is most visible at p95: hot should be flat and tight, cold and warm carry more spread.
- **max** is your "worst this run" number. Useful for spotting outliers (e.g. one Lambda cold start mixed in with N warm hits) but not the metric you optimize against.

## Expected ordering (sanity check)

If everything is healthy:

```
hot  <  warm  ≪  cold  ≈  archived
```

A rough back-of-envelope on first-byte:

| Scenario | Expected p50 (ms) |
|---|---|
| `hot` | 50 – 200 (cache hit, no RPC) |
| `warm` | 300 – 700 (RPC + reconnect) |
| `cold` | 4 000 – 8 000 (snapshot create) |
| `archived` | 4 000 – 9 000 (cancel + fresh cold) |

If `hot` and `warm` are within ±20% of each other, the LRU cache isn't being hit
— check that messages land on the same Lambda isolate (low-traffic preview
deployments scale to a single instance, which is what you want for this bench).
