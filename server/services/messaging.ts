import { z } from "zod";
import { tenant, lock, type Context, type Tx } from "../db";
import { audit, enqueue, event, notify } from "../audit";
import { encrypt, decrypt, unseal } from "../crypto";
import {
  intentOf,
  isSensitive,
  manualFields,
  type HouseManual,
} from "@/lib/domain";
import { aiReply } from "../integrations/providers";
import { ensure } from "../errors";
export async function inbound(
  tx: Tx,
  ctx: Context,
  input: {
    platform: string;
    threadId: string;
    bookingId: string;
    eventId: string;
    body: string;
    sentAt: string;
  },
) {
  await lock(
    tx,
    `inbound:${ctx.workspaceId}:${input.platform}:${input.threadId}`,
  );
  const booking = await tx.booking.findFirst({
    where: {
      workspaceId: ctx.workspaceId,
      id: input.bookingId,
      platform: input.platform,
    },
  });
  ensure(
    booking,
    404,
    "BOOKING_NOT_FOUND",
    "Booking not found for this platform.",
  );
  const thread = await tx.thread.upsert({
    where: {
      workspaceId_platform_externalId: {
        workspaceId: ctx.workspaceId,
        platform: input.platform,
        externalId: input.threadId,
      },
    },
    create: {
      workspaceId: ctx.workspaceId,
      listingId: booking.listingId,
      bookingId: booking.id,
      externalId: input.threadId,
      platform: input.platform,
      intent: intentOf(input.body),
    },
    update: {},
  });
  ensure(
    thread.bookingId === booking.id,
    409,
    "THREAD_MISMATCH",
    "Thread belongs to another booking.",
  );
  const existing = await tx.message.findFirst({
    where: {
      workspaceId: ctx.workspaceId,
      threadId: thread.id,
      externalId: input.eventId,
    },
  });
  if (existing) return existing;
  await tx.thread.update({
    where: { id: thread.id },
    data: {
      status: "NEEDS_REPLY",
      intent: intentOf(input.body),
      updatedAt: new Date(),
    },
  });
  const msg = await tx.message.create({
    data: {
      workspaceId: ctx.workspaceId,
      threadId: thread.id,
      externalId: input.eventId,
      sender: "GUEST",
      status: "RECEIVED",
      bodyEncrypted: encrypt(input.body, ctx.workspaceId),
      sentAt: new Date(input.sentAt),
    },
  });
  await event(
    tx,
    ctx,
    "MESSAGE_RECEIVED",
    msg.id,
    "message:" + input.platform + ":" + input.eventId,
    { threadId: thread.id },
  );
  await audit(
    tx,
    ctx,
    "RECEIVE",
    "Message",
    msg.id,
    "Verified provider webhook accepted; rules run before the AI layer.",
  );
  await enqueue(
    tx,
    ctx,
    "EVALUATE_MESSAGE",
    msg.id,
    "evaluate:" + msg.id,
    {},
    "MESSAGING",
    false,
  );
  return msg;
}
export async function evaluateMessage(ctx: Context, messageId: string) {
  const work = await tenant(ctx, async (tx) => {
    await lock(tx, "message:" + messageId);
    const message = await tx.message.findUniqueOrThrow({
      where: { id: messageId },
    });
    const thread = await tx.thread.findUniqueOrThrow({
      where: { id: message.threadId },
    });
    const existing = await tx.message.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        replyToId: messageId,
        sender: { not: "GUEST" },
      },
    });
    if (existing) return null;
    const listing = await tx.listing.findUniqueOrThrow({
      where: { id: thread.listingId },
    });
    const body = decrypt(message.bodyEncrypted, ctx.workspaceId),
      manual = unseal<HouseManual>(
        listing.houseManualEncrypted,
        ctx.workspaceId,
      );
    const settings = await tx.automationSettings.findUniqueOrThrow({
      where: { workspaceId: ctx.workspaceId },
    });
    if (
      thread.manual ||
      settings.paused ||
      !settings.messaging ||
      isSensitive(body) ||
      intentOf(body) !== "QUESTION"
    ) {
      await notify(
        tx,
        ctx,
        "human:" + messageId,
        "A guest needs your attention",
        isSensitive(body)
          ? "A safety, refund, cancellation, or legal request requires a human."
          : "Review this conversation before replying.",
        "/inbox?thread=" + thread.id,
      );
      await audit(
        tx,
        ctx,
        "ESCALATE",
        "Message",
        messageId,
        thread.manual
          ? "Manual takeover is enabled."
          : "Automation controls or sensitive intent require human review.",
      );
      return null;
    }
    const rules = await tx.automationRule.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        enabled: true,
        trigger: "GUEST_MESSAGE",
        OR: [{ listingId: null }, { listingId: listing.id }],
      },
      orderBy: [{ priority: "asc" }, { id: "asc" }],
    });
    const rule = rules.find((r) =>
      r.keywords.some((k) =>
        new RegExp(
          "(?:^|\\W)" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:$|\\W)",
          "i",
        ).test(body),
      ),
    );
    if (rule) {
      const template = decrypt(rule.templateEncrypted, ctx.workspaceId);
      const fact = rule.manualField
        ? manual[rule.manualField as keyof HouseManual]
        : "";
      if (rule.manualField && !fact) {
        await notify(
          tx,
          ctx,
          "missing-manual:" + messageId,
          "A house-manual detail is missing",
          "Add the missing field before automated replies can use it.",
          "/inbox?thread=" + thread.id,
        );
        return null;
      }
      const reply = template.replaceAll("{{answer}}", fact);
      await createSuggestion(
        tx,
        ctx,
        thread.id,
        messageId,
        reply,
        null,
        rule.id,
        `Rule “${rule.name}” matched. Source: ${rule.manualField || "host-written template"}.`,
        rule.action === "SEND" && !isSensitive(reply),
      );
      return null;
    }
    if (!settings.ai) {
      await notify(
        tx,
        ctx,
        "unmatched:" + messageId,
        "A guest question needs a reply",
        "No response rule matched. AI is disabled; the conversation is waiting for you.",
        "/inbox?thread=" + thread.id,
      );
      return null;
    }
    return { message, thread, body, manual };
  });
  if (!work) return;
  const prompt = JSON.stringify({
    manual: work.manual,
    guestMessage: work.body,
  });
  await tenant(ctx, (tx) =>
    audit(
      tx,
      ctx,
      "EXPORT",
      "Message",
      messageId,
      "Unmatched guest message and property knowledge exported to the configured AI provider.",
      { prompt },
    ),
  );
  try {
    const result = z
      .object({
        reply: z.string().min(1).max(6000),
        confidence: z.number().min(0).max(1),
        requiresHuman: z.boolean(),
        intent: z.enum([
          "QUESTION",
          "NEGOTIATION",
          "COMPLAINT",
          "BOOKING_ADJACENT",
        ]),
        sources: z.array(z.enum(manualFields)),
      })
      .parse(await aiReply(prompt));
    await tenant(ctx, async (tx) => {
      await lock(tx, "message:" + messageId);
      if (
        await tx.message.findFirst({
          where: {
            workspaceId: ctx.workspaceId,
            replyToId: messageId,
            sender: { not: "GUEST" },
          },
        })
      )
        return;
      const thread = await tx.thread.findUniqueOrThrow({
          where: { id: work.thread.id },
        }),
        settings = await tx.automationSettings.findUniqueOrThrow({
          where: { workspaceId: ctx.workspaceId },
        });
      await audit(
        tx,
        ctx,
        "AI_DRAFT",
        "Message",
        messageId,
        "Unmatched question sent to AI after deterministic rules; prompt and response are encrypted.",
        {
          prompt,
          response: result,
          model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        },
      );
      const allow =
        !settings.paused &&
        settings.messaging &&
        settings.ai &&
        !thread.manual &&
        result.confidence >= settings.confidence &&
        !result.requiresHuman &&
        result.intent === "QUESTION" &&
        !isSensitive(work.body) &&
        !isSensitive(result.reply) &&
        result.sources.length > 0;
      await createSuggestion(
        tx,
        ctx,
        thread.id,
        messageId,
        result.reply,
        result.confidence,
        null,
        `AI confidence ${Math.round(result.confidence * 100)}%; threshold ${Math.round(settings.confidence * 100)}%. Sources: ${result.sources.join(", ") || "none"}. ${allow ? "Within current guardrails." : "Host approval required."}`,
        allow,
      );
    });
  } catch {
    await tenant(ctx, async (tx) => {
      await notify(
        tx,
        ctx,
        "ai-failed:" + messageId,
        "A reply needs your attention",
        "AI could not produce a supported reply in time. The guest message remains in your queue.",
        "/inbox?thread=" + work.thread.id,
      );
      await audit(
        tx,
        ctx,
        "AI_FAILED",
        "Message",
        messageId,
        "Provider timeout, error, or invalid output; no automated reply was sent.",
      );
    });
  }
}
async function createSuggestion(
  tx: Tx,
  ctx: Context,
  threadId: string,
  replyToId: string,
  body: string,
  confidence: number | null,
  ruleId: string | null,
  explanation: string,
  send: boolean,
) {
  const m = await tx.message.create({
    data: {
      workspaceId: ctx.workspaceId,
      threadId,
      replyToId,
      bodyEncrypted: encrypt(body, ctx.workspaceId),
      sender: confidence === null ? "RULE" : "AI",
      automated: true,
      aiConfidence: confidence,
      ruleId,
      explanation,
      status: send ? "QUEUED" : "DRAFT",
    },
  });
  await tx.thread.update({
    where: { id: threadId },
    data: { status: send ? "AUTOMATED" : "AI_DRAFTED" },
  });
  await audit(tx, ctx, "SUGGEST", "Message", m.id, explanation);
  if (send)
    await enqueue(
      tx,
      ctx,
      "GUEST_MESSAGE",
      m.id,
      "send:" + m.id,
      {},
      "MESSAGING",
    );
  else
    await notify(
      tx,
      ctx,
      "draft:" + m.id,
      "A reply is ready to review",
      "Approve, edit, or dismiss the suggested reply.",
      "/inbox?thread=" + threadId,
    );
  return m;
}
export async function reply(
  tx: Tx,
  ctx: Context,
  threadId: string,
  body: string,
  key: string,
  draftId?: string,
) {
  await lock(tx, "thread:" + threadId);
  const thread = await tx.thread.findFirst({
    where: { workspaceId: ctx.workspaceId, id: threadId },
  });
  ensure(thread, 404, "NOT_FOUND", "Conversation not found.");
  let message;
  if (draftId) {
    message = await tx.message.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        id: draftId,
        threadId,
        status: "DRAFT",
      },
    });
    ensure(message, 409, "DRAFT_CHANGED", "This draft is no longer available.");
    message = await tx.message.update({
      where: { id: draftId },
      data: {
        bodyEncrypted: encrypt(body, ctx.workspaceId),
        status: "QUEUED",
        sender: "HOST",
        automated: false,
      },
    });
  } else {
    const incoming = await tx.message.findFirst({
      where: { workspaceId: ctx.workspaceId, threadId, sender: "GUEST" },
      orderBy: { createdAt: "desc" },
    });
    message = await tx.message.upsert({
      where: {
        workspaceId_threadId_externalId: {
          workspaceId: ctx.workspaceId,
          threadId,
          externalId: "host:" + key,
        },
      },
      create: {
        workspaceId: ctx.workspaceId,
        threadId,
        externalId: "host:" + key,
        bodyEncrypted: encrypt(body, ctx.workspaceId),
        sender: "HOST",
        status: "QUEUED",
        replyToId: incoming?.id,
      },
      update: {},
    });
  }
  await enqueue(
    tx,
    ctx,
    "GUEST_MESSAGE",
    message.id,
    "send:" + message.id,
    {},
    "MESSAGING",
    false,
  );
  await audit(
    tx,
    ctx,
    "APPROVE_SEND",
    "Message",
    message.id,
    "Host confirmed this reply. External messages cannot be recalled after provider acceptance.",
  );
  return { id: message.id, status: message.status };
}
