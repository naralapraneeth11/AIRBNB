import type { Booking, Listing } from "@prisma/client";
import { type Context, type Tx, lock } from "../db";
import { audit, event, enqueue, notify } from "../audit";
import { canTransition, checkoutInstant } from "@/lib/domain";
import { randomToken, hash, decrypt, encrypt } from "../crypto";
import { ensure } from "../errors";
import { appUrl } from "../config";
export async function createTurnover(
  tx: Tx,
  ctx: Context,
  b: Booking,
  l: Listing,
) {
  if (b.kind !== "RESERVATION" || b.status !== "CONFIRMED") return;
  const settings = await tx.automationSettings.findUnique({
    where: { workspaceId: ctx.workspaceId },
  });
  if (!settings?.cleaning || settings.paused) return;
  const scheduledAt = checkoutInstant(b.endDate, l.checkoutHour, l.timezone);
  if (scheduledAt.getTime() < Date.now() - 30 * 86400000) return;
  const prior = await tx.cleaningTask.findUnique({
    where: {
      workspaceId_bookingId: { workspaceId: ctx.workspaceId, bookingId: b.id },
    },
  });
  const task = await tx.cleaningTask.upsert({
    where: {
      workspaceId_bookingId: { workspaceId: ctx.workspaceId, bookingId: b.id },
    },
    create: {
      workspaceId: ctx.workspaceId,
      listingId: l.id,
      bookingId: b.id,
      scheduledAt,
      verifyBy: new Date(
        scheduledAt.getTime() + l.cleaningBufferHours * 3600000,
      ),
    },
    update: {},
  });
  if (
    !["DONE", "VERIFIED"].includes(task.status) &&
    task.scheduledAt.getTime() !== scheduledAt.getTime()
  ) {
    await tx.cleaningTask.update({
      where: { id: task.id },
      data: {
        scheduledAt,
        verifyBy: new Date(
          scheduledAt.getTime() + l.cleaningBufferHours * 3600000,
        ),
        version: { increment: 1 },
      },
    });
    await notify(
      tx,
      ctx,
      `cleaning-rescheduled:${task.id}:${b.version}`,
      "Turnover timing changed",
      `${l.name}: review the updated checkout time and cleaner assignment.`,
      "/cleaning",
    );
  }
  await event(tx, ctx, "CLEANING_CREATED", task.id, "task:" + b.id, {
    bookingId: b.id,
    listingId: l.id,
  });
  if (!prior)
    await audit(
      tx,
      ctx,
      "AUTOMATION",
      "CleaningTask",
      task.id,
      "A confirmed reservation requires a turnover at local checkout time.",
      { bookingId: b.id, scheduledAt: scheduledAt.toISOString() },
    );
  return task;
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
  if (task.bookingId) {
    const booking = await tx.booking.findFirst({
      where: { id: task.bookingId, workspaceId: ctx.workspaceId },
    });
    ensure(
      booking?.status === "CONFIRMED",
      409,
      "BOOKING_REVIEW",
      "Resolve the reservation before assigning or progressing its turnover.",
    );
  }
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
  if (task.bookingId) {
    const booking = await tx.booking.findFirst({
      where: { id: task.bookingId, workspaceId: ctx.workspaceId },
    });
    ensure(
      booking?.status === "CONFIRMED",
      409,
      "BOOKING_REVIEW",
      "Resolve the reservation before assigning or progressing its turnover.",
    );
  }
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
        status: { not: "VERIFIED" },
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
  const booking = task.bookingId
    ? await tx.booking.findFirst({
        where: { id: task.bookingId, workspaceId: ctx.workspaceId },
      })
    : null;
  await audit(
    tx,
    ctx,
    "READ",
    "CleaningTask",
    task.id,
    "Cleaner viewed their assigned job; guest contacts and pricing are excluded.",
  );
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    scheduledAt: task.scheduledAt,
    verifyBy: task.verifyBy,
    version: task.version,
    photoId: task.photoId,
    codeAvailable:
      (!task.bookingId || booking?.status === "CONFIRMED") &&
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
    if (task.bookingId) {
      const booking = await tx.booking.findFirst({
        where: { workspaceId: ctx.workspaceId, id: task.bookingId },
      });
      if (booking?.status !== "CONFIRMED") continue;
    }
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
