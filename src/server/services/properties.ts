// Removing a property from the app, and restoring it.
//
// Removal takes the property out of every screen and stops everything the
// app does for it: calendar checks, its export links, cleaning work and
// guest messages. It never contacts a platform. Nothing is sent to Airbnb,
// Vrbo or any other service, and the property's export links stop answering
// rather than serve an empty calendar, so removing a property here can never
// open up dates on a platform; the host removes the links there when ready.
//
// History is kept, as everywhere in this app (no hard deletes: the runtime
// role cannot delete calendar or cleaning history), which is also what makes
// restoring possible. Restoring turns back on exactly the calendar links the
// removal paused; links the host had switched off stay off.
import type { CleaningTask } from "@prisma/client";
import { audit } from "../audit";
import { reconcileListingTurnovers } from "../calendar/actions";
import {
  calendarMode,
  loadPropertyBlocks,
  publishExports,
} from "../calendar/commit";
import { fromLocalDate } from "../calendar/mappers";
import { lock, type Context, type Tx } from "../db";
import { ensure } from "../errors";
import { closeTask } from "./cleaning";
import { capabilityOf } from "@/domain/calendar/capabilities";
import { todayIn } from "@/domain/calendar/dates";
import type { Platform } from "@/domain/calendar/types";
import { sameName } from "@/lib/domain";

/** The connection health that marks a link paused by its property's removal. */
export const PAUSED_BY_REMOVAL = "PROPERTY_REMOVED";
/** The close reason on cleaning work cancelled by a removal. */
export const REMOVAL_REASON = "PROPERTY_REMOVED";
const NOT_STARTED = ["NEEDS_SCHEDULING", "ASSIGNED", "ACCEPTED"];
/** A request for an export link within this long counts as the link in use. */
const RECENT_USE_MS = 14 * 86_400_000;
/**
 * A cleaning started within this long is treated as under way, and removal
 * waits for it. Only the cleaner can finish a started job, so an older one
 * is treated as abandoned rather than allowed to block removal for good.
 */
export const ACTIVE_CLEANING_MS = 12 * 3_600_000;

/** Typed confirmation: the property's name, ignoring case and spacing. */
export const namesMatch = sameName;

const linkName = (c: { label: string | null; platform: string }) =>
  c.label || capabilityOf(c.platform as Platform).displayName;

/** Each of a property's export links with the last time anything asked for it. */
async function linkUse(
  tx: Tx,
  ctx: Context,
  connections: { id: string; label: string | null; platform: string }[],
  since: Date,
  classes: string[],
) {
  const rows = await tx.exportRetrieval.groupBy({
    by: ["connectionId"],
    where: {
      workspaceId: ctx.workspaceId,
      connectionId: { in: connections.map((c) => c.id) },
      lastAt: { gte: since },
      responseClass: { in: classes },
    },
    _max: { lastAt: true },
  });
  const last = new Map(rows.map((r) => [r.connectionId, r._max.lastAt]));
  return connections
    .filter((c) => last.get(c.id))
    .map((c) => ({ name: linkName(c), lastAt: last.get(c.id)!.toISOString() }))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

/** Removing and restoring are the workspace owner's decisions alone. */
function ownerOnly(ctx: Context) {
  ensure(
    ctx.role === "HOST",
    403,
    "OWNER_REQUIRED",
    "Only the workspace owner can remove or restore a property.",
  );
}

async function activeProperty(tx: Tx, ctx: Context, listingId: string) {
  const listing = await tx.listing.findFirst({
    where: { id: listingId, workspaceId: ctx.workspaceId, archivedAt: null },
  });
  ensure(listing, 404, "NOT_FOUND", "Property not found.");
  return listing;
}

/** What removing a property would change, for the host to confirm. */
export async function removalPreview(
  tx: Tx,
  ctx: Context,
  listingId: string,
  now = new Date(),
) {
  const listing = await activeProperty(tx, ctx, listingId);
  const today = fromLocalDate(todayIn(listing.timezone, now.getTime()));
  const scope = { workspaceId: ctx.workspaceId, listingId };
  const connections = await tx.channelConnection.findMany({
    where: scope,
    select: {
      id: true,
      label: true,
      platform: true,
      enabled: true,
      importUrlEncrypted: true,
    },
  });
  const tasks = await tx.cleaningTask.findMany({
    where: { ...scope, status: { in: [...NOT_STARTED, "IN_PROGRESS"] } },
    select: { status: true, cleanerId: true, startedAt: true },
  });
  const settings = await tx.automationSettings.findUniqueOrThrow({
    where: { workspaceId: ctx.workspaceId },
  });
  return {
    id: listing.id,
    name: listing.name,
    version: listing.version,
    calendarsChecked: connections.filter(
      (c) => c.enabled && c.importUrlEncrypted,
    ).length,
    exportLinks: connections.filter((c) => c.enabled).length,
    linksInUse: await linkUse(
      tx,
      ctx,
      connections.filter((c) => c.enabled),
      new Date(now.getTime() - RECENT_USE_MS),
      ["BODY", "NOT_MODIFIED", "HEAD"],
    ),
    upcomingStays: await tx.reservation.count({
      where: { ...scope, status: "CONFIRMED", endDate: { gte: today } },
    }),
    cleaningsToCancel: tasks.filter((t) => NOT_STARTED.includes(t.status))
      .length,
    cleanersToTell: new Set(
      tasks
        .filter((t) => ["ASSIGNED", "ACCEPTED"].includes(t.status))
        .map((t) => t.cleanerId),
    ).size,
    cleanersToldAutomatically: !settings.paused && settings.cleaning,
    cleaningUnderWay: tasks.some(
      (t) =>
        t.status === "IN_PROGRESS" &&
        !!t.startedAt &&
        now.getTime() - t.startedAt.getTime() < ACTIVE_CLEANING_MS,
    ),
    openConversations: await tx.thread.count({
      where: { ...scope, status: { not: "RESOLVED" } },
    }),
  };
}

async function ensureNoCleaningUnderWay(
  tx: Tx,
  ctx: Context,
  listingId: string,
  now: Date,
) {
  const working = await tx.cleaningTask.count({
    where: {
      workspaceId: ctx.workspaceId,
      listingId,
      status: "IN_PROGRESS",
      startedAt: { gte: new Date(now.getTime() - ACTIVE_CLEANING_MS) },
    },
  });
  ensure(
    working === 0,
    409,
    "CLEANING_UNDER_WAY",
    "A cleaner is working at this property now. Remove it once they have finished, so their job is not cut off.",
  );
}

export type RemovalResult = {
  id: string;
  removedAt: string;
  linksPaused: number;
  cleaningsCancelled: number;
  repliesHeld: number;
};

export async function removeProperty(
  tx: Tx,
  ctx: Context,
  listingId: string,
  input: { confirmName: string; version: number },
  now = new Date(),
): Promise<RemovalResult> {
  ownerOnly(ctx);
  // The same lock as a calendar check's apply step, so a check that is
  // applying finishes first, and one that applies later sees the removal.
  await lock(tx, "listing:" + listingId);
  const listing = await tx.listing.findFirst({
    where: { id: listingId, workspaceId: ctx.workspaceId },
  });
  ensure(listing, 404, "NOT_FOUND", "Property not found.");
  // Asking again (a retry after a lost answer) changes nothing more.
  if (listing.archivedAt)
    return {
      id: listing.id,
      removedAt: listing.archivedAt.toISOString(),
      linksPaused: 0,
      cleaningsCancelled: 0,
      repliesHeld: 0,
    };
  ensure(
    listing.version === input.version,
    409,
    "VERSION_CONFLICT",
    "This property changed since you opened it. Review it again before removing it.",
  );
  ensure(
    namesMatch(input.confirmName, listing.name),
    400,
    "CONFIRMATION_MISMATCH",
    `Type the property's name, ${listing.name}, to confirm.`,
  );
  await ensureNoCleaningUnderWay(tx, ctx, listingId, now);

  // 1. Calendar links: pause the ones that are on. Paused links are not
  // checked and their export links answer "not found", never an empty
  // calendar. Moving the fence and clearing the lease means a check that
  // is fetching right now cannot apply what it fetched.
  const paused = await tx.channelConnection.updateMany({
    where: { workspaceId: ctx.workspaceId, listingId, enabled: true },
    data: {
      enabled: false,
      health: PAUSED_BY_REMOVAL,
      leaseToken: null,
      leaseUntil: null,
      fence: { increment: 1 },
    },
  });

  // 2. Cleaning work that has not begun is cancelled, exactly as when a stay
  // is cancelled. Work already started or finished stays as history. A
  // cleaner accepting a job at this moment changes its version, so the
  // remaining work is read again until none is left.
  let cleaningsCancelled = 0;
  for (let pass = 0; ; pass++) {
    const open: CleaningTask[] = await tx.cleaningTask.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        listingId,
        status: { in: NOT_STARTED },
      },
    });
    if (!open.length) break;
    ensure(
      pass < 3,
      409,
      "CLEANING_CHANGING",
      "This property's cleaning jobs are changing right now. Try again in a moment.",
    );
    for (const task of open)
      if (await closeTask(tx, ctx, task, "CANCELLED", REMOVAL_REASON, now))
        cleaningsCancelled++;
  }

  // A cleaner who started a job meanwhile is not cut off either.
  await ensureNoCleaningUnderWay(tx, ctx, listingId, now);

  // 3. Replies not yet handed to a messaging service are held back as
  // drafts. One already being sent cannot be recalled and is left alone.
  const threads = await tx.thread.findMany({
    where: { workspaceId: ctx.workspaceId, listingId },
    select: { id: true },
  });
  const queued = await tx.message.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      threadId: { in: threads.map((t) => t.id) },
      status: "QUEUED",
    },
    select: { id: true },
  });
  const pending = await tx.outbox.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      kind: "GUEST_MESSAGE",
      entityId: { in: queued.map((m) => m.id) },
      status: "PENDING",
    },
    select: { id: true, entityId: true },
  });
  let repliesHeld = 0;
  for (const job of pending) {
    // Only a send nobody has picked up yet is stopped.
    const stopped = await tx.outbox.updateMany({
      where: { id: job.id, status: "PENDING" },
      data: { status: "CANCELLED" },
    });
    if (!stopped.count) continue;
    await tx.message.updateMany({
      where: { id: job.entityId, status: "QUEUED" },
      data: { status: "DRAFT" },
    });
    repliesHeld++;
  }

  // 4. Out of every screen.
  const removed = await tx.listing.update({
    where: { id: listing.id },
    data: { archivedAt: now, version: { increment: 1 } },
  });
  const result: RemovalResult = {
    id: listing.id,
    removedAt: removed.archivedAt!.toISOString(),
    linksPaused: paused.count,
    cleaningsCancelled,
    repliesHeld,
  };
  await audit(
    tx,
    ctx,
    "REMOVE",
    "Listing",
    listing.id,
    "Host removed this property from the app. Nothing was changed on any platform; its export links stop answering until it is restored.",
    result,
  );
  return result;
}

export type RestoreResult = {
  id: string;
  linksResumed: number;
  cleaningsRecreated: boolean;
};

export async function restoreProperty(
  tx: Tx,
  ctx: Context,
  listingId: string,
  now = new Date(),
): Promise<RestoreResult> {
  ownerOnly(ctx);
  await lock(tx, "listing:" + listingId);
  const listing = await tx.listing.findFirst({
    where: { id: listingId, workspaceId: ctx.workspaceId },
  });
  ensure(listing, 404, "NOT_FOUND", "Property not found.");
  // Restoring a property that is already back changes nothing.
  if (!listing.archivedAt)
    return { id: listing.id, linksResumed: 0, cleaningsRecreated: false };

  // Only the links the removal paused come back on, and they are checked
  // again straight away.
  const resumed = await tx.channelConnection.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      listingId,
      health: PAUSED_BY_REMOVAL,
    },
    select: { id: true, importUrlEncrypted: true },
  });
  for (const c of resumed)
    await tx.channelConnection.update({
      where: { id: c.id },
      data: {
        enabled: true,
        health: c.importUrlEncrypted ? "PENDING" : "EXPORT_ONLY",
        nextFetchAt: now,
        leaseToken: null,
        leaseUntil: null,
      },
    });
  const restored = await tx.listing.update({
    where: { id: listing.id },
    data: { archivedAt: null, version: { increment: 1 } },
  });
  // Export links answer with the property's current dates at once.
  await publishExports(
    tx,
    ctx,
    restored,
    await loadPropertyBlocks(tx, ctx, listing.id),
    now,
  );
  // Upcoming stays get their turnover work back (cancelled jobs stay
  // cancelled; new ones need a cleaner). Shadow mode creates no work.
  const live = (await calendarMode(tx, ctx)) === "LIVE";
  if (live) await reconcileListingTurnovers(tx, ctx, listing.id, now);
  const result: RestoreResult = {
    id: listing.id,
    linksResumed: resumed.length,
    cleaningsRecreated: live,
  };
  await audit(
    tx,
    ctx,
    "RESTORE",
    "Listing",
    listing.id,
    "Host restored this property. Calendar links it had paused are checked and answer again.",
    result,
  );
  return result;
}

/** Removed properties, newest first, and whether platforms still ask for their links. */
export async function removedProperties(tx: Tx, ctx: Context) {
  const listings = await tx.listing.findMany({
    where: { workspaceId: ctx.workspaceId, archivedAt: { not: null } },
    orderBy: { archivedAt: "desc" },
    select: { id: true, name: true, address: true, archivedAt: true },
    take: 100,
  });
  const rows = [];
  for (const l of listings) {
    const connections = await tx.channelConnection.findMany({
      where: { workspaceId: ctx.workspaceId, listingId: l.id },
      select: { id: true, label: true, platform: true },
    });
    rows.push({
      id: l.id,
      name: l.name,
      address: l.address,
      removedAt: l.archivedAt!.toISOString(),
      // Requests for a paused link since the removal: a platform that still
      // imports it should have the link removed in its calendar settings.
      linksStillRequested: await linkUse(tx, ctx, connections, l.archivedAt!, [
        "UNAVAILABLE",
      ]),
    });
  }
  return rows;
}
