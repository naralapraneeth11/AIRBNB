// Stage 7 Compare: proposed changes against the last accepted state, without
// side effects. Returns the complete next state of every changed block, so the
// apply stage persists exactly what was decided here.
//
// Invariants (asserted by property tests):
//   - compare never releases protection: no block becomes RELEASED here, and a
//     protective block stays protective (LIFE 01: ask before reopening);
//   - an untrusted observation never shrinks protected dates (CAL 02);
//   - repeating an observation changes nothing further (CAL 04), while the
//     missing-event timer still advances on later eligible observations.
import { classifyEvent } from "./classify";
import { contains, type LocalDate } from "./dates";
import type { Gate } from "./health";
import type { NormalizedEvent } from "./normalize";
import type { ReasonCode } from "./reasons";
import {
  isProtective,
  type BlockState,
  type ConnectionPolicy,
  type IdentityKind,
  type Platform,
  type ReviewFlag,
} from "./types";

/** Two eligible observations at least this far apart escalate a missing event. */
export const MISSING_SPACING_MS = 15 * 60_000;

export type DecisionType =
  | "CREATE"
  | "UPDATE"
  | "DEFER_UPDATE"
  | "RECLASSIFY"
  | "MISSING_OBSERVED"
  | "AWAIT_DECISION_ABSENCE"
  | "CANCELLATION_REVIEW"
  | "STALE_CANCELLATION"
  | "REAPPEARED"
  | "REAPPEARED_AFTER_RELEASE"
  | "REINSTATED"
  | "BEYOND_COVERAGE"
  | "ECHO_EXCLUDED"
  | "CANCELLED_UNKNOWN_IGNORED"
  | "ADDITION_BLOCKED"
  | "INVALID_EVENT_PRESENT"
  | "DUPLICATE_IDENTITY";

export type Decision = {
  type: DecisionType;
  key: string;
  blockId: string | null;
  reasons: ReasonCode[];
};

export type NewBlock = Omit<BlockState, "id">;

export type CompareInput = {
  connection: { id: string; listingId: string; platform: Platform };
  events: NormalizedEvent[];
  duplicateKeys: readonly string[];
  presentInvalidKeys: readonly string[];
  /** False when the content fingerprint equals the last accepted one. */
  contentChanged: boolean;
  gate: Gate;
  policy: ConnectionPolicy;
  /** This connection's blocks, in any lifecycle. */
  blocks: BlockState[];
  /** Every block id of the property: provenance for export echoes. */
  knownBlockIds: ReadonlySet<string>;
  today: LocalDate;
  now: string;
  /** The property revision this apply will commit (EXPORT 04). */
  nextRevision: number;
  missingSpacingMs?: number;
};

export type CompareResult = {
  creates: NewBlock[];
  updates: BlockState[];
  /** Present, unchanged blocks whose lastSeenAt advances (no revision). */
  touches: string[];
  decisions: Decision[];
};

const addFlag = (b: BlockState, flag: ReviewFlag) => {
  if (b.reviewFlags.includes(flag)) return false;
  b.reviewFlags = [...b.reviewFlags, flag].sort();
  return true;
};
const dropFlag = (b: BlockState, flag: ReviewFlag) => {
  if (!b.reviewFlags.includes(flag)) return false;
  b.reviewFlags = b.reviewFlags.filter((f) => f !== flag);
  return true;
};
const clearMissing = (b: BlockState) => {
  b.missingSince = null;
  b.missingObservations = 0;
  b.lastMissingObservationAt = null;
};

/** LIFE 01: an explicit source ordering, when present, decides staleness. */
export function isOlderThanCurrent(
  e: Pick<NormalizedEvent, "sequence" | "stamp">,
  b: Pick<BlockState, "sourceSequence" | "sourceStamp">,
): boolean {
  if (e.sequence !== null && b.sourceSequence !== null) {
    if (e.sequence < b.sourceSequence) return true;
    if (e.sequence > b.sourceSequence) return false;
  }
  return !!(e.stamp && b.sourceStamp && e.stamp < b.sourceStamp);
}

export const variantKey = (key: string, digest: string) =>
  `${key}~dup~${digest.slice(0, 12)}`;

export function compare(input: CompareInput): CompareResult {
  const spacing = input.missingSpacingMs ?? MISSING_SPACING_MS;
  const { gate, now } = input;
  const classifyCtx = {
    platform: input.connection.platform,
    policy: input.policy,
  };
  const byKey = new Map<string, BlockState>();
  for (const b of input.blocks) if (b.sourceKey) byKey.set(b.sourceKey, b);
  const presentInvalid = new Set(input.presentInvalidKeys);
  const isPresentInvalid = (key: string) =>
    presentInvalid.has(key) ||
    [...presentInvalid].some((k) => key.startsWith(k + "#"));

  const next = new Map<string, BlockState>();
  const edit = (b: BlockState) => {
    let copy = next.get(b.id);
    if (!copy) {
      copy = { ...b, reviewFlags: [...b.reviewFlags] };
      next.set(b.id, copy);
    }
    return copy;
  };
  const changed = new Set<string>();
  const creates: NewBlock[] = [];
  const decisions: Decision[] = [];
  const touches: string[] = [];
  const observed = new Set<string>();
  const decide = (
    type: DecisionType,
    key: string,
    blockId: string | null,
    ...reasons: ReasonCode[]
  ) => decisions.push({ type, key, blockId, reasons });

  const create = (
    e: NormalizedEvent,
    key: string,
    identityKind: IdentityKind,
    duplicateVariant: boolean,
    foreignEcho: boolean,
  ) => {
    const c = classifyEvent(e, classifyCtx, duplicateVariant);
    const flags = new Set<ReviewFlag>(e.flags);
    if (identityKind === "SURROGATE") flags.add("IDENTITY_UNCERTAIN");
    if (duplicateVariant) flags.add("DUPLICATE_UID");
    if (foreignEcho) flags.add("FOREIGN_ECHO_UID");
    creates.push({
      listingId: input.connection.listingId,
      connectionId: input.connection.id,
      sourceKey: key,
      identityKind,
      startDate: e.startDate,
      endDate: e.endDate,
      classification: foreignEcho ? "UNKNOWN" : c.classification,
      classificationEvidence: foreignEcho
        ? { ...c.evidence, rule: "FOREIGN_ECHO_UID" }
        : c.evidence,
      holdType: null,
      lifecycle: "ACTIVE",
      decisionReason: null,
      sourceStatus: e.status,
      sourceSequence: e.sequence,
      sourceStamp: e.stamp,
      sourceLabelKey: e.labelKey,
      contentDigest: e.contentDigest,
      sourceRevision: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      missingSince: null,
      missingObservations: 0,
      lastMissingObservationAt: null,
      bufferBeforeDays: null,
      bufferAfterDays: null,
      overrideClassification: null,
      overrideBasedOnRevision: null,
      reviewFlags: [...flags].sort(),
      pendingChange: null,
      compensatesBlockId: null,
      releasedAt: null,
      revision: 0,
      committedRevision: input.nextRevision,
    });
    decide("CREATE", key, null, "BLOCK_CREATED");
  };

  const handle = (
    e: NormalizedEvent,
    key: string,
    identityKind: IdentityKind,
    duplicateVariant: boolean,
  ) => {
    observed.add(key);
    let foreignEcho = false;
    if (e.echo) {
      if (input.knownBlockIds.has(e.echo.blockId)) {
        decide("ECHO_EXCLUDED", key, e.echo.blockId, "ECHO_EXCLUDED");
        return;
      }
      foreignEcho = true;
    }
    const existing = byKey.get(key);
    if (!existing) {
      if (e.status === "CANCELLED")
        return decide(
          "CANCELLED_UNKNOWN_IGNORED",
          key,
          null,
          "CANCELLED_UNKNOWN_IGNORED",
        );
      if (!gate.additions)
        return decide("ADDITION_BLOCKED", key, null, "ADDITION_BLOCKED");
      return create(e, key, identityKind, duplicateVariant, foreignEcho);
    }
    const b = edit(existing);
    let dirty = false;
    let reprotected = false;
    const stale = isOlderThanCurrent(e, b);

    if (e.status === "CANCELLED") {
      if (stale) {
        if (addFlag(b, "STALE_CANCELLATION_IGNORED")) dirty = true;
        decide("STALE_CANCELLATION", key, b.id, "STALE_CANCELLATION_IGNORED");
      } else if (
        gate.cancellationReview &&
        (b.lifecycle === "ACTIVE" ||
          b.lifecycle === "MISSING_OBSERVED" ||
          (b.lifecycle === "AWAITING_DECISION" &&
            b.decisionReason === "ABSENCE"))
      ) {
        b.lifecycle = "AWAITING_DECISION";
        b.decisionReason = "CANCELLATION";
        clearMissing(b);
        dirty = true;
        decide("CANCELLATION_REVIEW", key, b.id, "CANCELLATION_REVIEW");
      }
    } else if (b.lifecycle === "RELEASED") {
      if (gate.additions) {
        b.lifecycle = "ACTIVE";
        b.releasedAt = null;
        b.decisionReason = null;
        clearMissing(b);
        addFlag(b, "CONTRADICTORY_HISTORY");
        dirty = reprotected = true;
        decide(
          "REAPPEARED_AFTER_RELEASE",
          key,
          b.id,
          "REAPPEARED_AFTER_RELEASE",
        );
      } else decide("ADDITION_BLOCKED", key, b.id, "ADDITION_BLOCKED");
    } else if (b.lifecycle !== "ACTIVE") {
      const wasCancelled =
        b.lifecycle === "AWAITING_DECISION" &&
        b.decisionReason === "CANCELLATION";
      if (!(wasCancelled && stale)) {
        decide(
          wasCancelled ? "REINSTATED" : "REAPPEARED",
          key,
          b.id,
          wasCancelled ? "REINSTATED" : "REAPPEARED",
        );
        b.lifecycle = "ACTIVE";
        b.decisionReason = null;
        clearMissing(b);
        dirty = true;
      }
    }
    if (dropFlag(b, "BEYOND_COVERAGE")) dirty = true;

    // Imported facts: dates, status and label, under the health gate.
    if (
      !stale &&
      e.contentDigest !== b.contentDigest &&
      b.lifecycle !== "RELEASED"
    ) {
      const permission = reprotected ? "ALL" : gate.updates;
      const widening = contains(e, b);
      if (
        permission === "ALL" ||
        (permission === "PROTECTIVE_ONLY" && widening)
      ) {
        b.startDate = e.startDate;
        b.endDate = e.endDate;
        b.sourceStatus = e.status;
        b.sourceLabelKey = e.labelKey;
        b.contentDigest = e.contentDigest;
        b.sourceRevision += 1;
        b.pendingChange = null;
        dropFlag(b, "UPDATE_DEFERRED");
        // MANUAL 02: a source change under a host override opens review.
        if (b.overrideBasedOnRevision !== null)
          addFlag(b, "OVERRIDE_SOURCE_CHANGED");
        for (const f of e.flags) addFlag(b, f);
        dirty = true;
        decide("UPDATE", key, b.id, "BLOCK_UPDATED");
      } else if (permission === "PROTECTIVE_ONLY") {
        const pending = {
          startDate: e.startDate,
          endDate: e.endDate,
          labelKey: e.labelKey,
          contentDigest: e.contentDigest,
          observedAt: now,
        };
        if (b.pendingChange?.contentDigest !== pending.contentDigest) {
          b.pendingChange = pending;
          addFlag(b, "UPDATE_DEFERRED");
          dirty = true;
          decide("DEFER_UPDATE", key, b.id, "UPDATE_DEFERRED");
        }
      }
    }
    if (!stale) {
      if (e.sequence !== null && (b.sourceSequence ?? -1) < e.sequence) {
        b.sourceSequence = e.sequence;
        dirty = true;
      }
      if (e.stamp && (!b.sourceStamp || b.sourceStamp < e.stamp)) {
        b.sourceStamp = e.stamp;
        dirty = true;
      }
    }

    // Stage 6 on the block's current label (policy changes apply on any check).
    const c = classifyEvent(
      {
        identityKind: b.identityKind === "SURROGATE" ? "SURROGATE" : "UID",
        labelKey: b.sourceLabelKey ?? "none",
      },
      classifyCtx,
      b.identityKind === "DUPLICATE_VARIANT",
    );
    const nextClass = foreignEcho ? "UNKNOWN" : c.classification;
    const nextEvidence = foreignEcho
      ? { ...c.evidence, rule: "FOREIGN_ECHO_UID" as const }
      : c.evidence;
    if (
      b.classification !== nextClass ||
      JSON.stringify(b.classificationEvidence) !== JSON.stringify(nextEvidence)
    ) {
      if (b.classification !== nextClass)
        decide("RECLASSIFY", key, b.id, "RECLASSIFIED");
      b.classification = nextClass;
      b.classificationEvidence = nextEvidence;
      dirty = true;
    }
    if (dirty) changed.add(b.id);
  };

  // ID 01: disagreeing duplicates of one identity go to review. The existing
  // block keeps its identity only when one variant matches it exactly.
  const groups = new Map<string, NormalizedEvent[]>();
  for (const e of input.events) {
    const list = groups.get(e.key) ?? [];
    list.push(e);
    groups.set(e.key, list);
  }
  const duplicates = new Set(input.duplicateKeys);
  for (const [key, list] of groups) {
    if (list.length === 1 && !duplicates.has(key)) {
      handle(list[0], key, list[0].identityKind, false);
      continue;
    }
    observed.add(key);
    const existing = byKey.get(key);
    const match = existing
      ? list.find((e) => e.contentDigest === existing.contentDigest)
      : undefined;
    if (existing) {
      const b = edit(existing);
      if (addFlag(b, "DUPLICATE_UID")) changed.add(b.id);
    }
    decide(
      "DUPLICATE_IDENTITY",
      key,
      existing?.id ?? null,
      "DUPLICATE_UID_CONFLICT",
    );
    for (const e of [...list].sort((a, b) =>
      a.contentDigest < b.contentDigest ? -1 : 1,
    )) {
      if (e === match) handle(e, key, e.identityKind, false);
      else
        handle(
          { ...e, key: variantKey(key, e.contentDigest) },
          variantKey(key, e.contentDigest),
          "DUPLICATE_VARIANT",
          true,
        );
    }
  }

  // Absence: only complete, healthy, in-coverage observations count, only for
  // future dates (LIFE 02), and only toward a host decision, never a release.
  for (const original of input.blocks) {
    const key = original.sourceKey;
    if (!key || observed.has(key)) continue;
    if (isPresentInvalid(key)) {
      const b = edit(original);
      if (addFlag(b, "INVALID_SOURCE_EVENT")) {
        changed.add(b.id);
        decide("INVALID_EVENT_PRESENT", key, b.id, "INVALID_EVENT_PRESENT");
      }
      continue;
    }
    const current = next.get(original.id) ?? original;
    if (
      current.lifecycle !== "ACTIVE" &&
      current.lifecycle !== "MISSING_OBSERVED"
    )
      continue;
    if (current.endDate <= input.today) continue;
    if (!gate.absenceReview) continue;
    const b = edit(original);
    if (!gate.coverageEnd || b.startDate >= gate.coverageEnd) {
      if (addFlag(b, "BEYOND_COVERAGE")) {
        changed.add(b.id);
        decide("BEYOND_COVERAGE", key, b.id, "BEYOND_COVERAGE");
      }
      continue;
    }
    if (b.lifecycle === "ACTIVE") {
      b.lifecycle = "MISSING_OBSERVED";
      b.missingSince = now;
      b.missingObservations = 1;
      b.lastMissingObservationAt = now;
      changed.add(b.id);
      decide("MISSING_OBSERVED", key, b.id, "MISSING_OBSERVED");
    } else if (
      b.missingSince &&
      Date.parse(now) - Date.parse(b.missingSince) >= spacing
    ) {
      b.lifecycle = "AWAITING_DECISION";
      b.decisionReason = "ABSENCE";
      b.missingObservations += 1;
      b.lastMissingObservationAt = now;
      changed.add(b.id);
      decide("AWAIT_DECISION_ABSENCE", key, b.id, "AWAITING_DECISION_ABSENCE");
    }
  }

  const updates: BlockState[] = [];
  for (const b of input.blocks) {
    const n = next.get(b.id);
    if (n && changed.has(b.id)) {
      n.revision = b.revision + 1;
      n.committedRevision = input.nextRevision;
      if (observed.has(b.sourceKey ?? "")) n.lastSeenAt = now;
      updates.push(n);
    } else if (
      input.contentChanged &&
      b.sourceKey &&
      observed.has(b.sourceKey) &&
      isProtective(b)
    )
      touches.push(b.id);
  }
  return { creates, updates, touches, decisions };
}

/** CLASS 02: re-evaluate a connection's blocks after its policy changes. */
export function reclassifyForPolicy(input: {
  platform: Platform;
  policy: ConnectionPolicy;
  blocks: BlockState[];
  nextRevision: number;
}): { updates: BlockState[]; decisions: Decision[] } {
  const updates: BlockState[] = [];
  const decisions: Decision[] = [];
  for (const b of input.blocks) {
    if (!b.sourceKey || b.lifecycle === "RELEASED") continue;
    if (b.classificationEvidence.rule === "FOREIGN_ECHO_UID") continue;
    const c = classifyEvent(
      {
        identityKind: b.identityKind === "SURROGATE" ? "SURROGATE" : "UID",
        labelKey: b.sourceLabelKey ?? "none",
      },
      input,
      b.identityKind === "DUPLICATE_VARIANT",
    );
    if (
      c.classification === b.classification &&
      JSON.stringify(c.evidence) === JSON.stringify(b.classificationEvidence)
    )
      continue;
    if (c.classification !== b.classification)
      decisions.push({
        type: "RECLASSIFY",
        key: b.sourceKey,
        blockId: b.id,
        reasons: ["RECLASSIFIED"],
      });
    updates.push({
      ...b,
      classification: c.classification,
      classificationEvidence: c.evidence,
      revision: b.revision + 1,
      committedRevision: input.nextRevision,
    });
  }
  return { updates, decisions };
}
