// Deleting a removed property permanently (PRIV 02).
//
// Removing a property keeps everything so it can be restored (see
// properties.ts). Thirty days after its removal, or sooner when the
// workspace owner asks, everything this app stores about it is deleted for
// good: its stays and guest details, conversations, cleaning jobs and
// photos, calendar links with their check history, and the alerts about it.
// Nothing is sent to Airbnb or any other platform.
//
// The deletion itself is one database function, erase_listing (migration
// 202610070002_erasure). The runtime role cannot delete history any other
// way, and the function refuses a property that is still in the app. It
// records what it deleted, as counts only, in the Erasure ledger. Photos are
// stored outside the database, so they are deleted once the transaction has
// committed, and each stays listed in the ledger until storage confirms it
// is gone; the scheduler tries again for any that are left.
//
// The audit log is append-only and is not edited: its entries about the
// property remain, and any details they recorded stay encrypted.
import { Prisma, type Listing } from "@prisma/client";
import { audit } from "../audit";
import { passwordMatches } from "../crypto";
import { db, lock, tenant, type Context, type Tx } from "../db";
import { AppError, ensure } from "../errors";
import { deleteStoredObject } from "./storage";
import { sameName } from "@/lib/domain";

/** A removed property is deleted for good this long after its removal. */
export const ERASE_AFTER_DAYS = 30;
const DAY_MS = 86_400_000;
/** Properties the scheduler deletes per workspace and tick, at most. */
const ERASURES_PER_TICK = 2;
/** Stored photos retried per workspace and tick, at most. */
const PHOTO_RETRIES_PER_TICK = 20;

/** When a property removed at `removedAt` is deleted for good. */
export const erasesAt = (removedAt: Date) =>
  new Date(removedAt.getTime() + ERASE_AFTER_DAYS * DAY_MS);

export type ErasureTrigger = "OWNER" | "RETENTION" | "REAPPLIED";

/** What a deletion removed, as recorded in the ledger. */
export type ErasureCounts = {
  calendarLinks: number;
  calendarChecks: number;
  exportVersions: number;
  dateRanges: number;
  stays: number;
  overlaps: number;
  cleanings: number;
  conversations: number;
  messages: number;
  photos: number;
  alerts: number;
  queuedWork: number;
};

export type ErasureResult = {
  id: string;
  erasedAt: string;
  counts: ErasureCounts;
  /** Stored photos not yet confirmed deleted; the scheduler tries again. */
  photosPending: number;
};

/** Deleting a property for good is the workspace owner's decision alone. */
function ownerOnly(ctx: Context) {
  ensure(
    ctx.role === "HOST",
    403,
    "OWNER_REQUIRED",
    "Only the workspace owner can delete a property permanently.",
  );
}

/** What deleting a removed property would delete, for the owner to confirm. */
export async function erasurePreview(tx: Tx, ctx: Context, listingId: string) {
  ownerOnly(ctx);
  const listing = await tx.listing.findFirst({
    where: {
      id: listingId,
      workspaceId: ctx.workspaceId,
      archivedAt: { not: null },
    },
  });
  ensure(listing, 404, "NOT_FOUND", "Removed property not found.");
  const scope = { workspaceId: ctx.workspaceId, listingId };
  const tasks = await tx.cleaningTask.findMany({
    where: scope,
    select: { id: true },
  });
  const threads = await tx.thread.findMany({
    where: scope,
    select: { id: true },
  });
  return {
    id: listing.id,
    name: listing.name,
    removedAt: listing.archivedAt!.toISOString(),
    erasesAt: erasesAt(listing.archivedAt!).toISOString(),
    stays: await tx.reservation.count({ where: scope }),
    conversations: threads.length,
    messages: await tx.message.count({
      where: {
        workspaceId: ctx.workspaceId,
        threadId: { in: threads.map((t) => t.id) },
      },
    }),
    cleanings: tasks.length,
    photos: await tx.asset.count({
      where: {
        workspaceId: ctx.workspaceId,
        OR: [{ listingId }, { taskId: { in: tasks.map((t) => t.id) } }],
      },
    }),
    calendarLinks: await tx.channelConnection.count({ where: scope }),
    cleaners: await tx.cleaner.count({
      where: { workspaceId: ctx.workspaceId, listingIds: { has: listingId } },
    }),
  };
}

/**
 * The owner deletes a removed property now, confirming with their password
 * and the property's name. Asking again after a lost answer returns the
 * deletion already recorded.
 */
export async function eraseProperty(
  ctx: Context,
  listingId: string,
  input: { confirmName: string; password: string },
): Promise<ErasureResult> {
  ownerOnly(ctx);
  // Checked before anything is locked: a signed-in session alone is not
  // enough to delete for good.
  const user = await db.user.findUnique({ where: { id: ctx.actorId } });
  ensure(
    user &&
      !user.disabled &&
      passwordMatches(input.password, user.passwordHash),
    403,
    "PASSWORD_MISMATCH",
    "That password is not right. Nothing was deleted.",
  );
  return erase(ctx, listingId, "OWNER", (listing) =>
    ensure(
      sameName(input.confirmName, listing.name),
      400,
      "CONFIRMATION_MISMATCH",
      `Type the property's name, ${listing.name}, to confirm.`,
    ),
  );
}

const REASONS: Record<ErasureTrigger, string> = {
  OWNER:
    "The owner deleted this removed property permanently: its stays and guest details, conversations, cleaning jobs, photos, calendar links and alerts. Nothing was changed on any platform, and this log was not edited.",
  RETENTION:
    "This property was removed 30 days ago and has been deleted permanently: its stays and guest details, conversations, cleaning jobs, photos, calendar links and alerts. Nothing was changed on any platform, and this log was not edited.",
  REAPPLIED:
    "A deletion recorded before a backup restore was applied again to the restored data.",
};

/** The ledger entry for a property already deleted, if there is one. */
async function recorded(tx: Tx, ctx: Context, listingId: string) {
  return tx.erasure.findUnique({
    where: {
      workspaceId_subject_subjectId: {
        workspaceId: ctx.workspaceId,
        subject: "LISTING",
        subjectId: listingId,
      },
    },
  });
}

const resultOf = (row: {
  subjectId: string;
  erasedAt: Date;
  counts: Prisma.JsonValue;
  pendingObjects: string[];
}): ErasureResult => ({
  id: row.subjectId,
  erasedAt: row.erasedAt.toISOString(),
  counts: row.counts as ErasureCounts,
  photosPending: row.pendingObjects.length,
});

/** The SQL state of a failed raw query, such as "55P03". */
function sqlState(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const meta = error.meta as { code?: unknown } | undefined;
  return typeof meta?.code === "string" ? meta.code : null;
}

/** Delete one removed property and its stored photos, and record it. */
export async function erase(
  ctx: Context,
  listingId: string,
  trigger: ErasureTrigger,
  check?: (listing: Listing) => void,
): Promise<ErasureResult> {
  const { row, fresh } = await tenant(ctx, async (tx) => {
    // The same lock as removing, restoring and a calendar check's apply
    // step: none of them can interleave with the deletion.
    await lock(tx, "listing:" + listingId);
    const listing = await tx.listing.findFirst({
      where: { id: listingId, workspaceId: ctx.workspaceId },
    });
    if (!listing) {
      const done = await recorded(tx, ctx, listingId);
      ensure(done, 404, "NOT_FOUND", "Property not found.");
      return { row: done, fresh: false };
    }
    ensure(
      listing.archivedAt,
      409,
      "NOT_REMOVED",
      "Remove this property from the app before deleting it permanently.",
    );
    check?.(listing);
    try {
      await tx.$queryRaw`SELECT erase_listing(${listingId}, ${trigger}, ${ctx.actorId}) AS result`;
    } catch (error) {
      if (sqlState(error) === "55P03")
        throw new AppError(
          409,
          "SENDING",
          "A message about this property is being sent right now. Try again in a minute; nothing was deleted.",
        );
      throw error;
    }
    const done = await recorded(tx, ctx, listingId);
    ensure(done, 500, "ERASURE_UNRECORDED", "The deletion was not recorded.");
    await audit(tx, ctx, "ERASE", "Listing", listingId, REASONS[trigger], {
      trigger,
      counts: done.counts,
    });
    return { row: done, fresh: true };
  });
  if (!fresh) return resultOf(row);
  // Ids only. After a backup restore, these lines say which deletions made
  // since the backup must be applied again (scripts/erasures.ts).
  console.info(
    JSON.stringify({
      event: "property_erased",
      workspaceId: ctx.workspaceId,
      listingId,
      trigger,
      erasureId: row.id,
    }),
  );
  if (!row.pendingObjects.length) return resultOf(row);
  const pendingObjects = await deletePhotos(ctx, row.id, row.pendingObjects);
  return resultOf({ ...row, pendingObjects });
}

/** A recorded deletion, as exported for a backup restore: ids only. */
export type ErasureRecord = {
  workspaceId: string;
  subjectId: string;
  trigger: string;
  erasedAt: string;
};

/** Every deletion in the ledger, workspace by workspace, oldest first. */
export async function exportErasures(): Promise<ErasureRecord[]> {
  const workspaces = await db.workspace.findMany({
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  const records: ErasureRecord[] = [];
  for (const w of workspaces) {
    const ctx: Context = {
      workspaceId: w.id,
      actorId: "operator",
      role: "SYSTEM",
    };
    const rows = await tenant(ctx, (tx) =>
      tx.erasure.findMany({
        where: { workspaceId: w.id },
        orderBy: { erasedAt: "asc" },
        select: { subjectId: true, trigger: true, erasedAt: true },
      }),
    );
    for (const r of rows)
      records.push({
        workspaceId: w.id,
        subjectId: r.subjectId,
        trigger: r.trigger,
        erasedAt: r.erasedAt.toISOString(),
      });
  }
  return records;
}

/**
 * After a backup restore: delete again a property that was deleted after
 * the backup was made. Restored data from before its removal is taken out
 * of the app first, exactly as removal pauses its calendar links. A
 * property the restored data does not hold is left alone.
 */
export async function reapplyErasure(
  record: { workspaceId: string; subjectId: string },
  actorId: string,
): Promise<"ERASED" | "ABSENT"> {
  const ctx: Context = {
    workspaceId: record.workspaceId,
    actorId,
    role: "SYSTEM",
  };
  const listingId = record.subjectId;
  const present = await tenant(ctx, async (tx) => {
    await lock(tx, "listing:" + listingId);
    const listing = await tx.listing.findFirst({
      where: { id: listingId, workspaceId: ctx.workspaceId },
      select: { archivedAt: true },
    });
    if (!listing) return false;
    if (!listing.archivedAt) {
      await tx.channelConnection.updateMany({
        where: { workspaceId: ctx.workspaceId, listingId, enabled: true },
        data: {
          enabled: false,
          health: "PROPERTY_REMOVED",
          leaseToken: null,
          leaseUntil: null,
          fence: { increment: 1 },
        },
      });
      await tx.listing.update({
        where: { id: listingId },
        data: { archivedAt: new Date(), version: { increment: 1 } },
      });
    }
    return true;
  });
  if (!present) return "ABSENT";
  await erase(ctx, listingId, "REAPPLIED");
  return "ERASED";
}

/**
 * Delete stored photos for good and strike each one storage confirms from
 * the ledger. Returns the ones still pending. Only keys in the workspace's
 * own folder are ever deleted.
 */
async function deletePhotos(ctx: Context, erasureId: string, keys: string[]) {
  const gone: string[] = [];
  for (const key of keys) {
    if (!key.startsWith(ctx.workspaceId + "/")) continue;
    try {
      if (await deleteStoredObject(key)) gone.push(key);
    } catch {
      // Storage unreachable or not configured: the key stays pending.
    }
  }
  const rows = gone.length
    ? await tenant(
        ctx,
        (tx) => tx.$queryRaw<{ pendingObjects: string[] }[]>`
          UPDATE "Erasure"
             SET "pendingObjects" = ARRAY(
               SELECT k FROM unnest("pendingObjects") AS k
                WHERE NOT (k = ANY(${gone}::text[])))
           WHERE "id" = ${erasureId} AND "workspaceId" = ${ctx.workspaceId}
       RETURNING "pendingObjects"`,
      )
    : [];
  const pending = rows[0]?.pendingObjects ?? keys;
  if (pending.length)
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "erasure_photos_pending",
        erasureId,
        pending: pending.length,
      }),
    );
  return pending;
}

/**
 * The scheduler's part (each tick, per workspace): properties removed more
 * than 30 days ago are deleted for good, a few at a time, and stored photos
 * an earlier deletion could not remove are tried again.
 */
export async function eraseExpired(
  workspaceId: string,
  now = new Date(),
  deadline = Number.POSITIVE_INFINITY,
) {
  const ctx: Context = { workspaceId, actorId: "worker", role: "SYSTEM" };
  const due = await tenant(ctx, (tx) =>
    tx.listing.findMany({
      where: {
        workspaceId,
        archivedAt: {
          lte: new Date(now.getTime() - ERASE_AFTER_DAYS * DAY_MS),
        },
      },
      orderBy: { archivedAt: "asc" },
      select: { id: true },
      // More candidates than deletions, so one that keeps failing cannot
      // hold up the rest.
      take: ERASURES_PER_TICK * 3,
    }),
  );
  let erased = 0;
  const failures: unknown[] = [];
  for (const { id } of due) {
    if (erased >= ERASURES_PER_TICK || Date.now() > deadline) break;
    try {
      await erase(ctx, id, "RETENTION");
      erased++;
    } catch (error) {
      failures.push(error);
    }
  }
  if (Date.now() <= deadline) {
    const left = await tenant(ctx, (tx) =>
      tx.erasure.findMany({
        where: { workspaceId, pendingObjects: { isEmpty: false } },
        orderBy: { erasedAt: "asc" },
        select: { id: true, pendingObjects: true },
        take: 5,
      }),
    );
    let budget = PHOTO_RETRIES_PER_TICK;
    for (const row of left) {
      if (budget <= 0 || Date.now() > deadline) break;
      const keys = row.pendingObjects.slice(0, budget);
      budget -= keys.length;
      await deletePhotos(ctx, row.id, keys);
    }
  }
  // One property that cannot be deleted yet (a message being sent) must not
  // stop the others; the tick reports the first failure.
  if (failures.length) throw failures[0];
  return { erased };
}
