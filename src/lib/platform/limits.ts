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
