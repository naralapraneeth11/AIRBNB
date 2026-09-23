import { db, tenant, lock, type Context } from "../db";
import { audit, notify } from "../audit";
import { randomToken, unseal, decrypt } from "../crypto";
import {
  sendSMS,
  sendEmail,
  sendChannel,
  sendPush,
} from "../integrations/providers";
import { evaluateMessage } from "./messaging";
import { pollSource } from "./calendar";
import { createTurnover } from "./cleaning";
import { isSensitive, dateOnly } from "@/lib/domain";
import { ensure } from "../errors";
import type webpush from "web-push";
export async function dispatch(ctx: Context, id: string) {
  const lease = randomToken();
  const job = await tenant(ctx, async (tx) => {
    await lock(tx, "outbox:" + id);
    const row = await tx.outbox.findFirst({
      where: {
        id,
        workspaceId: ctx.workspaceId,
        status: "PENDING",
        dueAt: { lte: new Date() },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
    });
    if (!row) return null;
    const settings = await tx.automationSettings.findUniqueOrThrow({
      where: { workspaceId: ctx.workspaceId },
    });
    if (
      row.automated &&
      (settings.paused ||
        (row.category === "CLEANING" && !settings.cleaning) ||
        (row.category === "MESSAGING" && !settings.messaging))
    )
      return null;
    const updated = await tx.outbox.updateMany({
      where: { id, status: "PENDING" },
      data: {
        status: "SENDING",
        leaseToken: lease,
        leaseUntil: new Date(Date.now() + 45000),
        attempts: { increment: 1 },
      },
    });
    return updated.count ? row : null;
  });
  if (!job) return;
  let providerId: string | undefined;
  try {
    if (job.kind === "EVALUATE_MESSAGE") {
      await evaluateMessage(ctx, job.entityId);
    } else if (job.kind === "PUSH") {
      const payload = unseal<{ title: string; body: string; href: string }>(
        job.payloadEncrypted,
        ctx.workspaceId,
      );
      const subscriptions = await tenant(ctx, (tx) =>
        tx.pushSubscription.findMany({
          where: { workspaceId: ctx.workspaceId },
        }),
      );
      for (const subscription of subscriptions) {
        try {
          await sendPush(
            unseal<webpush.PushSubscription>(
              subscription.subscriptionEncrypted,
              ctx.workspaceId,
            ),
            payload,
          );
        } catch (error) {
          if ([404, 410].includes((error as { statusCode: number }).statusCode))
            await tenant(ctx, (tx) =>
              tx.pushSubscription.delete({ where: { id: subscription.id } }),
            );
          else throw error;
        }
      }
    } else if (job.kind === "CLEANER_SMS") {
      const payload = unseal<{
        cleanerId: string;
        taskVersion: number;
        to: string;
        text: string;
      }>(job.payloadEncrypted, ctx.workspaceId);
      const allowed = await tenant(ctx, async (tx) => {
        const settings = await tx.automationSettings.findUniqueOrThrow({
          where: { workspaceId: ctx.workspaceId },
        });
        const task = await tx.cleaningTask.findFirst({
          where: { id: job.entityId, workspaceId: ctx.workspaceId },
        });
        if (
          !task ||
          task.cleanerId !== payload.cleanerId ||
          task.version !== payload.taskVersion ||
          task.status !== "ASSIGNED"
        )
          return false;
        const cleaner = await tx.cleaner.findFirst({
          where: {
            id: payload.cleanerId,
            workspaceId: ctx.workspaceId,
            enabled: true,
          },
        });
        const booking = task.bookingId
          ? await tx.booking.findFirst({
              where: { id: task.bookingId, workspaceId: ctx.workspaceId },
            })
          : null;
        return (
          !settings.paused &&
          settings.cleaning &&
          !!cleaner &&
          cleaner.listingIds.includes(task.listingId) &&
          (!task.bookingId || booking?.status === "CONFIRMED")
        );
      });
      if (!allowed) {
        await tenant(ctx, (tx) =>
          tx.outbox.update({
            where: { id },
            data: { status: "CANCELLED", leaseUntil: null, leaseToken: null },
          }),
        );
        return;
      }
      providerId = await sendSMS(payload.to, payload.text);
    } else if (job.kind === "GUEST_MESSAGE") {
      const data = await tenant(ctx, async (tx) => {
        const m = await tx.message.findUniqueOrThrow({
            where: { id: job.entityId },
          }),
          thread = await tx.thread.findUniqueOrThrow({
            where: { id: m.threadId },
          }),
          booking = await tx.booking.findUniqueOrThrow({
            where: { id: thread.bookingId },
          }),
          settings = await tx.automationSettings.findUniqueOrThrow({
            where: { workspaceId: ctx.workspaceId },
          }),
          integration = await tx.integration.findUnique({
            where: {
              workspaceId_platform: {
                workspaceId: ctx.workspaceId,
                platform: thread.platform,
              },
            },
          });
        const body = decrypt(m.bodyEncrypted, ctx.workspaceId);
        const latest = await tx.message.findFirst({
          where: {
            workspaceId: ctx.workspaceId,
            threadId: thread.id,
            sender: "GUEST",
          },
          orderBy: { createdAt: "desc" },
        });
        const stale = !!latest && m.replyToId !== latest.id;
        const gate =
          m.automated &&
          (settings.paused ||
            !settings.messaging ||
            thread.manual ||
            isSensitive(body) ||
            stale ||
            (m.sender === "AI" &&
              (!settings.ai || (m.aiConfidence || 0) < settings.confidence)));
        if (gate) {
          await tx.message.update({
            where: { id: m.id },
            data: { status: "DRAFT" },
          });
          await tx.thread.update({
            where: { id: thread.id },
            data: { status: "AI_DRAFTED" },
          });
          await tx.outbox.update({
            where: { id },
            data: { status: "CANCELLED", leaseUntil: null, leaseToken: null },
          });
          await audit(
            tx,
            ctx,
            "SEND_STOPPED",
            "Message",
            m.id,
            "Automation gate, confidence, manual takeover, or newer guest message blocked dispatch.",
          );
          return null;
        }
        if (m.status !== "QUEUED") {
          await tx.outbox.update({
            where: { id },
            data: { status: "CANCELLED", leaseUntil: null, leaseToken: null },
          });
          return null;
        }
        await audit(
          tx,
          ctx,
          "EXPORT",
          "Message",
          m.id,
          "Message content and recipient shared with the configured delivery provider.",
        );
        return { m, thread, booking, integration, body };
      });
      if (!data) return;
      const { thread, booking, integration, body } = data;
      if (thread.platform === "DIRECT") {
        const contact = decrypt(booking.guestContactEncrypted, ctx.workspaceId);
        ensure(
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact),
          422,
          "EMAIL_REQUIRED",
          "A direct-booking email address is required.",
        );
        providerId = await sendEmail(contact, body, job.key);
      } else {
        ensure(
          integration?.enabled,
          503,
          "INTEGRATION_REQUIRED",
          "An approved native messaging bridge is required for this channel.",
        );
        providerId = await sendChannel(
          decrypt(integration.endpointEncrypted, ctx.workspaceId),
          decrypt(integration.secretEncrypted, ctx.workspaceId),
          { threadId: thread.externalId, body, idempotencyKey: job.key },
        );
      }
      await tenant(ctx, async (tx) => {
        await tx.message.update({
          where: { id: job.entityId },
          data: { status: "SENT", sentAt: new Date() },
        });
        const latest = await tx.message.findFirst({
          where: {
            workspaceId: ctx.workspaceId,
            threadId: thread.id,
            sender: "GUEST",
          },
          orderBy: { createdAt: "desc" },
        });
        if (!latest || latest.id === data.m.replyToId)
          await tx.thread.update({
            where: { id: thread.id },
            data: { status: "RESOLVED" },
          });
      });
    } else throw new Error("Unknown outbox job kind");
    await tenant(ctx, async (tx) => {
      await tx.outbox.updateMany({
        where: { id, leaseToken: lease },
        data: {
          status: "DELIVERED",
          providerId,
          leaseUntil: null,
          leaseToken: null,
          error: null,
        },
      });
      await audit(
        tx,
        ctx,
        "DISPATCH",
        "Outbox",
        id,
        "Provider accepted the action or internal evaluation completed.",
        { providerId: providerId || null },
      );
    });
  } catch (error) {
    await tenant(ctx, async (tx) => {
      const safeInternal = ["EVALUATE_MESSAGE", "PUSH"].includes(job.kind);
      await tx.outbox.updateMany({
        where: { id, leaseToken: lease },
        data: {
          status: safeInternal && job.attempts < 3 ? "PENDING" : "UNKNOWN",
          dueAt: new Date(Date.now() + 60000 * 2 ** Math.min(job.attempts, 4)),
          leaseUntil: null,
          leaseToken: null,
          error:
            "Delivery was not confirmed. Inspect provider logs before retrying.",
        },
      });
      if (job.kind === "GUEST_MESSAGE")
        await tx.message.update({
          where: { id: job.entityId },
          data: { status: "DELIVERY_UNCERTAIN" },
        });
      await notify(
        tx,
        ctx,
        "delivery:" + id,
        "An action needs review",
        "A provider did not confirm delivery. Reconcile before retrying to avoid duplicates.",
        "/activity",
      );
      await audit(
        tx,
        ctx,
        "DISPATCH_FAILED",
        "Outbox",
        id,
        "External outcome is uncertain; irreversible sends are not automatically repeated.",
        { code: (error as { code?: string }).code || "PROVIDER_ERROR" },
      );
    });
  }
}
export async function drainWorkspace(workspaceId: string, budgetMs = 40000) {
  const ctx: Context = { workspaceId, actorId: "worker", role: "SYSTEM" };
  const started = Date.now();
  const sources = await tenant(ctx, (tx) =>
    tx.syncSource.findMany({
      where: {
        workspaceId,
        enabled: true,
        direction: "IMPORT",
        nextPollAt: { lte: new Date() },
      },
      take: 20,
      orderBy: { nextPollAt: "asc" },
      select: { id: true },
    }),
  );
  for (let i = 0; i < sources.length && Date.now() - started < budgetMs; i += 3)
    await Promise.allSettled(
      sources.slice(i, i + 3).map((s) => pollSource(ctx, s.id)),
    );
  await tenant(ctx, async (tx) => {
    const abandoned = await tx.outbox.findMany({
      where: { workspaceId, status: "SENDING", leaseUntil: { lt: new Date() } },
      take: 50,
    });
    for (const job of abandoned) {
      await tx.outbox.update({
        where: { id: job.id },
        data: {
          status: ["PUSH", "EVALUATE_MESSAGE"].includes(job.kind)
            ? "PENDING"
            : "UNKNOWN",
          leaseUntil: null,
          leaseToken: null,
        },
      });
      await notify(
        tx,
        ctx,
        "abandoned:" + job.id,
        "An interrupted action needs review",
        "The worker stopped before recording an outcome. Check provider history before resending.",
        "/activity",
      );
    }
    const now = new Date();
    const tasks = await tx.cleaningTask.findMany({
      where: {
        workspaceId,
        OR: [
          { status: "ASSIGNED", acceptBy: { lt: now } },
          { status: { not: "VERIFIED" }, verifyBy: { lt: now } },
        ],
      },
      take: 100,
    });
    for (const t of tasks)
      await notify(
        tx,
        ctx,
        `${t.status === "ASSIGNED" ? "accept-overdue" : "verify-overdue"}:${t.id}`,
        "A turnover needs attention",
        t.status === "ASSIGNED"
          ? "The cleaner has not accepted. Reassign before checkout."
          : "Checkout plus the cleaning buffer has passed without photo verification.",
        "/cleaning",
      );
    const stale = await tx.syncSource.findMany({
      where: {
        workspaceId,
        enabled: true,
        lastSyncedAt: {
          lt: new Date(
            Date.now() -
              (Number(process.env.SYNC_STALE_MINUTES) || 240) * 60000,
          ),
        },
      },
    });
    for (const s of stale)
      await notify(
        tx,
        ctx,
        `stale:${s.id}:${dateOnly(now)}`,
        "Calendar data is stale",
        "Dates remain protected, but the feed needs attention before new availability is trusted.",
        "/calendar",
      );
    const bookings = await tx.booking.findMany({
      where: {
        workspaceId,
        status: "CONFIRMED",
        kind: "RESERVATION",
        endDate: {
          gte: new Date(Date.now() - 86400000),
          lte: new Date(Date.now() + 90 * 86400000),
        },
      },
      take: 100,
    });
    for (const b of bookings) {
      const l = await tx.listing.findUniqueOrThrow({
        where: { id: b.listingId },
      });
      await createTurnover(tx, ctx, b, l);
    }
  });
  while (Date.now() - started < budgetMs) {
    const jobs = await tenant(ctx, async (tx) => {
      const settings = await tx.automationSettings.findUniqueOrThrow({
        where: { workspaceId },
      });
      return tx.outbox.findMany({
        where: {
          workspaceId,
          status: "PENDING",
          dueAt: { lte: new Date() },
          OR: [
            { automated: false },
            ...(!settings.paused
              ? [
                  {
                    category: {
                      in: [
                        ...(settings.cleaning ? ["CLEANING"] : []),
                        ...(settings.messaging ? ["MESSAGING"] : []),
                      ],
                    },
                  },
                ]
              : []),
          ],
        },
        orderBy: { createdAt: "asc" },
        take: 4,
        select: { id: true },
      });
    });
    if (!jobs.length) break;
    await Promise.allSettled(jobs.map((j) => dispatch(ctx, j.id)));
    break;
  }
}
export async function runCron() {
  const started = Date.now();
  const workspaces = await db.workspace.findMany({
    orderBy: { nextRunAt: "asc" },
  });
  for (const w of workspaces) {
    if (Date.now() - started > 48000) break;
    await db.workspace.update({
      where: { id: w.id },
      data: { nextRunAt: new Date(Date.now() + 60000) },
    });
    await drainWorkspace(w.id, Math.min(15000, 48000 - (Date.now() - started)));
  }
  await db.rateLimit.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - 86400000) } },
  });
  await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return { durationMs: Date.now() - started };
}
