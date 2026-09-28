// API shapes for the calendar. Feed URLs, token hashes and snapshots never
// leave the server (SEC 03); guest fields are decrypted only for hosts.
import type {
  AvailabilityBlock,
  ChannelConnection,
  ConflictCase,
  Reservation,
} from "@prisma/client";
import { capabilityOf } from "@/domain/calendar/capabilities";
import { bufferOf } from "@/domain/calendar/conflicts";
import { RESTORE_WINDOW_MS } from "@/domain/calendar/lifecycle";
import { effectiveClass, type Platform } from "@/domain/calendar/types";
import type { Context } from "../db";
import { decrypt } from "../crypto";
import { blockState, toLocalDate } from "./mappers";

export function reservationDTO(r: Reservation, ctx: Context) {
  return {
    id: r.id,
    listingId: r.listingId,
    blockId: r.blockId,
    source: r.source,
    platform: r.platform,
    status: r.status,
    startDate: toLocalDate(r.startDate),
    endDate: toLocalDate(r.endDate),
    guestName:
      decrypt(r.guestNameEncrypted, ctx.workspaceId) ||
      "Guest details unavailable",
    hasGuestContact: !!r.guestContactEncrypted,
    price: r.price === null ? null : Number(r.price),
    currency: r.currency,
    firstObservedAt: r.firstObservedAt,
    version: r.version,
  };
}

export function blockDTO(
  row: AvailabilityBlock,
  ctx: Context,
  input: {
    platform: string;
    defaultBufferDays: number;
    reservation: Reservation | null;
  },
) {
  const b = blockState(row);
  const buffer = bufferOf(b, input.defaultBufferDays);
  return {
    id: b.id,
    listingId: b.listingId,
    connectionId: b.connectionId,
    platform: input.platform,
    identityKind: b.identityKind,
    startDate: b.startDate,
    endDate: b.endDate,
    classification: b.classification,
    effectiveClass: effectiveClass(b),
    evidenceRule: b.classificationEvidence.rule,
    suggested: b.classificationEvidence.suggested ?? null,
    labelKey: b.sourceLabelKey,
    overrideClassification: b.overrideClassification,
    lifecycle: b.lifecycle,
    decisionReason: b.decisionReason,
    sourceStatus: b.sourceStatus,
    holdType: b.holdType,
    reason: row.reasonEncrypted
      ? decrypt(row.reasonEncrypted, ctx.workspaceId)
      : null,
    reviewFlags: b.reviewFlags,
    pendingChange: b.pendingChange,
    buffer: {
      before: buffer.before,
      after: buffer.after,
      overridden: b.bufferBeforeDays !== null || b.bufferAfterDays !== null,
    },
    firstSeenAt: b.firstSeenAt,
    lastSeenAt: b.lastSeenAt,
    missingSince: b.missingSince,
    releasedAt: b.releasedAt,
    restorableUntil: b.releasedAt
      ? new Date(Date.parse(b.releasedAt) + RESTORE_WINDOW_MS).toISOString()
      : null,
    revision: b.revision,
    reservation: input.reservation
      ? reservationDTO(input.reservation, ctx)
      : null,
  };
}

export function connectionDTO(c: ChannelConnection, now = Date.now()) {
  const capability = capabilityOf(c.platform as Platform);
  return {
    id: c.id,
    listingId: c.listingId,
    platform: c.platform,
    platformName: capability.displayName,
    label: c.label,
    importing: !!c.importUrlEncrypted,
    enabled: c.enabled,
    health: c.health,
    lastResult: c.lastResult,
    lastSuccessAt: c.lastSuccessAt,
    lastAttemptAt: c.lastAttemptAt,
    nextFetchAt: c.nextFetchAt,
    sourceRetryAfter: c.sourceRetryAfter,
    checking: !!c.leaseUntil && c.leaseUntil.getTime() > now,
    failures: c.failures,
    coverageEnd: c.coverageEnd ? toLocalDate(c.coverageEnd) : null,
    policy: {
      mode: c.policyMode,
      labels: c.policyLabels,
      version: c.policyVersion,
      decidedAt: c.policyDecidedAt,
    },
    refreshGuidance: capability.refreshGuidance,
    exportTokenGeneration: c.exportTokenGeneration,
  };
}

export function conflictDTO(c: ConflictCase) {
  return {
    id: c.id,
    listingId: c.listingId,
    blockAId: c.blockAId,
    blockBId: c.blockBId,
    kind: c.kind,
    severity: c.severity,
    state: c.state,
    overlapStart: toLocalDate(c.overlapStart),
    overlapEnd: toLocalDate(c.overlapEnd),
    firstDetectedAt: c.firstDetectedAt,
    lastDetectedAt: c.lastDetectedAt,
    revision: c.revision,
  };
}
