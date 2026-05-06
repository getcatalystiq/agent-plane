/**
 * U0 Phase 0 spike — streaming workflow.
 *
 * Exercises the WDK primitives the dispatch refactor depends on:
 *   - createHook with a deterministic custom token reconstructable from messageId
 *   - hook iteration via `for await`
 *   - getWritable inside a step + getReadable from outside via run.getReadable
 *   - termination on a sentinel-kind chunk
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
}

export type SpikeChunk = { kind: "chunk" | "terminal"; data: string };

export async function spikeStreamingWorkflow(
  input: SpikeStreamingInput,
): Promise<SpikeStreamingOutput> {
  "use workflow";

  const token = `spike:transcript:${input.messageId}`;
  const hook = createHook<SpikeChunk>({ token });

  await spikeIterateAndForward(hook);

  return { messageId: input.messageId, token };
}

async function spikeIterateAndForward(
  hook: AsyncIterable<SpikeChunk>,
): Promise<void> {
  "use step";

  const writable = getWritable<string>();
  const writer = writable.getWriter();

  try {
    for await (const payload of hook) {
      await writer.write(payload.data);
      if (payload.kind === "terminal") {
        break;
      }
    }
  } finally {
    writer.releaseLock();
  }
}
