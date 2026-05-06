/**
 * U0 Phase 0 spike — streaming workflow.
 *
 * Exercises the WDK primitives the dispatch refactor depends on:
 *   - createHook with a deterministic custom token reconstructable from messageId
 *   - hook iteration via `for await`
 *   - getWritable + write each chunk
 *   - termination on a sentinel-kind chunk
 *
 * **WDK constraints learned during U0:**
 *   - `createHook()` must be called from a workflow function (NOT a step)
 *   - The `Hook<T>` object cannot cross the workflow→step boundary (it carries
 *     non-serializable Symbols and functions)
 *
 * Therefore: createHook AND the iteration loop both live inside the workflow
 * body. No step delegation for the hook lifecycle. This is the pattern the
 * dispatch refactor's U2 must use.
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

  const writable = getWritable<string>();
  const writer = writable.getWriter();
  let chunksWritten = 0;

  try {
    for await (const payload of hook) {
      await writer.write(payload.data);
      chunksWritten++;
      if (payload.kind === "terminal") {
        break;
      }
    }
  } finally {
    writer.releaseLock();
  }

  return { messageId: input.messageId, token, chunksWritten };
}
