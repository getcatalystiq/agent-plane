/**
 * U0 Phase 0 spike — streaming workflow.
 *
 * Exercises the WDK primitives the dispatch refactor depends on:
 *   - createHook with a deterministic custom token reconstructable from messageId
 *   - hook iteration via `for await` in workflow body
 *   - writing each iterated chunk via getWritable in a step
 *   - termination on a sentinel-kind chunk
 *
 * **WDK constraints learned during U0 (preserved as code comments because
 *  they materially shape U2's dispatch refactor):**
 *
 *   1. `createHook()` must be called from a workflow function (NOT a step)
 *   2. The `Hook<T>` object cannot cross the workflow→step boundary (it
 *      carries non-serializable Symbols and AsyncGeneratorFunctions)
 *   3. Stream writes via `getWritable().getWriter().write()` must happen
 *      INSIDE a step (workflow body throws "Not supported in workflow
 *      functions")
 *
 *  Therefore: createHook + `for await` iteration live in the workflow body.
 *  Each chunk's data (a string — serializable) is passed to a write step.
 *  This is the pattern U2's `streamFromHook` step in the dispatch refactor
 *  must follow.
 *
 * Plan reference: U0 in docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md
 */
import { createHook, getWritable } from "workflow";

export interface SpikeStreamingInput {
  messageId: string;
}

export interface SpikeStreamingOutput {
  messageId: string;
  token: string;
  chunksWritten: number;
}

export type SpikeChunk = { kind: "chunk" | "terminal"; data: string };

export async function spikeStreamingWorkflow(
  input: SpikeStreamingInput,
): Promise<SpikeStreamingOutput> {
  "use workflow";

  const token = `spike:transcript:${input.messageId}`;
  const hook = createHook<SpikeChunk>({ token });

  let chunksWritten = 0;
  for await (const payload of hook) {
    await spikeWriteChunk(payload.data);
    chunksWritten++;
    if (payload.kind === "terminal") {
      break;
    }
  }

  return { messageId: input.messageId, token, chunksWritten };
}

async function spikeWriteChunk(data: string): Promise<void> {
  "use step";
  const writer = getWritable<string>().getWriter();
  try {
    await writer.write(data);
  } finally {
    writer.releaseLock();
  }
}
