// Stages 3-7 composed (CAL 01/02). Deterministic given its inputs: the fetch
// outcome, the last accepted snapshot, policy, current blocks and a supplied
// clock. Stages 1-2 and 8-10 are adapters in src/server/calendar.
import { needsPolicyQuestion } from "./classify";
import { compare, type CompareResult, type DecisionType } from "./compare";
import { type LocalDate } from "./dates";
import { assessHealth, type AnomalyHealth, type Gate } from "./health";
import {
  normalizeCalendar,
  type NormalizeCounts,
  type NormalizedEvent,
} from "./normalize";
import { parseCalendar } from "./parse";
import type { ReasonCode } from "./reasons";
import {
  effectiveClass,
  isProtective,
  type BlockState,
  type ConnectionPolicy,
  type Platform,
} from "./types";

/** DATA 03: bounded normalized comparison snapshot of an accepted version. */
export type Snapshot = {
  format: 1;
  events: NormalizedEvent[];
  duplicateKeys: string[];
  presentInvalidKeys: string[];
  complete: boolean;
  coverageEnd: LocalDate | null;
  fingerprint: string;
  flags: ReasonCode[];
};

export type FetchOutcome =
  | { outcome: "BODY"; body: string }
  | { outcome: "NOT_MODIFIED" }
  | { outcome: "FAILED"; code: ReasonCode };

export type VisibleResult =
  "NO_CHANGES" | "UPDATED" | "NEEDS_REVIEW" | "COULD_NOT_CHECK";

export type ObservationPlan = {
  outcome: "BODY" | "NOT_MODIFIED" | "FAILED";
  gate: Gate;
  /** Set when this observation's content was used; stored only if changed. */
  snapshot: Snapshot | null;
  contentChanged: boolean;
  accepted: boolean;
  compare: CompareResult;
  result: VisibleResult;
  reasons: ReasonCode[];
  counts: Partial<NormalizeCounts>;
  policyQuestion: boolean;
  /** The anomaly verdict to keep with the connection (see HealthInput). */
  anomaly: KnownAnomaly | null;
};

export type KnownAnomaly = { fingerprint: string; health: AnomalyHealth };

export type PlanInput = {
  fetch: FetchOutcome;
  snapshot: Snapshot | null;
  lastAcceptedFingerprint: string | null;
  connection: {
    id: string;
    listingId: string;
    platform: Platform;
    policy: ConnectionPolicy;
    coverageEnd: LocalDate | null;
    anomaly?: KnownAnomaly | null;
  };
  property: { zone: string; checkoutHour: number };
  blocks: BlockState[];
  knownBlockIds: ReadonlySet<string>;
  today: LocalDate;
  now: string;
  nextRevision: number;
};

const REVIEW: ReadonlySet<DecisionType> = new Set([
  "DEFER_UPDATE",
  "MISSING_OBSERVED",
  "AWAIT_DECISION_ABSENCE",
  "CANCELLATION_REVIEW",
  "STALE_CANCELLATION",
  "BEYOND_COVERAGE",
  "INVALID_EVENT_PRESENT",
  "DUPLICATE_IDENTITY",
  "REAPPEARED_AFTER_RELEASE",
]);
const AVAILABILITY: ReadonlySet<DecisionType> = new Set([
  "CREATE",
  "UPDATE",
  "REAPPEARED",
  "REINSTATED",
  "REAPPEARED_AFTER_RELEASE",
]);

const EMPTY: CompareResult = {
  creates: [],
  updates: [],
  touches: [],
  decisions: [],
};

export function planObservation(input: PlanInput): ObservationPlan {
  let snapshot: Snapshot | null = null;
  let failure: ReasonCode | null = null;
  let counts: Partial<NormalizeCounts> = {};
  const reasons = new Set<ReasonCode>();

  if (input.fetch.outcome === "FAILED") failure = input.fetch.code;
  else if (input.fetch.outcome === "NOT_MODIFIED") {
    // A valid 304 re-uses the accepted normalized state (FETCH 02).
    if (input.snapshot) snapshot = input.snapshot;
    else failure = "SNAPSHOT_MISSING";
  } else {
    const parsed = parseCalendar(input.fetch.body);
    if (parsed.kind === "NOT_CALENDAR") failure = "NOT_CALENDAR";
    else {
      const n = normalizeCalendar(parsed, {
        platform: input.connection.platform,
        zone: input.property.zone,
        checkoutHour: input.property.checkoutHour,
        today: input.today,
      });
      counts = n.counts;
      snapshot = {
        format: 1,
        events: n.events,
        duplicateKeys: n.duplicateKeys,
        presentInvalidKeys: n.presentInvalidKeys,
        complete: n.complete,
        coverageEnd: n.coverageEnd,
        fingerprint: n.fingerprint,
        flags: n.flags,
      };
    }
  }

  if (failure || !snapshot) {
    const gate = assessHealth({
      outcome: "FAILED",
      complete: false,
      futureKeys: new Set(),
      previousFutureKeys: new Set(),
      coverageEnd: null,
      previousCoverageEnd: null,
    });
    return {
      outcome: "FAILED",
      gate,
      snapshot: null,
      contentChanged: false,
      accepted: false,
      compare: EMPTY,
      result: "COULD_NOT_CHECK",
      reasons: [failure ?? "FETCH_INTERNAL"],
      counts,
      policyQuestion: false,
      // Nothing was judged, so an earlier verdict stands.
      anomaly: input.connection.anomaly ?? null,
    };
  }

  for (const f of snapshot.flags) reasons.add(f);
  const contentChanged = snapshot.fingerprint !== input.lastAcceptedFingerprint;
  if (input.fetch.outcome === "BODY" && !contentChanged)
    reasons.add("UNCHANGED_CONTENT");

  const previousFutureKeys = new Set(
    input.blocks
      .filter((b) => b.sourceKey && isProtective(b) && b.endDate > input.today)
      .map((b) => b.sourceKey as string),
  );
  // An explicitly cancelled identity is reported, not absent: it counts as
  // present for the empty and mass-disappearance anomaly checks.
  const futureKeys = new Set(
    snapshot.events
      .filter((e) => e.endDate > input.today && !e.echo)
      .map((e) => e.key),
  );
  const gate = assessHealth({
    outcome: input.fetch.outcome,
    complete: snapshot.complete,
    futureKeys,
    previousFutureKeys,
    coverageEnd: snapshot.coverageEnd,
    previousCoverageEnd: input.connection.coverageEnd,
    knownAnomaly:
      input.connection.anomaly?.fingerprint === snapshot.fingerprint
        ? input.connection.anomaly.health
        : null,
  });
  for (const r of gate.reasons) reasons.add(r);

  const result = compare({
    connection: input.connection,
    events: snapshot.events,
    duplicateKeys: snapshot.duplicateKeys,
    presentInvalidKeys: snapshot.presentInvalidKeys,
    contentChanged,
    gate,
    policy: input.connection.policy,
    blocks: input.blocks,
    knownBlockIds: input.knownBlockIds,
    today: input.today,
    now: input.now,
    nextRevision: input.nextRevision,
  });
  for (const d of result.decisions) for (const r of d.reasons) reasons.add(r);

  const after = new Map(input.blocks.map((b) => [b.id, b]));
  for (const u of result.updates) after.set(u.id, u);
  const unknown =
    [...after.values()].filter(
      (b) => isProtective(b) && effectiveClass(b) === "UNKNOWN",
    ).length +
    result.creates.filter((b) => effectiveClass(b) === "UNKNOWN").length;
  const policyQuestion = needsPolicyQuestion(input.connection.policy, unknown);

  const needsReview =
    gate.health !== "HEALTHY" ||
    policyQuestion ||
    result.decisions.some((d) => REVIEW.has(d.type));
  return {
    outcome: input.fetch.outcome,
    gate,
    snapshot,
    contentChanged,
    accepted: true,
    compare: result,
    result: needsReview
      ? "NEEDS_REVIEW"
      : result.decisions.some((d) => AVAILABILITY.has(d.type))
        ? "UPDATED"
        : "NO_CHANGES",
    reasons: [...reasons].sort(),
    counts,
    policyQuestion,
    anomaly:
      gate.health === "EMPTY_ANOMALY" || gate.health === "DROP_ANOMALY"
        ? { fingerprint: snapshot.fingerprint, health: gate.health }
        : null,
  };
}
