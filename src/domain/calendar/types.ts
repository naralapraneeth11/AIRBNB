import type { LocalDate } from "./dates";

export const PLATFORMS = [
  "AIRBNB",
  "VRBO",
  "BOOKING",
  "EXPEDIA",
  "GOOGLE",
  "OTHER",
] as const;
export type Platform = (typeof PLATFORMS)[number];

export type Classification =
  "RESERVATION" | "OWNER_BLOCK" | "UNKNOWN" | "CONFIRMED_ECHO" | "MANUAL";
/** Classes a host may assign or a connection policy may map to. */
export const HOST_CLASSES = ["RESERVATION", "OWNER_BLOCK", "UNKNOWN"] as const;
export type HostClass = (typeof HOST_CLASSES)[number];

export type Lifecycle =
  | "ACTIVE"
  | "MISSING_OBSERVED"
  | "AWAITING_DECISION"
  | "RETAINED_HOLD"
  | "RELEASED";
export type DecisionReason = "ABSENCE" | "CANCELLATION";
export type SourceStatus = "CONFIRMED" | "TENTATIVE" | "CANCELLED";
export type IdentityKind =
  "UID" | "RECURRENCE_INSTANCE" | "SURROGATE" | "DUPLICATE_VARIANT" | "MANUAL";
export type HoldType =
  "OWNER" | "MAINTENANCE" | "DIRECT_RESERVATION" | "RESTORED";

export const POLICY_MODES = [
  "UNSET",
  "RESERVATIONS",
  "OWNER_BLOCKS",
  "BY_LABEL",
] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];
export type ConnectionPolicy = {
  mode: PolicyMode;
  labels: Record<string, HostClass> | null;
  version: number;
};

export type ReviewFlag =
  | "IDENTITY_UNCERTAIN"
  | "DUPLICATE_UID"
  | "INVALID_SOURCE_EVENT"
  | "AMBIGUOUS_TIME"
  | "OVERRIDE_SOURCE_CHANGED"
  | "CONTRADICTORY_HISTORY"
  | "UPDATE_DEFERRED"
  | "FOREIGN_ECHO_UID"
  | "STALE_CANCELLATION_IGNORED"
  | "BEYOND_COVERAGE";

export type EvidenceRule =
  | "HOST_OVERRIDE"
  | "CONNECTION_POLICY"
  | "PLATFORM_LABEL_VERIFIED"
  | "NO_EVIDENCE"
  | "POLICY_LABEL_UNMAPPED"
  | "IDENTITY_UNCERTAIN"
  | "DUPLICATE_UID"
  | "FOREIGN_ECHO_UID"
  | "HOST_CREATED";

export type ClassificationEvidence = {
  rule: EvidenceRule;
  rulesVersion: string;
  policyVersion?: number;
  labelKey?: string;
  /** A hint from an unverified platform rule; never applied automatically. */
  suggested?: HostClass;
};

export type PendingChange = {
  startDate: LocalDate;
  endDate: LocalDate;
  labelKey: string;
  contentDigest: string;
  observedAt: string;
};

/** A persisted availability block as the pure core sees it. Times are ISO. */
export type BlockState = {
  id: string;
  listingId: string;
  connectionId: string | null;
  sourceKey: string | null;
  identityKind: IdentityKind;
  startDate: LocalDate;
  endDate: LocalDate;
  classification: Classification;
  classificationEvidence: ClassificationEvidence;
  holdType: HoldType | null;
  lifecycle: Lifecycle;
  decisionReason: DecisionReason | null;
  sourceStatus: SourceStatus;
  sourceSequence: number | null;
  sourceStamp: string | null;
  sourceLabelKey: string | null;
  contentDigest: string | null;
  sourceRevision: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  missingSince: string | null;
  missingObservations: number;
  lastMissingObservationAt: string | null;
  bufferBeforeDays: number | null;
  bufferAfterDays: number | null;
  overrideClassification: HostClass | null;
  overrideBasedOnRevision: number | null;
  reviewFlags: ReviewFlag[];
  pendingChange: PendingChange | null;
  compensatesBlockId: string | null;
  releasedAt: string | null;
  revision: number;
  committedRevision: number;
};

/** Lifecycles in which a block protects its dates. */
export const PROTECTIVE: ReadonlySet<Lifecycle> = new Set([
  "ACTIVE",
  "MISSING_OBSERVED",
  "AWAITING_DECISION",
  "RETAINED_HOLD",
]);
export const isProtective = (b: Pick<BlockState, "lifecycle">) =>
  PROTECTIVE.has(b.lifecycle);

/** The class used for turnover work, buffers and conflicts. */
export function effectiveClass(
  b: Pick<BlockState, "classification" | "overrideClassification">,
): Classification {
  return b.overrideClassification ?? b.classification;
}
