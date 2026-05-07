/**
 * Per-platform message size + edit-rate constants. Single source of truth so
 * the workflow's rollover and the callback's 429 handling reference one map.
 *
 * Plan reference: U6 in
 * docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
 */

import type { ChatPlatform } from "@/lib/platform/operations";

export interface PlatformLimit {
  /** Maximum characters per single platform message before rollover fires. */
  maxPerMessage: number;
  /** Per-channel edit-rate ceiling — used by the dynamic edit-gate logic. */
  editsPer5Sec: number;
}

export const PLATFORM_LIMITS: Record<ChatPlatform, PlatformLimit> = {
  discord: { maxPerMessage: 2000, editsPer5Sec: 5 },
  slack: { maxPerMessage: 40000, editsPer5Sec: 100 },
};

export const DEFAULT_EDIT_GATE_MS = 1500;

// Approximate runner chunk inter-arrival under typical agent generation.
// Used to translate WDK-deterministic chunk counts into wall-clock
// estimates (CHUNKS_PER_FLUSH × this ≈ user-visible edit cadence).
export const APPROX_CHUNK_INTERVAL_MS = 250;

// Target wall-clock interval between platform edits during streaming.
// Combined with APPROX_CHUNK_INTERVAL_MS, gives the chunk-count gate.
export const EDIT_FLUSH_INTERVAL_MS = 1000;

// Cap on how many chunks the chat workflow skips after a 429 before
// retrying. Keeps the loop responsive on slow models and bounds
// stream-buffer accumulation.
export const MAX_RATE_LIMITED_BACKOFF_CHUNKS = 12;
