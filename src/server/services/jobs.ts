import { randomUUID } from "node:crypto";
import {
  db,
  tenant,
  lock,
  ensureDatabaseSafety,
  type Context,
  type Tx,
} from "../db";
import { audit, notify } from "../audit";
import { randomToken, unseal, decrypt } from "../crypto";
import {
  sendSMS,
  sendEmail,
  sendChannel,
  sendPush,
} from "../integrations/providers";
import { evaluateMessage } from "./messaging";
import { turnoverStanding } from "./cleaning";
import { isSensitive, dateOnly } from "@/lib/domain";
import { ensure } from "../errors";
import { reportError } from "../observability";
import { platformBudget } from "@/domain/calendar/schedule";
import { todayIn } from "@/domain/calendar/dates";
import type { Platform } from "@/domain/calendar/types";
import { runConnection } from "../calendar/run";
import {
  calendarMode,
  loadPropertyBlocks,
  publishExports,
} from "../calendar/commit";
import { fromLocalDate, toLocalDate } from "../calendar/mappers";
import type webpush from "web-push";
import { activeListingIds } from "./listings";
import { eraseExpired } from "./erasure";

/** A tick must finish inside the platform's 60 second function limit. */
export const TICK_BUDGET_MS = 48_000;
/** Longer than any tick, so an overlapping clock call skips instead of racing. */
const TICK_LEASE_MS = 58_000;
const WORKSPACE_BUDGET_MS = 15_000;
const CONNECTIONS_PER_WORKSPACE = 10;
const CONCURRENCY = 3;
/** Bounded retention for high-volume operational evidence. */
export const RETENTION = {
  observationsDays: 30,
  retrievalsDays: 14,
  ticksDays: 14,
} as const;

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
    } else if (job.kind === "CLEANER_SMS" || job.kind === "CLEANER_NOTICE") {
      const payload = unseal<{
        cleanerId: string;
        taskVersion?: number;
        to?: string;
        text: string;
      }>(job.payloadEncrypted, ctx.workspaceId);
      const recipient = await tenant(ctx, async (tx) => {
        const settings = await tx.automationSettings.findUniqueOrThrow({
          where: { workspaceId: ctx.workspaceId },
        });
        const task = await tx.cleaningTask.findFirst({
          where: { id: job.entityId, workspaceId: ctx.workspaceId },
        });
        const cleaner = await tx.cleaner.findFirst({
          where: {
            id: payload.cleanerId,
            workspaceId: ctx.workspaceId,
            enabled: true,
          },
        });
        if (!task || !cleaner || settings.paused || !settings.cleaning)
          return null;
        if (job.kind === "CLEANER_NOTICE")
          // A cancellation or change notice goes to the cleaner who held the job.
          return task.cleanerId === payload.cleanerId &&
            ["CANCELLED", "SUPERSEDED"].includes(task.status)
            ? decrypt(cleaner.phoneEncrypted, ctx.workspaceId)
            : null;
        const standing = await turnoverStanding(tx, ctx, task);
        return task.cleanerId === payload.cleanerId &&
          task.version === payload.taskVersion &&
          task.status === "ASSIGNED" &&
          cleaner.listingIds.includes(task.listingId) &&
          standing.expected &&
          !task.reviewRequired
          ? (payload.to ?? null)
          : null;
      });
      if (!recipient) {
        await tenant(ctx, (tx) =>
          tx.outbox.update({
            where: { id },
            data: { status: "CANCELLED", leaseUntil: null, leaseToken: null },
          }),
        );
        return;
      }
      providerId = await sendSMS(recipient, payload.text);
    } else if (job.kind === "GUEST_MESSAGE") {
      const data = await tenant(ctx, async (tx) => {
        const m = await tx.message.findUniqueOrThrow({
            where: { id: job.entityId },
          }),
          thread = await tx.thread.findUniqueOrThrow({
            where: { id: m.threadId },
          }),
          reservation = await tx.reservation.findUniqueOrThrow({
            where: { id: thread.reservationId },
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
        // Nothing is sent for a property removed from the app.
        const property = await tx.listing.findUniqueOrThrow({
          where: { id: thread.listingId },
          select: { archivedAt: true },
        });
        if (property.archivedAt) {
          await tx.message.update({
            where: { id: m.id },
            data: { status: "DRAFT" },
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
            "This property was removed from the app; the reply was not sent.",
          );
          return null;
        }
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
        return { m, thread, reservation, integration, body };
      });
      if (!data) return;
      const { thread, reservation, integration, body } = data;
      if (thread.platform === "DIRECT") {
        const contact = decrypt(
          reservation.guestContactEncrypted,
          ctx.workspaceId,
        );
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

/** Outbox work only: used after requests and by the tick (AUTO 03). */
export async function dispatchOutbox(workspaceId: string, budgetMs = 20000) {
  const ctx: Context = { workspaceId, actorId: "worker", role: "SYSTEM" };
  const started = Date.now();
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
  });
  // Each job is attempted at most once per drain, so a job that stays pending
  // (a gate closed, another worker holds it) cannot spin the loop.
  const attempted: string[] = [];
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
          id: { notIn: attempted },
          OR: [
            { automated: false },
            { category: { in: automatedCategories(settings) } },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: 4,
        select: { id: true },
      });
    });
    if (!jobs.length) break;
    attempted.push(...jobs.map((j) => j.id));
    await Promise.allSettled(jobs.map((j) => dispatch(ctx, j.id)));
  }
  return { dispatched: attempted.length };
}

const automatedCategories = (s: {
  paused: boolean;
  cleaning: boolean;
  messaging: boolean;
}) =>
  s.paused
    ? []
    : [
        ...(s.cleaning ? ["CLEANING"] : []),
        ...(s.messaging ? ["MESSAGING"] : []),
      ];

type TickStats = {
  workspaces: number;
  claimed: number;
  completed: number;
  failed: number;
  retries: number;
  dispatched: number;
  backlog: number;
  oldestDueAt: Date | null;
  oldestOutboxDueAt: Date | null;
};

const earliest = (a: Date | null, b: Date | null) =>
  !a ? b : !b ? a : a < b ? a : b;
const DAY_MS = 86_400_000;
const system = (workspaceId: string): Context => ({
  workspaceId,
  actorId: "worker",
  role: "SYSTEM",
});

/**
 * Stage 1 for one workspace: run its due calendar checks under the tick's
 * shared platform budgets. Claiming and fencing happen inside runConnection.
 */
type RunOptions = Pick<Parameters<typeof runConnection>[2], "fetcher">;

async function runDueConnections(
  workspaceId: string,
  deadline: number,
  budget: ReturnType<typeof platformBudget>,
  stats: TickStats,
  options: RunOptions,
) {
  const ctx = system(workspaceId);
  const now = new Date();
  const due = await tenant(ctx, (tx) =>
    tx.channelConnection.findMany({
      where: {
        workspaceId,
        enabled: true,
        importUrlEncrypted: { not: null },
        nextFetchAt: { lte: now },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      orderBy: { nextFetchAt: "asc" },
      take: CONNECTIONS_PER_WORKSPACE * 2,
      select: { id: true, platform: true },
    }),
  );
  const selected = due
    .filter((c) => budget.take(c.platform as Platform))
    .slice(0, CONNECTIONS_PER_WORKSPACE);
  for (
    let i = 0;
    i < selected.length && Date.now() < deadline;
    i += CONCURRENCY
  ) {
    const results = await Promise.allSettled(
      selected
        .slice(i, i + CONCURRENCY)
        .map((c) =>
          runConnection(ctx, c.id, { trigger: "SCHEDULED", ...options }),
        ),
    );
    for (const r of results) {
      if (r.status === "rejected") {
        stats.failed++;
        reportError(r.reason, "scheduler-run");
        continue;
      }
      // Null: another worker holds the lease or the connection changed.
      if (!r.value) continue;
      stats.claimed++;
      if (r.value.retry) stats.retries++;
      if (r.value.outcome === "BODY" || r.value.outcome === "NOT_MODIFIED")
        stats.completed++;
      else if (r.value.outcome === "FAILED") stats.failed++;
    }
  }
}

/** Cleaning deadlines and stale calendars: alerts that need no feed to be due. */
async function alertOverdue(workspaceId: string, now: Date) {
  const ctx = system(workspaceId);
  await tenant(ctx, async (tx) => {
    const tasks = await tx.cleaningTask.findMany({
      where: {
        workspaceId,
        // A removed property's work raises no alerts.
        listingId: { in: await activeListingIds(tx, ctx) },
        OR: [
          { status: "ASSIGNED", acceptBy: { lt: now } },
          {
            status: { notIn: ["VERIFIED", "CANCELLED", "SUPERSEDED"] },
            verifyBy: { lt: now },
          },
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
    // REL 01: shadow mode raises no calendar alerts.
    if ((await calendarMode(tx, ctx)) !== "LIVE") return;
    const staleBefore = new Date(
      now.getTime() - (Number(process.env.SYNC_STALE_MINUTES) || 240) * 60000,
    );
    const stale = await tx.channelConnection.findMany({
      where: {
        workspaceId,
        enabled: true,
        importUrlEncrypted: { not: null },
        createdAt: { lt: staleBefore },
        OR: [{ lastSuccessAt: null }, { lastSuccessAt: { lt: staleBefore } }],
      },
      take: 100,
    });
    for (const c of stale)
      await notify(
        tx,
        ctx,
        `stale:${c.id}:${dateOnly(now)}`,
        "Calendar data is stale",
        "Dates remain protected, but this calendar has not been checked successfully for a while.",
        "/properties?connection=" + c.id,
      );
  });
}

/**
 * EXPORT 01: an export changes by the passage of time alone when its oldest
 * event leaves the history window. Each listing records that date, so this
 * republishes once on the day it arrives instead of recomputing every tick.
 */
async function refreshAgedExports(
  workspaceId: string,
  now: Date,
  deadline: number,
) {
  const ctx = system(workspaceId);
  // No time zone is ahead of UTC+14, so no property's date is later than this.
  const latestDate = toLocalDate(new Date(now.getTime() + 14 * 3_600_000));
  const due = await tenant(ctx, (tx) =>
    tx.listing.findMany({
      where: {
        workspaceId,
        archivedAt: null,
        exportRefreshOn: { lte: fromLocalDate(latestDate) },
      },
      select: { id: true, timezone: true, exportRefreshOn: true },
      take: 50,
    }),
  );
  for (const l of due) {
    if (Date.now() > deadline) return;
    if (toLocalDate(l.exportRefreshOn!) > todayIn(l.timezone, now.getTime()))
      continue;
    await tenant(ctx, async (tx) => {
      await lock(tx, "listing:" + l.id);
      const listing = await tx.listing.findUniqueOrThrow({
        where: { id: l.id },
      });
      await publishExports(
        tx,
        ctx,
        listing,
        await loadPropertyBlocks(tx, ctx, listing.id),
        now,
      );
    });
  }
}

/** Bounded retention for high-volume operational evidence (DATA 03). */
async function pruneEvidence(workspaceId: string, now: Date) {
  await tenant(system(workspaceId), async (tx) => {
    await tx.feedObservation.deleteMany({
      where: {
        workspaceId,
        observedAt: {
          lt: new Date(now.getTime() - RETENTION.observationsDays * DAY_MS),
        },
        // Comparison snapshots (the latest two accepted per connection) and
        // each connection's newest observation stay, however old.
        snapshotEncrypted: null,
        id: { notIn: await latestObservationIds(tx, workspaceId) },
      },
    });
    await tx.exportRetrieval.deleteMany({
      where: {
        workspaceId,
        lastAt: {
          lt: new Date(now.getTime() - RETENTION.retrievalsDays * DAY_MS),
        },
      },
    });
    await tx.revokedExportToken.deleteMany({
      where: { workspaceId, expiresAt: { lt: now } },
    });
  });
}

async function latestObservationIds(tx: Tx, workspaceId: string) {
  const rows = await tx.channelConnection.findMany({
    where: { workspaceId, lastObservationId: { not: null } },
    select: { lastObservationId: true },
  });
  return rows.map((r) => r.lastObservationId!);
}

/** Remaining due work and the oldest actionable items (OPS 01 progress). */
async function measureBacklog(workspaceId: string, stats: TickStats) {
  await tenant(system(workspaceId), async (tx) => {
    const now = new Date();
    const dueWhere = {
      workspaceId,
      enabled: true,
      importUrlEncrypted: { not: null },
      nextFetchAt: { lte: now },
    };
    stats.backlog += await tx.channelConnection.count({ where: dueWhere });
    const oldest = await tx.channelConnection.findFirst({
      where: dueWhere,
      orderBy: { nextFetchAt: "asc" },
      select: { nextFetchAt: true },
    });
    stats.oldestDueAt = earliest(
      stats.oldestDueAt,
      oldest?.nextFetchAt ?? null,
    );
    const settings = await tx.automationSettings.findUnique({
      where: { workspaceId },
    });
    const outboxWhere = {
      workspaceId,
      status: "PENDING",
      dueAt: { lte: now },
      OR: [
        { automated: false },
        {
          category: {
            in: settings ? automatedCategories(settings) : [],
          },
        },
      ],
    };
    stats.backlog += await tx.outbox.count({ where: outboxWhere });
    const outbox = await tx.outbox.findFirst({
      where: outboxWhere,
      orderBy: { dueAt: "asc" },
      select: { dueAt: true },
    });
    stats.oldestOutboxDueAt = earliest(
      stats.oldestOutboxDueAt,
      outbox?.dueAt ?? null,
    );
  });
}

/**
 * ARCH 03 / OPS 01: one authenticated scheduler tick. The scheduler holds no
 * booking policy: it claims bounded durable work, records what advanced and
 * what remains, and releases its lease. A 200 from the endpoint therefore
 * never stands in for progress; the recorded tick does.
 */
export async function runTick(
  trigger: "CRON_HTTP" | "WORKER",
  /** Tests inject a fetcher; production always uses the hardened one. */
  options: RunOptions = {},
) {
  await ensureDatabaseSafety();
  const id = randomUUID();
  const startedAt = new Date();
  const holder = randomToken();
  const leased = await db.$executeRaw`
    UPDATE "SchedulerLease"
       SET "holder" = ${holder},
           "leaseUntil" = ${new Date(startedAt.getTime() + TICK_LEASE_MS)}
     WHERE "id" = 'scheduler'
       AND ("leaseUntil" IS NULL OR "leaseUntil" < ${startedAt})`;
  const stats: TickStats = {
    workspaces: 0,
    claimed: 0,
    completed: 0,
    failed: 0,
    retries: 0,
    dispatched: 0,
    backlog: 0,
    oldestDueAt: null,
    oldestOutboxDueAt: null,
  };
  if (!leased) {
    // The clock still fired: a heartbeat, but no claim on work.
    await db.schedulerTick.create({
      data: {
        id,
        trigger,
        status: "SKIPPED_OVERLAP",
        startedAt,
        completedAt: startedAt,
        durationMs: 0,
      },
    });
    return { id, status: "SKIPPED_OVERLAP" as const, durationMs: 0, ...stats };
  }
  await db.schedulerTick.create({
    data: { id, trigger, status: "RUNNING", startedAt },
  });
  let status: "COMPLETED" | "FAILED" = "COMPLETED";
  let errorCode: string | null = null;
  try {
    const deadline = startedAt.getTime() + TICK_BUDGET_MS;
    const budget = platformBudget();
    // Least recently served first, so a noisy workspace cannot starve others.
    const workspaces = await db.workspace.findMany({
      orderBy: { nextRunAt: "asc" },
      select: { id: true },
    });
    for (const w of workspaces) {
      if (Date.now() > deadline) break;
      stats.workspaces++;
      await db.workspace.update({
        where: { id: w.id },
        data: { nextRunAt: new Date(Date.now() + 60000) },
      });
      const workspaceDeadline = Math.min(
        deadline,
        Date.now() + WORKSPACE_BUDGET_MS,
      );
      try {
        await runDueConnections(
          w.id,
          workspaceDeadline,
          budget,
          stats,
          options,
        );
        stats.dispatched += (
          await dispatchOutbox(
            w.id,
            Math.max(0, workspaceDeadline - Date.now()),
          )
        ).dispatched;
        const now = new Date();
        await alertOverdue(w.id, now);
        await refreshAgedExports(w.id, now, workspaceDeadline);
        await pruneEvidence(w.id, now);
        // PRIV 02: properties removed 30 days ago are deleted for good.
        await eraseExpired(w.id, now, workspaceDeadline);
      } catch (error) {
        stats.failed++;
        reportError(error, "scheduler-workspace");
      }
    }
    for (const w of workspaces) await measureBacklog(w.id, stats);
    await db.rateLimit.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - DAY_MS) } },
    });
    await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await db.schedulerTick.deleteMany({
      where: {
        startedAt: { lt: new Date(Date.now() - RETENTION.ticksDays * DAY_MS) },
      },
    });
  } catch (error) {
    status = "FAILED";
    errorCode = error instanceof Error ? error.name : "Unknown";
    reportError(error, "scheduler-tick");
  } finally {
    const completedAt = new Date();
    await db.schedulerTick.update({
      where: { id },
      data: {
        status,
        completedAt,
        durationMs: completedAt.getTime() - startedAt.getTime(),
        errorCode,
        ...stats,
      },
    });
    await db.$executeRaw`
      UPDATE "SchedulerLease" SET "holder" = NULL, "leaseUntil" = NULL
       WHERE "id" = 'scheduler' AND "holder" = ${holder}`;
  }
  return {
    id,
    status,
    durationMs: Date.now() - startedAt.getTime(),
    ...stats,
  };
}
