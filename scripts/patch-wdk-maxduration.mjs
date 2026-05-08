#!/usr/bin/env node
/**
 * Postinstall patch for the @workflow/next package source.
 *
 * The package writes
 *   { "maxDuration": "max", ... }
 * into the auto-generated `.vc-config.json` for
 *   /.well-known/workflow/v1/step.func
 *   /.well-known/workflow/v1/flow.func
 *
 * Per Vercel's Build Output API spec
 * (https://vercel.com/docs/build-output-api/primitives), `maxDuration`
 * must be an Integer. The literal string `"max"` is NOT a valid value.
 *
 * Empirically confirmed (May 2026): three separate `consumeAndPostStep`
 * runs died at exactly 120.52 seconds while consuming a long Slack
 * chat reply, leaving 12-minute zombie inner workflow runs that ate
 * sandbox time + transcript blob bytes the user never saw. The Slack
 * reply silently truncates at the 120s mark.
 *
 * Vercel build pipeline ordering forecloses post-build patching of the
 * generated `.vc-config.json`:
 *   `vercel build`
 *     -> runs vercel.json `buildCommand` (= our `next build`)
 *        - WDK plugin writes intermediate `.well-known/workflow/v1/config.json`
 *        - Next.js bundles workflow routes
 *     -> AFTER buildCommand returns, vercel build assembles `.vercel/output/`
 *        and writes the final `.vc-config.json` files (this is where the
 *        `"max"` lands; we cannot reach it from buildCommand).
 * No public hook fires after that finalization, so the only point we
 * can intervene is *before* the generation: patch the source of truth
 * inside `node_modules/@workflow/next/dist/builder-eager.js` itself.
 *
 * Mechanism: replace the two `maxDuration: 'max',` literals with
 * `maxDuration: 800,` (Pro Fluid plan max). Idempotent — re-running on
 * an already-patched file is a no-op. Runs via `postinstall` so it
 * applies after every `npm install` in CI and locally.
 *
 * When upstream WDK emits a real integer or supports a config override
 * for max, delete this script and remove the `postinstall` entry from
 * package.json.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const PRO_FLUID_MAX_SECONDS = 800;
const TARGETS = [
  "node_modules/@workflow/next/dist/builder-eager.js",
  "node_modules/@workflow/builders/dist/vercel-build-output-api.js",
];

const NEEDLE = /maxDuration:\s*['"]max['"]/g;

async function patchOne(rel) {
  const abs = resolve(process.cwd(), rel);
  let raw;
  try {
    raw = await readFile(abs, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { rel, status: "missing" };
    throw err;
  }

  const matches = raw.match(NEEDLE);
  if (!matches) {
    if (raw.includes(`maxDuration: ${PRO_FLUID_MAX_SECONDS}`)) {
      return { rel, status: "already_patched" };
    }
    return { rel, status: "needle_missing" };
  }

  const patched = raw.replace(NEEDLE, `maxDuration: ${PRO_FLUID_MAX_SECONDS}`);
  await writeFile(abs, patched, "utf8");
  return { rel, status: "patched", count: matches.length };
}

async function main() {
  let anyPatched = false;
  for (const rel of TARGETS) {
    const result = await patchOne(rel);
    if (result.status === "patched") {
      console.log(`[patch-wdk-maxduration] PATCHED ${rel}: ${result.count}× 'max' -> ${PRO_FLUID_MAX_SECONDS}`);
      anyPatched = true;
    } else if (result.status === "already_patched") {
      console.log(`[patch-wdk-maxduration] OK ${rel}: already ${PRO_FLUID_MAX_SECONDS}`);
    } else if (result.status === "missing") {
      console.log(`[patch-wdk-maxduration] SKIP ${rel}: not installed`);
    } else if (result.status === "needle_missing") {
      console.log(`[patch-wdk-maxduration] WARN ${rel}: 'maxDuration: "max"' not found — upstream may have changed; please verify and update this script`);
    }
  }
  if (!anyPatched) {
    console.log("[patch-wdk-maxduration] No patches applied (already current or upstream changed).");
  }
}

main().catch((err) => {
  console.error("[patch-wdk-maxduration] Fatal:", err);
  process.exit(1);
});
