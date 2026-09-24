import ICAL from "ical.js";
import type { Booking, Listing, SyncSource } from "@prisma/client";
import { db, tenant, lock, type Context, type Tx } from "../db";
import { audit, event, notify } from "../audit";
import { decrypt, encrypt, hash, blind, randomToken, unseal } from "../crypto";
import { dateOnly, dayAdd, overlaps, type HouseManual } from "@/lib/domain";
import { AppError, ensure } from "../errors";
import { safeRequest } from "../integrations/http";
import { createTurnover } from "./cleaning";
import { appUrl } from "../config";
export function bookingDTO(b: Booking, ctx: Context) {
  return {
    id: b.id,
    listingId: b.listingId,
    guestName:
      decrypt(b.guestNameEncrypted, ctx.workspaceId) ||
      "Guest details unavailable",
    startDate: dateOnly(b.startDate),
    endDate: dateOnly(b.endDate),
    platform: b.platform,
    status: b.status,
    kind: b.kind,
    reason: b.reason,
    price: b.price === null ? null : Number(b.price),
    currency: b.currency,
    confirmedAt: b.confirmedAt,
    conflictWithId: b.conflictWithId,
    version: b.version,
  };
}
export function listingDTO(l: Listing, ctx: Context) {
  return {
    id: l.id,
    name: l.name,
    address: l.address,
    timezone: l.timezone,
    color: l.color,
    currency: l.currency,
    bufferDays: l.bufferDays,
    checkoutHour: l.checkoutHour,
    cleaningBufferHours: l.cleaningBufferHours,
    photoIds: l.photoIds,
    ready: l.ready,
    version: l.version,
    hasDoorCode: !!l.doorCodeEncrypted,
    houseManual: unseal<HouseManual>(l.houseManualEncrypted, ctx.workspaceId),
  };
}
export function exportLink(
  workspaceId: string,
  listingId: string,
  token: string,
  sourceId?: string,
) {
  return `${appUrl()}/api/listings/${listingId}/export.ics?workspace=${encodeURIComponent(workspaceId)}&token=${encodeURIComponent(token)}${sourceId ? "&source=" + encodeURIComponent(sourceId) : ""}`;
}
export async function blockDates(
  tx: Tx,
  ctx: Context,
  input: {
    listingId: string;
    from: string;
    to: string;
    reason: string;
    idempotencyKey: string;
  },
) {
  await lock(tx, `listing:${input.listingId}`);
  const old = await tx.booking.findFirst({
    where: {
      workspaceId: ctx.workspaceId,
      externalUid: input.idempotencyKey,
      kind: "BLOCK",
    },
  });
  if (old) return bookingDTO(old, ctx);
  const l = await tx.listing.findFirst({
    where: {
      id: input.listingId,
      workspaceId: ctx.workspaceId,
      archivedAt: null,
    },
  });
  ensure(l, 404, "NOT_FOUND", "Listing not found.");
  const startDate = new Date(input.from + "T00:00:00Z"),
    endDate = new Date(input.to + "T00:00:00Z");
  const existing = await tx.booking.findMany({
    where: {
      listingId: l.id,
      workspaceId: ctx.workspaceId,
      status: { in: ["CONFIRMED", "CONFLICT", "PENDING_REMOVAL"] },
    },
  });
  ensure(
    !existing.some((b) => overlaps({ startDate, endDate }, b, l.bufferDays)),
    409,
    "DATE_CONFLICT",
    "This range overlaps a reservation, block, or protected buffer.",
  );
  const b = await tx.booking.create({
    data: {
      workspaceId: ctx.workspaceId,
      listingId: l.id,
      externalUid: input.idempotencyKey,
      startDate,
      endDate,
      platform: "DIRECT",
      kind: "BLOCK",
      reason: input.reason,
      confirmedAt: new Date(),
      currency: l.currency,
    },
  });
  await event(tx, ctx, "CALENDAR_BLOCKED", b.id, "block:" + b.id, {
    listingId: l.id,
  });
  await audit(
    tx,
    ctx,
    "CREATE",
    "Booking",
    b.id,
    "Host blocked dates; all export feeds include this block.",
    { from: input.from, to: input.to, reason: input.reason },
  );
  return bookingDTO(b, ctx);
}
export type FeedEvent = {
  uid: string;
  start: Date;
  end: Date;
  confirmedAt: Date | null;
  cancelled: boolean;
};
export function parseFeed(body: string): FeedEvent[] {
  ensure(
    body.trimStart().startsWith("BEGIN:VCALENDAR"),
    422,
    "INVALID_ICAL",
    "The feed is not an iCalendar document.",
  );
  const calendar = new ICAL.Component(ICAL.parse(body));
  const result: FeedEvent[] = [];
  const floor = dayAdd(new Date(), -365),
    ceiling = dayAdd(new Date(), 730);
  for (const component of calendar.getAllSubcomponents("vevent")) {
    const ev = new ICAL.Event(component);
    if (ev.isRecurrenceException()) continue;
    ensure(ev.uid, 422, "INVALID_UID", "A calendar event is missing its UID.");
    if (ev.uid.endsWith("@airbnb-automation")) continue;
    const stamp =
      component.getFirstPropertyValue("created") ||
      component.getFirstPropertyValue("dtstamp");
    const cancelled =
      String(component.getFirstPropertyValue("status")).toUpperCase() ===
      "CANCELLED";
    if (!ev.startDate || !ev.endDate)
      throw new AppError(
        422,
        "INVALID_DATES",
        "A calendar event is missing its date range.",
      );
    const add = (start: ICAL.Time, end: ICAL.Time, suffix = "") => {
      const s = new Date(start.toString().slice(0, 10) + "T00:00:00Z"),
        e = new Date(end.toString().slice(0, 10) + "T00:00:00Z");
      ensure(
        e > s,
        422,
        "INVALID_RANGE",
        "A feed event has an invalid or zero-length stay.",
      );
      result.push({
        uid: ev.uid + suffix,
        start: s,
        end: e,
        confirmedAt: stamp instanceof ICAL.Time ? stamp.toJSDate() : null,
        cancelled,
      });
    };
    if (ev.isRecurring()) {
      let count = 0;
      const iterator = ev.iterator();
      let next;
      while ((next = iterator.next())) {
        if (++count > 3000)
          throw new AppError(
            422,
            "RECURRENCE_LIMIT",
            "A recurrence is too large to safely import.",
          );
        if (next.toJSDate() > ceiling) break;
        if (next.toJSDate() < floor) continue;
        const detail = ev.getOccurrenceDetails(next);
        if (
          String(
            detail.item.component.getFirstPropertyValue("status"),
          ).toUpperCase() === "CANCELLED"
        ) {
          result.push({
            uid: ev.uid + "#" + next.toString(),
            start: new Date(
              detail.startDate.toString().slice(0, 10) + "T00:00:00Z",
            ),
            end: new Date(
              detail.endDate.toString().slice(0, 10) + "T00:00:00Z",
            ),
            confirmedAt: null,
            cancelled: true,
          });
        } else add(detail.startDate, detail.endDate, "#" + next.toString());
      }
    } else add(ev.startDate, ev.endDate);
    ensure(
      result.length <= 10000,
      422,
      "FEED_LIMIT",
      "The feed exceeds the supported event limit.",
    );
  }
  return result;
}
async function reconcile(
  tx: Tx,
  ctx: Context,
  source: SyncSource,
  events: FeedEvent[],
) {
  await lock(tx, "listing:" + source.listingId);
  const listing = await tx.listing.findUniqueOrThrow({
    where: { id: source.listingId },
  });
  const now = new Date();
  for (const e of events) {
    const where = {
      workspaceId_listingId_platform_externalUid: {
        workspaceId: ctx.workspaceId,
        listingId: source.listingId,
        platform: source.platform,
        externalUid: e.uid,
      },
    };
    const existing = await tx.booking.findUnique({ where });
    const confirmedAt = existing?.confirmedAt || e.confirmedAt || now;
    const b = await tx.booking.upsert({
      where,
      create: {
        workspaceId: ctx.workspaceId,
        listingId: source.listingId,
        sourceId: source.id,
        externalUid: e.uid,
        startDate: e.start,
        endDate: e.end,
        platform: source.platform,
        currency: listing.currency,
        status: e.cancelled ? "CANCELLED" : "CONFIRMED",
        confirmedAt,
        lastSeenAt: now,
      },
      update: {
        startDate: e.start,
        endDate: e.end,
        lastSeenAt: now,
        missingCount: 0,
        ...(e.cancelled
          ? { status: "CANCELLED" }
          : existing &&
              ["PENDING_REMOVAL", "CANCELLED"].includes(existing.status)
            ? { status: "CONFIRMED" }
            : {}),
        version: { increment: 1 },
      },
    });
    if (e.cancelled) {
      await event(
        tx,
        ctx,
        "BOOKING_CANCELLED_BY_SOURCE",
        b.id,
        `cancel:${b.id}:${b.version}`,
      );
      await audit(
        tx,
        ctx,
        "SYNC_CANCEL",
        "Booking",
        b.id,
        "The source explicitly marked the reservation cancelled.",
      );
      await tx.magicLink.updateMany({
        where: {
          workspaceId: ctx.workspaceId,
          taskId: {
            in: (
              await tx.cleaningTask.findMany({
                where: { bookingId: b.id, workspaceId: ctx.workspaceId },
                select: { id: true },
              })
            ).map((t) => t.id),
          },
        },
        data: { revokedAt: now },
      });
      continue;
    }
    if (!existing)
      await event(tx, ctx, "BOOKING_IMPORTED", b.id, "import:" + b.id, {
        sourceId: source.id,
      });
  }
  const unseen = await tx.booking.findMany({
    where: {
      sourceId: source.id,
      workspaceId: ctx.workspaceId,
      lastSeenAt: { lt: now },
      endDate: { gte: dayAdd(now, -30) },
      status: { in: ["CONFIRMED", "CONFLICT"] },
    },
  });
  for (const b of unseen) {
    await tx.booking.update({
      where: { id: b.id },
      data: {
        missingCount: { increment: 1 },
        ...(b.missingCount >= 1 ? { status: "PENDING_REMOVAL" } : {}),
      },
    });
    if (b.missingCount >= 1)
      await notify(
        tx,
        ctx,
        "missing:" + b.id,
        "Reservation disappeared from feed",
        "Review the reservation before releasing protected dates.",
        "/calendar",
      );
  }
  await reconcileListingConflicts(tx, ctx, listing);
}
export async function reconcileListingConflicts(
  tx: Tx,
  ctx: Context,
  listing: Listing,
) {
  await lock(tx, "listing:" + listing.id);
  // Missing feed records remain protected until a host explicitly releases them.
  const all = await tx.booking.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      listingId: listing.id,
      status: { in: ["CONFIRMED", "CONFLICT", "PENDING_REMOVAL"] },
    },
    orderBy: [
      { priorityOverride: "desc" },
      { confirmedAt: "asc" },
      { observedAt: "asc" },
      { id: "asc" },
    ],
  });
  const winners: Booking[] = [];
  for (const b of all) {
    const winner = winners.find((w) => overlaps(w, b, listing.bufferDays));
    if (winner) {
      if (b.conflictWithId !== winner.id || b.status === "CONFIRMED")
        await tx.booking.update({
          where: { id: b.id },
          data: {
            status:
              b.status === "PENDING_REMOVAL" ? "PENDING_REMOVAL" : "CONFLICT",
            conflictWithId: winner.id,
            version: { increment: 1 },
          },
        });
      await notify(
        tx,
        ctx,
        "conflict:" + b.id,
        "Calendar conflict needs review",
        `${listing.name} has overlapping reservations or a buffer violation. No external booking was cancelled.`,
        "/calendar",
      );
      await event(
        tx,
        ctx,
        "BOOKING_CONFLICT",
        b.id,
        `conflict:${b.id}:${winner.id}`,
        { winnerId: winner.id },
      );
      if (b.status !== "CONFLICT" || b.conflictWithId !== winner.id)
        await audit(
          tx,
          ctx,
          "CONFLICT",
          "Booking",
          b.id,
          "Earliest confirmation is the preferred reservation; all conflicting dates remain blocked.",
          { preferredId: winner.id },
        );
    } else {
      winners.push(b);
      if (b.status === "CONFLICT" || b.conflictWithId)
        await tx.booking.update({
          where: { id: b.id },
          data: {
            status: b.status === "CONFLICT" ? "CONFIRMED" : b.status,
            conflictWithId: null,
            version: { increment: 1 },
          },
        });
      if (b.status !== "PENDING_REMOVAL")
        await createTurnover(tx, ctx, { ...b, status: "CONFIRMED" }, listing);
    }
  }
}

export async function pollSource(ctx: Context, sourceId: string) {
  const lease = randomToken();
  const source = await tenant(ctx, async (tx) => {
    const claimed = await tx.syncSource.updateMany({
      where: {
        id: sourceId,
        workspaceId: ctx.workspaceId,
        enabled: true,
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      data: {
        leaseUntil: new Date(Date.now() + 55000),
        leaseToken: lease,
        lastAttemptAt: new Date(),
      },
    });
    return claimed.count
      ? tx.syncSource.findUnique({ where: { id: sourceId } })
      : null;
  });
  if (!source) return;
  const started = Date.now();
  try {
    const headers: Record<string, string> = {
      Accept: "text/calendar",
      "User-Agent": "AirbnbAutomation/1.0",
    };
    if (source.etag) headers["If-None-Match"] = source.etag;
    if (source.lastModified) headers["If-Modified-Since"] = source.lastModified;
    const response = await safeRequest(
      decrypt(source.urlEncrypted, ctx.workspaceId),
      { allowlist: process.env.ICAL_ALLOWED_HOSTS || "", headers },
    );
    ensure(
      response.status === 200 || response.status === 304,
      502,
      "FEED_HTTP",
      "The feed returned an error or redirect; use its final HTTPS URL.",
    );
    const events = response.status === 200 ? parseFeed(response.body) : null;
    await tenant(ctx, async (tx) => {
      const current = await tx.syncSource.findUnique({
        where: { id: source.id },
      });
      if (current?.leaseToken !== lease) return;
      if (events) await reconcile(tx, ctx, source, events);
      await tx.syncSource.update({
        where: { id: source.id },
        data: {
          status: "SYNCED",
          lastSyncedAt: new Date(),
          nextPollAt: new Date(
            Date.now() +
              Math.max(
                60,
                Math.min(120, Number(process.env.SYNC_POLL_SECONDS) || 120),
              ) *
                1000,
          ),
          failures: 0,
          error: null,
          etag: String(response.headers.etag || source.etag || "") || null,
          lastModified:
            String(
              response.headers["last-modified"] || source.lastModified || "",
            ) || null,
          leaseUntil: null,
          leaseToken: null,
        },
      });
      await tx.syncRun.create({
        data: {
          workspaceId: ctx.workspaceId,
          sourceId: source.id,
          success: true,
          durationMs: Date.now() - started,
          events: events?.length || 0,
        },
      });
      await audit(
        tx,
        ctx,
        "POLL",
        "SyncSource",
        source.id,
        "Source calendar fetched; destination platform refresh remains outside our control.",
      );
    });
  } catch (error) {
    await tenant(ctx, async (tx) => {
      await tx.syncSource.updateMany({
        where: { id: source.id, leaseToken: lease },
        data: {
          status: "ERROR",
          error:
            "Calendar feed unavailable or invalid. Check URL, access, and domain allowlist.",
          failures: { increment: 1 },
          nextPollAt: new Date(
            Date.now() +
              Math.min(15 * 60000, 120000 * 2 ** Math.min(source.failures, 3)),
          ),
          leaseUntil: null,
          leaseToken: null,
        },
      });
      await tx.syncRun.create({
        data: {
          workspaceId: ctx.workspaceId,
          sourceId: source.id,
          success: false,
          durationMs: Date.now() - started,
          error: error instanceof AppError ? error.code : "FETCH_FAILED",
        },
      });
      await notify(
        tx,
        ctx,
        `sync-error:${source.id}:${dateOnly(new Date())}`,
        "Calendar sync needs attention",
        "The last known dates are still protected. Check the affected feed.",
        "/calendar",
      );
      await audit(
        tx,
        ctx,
        "POLL_FAILED",
        "SyncSource",
        source.id,
        "Failed feed was not used to remove any reservations.",
      );
    });
  }
}
export async function calendarFeed(
  ctx: Context,
  listingId: string,
  token: string,
  sourceId?: string,
) {
  return tenant(ctx, async (tx) => {
    const listing = await tx.listing.findFirst({
      where: { workspaceId: ctx.workspaceId, id: listingId, archivedAt: null },
    });
    ensure(listing, 404, "NOT_FOUND", "Calendar not found.");
    let exclude: string | undefined;
    if (sourceId) {
      const source = await tx.syncSource.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          id: sourceId,
          listingId,
          enabled: true,
          tokenHash: hash(token),
        },
      });
      ensure(source, 404, "NOT_FOUND", "Calendar not found.");
      exclude = source.platform;
    } else
      ensure(
        listing.exportTokenHash === hash(token),
        404,
        "NOT_FOUND",
        "Calendar not found.",
      );
    const bookings = await tx.booking.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        listingId,
        status: { in: ["CONFIRMED", "CONFLICT", "PENDING_REMOVAL"] },
        endDate: { gte: dayAdd(new Date(), -365) },
      },
    });
    const cal = new ICAL.Component(["vcalendar", [], []]);
    cal.updatePropertyWithValue("version", "2.0");
    cal.updatePropertyWithValue(
      "prodid",
      "-//Airbnb Automation//Protected Availability//EN",
    );
    for (const b of bookings) {
      const add = (from: Date, to: Date, suffix: string) => {
        if (to <= from) return;
        const ev = new ICAL.Event();
        ev.uid = b.id + suffix + "@airbnb-automation";
        ev.summary = "Unavailable";
        ev.startDate = ICAL.Time.fromDateString(dateOnly(from));
        ev.endDate = ICAL.Time.fromDateString(dateOnly(to));
        ev.component.updatePropertyWithValue(
          "dtstamp",
          ICAL.Time.fromJSDate(b.updatedAt, true),
        );
        ev.component.updatePropertyWithValue("status", "CONFIRMED");
        cal.addSubcomponent(ev.component);
      };
      if (b.platform !== exclude) add(b.startDate, b.endDate, "");
      if (listing.bufferDays) {
        add(dayAdd(b.startDate, -listing.bufferDays), b.startDate, "-pre");
        add(b.endDate, dayAdd(b.endDate, listing.bufferDays), "-post");
      }
    }
    await audit(
      tx,
      ctx,
      "EXPORT",
      "Listing",
      listingId,
      "Availability-only iCal feed requested; no guest data or price exported.",
    );
    return cal.toString() + "\r\n";
  });
}

export async function createDirectBooking(
  tx: Tx,
  ctx: Context,
  input: {
    listingId: string;
    from: string;
    to: string;
    guestName: string;
    guestContact: string;
    price: number | null;
    currency: string;
    idempotencyKey: string;
  },
) {
  await lock(tx, "listing:" + input.listingId);
  const listing = await tx.listing.findFirst({
    where: {
      id: input.listingId,
      workspaceId: ctx.workspaceId,
      archivedAt: null,
    },
  });
  ensure(listing, 404, "NOT_FOUND", "Listing not found.");
  ensure(
    input.currency === listing.currency,
    400,
    "CURRENCY_MISMATCH",
    "Use the listing currency for this reservation.",
  );
  const existing = await tx.booking.findUnique({
    where: {
      workspaceId_listingId_platform_externalUid: {
        workspaceId: ctx.workspaceId,
        listingId: listing.id,
        platform: "DIRECT",
        externalUid: input.idempotencyKey,
      },
    },
  });
  if (existing) {
    ensure(
      existing.kind === "RESERVATION" &&
        dateOnly(existing.startDate) === input.from &&
        dateOnly(existing.endDate) === input.to &&
        decrypt(existing.guestNameEncrypted, ctx.workspaceId) ===
          input.guestName &&
        decrypt(existing.guestContactEncrypted, ctx.workspaceId) ===
          input.guestContact &&
        (existing.price === null ? null : Number(existing.price)) ===
          input.price,
      409,
      "IDEMPOTENCY_CONFLICT",
      "This request key was already used for different reservation details.",
    );
    const thread = await tx.thread.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        bookingId: existing.id,
        platform: "DIRECT",
      },
    });
    await audit(
      tx,
      ctx,
      "READ",
      "Booking",
      existing.id,
      "An idempotent reservation request returned the existing booking.",
    );
    return { ...bookingDTO(existing, ctx), threadId: thread?.id || null };
  }
  const startDate = new Date(input.from + "T00:00:00Z"),
    endDate = new Date(input.to + "T00:00:00Z");
  const protectedBookings = await tx.booking.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      listingId: listing.id,
      status: { in: ["CONFIRMED", "CONFLICT", "PENDING_REMOVAL"] },
    },
  });
  ensure(
    !protectedBookings.some((b) =>
      overlaps({ startDate, endDate }, b, listing.bufferDays),
    ),
    409,
    "DATE_CONFLICT",
    "These dates overlap a reservation, a manual block, or a protected buffer.",
  );
  const booking = await tx.booking.create({
    data: {
      workspaceId: ctx.workspaceId,
      listingId: listing.id,
      externalUid: input.idempotencyKey,
      platform: "DIRECT",
      kind: "RESERVATION",
      status: "CONFIRMED",
      startDate,
      endDate,
      confirmedAt: new Date(),
      guestNameEncrypted: encrypt(input.guestName, ctx.workspaceId),
      guestContactEncrypted: encrypt(input.guestContact, ctx.workspaceId),
      guestHash: input.guestContact ? blind(input.guestContact) : null,
      price: input.price,
      currency: listing.currency,
    },
  });
  const thread = await tx.thread.create({
    data: {
      workspaceId: ctx.workspaceId,
      listingId: listing.id,
      bookingId: booking.id,
      platform: "DIRECT",
      externalId: booking.id,
      status: "RESOLVED",
    },
  });
  await createTurnover(tx, ctx, booking, listing);
  await event(
    tx,
    ctx,
    "BOOKING_CONFIRMED",
    booking.id,
    "direct:" + booking.id,
    { listingId: listing.id },
  );
  await audit(
    tx,
    ctx,
    "CREATE",
    "Booking",
    booking.id,
    "Host confirmed a direct reservation. Guest information is encrypted; all availability exports include its dates.",
    { from: input.from, to: input.to, threadId: thread.id },
  );
  return { ...bookingDTO(booking, ctx), threadId: thread.id };
}
