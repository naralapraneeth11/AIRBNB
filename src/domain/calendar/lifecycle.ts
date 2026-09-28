// Host decisions on protected dates (LIFE 01-03, MANUAL 01-02). These are the
// only transitions that release availability, and each needs the block
// revision the host reviewed. Undo is compensation: a new hold, never a
// rewrite of history (LIFE 04).
import type { LocalDate } from "./dates";
import { RULES_VERSION } from "./capabilities";
import type { NewBlock } from "./compare";
import {
  effectiveClass,
  isProtective,
  type BlockState,
  type HoldType,
  type HostClass,
} from "./types";

export type TransitionError =
  "STALE_REVISION" | "INVALID_STATE" | "RESTORE_WINDOW_PASSED" | "NOT_IMPORTED";

export type TransitionResult =
  { ok: true; block: BlockState } | { ok: false; error: TransitionError };

/** LIFE 03: a released block may be restored within this window. */
export const RESTORE_WINDOW_MS = 24 * 3_600_000;

const bump = (b: BlockState, nextRevision: number): BlockState => ({
  ...b,
  reviewFlags: [...b.reviewFlags],
  revision: b.revision + 1,
  committedRevision: nextRevision,
});

function guard(
  b: BlockState,
  expectedRevision: number,
): TransitionError | null {
  return b.revision === expectedRevision ? null : "STALE_REVISION";
}

/** LIFE 03: a deliberate release of protected nights. */
export function releaseBlock(
  b: BlockState,
  input: { expectedRevision: number; now: string; nextRevision: number },
): TransitionResult {
  const stale = guard(b, input.expectedRevision);
  if (stale) return { ok: false, error: stale };
  if (!isProtective(b)) return { ok: false, error: "INVALID_STATE" };
  const next = bump(b, input.nextRevision);
  next.lifecycle = "RELEASED";
  next.decisionReason = null;
  next.releasedAt = input.now;
  next.missingSince = null;
  next.missingObservations = 0;
  next.lastMissingObservationAt = null;
  return { ok: true, block: next };
}

/** "Keep blocked": a retained hold; the same alert is not recreated. */
export function keepBlocked(
  b: BlockState,
  input: { expectedRevision: number; nextRevision: number },
): TransitionResult {
  const stale = guard(b, input.expectedRevision);
  if (stale) return { ok: false, error: stale };
  if (b.lifecycle !== "AWAITING_DECISION" && b.lifecycle !== "MISSING_OBSERVED")
    return { ok: false, error: "INVALID_STATE" };
  const next = bump(b, input.nextRevision);
  next.lifecycle = "RETAINED_HOLD";
  next.decisionReason = null;
  next.missingSince = null;
  next.missingObservations = 0;
  next.lastMissingObservationAt = null;
  return { ok: true, block: next };
}

/**
 * Restore within 24 hours of a release: a new compensating hold with the same
 * dates. It cannot recall a platform refresh or cancel a booking made
 * meanwhile; the interface says so before the host confirms.
 */
export function restoreBlock(
  b: BlockState,
  input: { expectedRevision: number; now: string; nextRevision: number },
): { ok: true; hold: NewBlock } | { ok: false; error: TransitionError } {
  const stale = guard(b, input.expectedRevision);
  if (stale) return { ok: false, error: stale };
  if (b.lifecycle !== "RELEASED" || !b.releasedAt)
    return { ok: false, error: "INVALID_STATE" };
  if (Date.parse(input.now) - Date.parse(b.releasedAt) > RESTORE_WINDOW_MS)
    return { ok: false, error: "RESTORE_WINDOW_PASSED" };
  return {
    ok: true,
    hold: manualHold({
      listingId: b.listingId,
      startDate: b.startDate,
      endDate: b.endDate,
      holdType: "RESTORED",
      now: input.now,
      nextRevision: input.nextRevision,
      compensatesBlockId: b.id,
      reservation: false,
    }),
  };
}

/** MANUAL 01: a host-created hold or direct reservation. */
export function manualHold(input: {
  listingId: string;
  startDate: LocalDate;
  endDate: LocalDate;
  holdType: HoldType;
  now: string;
  nextRevision: number;
  compensatesBlockId?: string | null;
  reservation: boolean;
}): NewBlock {
  return {
    listingId: input.listingId,
    connectionId: null,
    sourceKey: null,
    identityKind: "MANUAL",
    startDate: input.startDate,
    endDate: input.endDate,
    classification: input.reservation ? "RESERVATION" : "MANUAL",
    classificationEvidence: {
      rule: "HOST_CREATED",
      rulesVersion: RULES_VERSION,
    },
    holdType: input.holdType,
    lifecycle: "ACTIVE",
    decisionReason: null,
    sourceStatus: "CONFIRMED",
    sourceSequence: null,
    sourceStamp: null,
    sourceLabelKey: null,
    contentDigest: null,
    sourceRevision: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    missingSince: null,
    missingObservations: 0,
    lastMissingObservationAt: null,
    bufferBeforeDays: null,
    bufferAfterDays: null,
    overrideClassification: null,
    overrideBasedOnRevision: null,
    reviewFlags: [],
    pendingChange: null,
    compensatesBlockId: input.compensatesBlockId ?? null,
    releasedAt: null,
    revision: 0,
    committedRevision: input.nextRevision,
  };
}

/**
 * MANUAL 01/02: a host classification of an imported block. It is recorded
 * against the source revision it was based on; a later source change keeps
 * protection and opens review instead of silently discarding it.
 */
export function classifyBlock(
  b: BlockState,
  input: {
    expectedRevision: number;
    classification: HostClass | null;
    nextRevision: number;
  },
): TransitionResult {
  const stale = guard(b, input.expectedRevision);
  if (stale) return { ok: false, error: stale };
  if (!b.connectionId) return { ok: false, error: "NOT_IMPORTED" };
  if (b.lifecycle === "RELEASED") return { ok: false, error: "INVALID_STATE" };
  if (b.identityKind !== "UID" && b.identityKind !== "RECURRENCE_INSTANCE")
    return { ok: false, error: "INVALID_STATE" };
  const next = bump(b, input.nextRevision);
  next.overrideClassification = input.classification;
  next.overrideBasedOnRevision =
    input.classification ||
    next.bufferBeforeDays !== null ||
    next.bufferAfterDays !== null
      ? b.sourceRevision
      : null;
  next.reviewFlags = next.reviewFlags.filter(
    (f) => f !== "OVERRIDE_SOURCE_CHANGED",
  );
  return { ok: true, block: next };
}

/** MANUAL 01: per-block buffer override; null restores the property default. */
export function overrideBuffers(
  b: BlockState,
  input: {
    expectedRevision: number;
    before: number | null;
    after: number | null;
    nextRevision: number;
  },
): TransitionResult {
  const stale = guard(b, input.expectedRevision);
  if (stale) return { ok: false, error: stale };
  if (b.lifecycle === "RELEASED") return { ok: false, error: "INVALID_STATE" };
  const next = bump(b, input.nextRevision);
  next.bufferBeforeDays = input.before;
  next.bufferAfterDays = input.after;
  if (b.connectionId)
    next.overrideBasedOnRevision =
      input.before !== null ||
      input.after !== null ||
      next.overrideClassification
        ? b.sourceRevision
        : null;
  next.reviewFlags = next.reviewFlags.filter(
    (f) => f !== "OVERRIDE_SOURCE_CHANGED",
  );
  return { ok: true, block: next };
}

/** Acknowledge review flags after the host inspected them. */
export function acknowledgeFlags(
  b: BlockState,
  input: {
    expectedRevision: number;
    flags: BlockState["reviewFlags"];
    nextRevision: number;
  },
): TransitionResult {
  const stale = guard(b, input.expectedRevision);
  if (stale) return { ok: false, error: stale };
  const next = bump(b, input.nextRevision);
  next.reviewFlags = next.reviewFlags.filter((f) => !input.flags.includes(f));
  if (input.flags.includes("UPDATE_DEFERRED")) next.pendingChange = null;
  if (input.flags.includes("OVERRIDE_SOURCE_CHANGED") && b.connectionId)
    next.overrideBasedOnRevision =
      next.overrideBasedOnRevision === null ? null : b.sourceRevision;
  return { ok: true, block: next };
}

/** Whether a block produces guest turnover work (CLEAN 01). */
export const isReservation = (b: BlockState) =>
  effectiveClass(b) === "RESERVATION";
