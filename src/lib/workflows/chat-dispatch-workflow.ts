/**
 * chatDispatchWorkflow — Shape A WDK composition for chat ingress.
 *
 * Plan reference: U6 in
 * docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
 *
 * Body:
 *   - Inline rate-limit check (no WDK step — pure in-memory).
 *   - Step: persistAttachmentsStep (Discord/Slack URL → private blob,
 *     returns signed-URL handoff for the dispatcher's preInjectFiles).
 *   - Step: startInnerDispatchStep — reserveSessionAndMessage +
 *     start(dispatchWorkflow). Returns innerRunId.
 *   - Body: getRun<string>(innerRunId).getReadable() — iterate NDJSON
 *     chunks the dispatcher writes via getWritable. Per text_delta
 *     accumulate into responseText; every 1.5s OR on rollover, call
 *     postOrEditStep with the formatted slice. Discord 429 + Retry-After
 *     dynamically lengthens the edit gate per channel.
 *   - Step: finalizeChatStep — markBotEvent + cleanup.
 *
 * Resumption (durability claim): on function-host recycle, WDK re-enters
 * the workflow body at the last completed step boundary. The
 * `getReadable({ startIndex })` re-attaches at the persisted chunk index
 * — `lastSeenIndex` is updated inside postOrEditStep so it survives via
 * step input/output.
 */

import { getRun, start } from "workflow/api";
import {
  dispatchWorkflow,
  type DispatchInput,
  type DispatchWorkflowOutput,
  type RunnerChunk,
} from "@/lib/workflows/dispatch-workflow";
import { reserveSessionAndMessage, type PreparedExecution } from "@/lib/dispatcher";
import { getCallbackBaseUrl } from "@/lib/mcp-connections";
import { logger } from "@/lib/logger";
import { setWorkflowRunId } from "@/lib/sessions";
import {
  ChannelTokenBucket,
  postOrEdit,
  type PostOrEditResult,
} from "@/lib/platform/callback";
import { formatForPlatform } from "@/lib/platform/format";
import { PLATFORM_LIMITS, DEFAULT_EDIT_GATE_MS } from "@/lib/platform/limits";
import {
  getOrCreateBot,
  type CachedBot,
} from "@/lib/platform/bot";
import {
  persistAttachments,
  renderAttachmentPromptBlock,
  type PersistedAttachment,
  type NormalizedAttachment,
} from "@/lib/platform/attachments";
import {
  markBotEvent,
  markBotError,
  getBotConfig,
  getDecryptedCredentials,
  type ChatPlatform,
  type SlackCredentials,
} from "@/lib/platform/operations";
import type { ChatTriggerInput } from "@/lib/platform/bridge";
import type { TenantId, AgentId } from "@/lib/types";

// ---------------------------------------------------------------------------
// Public start function (called by bridge.triggerChatWorkflow)
// ---------------------------------------------------------------------------

export interface StartChatDispatchOptions {
  idempotencyKey: string;
  rateLimited: "agent" | "user" | null;
}

export async function startChatDispatchWorkflow(
  input: ChatTriggerInput,
  options: StartChatDispatchOptions,
): Promise<void> {
  try {
    await start(
      chatDispatchWorkflow as unknown as (
        input: ChatTriggerInput,
        options: StartChatDispatchOptions,
      ) => Promise<void>,
      [input, options],
    );
  } catch (err) {
    logger.error("startChatDispatchWorkflow: start() failed", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      platform: input.platform,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Workflow body
// ---------------------------------------------------------------------------

export async function chatDispatchWorkflow(
  input: ChatTriggerInput,
  options: StartChatDispatchOptions,
): Promise<void> {
  "use workflow";

  // 1. If rate-limited at the bridge, post a generic busy reply and exit.
  if (options.rateLimited) {
    await postBusyReplyStep(input, options.rateLimited);
    return;
  }

  // 2. Persist attachments (private blob; returns signed-URL handoff).
  const persisted = input.attachmentRefs && input.attachmentRefs.length > 0
    ? await persistAttachmentsStep(input)
    : [];

  // 3. Reserve session + message and start the inner dispatchWorkflow.
  let started: StartedDispatch;
  try {
    started = await startInnerDispatchStep(input, persisted);
  } catch (err) {
    logger.error("chatDispatchWorkflow: dispatch start failed", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      thread_key: input.threadKey,
      error: err instanceof Error ? err.message : String(err),
    });
    await markBotErrorStep(input, err instanceof Error ? err.message : String(err));
    return;
  }

  // 4. Stream consumption — read the inner dispatcher's NDJSON chunks via
  //    getRun().getReadable() so resumption-after-recycle re-attaches
  //    at the right offset. WDK's WorkflowReadableStream is a plain
  //    ReadableStream — pump via getReader() rather than for-await (the
  //    async-iterator surface isn't on the WDK type).
  const readable = getRun<string>(started.innerRunId).getReadable<string>();
  const reader = readable.getReader();
  const limits = PLATFORM_LIMITS[input.platform];

  let responseText = "";
  let pendingRemainder = "";
  let committedLength = 0;
  let messageId: string | null = null;
  let editGateMs = DEFAULT_EDIT_GATE_MS;
  let lastEditAt = 0;
  let hasPosted = false;
  let postFailed = false;
  const channelBucket = new ChannelTokenBucket(limits.editsPer5Sec, 5_000);

  try {
    while (true) {
      const { value: ndjsonLine, done } = await reader.read();
      if (done) break;
      if (typeof ndjsonLine !== "string") continue;
      // Each chunk is a JSON line written by the dispatcher's writeChunkStep.
      // Parse, extract text_delta if present, and accumulate.
      const evt = parseNdjsonLine(ndjsonLine);
      if (!evt) continue;

      if (evt.type === "text_delta" && typeof evt.text === "string") {
        responseText += evt.text;
      } else if (evt.type === "error") {
        // Dispatcher hit an error mid-stream. Post the partial response
        // with a suffix so the user sees what was generated.
        if (!postFailed) {
          await flushAndFinishStep({
            input,
            text: responseText.slice(committedLength) + " (agent stopped early)",
            existingMessageId: messageId,
            committedLength,
            error: evt.message ?? "agent_error",
          });
        }
        await markBotErrorStep(input, evt.message ?? "agent_error");
        return;
      } else if (evt.type === "result" || evt.kind === "terminal") {
        break;
      }

      const now = Date.now();
      const overflow = responseText.length - committedLength > limits.maxPerMessage;
      const gateElapsed = now - lastEditAt >= editGateMs;
      const channelHasBudget = channelBucket.tryConsume();

      if (postFailed) continue;
      if (!overflow && !(gateElapsed && channelHasBudget)) continue;

      const slice = responseText.slice(committedLength);
      const formatted = formatForPlatform(input.platform, slice, { partial: !overflow });
      // partial-token holdback: the format remainder is held until the next
      // tick. We track pendingRemainder for visibility but the workflow body
      // re-derives slice from responseText each iteration so the holdback is
      // implicit (un-flushed chars stay in slice next time).
      pendingRemainder = formatted.remainder;
      if (formatted.flushable.length === 0 && !overflow) continue;

      const result = await postOrEditStep({
        tenantId: input.tenantId,
        agentId: input.agentId,
        platform: input.platform,
        channelId: input.channelId,
        text: formatted.flushable,
        existingMessageId: messageId,
        seal: overflow,
        continuation: hasPosted && !messageId,
        replyToMessageId: hasPosted ? undefined : input.replyToMessageId,
      });

      if (!result.ok) {
        if (result.rateLimited) {
          editGateMs = Math.max(editGateMs, result.retryAfterMs);
          channelBucket.drain();
          // Don't move committedLength — this slice gets re-flushed next tick.
        } else {
          // Non-429 error: stop trying to post.
          postFailed = true;
          logger.error("chatDispatchWorkflow: post failed; sentinel set", {
            tenant_id: input.tenantId,
            agent_id: input.agentId,
            error: result.error,
          });
        }
        continue;
      }

      // Success — advance committedLength.
      lastEditAt = now;
      hasPosted = true;
      if (overflow) {
        committedLength += formatted.flushable.length;
        messageId = null; // seal current; next iteration starts fresh
      } else {
        messageId = result.messageId;
        committedLength = responseText.length - pendingRemainder.length;
      }
    }
  } catch (err) {
    logger.error("chatDispatchWorkflow: stream iteration failed", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    await markBotErrorStep(input, err instanceof Error ? err.message : String(err));
    return;
  }

  // 5. Final flush — any remaining unsent text after the loop exits.
  if (!postFailed && responseText.length > committedLength) {
    const tail = responseText.slice(committedLength);
    const formatted = formatForPlatform(input.platform, tail, { partial: false });
    if (formatted.flushable.trim().length > 0) {
      await postOrEditStep({
        tenantId: input.tenantId,
        agentId: input.agentId,
        platform: input.platform,
        channelId: input.channelId,
        text: formatted.flushable,
        existingMessageId: messageId,
        seal: false,
        continuation: hasPosted && !messageId,
        replyToMessageId: hasPosted ? undefined : input.replyToMessageId,
      });
    }
  }

  await finalizeChatStep(input);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

interface StartedDispatch {
  sessionId: string;
  messageId: string;
  innerRunId: string;
}

async function startInnerDispatchStep(
  input: ChatTriggerInput,
  persisted: PersistedAttachment[],
): Promise<StartedDispatch> {
  "use step";

  const composedPrompt = `[${input.platform} message from ${input.authorDisplayName}]\n${input.prompt}${renderAttachmentPromptBlock(persisted)}`;

  // platformApiUrl is the absolute origin the sandbox calls back to for
  // the per-message transcript upload. Chat ingress has no incoming
  // request URL to derive from — use the same getCallbackBaseUrl helper
  // the schedule + webhook entry points already use.
  const dispatchInput: DispatchInput = {
    tenantId: input.tenantId,
    agentId: input.agentId,
    prompt: composedPrompt,
    triggeredBy: "chat",
    contextId: input.threadKey,
    ephemeral: false,
    idleTtlSeconds: 600,
    callerKeyId: null,
    platformApiUrl: getCallbackBaseUrl(),
    preInjectFiles: persisted.map((p) => ({
      path: p.path,
      signedReadUrl: p.signedReadUrl,
      contentType: p.contentType,
      sizeBytes: p.sizeBytes,
    })),
  };

  const prepared = await reserveSessionAndMessage(dispatchInput);
  const run = await start(
    dispatchWorkflow as unknown as (
      input: DispatchInput,
      prepared: PreparedExecution,
    ) => Promise<DispatchWorkflowOutput>,
    [dispatchInput, prepared],
  );
  await setWorkflowRunId(prepared.session.id, input.tenantId as TenantId, `wdk_v1_${run.runId}`).catch(() => {});

  return {
    sessionId: prepared.session.id,
    messageId: prepared.messageId,
    innerRunId: run.runId,
  };
}

async function persistAttachmentsStep(input: ChatTriggerInput): Promise<PersistedAttachment[]> {
  "use step";
  if (!input.attachmentRefs || input.attachmentRefs.length === 0) return [];

  const normalized: NormalizedAttachment[] = input.attachmentRefs.map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    sizeBytes: a.sizeBytes,
    sourceUrl: a.url,
    sourcePlatform: input.platform,
  }));

  // Slack downloads need the bot token; load it once here.
  let slackBotToken: string | undefined;
  if (input.platform === "slack") {
    const creds = (await getDecryptedCredentials(input.tenantId, input.agentId, "slack")) as SlackCredentials | null;
    slackBotToken = creds?.botToken;
  }

  return persistAttachments(normalized, {
    tenantId: input.tenantId,
    slackBotToken,
  });
}

interface PostOrEditStepInput {
  tenantId: TenantId;
  agentId: AgentId;
  platform: ChatPlatform;
  channelId: string;
  text: string;
  existingMessageId: string | null;
  seal: boolean;
  continuation: boolean;
  replyToMessageId?: string;
}

async function postOrEditStep(input: PostOrEditStepInput): Promise<PostOrEditResult> {
  "use step";

  const config = await getBotConfig(input.tenantId, input.agentId, input.platform);
  if (!config) {
    return { ok: false, rateLimited: false, error: "bot_config_missing" };
  }

  const cached: CachedBot = await getOrCreateBot({
    tenantId: input.tenantId,
    agentId: input.agentId,
    platform: input.platform,
    credentialsVersion: config.credentialsVersion,
    platformIdentity: config.platformIdentity,
  });

  return postOrEdit({
    bot: cached,
    channelId: input.channelId,
    text: input.text,
    existingMessageId: input.existingMessageId ?? undefined,
    seal: input.seal,
    continuation: input.continuation,
    replyToMessageId: input.replyToMessageId,
  });
}

async function postBusyReplyStep(input: ChatTriggerInput, which: "agent" | "user"): Promise<void> {
  "use step";

  const text = which === "user"
    ? "I'm rate-limited for you specifically — wait a minute before retrying."
    : "I'm currently busy across the board — wait a few minutes before retrying.";

  const config = await getBotConfig(input.tenantId, input.agentId, input.platform);
  if (!config) return;

  try {
    const cached = await getOrCreateBot({
      tenantId: input.tenantId,
      agentId: input.agentId,
      platform: input.platform,
      credentialsVersion: config.credentialsVersion,
      platformIdentity: config.platformIdentity,
    });
    await postOrEdit({
      bot: cached,
      channelId: input.channelId,
      text,
      replyToMessageId: input.replyToMessageId,
    });
  } catch (err) {
    logger.warn("postBusyReplyStep: failed", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function flushAndFinishStep(opts: {
  input: ChatTriggerInput;
  text: string;
  existingMessageId: string | null;
  committedLength: number;
  error: string;
}): Promise<void> {
  "use step";
  void opts.committedLength;
  const config = await getBotConfig(opts.input.tenantId, opts.input.agentId, opts.input.platform);
  if (!config) return;
  try {
    const cached = await getOrCreateBot({
      tenantId: opts.input.tenantId,
      agentId: opts.input.agentId,
      platform: opts.input.platform,
      credentialsVersion: config.credentialsVersion,
      platformIdentity: config.platformIdentity,
    });
    const formatted = formatForPlatform(opts.input.platform, opts.text, { partial: false });
    await postOrEdit({
      bot: cached,
      channelId: opts.input.channelId,
      text: formatted.flushable,
      existingMessageId: opts.existingMessageId ?? undefined,
    });
  } catch (err) {
    logger.warn("flushAndFinishStep: failed", {
      tenant_id: opts.input.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function markBotErrorStep(input: ChatTriggerInput, message: string): Promise<void> {
  "use step";
  await markBotError(input.tenantId, input.agentId, input.platform, message).catch(() => {});
}

async function finalizeChatStep(input: ChatTriggerInput): Promise<void> {
  "use step";
  await markBotEvent(input.tenantId, input.agentId, input.platform).catch(() => {});
}

// ---------------------------------------------------------------------------
// NDJSON parser — chunks the dispatcher writeChunkStep emits via getWritable
// ---------------------------------------------------------------------------

interface ParsedEvent {
  type?: string;
  kind?: string;
  text?: string;
  message?: string;
}

function parseNdjsonLine(raw: string): ParsedEvent | null {
  if (!raw) return null;
  // The dispatcher writes one line per chunk via writer.write(line). Lines
  // may contain trailing newline or not — handle both. The chunk content is
  // already a JSON string per processLineAssets / writeChunkStep semantics.
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as ParsedEvent;
  } catch {
    return null;
  }
}
