// Stage 5 Assess health: an operation gate, not a single good/bad bit (CAL 02).
// A partial feed may still add protection but may never remove it.
//
//   Observation                          Protective additions   Absence review
//   Complete healthy feed                applied                eligible
//   Timeout, non-calendar, parse failure none                   forbidden
//   Partial or truncated feed            valid identifiable     forbidden
//   Empty after future availability      hold, request review   forbidden
//   > half of future identities vanish   preserve, investigate  forbidden
//   Coverage horizon changes             in-range only          outside coverage forbidden
import type { LocalDate } from "./dates";
import type { ReasonCode } from "./reasons";

export type ObservationHealth =
  "HEALTHY" | "PARTIAL" | "EMPTY_ANOMALY" | "DROP_ANOMALY" | "FAILED";

export type UpdatePermission = "ALL" | "PROTECTIVE_ONLY" | "NONE";

export type Gate = {
  health: ObservationHealth;
  additions: boolean;
  updates: UpdatePermission;
  cancellationReview: boolean;
  absenceReview: boolean;
  /** Absence is judged only for blocks starting before this date. */
  coverageEnd: LocalDate | null;
  reasons: ReasonCode[];
};

export type HealthInput = {
  outcome: "BODY" | "NOT_MODIFIED" | "FAILED";
  /** For NOT_MODIFIED this describes the last accepted (snapshot) version. */
  complete: boolean;
  /** Future identities present in this observation (not cancelled). */
  futureKeys: ReadonlySet<string>;
  /** Future protective identities this connection held before the check. */
  previousFutureKeys: ReadonlySet<string>;
  coverageEnd: LocalDate | null;
  previousCoverageEnd: LocalDate | null;
};

export const DROP_ANOMALY_THRESHOLD = 0.5;

export function assessHealth(input: HealthInput): Gate {
  if (input.outcome === "FAILED")
    return {
      health: "FAILED",
      additions: false,
      updates: "NONE",
      cancellationReview: false,
      absenceReview: false,
      coverageEnd: null,
      reasons: [],
    };
  const reasons: ReasonCode[] = [];
  if (input.outcome === "NOT_MODIFIED") reasons.push("NOT_MODIFIED");
  if (!input.complete) {
    if (input.outcome === "NOT_MODIFIED")
      reasons.push("PREVIOUS_ACCEPTANCE_PARTIAL");
    return {
      health: "PARTIAL",
      additions: true,
      updates: "PROTECTIVE_ONLY",
      cancellationReview: true,
      absenceReview: false,
      coverageEnd: input.coverageEnd,
      reasons,
    };
  }
  if (input.futureKeys.size === 0 && input.previousFutureKeys.size > 0)
    return {
      health: "EMPTY_ANOMALY",
      additions: false,
      updates: "NONE",
      cancellationReview: false,
      absenceReview: false,
      coverageEnd: input.coverageEnd,
      reasons: [...reasons, "EMPTY_FEED_ANOMALY"],
    };
  let vanished = 0;
  for (const key of input.previousFutureKeys)
    if (!input.futureKeys.has(key)) vanished++;
  if (
    input.previousFutureKeys.size > 0 &&
    vanished / input.previousFutureKeys.size > DROP_ANOMALY_THRESHOLD
  )
    return {
      health: "DROP_ANOMALY",
      additions: true,
      updates: "PROTECTIVE_ONLY",
      cancellationReview: true,
      absenceReview: false,
      coverageEnd: input.coverageEnd,
      reasons: [...reasons, "IDENTITY_DROP_ANOMALY"],
    };
  if (
    input.previousCoverageEnd &&
    (!input.coverageEnd || input.coverageEnd < input.previousCoverageEnd)
  )
    reasons.push("COVERAGE_SHRANK");
  return {
    health: "HEALTHY",
    additions: true,
    updates: "ALL",
    cancellationReview: true,
    absenceReview: true,
    coverageEnd: input.coverageEnd,
    reasons,
  };
}
