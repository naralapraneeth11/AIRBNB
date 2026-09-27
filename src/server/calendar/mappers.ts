// Conversions between persisted rows and the pure core's plain state. Dates
// are DATE columns (UTC midnight in JS) and become "YYYY-MM-DD"; instants
// become ISO strings, so the core never sees a Date object.
import {
  Prisma,
  type AvailabilityBlock,
  type ChannelConnection,
} from "@prisma/client";
import type { LocalDate } from "@/domain/calendar/dates";
import type { NewBlock } from "@/domain/calendar/compare";
import type {
  BlockState,
  ClassificationEvidence,
  ConnectionPolicy,
  HostClass,
  PendingChange,
  Platform,
  ReviewFlag,
} from "@/domain/calendar/types";

export const toLocalDate = (d: Date): LocalDate => d.toISOString().slice(0, 10);
export const fromLocalDate = (d: LocalDate) => new Date(d + "T00:00:00Z");
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const date = (s: string | null) => (s ? new Date(s) : null);

export function blockState(row: AvailabilityBlock): BlockState {
  return {
    id: row.id,
    listingId: row.listingId,
    connectionId: row.connectionId,
    sourceKey: row.sourceKey,
    identityKind: row.identityKind as BlockState["identityKind"],
    startDate: toLocalDate(row.startDate),
    endDate: toLocalDate(row.endDate),
    classification: row.classification as BlockState["classification"],
    classificationEvidence:
      row.classificationEvidence as ClassificationEvidence,
    holdType: row.holdType as BlockState["holdType"],
    lifecycle: row.lifecycle as BlockState["lifecycle"],
    decisionReason: row.decisionReason as BlockState["decisionReason"],
    sourceStatus: row.sourceStatus as BlockState["sourceStatus"],
    sourceSequence: row.sourceSequence,
    sourceStamp: iso(row.sourceStamp),
    sourceLabelKey: row.sourceLabelKey,
    contentDigest: row.contentDigest,
    sourceRevision: row.sourceRevision,
    firstSeenAt: iso(row.firstSeenAt),
    lastSeenAt: iso(row.lastSeenAt),
    missingSince: iso(row.missingSince),
    missingObservations: row.missingObservations,
    lastMissingObservationAt: iso(row.lastMissingObservationAt),
    bufferBeforeDays: row.bufferBeforeDays,
    bufferAfterDays: row.bufferAfterDays,
    overrideClassification: row.overrideClassification as HostClass | null,
    overrideBasedOnRevision: row.overrideBasedOnRevision,
    reviewFlags: (row.reviewFlags ?? []) as ReviewFlag[],
    pendingChange: (row.pendingChange as PendingChange | null) ?? null,
    compensatesBlockId: row.compensatesBlockId,
    releasedAt: iso(row.releasedAt),
    revision: row.revision,
    committedRevision: row.committedRevision,
  };
}

/** The persisted columns owned by the core (adapter-only columns excluded). */
export function blockData(b: Omit<BlockState, "id"> | NewBlock) {
  return {
    listingId: b.listingId,
    connectionId: b.connectionId,
    sourceKey: b.sourceKey,
    identityKind: b.identityKind,
    startDate: fromLocalDate(b.startDate),
    endDate: fromLocalDate(b.endDate),
    classification: b.classification,
    classificationEvidence: b.classificationEvidence as Prisma.InputJsonValue,
    holdType: b.holdType,
    lifecycle: b.lifecycle,
    decisionReason: b.decisionReason,
    sourceStatus: b.sourceStatus,
    sourceSequence: b.sourceSequence,
    sourceStamp: date(b.sourceStamp),
    sourceLabelKey: b.sourceLabelKey,
    contentDigest: b.contentDigest,
    sourceRevision: b.sourceRevision,
    firstSeenAt: date(b.firstSeenAt),
    lastSeenAt: date(b.lastSeenAt),
    missingSince: date(b.missingSince),
    missingObservations: b.missingObservations,
    lastMissingObservationAt: date(b.lastMissingObservationAt),
    bufferBeforeDays: b.bufferBeforeDays,
    bufferAfterDays: b.bufferAfterDays,
    overrideClassification: b.overrideClassification,
    overrideBasedOnRevision: b.overrideBasedOnRevision,
    reviewFlags: b.reviewFlags,
    // JSON null must be explicit: `undefined` would leave a stale value.
    pendingChange:
      b.pendingChange === null
        ? Prisma.DbNull
        : (b.pendingChange as unknown as Prisma.InputJsonValue),
    compensatesBlockId: b.compensatesBlockId,
    releasedAt: date(b.releasedAt),
    revision: b.revision,
    committedRevision: b.committedRevision,
  };
}

export function connectionPolicy(c: ChannelConnection): ConnectionPolicy {
  return {
    mode: c.policyMode as ConnectionPolicy["mode"],
    labels: (c.policyLabels as Record<string, HostClass> | null) ?? null,
    version: c.policyVersion,
  };
}

export const platformOf = (c: Pick<ChannelConnection, "platform">) =>
  c.platform as Platform;
