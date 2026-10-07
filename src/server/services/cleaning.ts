import { randomUUID } from "node:crypto";
import type { CleaningTask, Listing, Reservation } from "@prisma/client";
import { type Context, type Tx, lock } from "../db";
import { audit, event, enqueue, notify } from "../audit";
import { canTransition, checkoutInstant } from "@/lib/domain";
import { randomToken, hash, decrypt } from "../crypto";
import { ensure } from "../errors";
import { appUrl } from "../config";
import {
  planTurnover,
  stayExpected,
  type TurnoverTask,
} from "@/domain/cleaning/turnover";
import { todayIn } from "@/domain/calendar/dates";
import type { BlockState, Lifecycle } from "@/domain/calendar/types";
import { activeListing } from "./listings";

const CLOSED = ["CANCELLED", "SUPERSEDED"];
const toDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Close work that has not begun (CLEAN 01/03), unless it changed meanwhile.
 * The cleaner keeps their link so they see a clear cancelled or changed
 * screen; queued invitations stop and door codes stay withheld. A cleaner
 * who held the job is sent a notice, which goes out only while cleaning
 * automation is on. Returns whether the task was closed.
 */
export async function closeTask(
  tx: Tx,
  ctx: Context,
  task: CleaningTask,
  status: "CANCELLED" | "SUPERSEDED",
  reason: string,
  now: Date,
) {
  const written = await tx.cleaningTask.updateMany({
    where: { id: task.id, version: task.version },
    data: {
      status,
      closedAt: now,
      closeReason: reason,
      reviewRequired: false,
      reviewReason: null,
      codeReleasedAt: null,
      version: { increment: 1 },
    },
  });
  if (!written.count) return false;
  await tx.outbox.updateMany({
    where: {
      workspaceId: ctx.workspaceId,
      entityId: task.id,
      kind: "CLEANER_SMS",
      status: "PENDING",
    },
    data: { status: "CANCELLED" },
  });
  if (task.cleanerId && ["ASSIGNED", "ACCEPTED"].includes(task.status))
    await enqueue(
      tx,
      ctx,
      "CLEANER_NOTICE",
      task.id,
      `notice:${task.id}:${status}`,
      {
        cleanerId: task.cleanerId,
        text:
          status === "SUPERSEDED"
            ? "A cleaning job assigned to you changed. Your host will send the updated job; please do not start the old one."
            : "A cleaning job assigned to you was cancelled. Please do not go to the property for it.",
      },
      "CLEANING",
    );
  await event(
    tx,
    ctx,
    `CLEANING_${status}`,
    task.id,
    `transition:${task.id}:${status}`,
    { from: task.status, to: status, reason },
  );
  await audit(
    tx,
    ctx,
    "TRANSITION",
    "CleaningTask",
    task.id,
    `${task.status} → ${status}: ${reason}.`,
    { reservationId: task.reservationId },
  );
  return true;
}

/**
 * CLEAN 01/03: bring a reservation's turnover work in line with the stay.
 * Runs inside the calendar commit transaction, in LIVE mode only.
 */
export async function applyTurnover(
  tx: Tx,
  ctx: Context,
  listing: Listing,
  reservation: Reservation,
  block: BlockState,
  now: Date,
) {
  const tasks = await tx.cleaningTask.findMany({
    where: { workspaceId: ctx.workspaceId, reservationId: reservation.id },
  });
  const ops = planTurnover(
    {
      id: reservation.id,
      status: reservation.status as "CONFIRMED" | "CANCELLED" | "RECLASSIFIED",
      blockLifecycle: block.lifecycle,
      departureDate: toDate(reservation.endDate),
    },
    tasks.map<TurnoverTask>((t) => ({
      id: t.id,
      departureDate: t.departureDate ? toDate(t.departureDate) : null,
      status: t.status as TurnoverTask["status"],
      reviewRequired: t.reviewRequired,
      reviewReason: t.reviewReason,
    })),
  );
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const op of ops) {
    if (op.type === "CREATE") {
      const scheduledAt = checkoutInstant(
        reservation.endDate,
        listing.checkoutHour,
        listing.timezone,
      );
      if (scheduledAt.getTime() < now.getTime() - 30 * 86_400_000) continue;
      const task = await tx.cleaningTask.create({
        data: {
          id: randomUUID(),
          workspaceId: ctx.workspaceId,
          listingId: listing.id,
          reservationId: reservation.id,
          taskType: "TURNOVER",
          departureDate: reservation.endDate,
          supersedesTaskId: op.supersedesTaskId,
          scheduledAt,
          verifyBy: new Date(
            scheduledAt.getTime() + listing.cleaningBufferHours * 3_600_000,
          ),
        },
      });
      await event(tx, ctx, "CLEANING_CREATED", task.id, `task:${task.id}`, {
        reservationId: reservation.id,
        listingId: listing.id,
        supersedes: op.supersedesTaskId,
      });
      await audit(
        tx,
        ctx,
        "AUTOMATION",
        "CleaningTask",
        task.id,
        op.supersedesTaskId
          ? "The stay's dates changed; a replacement turnover was created and the previous one superseded."
          : "A confirmed reservation requires a turnover at local checkout time.",
        {
          reservationId: reservation.id,
          scheduledAt: scheduledAt.toISOString(),
        },
      );
      continue;
    }
    const task = byId.get(op.taskId)!;
    if (op.type === "SUPERSEDE" || op.type === "CANCEL") {
      const status = op.type === "SUPERSEDE" ? "SUPERSEDED" : "CANCELLED";
      if (!(await closeTask(tx, ctx, task, status, op.reason, now))) continue;
      await notify(
        tx,
        ctx,
        `cleaning-${status.toLowerCase()}:${task.id}`,
        status === "SUPERSEDED"
          ? "A turnover moved with its stay"
          : "A turnover was cancelled",
        `${listing.name}, turnover on ${todayIn(listing.timezone, task.scheduledAt.getTime())}: ${
          task.cleanerId
            ? "the assigned cleaner is notified when cleaning automation is on; otherwise let them know yourself."
            : "no cleaner was assigned, so there is no one to tell."
        }`,
        "/cleaning",
      );
    } else if (op.type === "FLAG_REVIEW") {
      const written = await tx.cleaningTask.updateMany({
        where: { id: task.id, version: task.version },
        data: {
          reviewRequired: true,
          reviewReason: op.reason,
          version: { increment: 1 },
        },
      });
      if (written.count)
        await notify(
          tx,
          ctx,
          `cleaning-review:${task.id}:${op.reason}`,
          "A turnover needs your review",
          `${listing.name}: the stay changed or is under review. Door-code access is withheld until you decide.`,
          "/cleaning",
        );
    } else if (op.type === "CLEAR_REVIEW")
      await tx.cleaningTask.updateMany({
        where: { id: task.id, version: task.version },
        data: {
          reviewRequired: false,
          reviewReason: null,
          version: { increment: 1 },
        },
      });
  }
  // Keep the current, not-yet-started turnover on the property's checkout time.
  const current = await tx.cleaningTask.findFirst({
    where: {
      workspaceId: ctx.workspaceId,
      reservationId: reservation.id,
      departureDate: reservation.endDate,
      status: { in: ["NEEDS_SCHEDULING", "ASSIGNED", "ACCEPTED"] },
    },
  });
  if (current) {
    const scheduledAt = checkoutInstant(
      reservation.endDate,
      listing.checkoutHour,
      listing.timezone,
    );
    if (current.scheduledAt.getTime() !== scheduledAt.getTime()) {
      await tx.cleaningTask.update({
        where: { id: current.id },
        data: {
          scheduledAt,
          verifyBy: new Date(
            scheduledAt.getTime() + listing.cleaningBufferHours * 3_600_000,
          ),
          version: { increment: 1 },
        },
      });
      await notify(
        tx,
        ctx,
        `cleaning-rescheduled:${current.id}:${scheduledAt.toISOString()}`,
        "Turnover timing changed",
        `${listing.name}: review the updated checkout time and cleaner assignment.`,
        "/cleaning",
      );
    }
  }
}

/** Whether a task's stay is still expected; tasks without a stay always are. */
export async function turnoverStanding(
  tx: Tx,
  ctx: Context,
  task: CleaningTask,
) {
  if (CLOSED.includes(task.status)) return { expected: false, closed: true };
  if (!task.reservationId) return { expected: true, closed: false };
  const reservation = await tx.reservation.findFirst({
    where: { workspaceId: ctx.workspaceId, id: task.reservationId },
  });
  const block = reservation?.blockId
    ? await tx.availabilityBlock.findFirst({
        where: { workspaceId: ctx.workspaceId, id: reservation.blockId },
        select: { lifecycle: true },
      })
    : null;
  const expected =
    !!reservation &&
    stayExpected({
      status: reservation.status as "CONFIRMED" | "CANCELLED" | "RECLASSIFIED",
      blockLifecycle: (block?.lifecycle ?? "ACTIVE") as Lifecycle,
    });
  return { expected, closed: false };
}

export async function assignTask(
  tx: Tx,
  ctx: Context,
  taskId: string,
  cleanerId: string,
  version: number,
) {
  await lock(tx, "task:" + taskId);
  const task = await tx.cleaningTask.findFirst({
    where: { id: taskId, workspaceId: ctx.workspaceId },
  });
  ensure(task, 404, "NOT_FOUND", "Task not found.");
  await activeListing(tx, ctx, task.listingId);
  const standing = await turnoverStanding(tx, ctx, task);
  ensure(
    !standing.closed,
    409,
    "TASK_CLOSED",
    "This turnover was cancelled or replaced.",
  );
  ensure(
    standing.expected && !task.reviewRequired,
    409,
    "BOOKING_REVIEW",
    "Resolve the reservation before assigning or progressing its turnover.",
  );
  ensure(
    task.version === version,
    409,
    "VERSION_CONFLICT",
    "This task changed. Refresh and try again.",
  );
  ensure(
    !["IN_PROGRESS", "DONE", "VERIFIED"].includes(task.status),
    409,
    "INVALID_STATE",
    "An active or completed task cannot be reassigned.",
  );
  const cleaner = await tx.cleaner.findFirst({
    where: { workspaceId: ctx.workspaceId, id: cleanerId, enabled: true },
  });
  ensure(
    cleaner && cleaner.listingIds.includes(task.listingId),
    400,
    "ASSIGNMENT_SCOPE",
    "Select a cleaner authorized for this listing.",
  );
  await tx.magicLink.updateMany({
    where: { workspaceId: ctx.workspaceId, taskId },
    data: { revokedAt: new Date() },
  });
  await tx.outbox.updateMany({
    where: {
      workspaceId: ctx.workspaceId,
      entityId: taskId,
      kind: "CLEANER_SMS",
      status: { in: ["PENDING", "FAILED"] },
    },
    data: { status: "CANCELLED" },
  });
  const token = randomToken();
  const acceptBy = new Date(
    Math.min(
      task.scheduledAt.getTime() - 15 * 60000,
      Math.max(
        Date.now() + 15 * 60000,
        task.scheduledAt.getTime() - 24 * 3600000,
      ),
    ),
  );
  const expiresAt = new Date(
    Math.max(task.verifyBy.getTime() + 24 * 3600000, Date.now() + 24 * 3600000),
  );
  await tx.magicLink.create({
    data: {
      workspaceId: ctx.workspaceId,
      taskId,
      cleanerId,
      tokenHash: hash(token),
      expiresAt,
    },
  });
  const updated = await tx.cleaningTask.update({
    where: { id: taskId },
    data: {
      cleanerId,
      status: "ASSIGNED",
      acceptedAt: null,
      codeReleasedAt: null,
      acceptBy,
      version: { increment: 1 },
    },
  });
  await event(
    tx,
    ctx,
    "CLEANING_ASSIGNED",
    taskId,
    `assign:${taskId}:${updated.version}`,
    { cleanerId },
  );
  await enqueue(
    tx,
    ctx,
    "CLEANER_SMS",
    taskId,
    `sms:${taskId}:${updated.version}`,
    {
      cleanerId,
      taskVersion: updated.version,
      to: decrypt(cleaner.phoneEncrypted, ctx.workspaceId),
      text: `A cleaning job is ready for you. Review and accept: ${appUrl()}/cleaner#token=${token}`,
    },
    "CLEANING",
  );
  await audit(
    tx,
    ctx,
    "ASSIGN",
    "CleaningTask",
    taskId,
    "Cleaner assigned; a scoped, expiring magic link is queued. Door code remains withheld.",
    { cleanerId },
  );
  return updated;
}
export async function transitionTask(
  tx: Tx,
  ctx: Context,
  taskId: string,
  next: string,
  version: number,
) {
  await lock(tx, "task:" + taskId);
  const task = await tx.cleaningTask.findFirst({
    where: { id: taskId, workspaceId: ctx.workspaceId },
  });
  ensure(task, 404, "NOT_FOUND", "Task not found.");
  const standing = await turnoverStanding(tx, ctx, task);
  ensure(
    !standing.closed,
    409,
    "TASK_CLOSED",
    "This turnover was cancelled or replaced.",
  );
  // Verifying finished work stays possible so evidence can be reconciled;
  // every other step needs a stay that is still expected (CLEAN 03).
  if (next !== "VERIFIED" && !(next === "DONE" && task.status === "VERIFIED"))
    ensure(
      standing.expected && !task.reviewRequired,
      409,
      "BOOKING_REVIEW",
      "Resolve the reservation before assigning or progressing its turnover.",
    );
  if (ctx.role === "CLEANER")
    ensure(
      task.id === ctx.taskId && task.cleanerId === ctx.cleanerId,
      403,
      "FORBIDDEN",
      "This task is not assigned to you.",
    );
  ensure(
    task.version === version,
    409,
    "VERSION_CONFLICT",
    "This task changed. Refresh before continuing.",
  );
  ensure(
    canTransition(task.status, next, ctx.role, !!task.photoId),
    409,
    "INVALID_TRANSITION",
    next === "VERIFIED"
      ? "A completed task and uploaded cleaner photo are required."
      : "That task transition is not permitted.",
  );
  const settings = await tx.automationSettings.findUnique({
    where: { workspaceId: ctx.workspaceId },
  });
  const now = new Date();
  const updated = await tx.cleaningTask.update({
    where: { id: taskId },
    data: {
      status: next,
      version: { increment: 1 },
      ...(next === "ACCEPTED"
        ? {
            acceptedAt: now,
            codeReleasedAt: settings?.cleaning && !settings.paused ? now : null,
          }
        : {}),
      ...(next === "IN_PROGRESS" ? { startedAt: now } : {}),
      ...(next === "DONE" ? { completedAt: now, verifiedAt: null } : {}),
      ...(next === "VERIFIED" ? { verifiedAt: now } : {}),
      ...(next === "NEEDS_SCHEDULING"
        ? { cleanerId: null, acceptedAt: null, codeReleasedAt: null }
        : {}),
    },
  });
  if (next === "NEEDS_SCHEDULING") {
    await tx.magicLink.updateMany({
      where: {
        workspaceId: ctx.workspaceId,
        taskId,
        ...(ctx.role === "CLEANER" && ctx.cleanerSessionId
          ? { id: { not: ctx.cleanerSessionId } }
          : {}),
      },
      data: { revokedAt: now },
    });
    await notify(
      tx,
      ctx,
      `declined:${taskId}:${updated.version}`,
      "Cleaner declined a job",
      "Reassign the turnover before the scheduled checkout.",
      "/cleaning",
    );
  }
  if (next === "VERIFIED") {
    const remaining = await tx.cleaningTask.count({
      where: {
        workspaceId: ctx.workspaceId,
        listingId: task.listingId,
        id: { not: taskId },
        scheduledAt: { lte: now },
        status: { notIn: ["VERIFIED", ...CLOSED] },
      },
    });
    await tx.listing.update({
      where: { id: task.listingId },
      data: { ready: remaining === 0 },
    });
  } else
    await tx.listing.update({
      where: { id: task.listingId },
      data: { ready: false },
    });
  await event(
    tx,
    ctx,
    `CLEANING_${next}`,
    taskId,
    `transition:${taskId}:${updated.version}`,
    { from: task.status, to: next },
  );
  await audit(
    tx,
    ctx,
    "TRANSITION",
    "CleaningTask",
    taskId,
    `${task.status} → ${next}. ${next === "ACCEPTED" ? "Door code release follows cleaning automation controls." : ""}`,
    { from: task.status, to: next },
  );
  return updated;
}

const NOTICES: Record<string, string> = {
  CANCELLED: "This job was cancelled. Please do not go to the property for it.",
  SUPERSEDED: "This job changed. Your host will send the updated job.",
  REVIEW:
    "Your host is reviewing this stay. Door-code access is paused until they decide.",
};

export async function cleanerJob(tx: Tx, ctx: Context) {
  const task = await tx.cleaningTask.findFirst({
    where: {
      workspaceId: ctx.workspaceId,
      id: ctx.taskId,
      cleanerId: ctx.cleanerId,
    },
  });
  ensure(task, 404, "NOT_FOUND", "This job is no longer assigned to you.");
  const listing = await tx.listing.findUniqueOrThrow({
    where: { id: task.listingId },
  });
  const standing = await turnoverStanding(tx, ctx, task);
  await audit(
    tx,
    ctx,
    "READ",
    "CleaningTask",
    task.id,
    "Cleaner viewed their assigned job; guest contacts and pricing are excluded.",
  );
  const underReview =
    !standing.closed && (!standing.expected || task.reviewRequired);
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    scheduledAt: task.scheduledAt,
    verifyBy: task.verifyBy,
    version: task.version,
    photoId: task.photoId,
    closed: standing.closed,
    reviewRequired: underReview,
    notice: standing.closed
      ? NOTICES[task.status]
      : underReview
        ? NOTICES.REVIEW
        : null,
    codeAvailable:
      standing.expected &&
      !task.reviewRequired &&
      !!task.codeReleasedAt &&
      ["ACCEPTED", "IN_PROGRESS", "DONE"].includes(task.status),
    listing: {
      name: listing.name,
      address: listing.address,
      timezone: listing.timezone,
    },
    note: decrypt(task.noteEncrypted, ctx.workspaceId),
  };
}

export async function cleanerJobs(tx: Tx, ctx: Context) {
  const now = new Date();
  const cleaner = await tx.cleaner.findFirst({
    where: { workspaceId: ctx.workspaceId, id: ctx.cleanerId, enabled: true },
  });
  ensure(
    cleaner,
    403,
    "ASSIGNMENT_REVOKED",
    "Your cleaner access is no longer active.",
  );
  const tasks = await tx.cleaningTask.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      cleanerId: ctx.cleanerId,
      listingId: { in: cleaner.listingIds },
      status: { in: ["ASSIGNED", "ACCEPTED", "IN_PROGRESS", "DONE"] },
      scheduledAt: {
        gte: new Date(now.getTime() - 48 * 3600000),
        lte: new Date(now.getTime() + 48 * 3600000),
      },
    },
    orderBy: { scheduledAt: "asc" },
    take: 100,
  });
  const jobs = [];
  for (const task of tasks) {
    const listing = await tx.listing.findFirst({
      where: {
        id: task.listingId,
        workspaceId: ctx.workspaceId,
        archivedAt: null,
      },
    });
    if (!listing) continue;
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: listing.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    if (day.format(task.scheduledAt) !== day.format(now)) continue;
    jobs.push(await cleanerJob(tx, { ...ctx, taskId: task.id }));
  }
  await audit(
    tx,
    ctx,
    "READ",
    "CleaningTask",
    null,
    "Cleaner viewed today’s assigned jobs in each property’s local timezone; guest information and pricing are excluded.",
  );
  return { jobs };
}
