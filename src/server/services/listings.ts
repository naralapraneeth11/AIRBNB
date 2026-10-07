import type { Listing } from "@prisma/client";
import type { HouseManual } from "@/lib/domain";
import type { Context, Tx } from "../db";
import { unseal } from "../crypto";
import { ensure } from "../errors";

/**
 * The workspace's properties that have not been removed. Anything a removed
 * property owns (calendar links, dates, cleaning, conversations) is left out
 * of every screen and refused by every action; see services/properties.ts.
 */
export async function activeListingIds(tx: Tx, ctx: Context) {
  const rows = await tx.listing.findMany({
    where: { workspaceId: ctx.workspaceId, archivedAt: null },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** A property that can still be worked on: found, and not removed. */
export async function activeListing(tx: Tx, ctx: Context, listingId: string) {
  const listing = await tx.listing.findFirst({
    where: { id: listingId, workspaceId: ctx.workspaceId },
  });
  ensure(listing, 404, "NOT_FOUND", "Property not found.");
  ensure(
    !listing.archivedAt,
    409,
    "PROPERTY_REMOVED",
    "This property was removed. Restore it on the Properties page to work with it again.",
  );
  return listing;
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
