import type { Listing } from "@prisma/client";
import type { HouseManual } from "@/lib/domain";
import type { Context } from "../db";
import { unseal } from "../crypto";

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
