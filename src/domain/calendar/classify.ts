// Stage 6 Classify (CLASS 01, CLASS 02, ID 02). Source evidence, strongest
// first:
//   1. an event without reliable identity stays Unknown (ID 02);
//   2. the connection's host-confirmed classification policy;
//   3. a platform label rule verified against anonymized fixtures.
// Anything else is Unknown: dates are protected and no turnover work is made.
// A host's explicit classification of one block is kept separately as an
// override (see effectiveClass), so removing it restores the evidence class.
// Date overlap and export timing are never evidence of an echo (CLASS 01).
import { labelRule, RULES_VERSION } from "./capabilities";
import type { NormalizedEvent } from "./normalize";
import type {
  Classification,
  ClassificationEvidence,
  ConnectionPolicy,
  Platform,
} from "./types";

export type ClassifyContext = {
  platform: Platform;
  policy: ConnectionPolicy;
};

export type Classified = {
  classification: Exclude<Classification, "MANUAL" | "CONFIRMED_ECHO">;
  evidence: ClassificationEvidence;
};

export function classifyEvent(
  event: Pick<NormalizedEvent, "identityKind" | "labelKey">,
  ctx: ClassifyContext,
  duplicateVariant = false,
): Classified {
  const base = { rulesVersion: RULES_VERSION, labelKey: event.labelKey };
  if (event.identityKind === "SURROGATE")
    return {
      classification: "UNKNOWN",
      evidence: { ...base, rule: "IDENTITY_UNCERTAIN" },
    };
  if (duplicateVariant)
    return {
      classification: "UNKNOWN",
      evidence: { ...base, rule: "DUPLICATE_UID" },
    };
  const rule = labelRule(ctx.platform, event.labelKey);
  const suggested = rule?.suggests;
  const policy = ctx.policy;
  if (policy.mode === "RESERVATIONS" || policy.mode === "OWNER_BLOCKS")
    return {
      classification:
        policy.mode === "RESERVATIONS" ? "RESERVATION" : "OWNER_BLOCK",
      evidence: {
        ...base,
        rule: "CONNECTION_POLICY",
        policyVersion: policy.version,
      },
    };
  if (policy.mode === "BY_LABEL") {
    const mapped = policy.labels?.[event.labelKey];
    if (mapped)
      return {
        classification: mapped,
        evidence: {
          ...base,
          rule: "CONNECTION_POLICY",
          policyVersion: policy.version,
        },
      };
  }
  if (rule && rule.verifiedBy.length > 0 && rule.suggests !== "UNKNOWN")
    return {
      classification: rule.suggests,
      evidence: { ...base, rule: "PLATFORM_LABEL_VERIFIED" },
    };
  return {
    classification: "UNKNOWN",
    evidence: {
      ...base,
      rule:
        policy.mode === "BY_LABEL" ? "POLICY_LABEL_UNMAPPED" : "NO_EVIDENCE",
      ...(policy.mode === "BY_LABEL" ? { policyVersion: policy.version } : {}),
      ...(suggested && suggested !== "UNKNOWN" ? { suggested } : {}),
    },
  };
}

/**
 * CLASS 02: ask the host once per connection while its imported events stay
 * Unknown for lack of a policy. Until then dates stay protected and no
 * turnover work is created.
 */
export function needsPolicyQuestion(
  policy: ConnectionPolicy,
  unknownImportedCount: number,
): boolean {
  return policy.mode === "UNSET" && unknownImportedCount > 0;
}
