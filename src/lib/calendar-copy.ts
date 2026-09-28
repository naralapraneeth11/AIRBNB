// Host-facing calendar wording in one place. CAL 05: a run result names what
// was observed, with the last successful check and the next eligible check,
// never a fabricated completion time. EXPORT 02: observed requests, host
// verification and platform confirmation stay distinct; nothing here says a
// calendar is "synced". A11Y 03: every block has a text class and state.
import type { CalendarBlock, Connection } from "./types";
import { ago, dateTime, until } from "./client";

export const RESULT_WORDING = {
  NO_CHANGES: "Checked with no changes",
  UPDATED: "Availability updated",
  NEEDS_REVIEW: "Some events need review",
  COULD_NOT_CHECK: "Could not check; existing dates remain protected",
} as const;

export type Tone = "ok" | "attention" | "critical" | "muted";

export function connectionStatus(
  c: Connection,
  now = Date.now(),
): { tone: Tone; headline: string; detail: string } {
  const name = c.label || c.platformName;
  if (!c.enabled)
    return {
      tone: "muted",
      headline: "Turned off",
      detail: `${name} is off and its export link does not answer. Dates it imported stay protected until you release them.`,
    };
  if (!c.importing)
    return {
      tone: "muted",
      headline: "Export link only",
      detail:
        "This link publishes the property's protected dates. There is no source calendar to check.",
    };
  const last = c.lastSuccessAt
    ? `Checked the ${c.platformName} source ${ago(c.lastSuccessAt, now)}.`
    : "No successful check yet.";
  const wait = Date.parse(c.nextFetchAt) - now;
  const next =
    c.health === "PAUSED_BY_SOURCE" && c.sourceRetryAfter
      ? ` The calendar asked us to wait; the next check is after ${dateTime(c.sourceRetryAfter)}.`
      : wait > 30_000
        ? ` Next check ${until(c.nextFetchAt, now)}.`
        : wait > -10 * 60_000
          ? " The next check is due now."
          : ` The next check is overdue; it was due ${ago(c.nextFetchAt, now)}.`;
  if (c.checking)
    return { tone: "muted", headline: "Checking now", detail: last };
  if (!c.lastResult)
    return {
      tone: "muted",
      headline: "Waiting for the first check",
      detail: `Dates appear after the first successful check.${next}`,
    };
  return {
    tone:
      c.lastResult === "COULD_NOT_CHECK"
        ? "critical"
        : c.lastResult === "NEEDS_REVIEW"
          ? "attention"
          : "ok",
    headline: RESULT_WORDING[c.lastResult],
    detail: `${last}${next}`,
  };
}

export const CLASS_LABEL: Record<string, string> = {
  RESERVATION: "Reservation",
  OWNER_BLOCK: "Owner block",
  UNKNOWN: "Unknown block",
  CONFIRMED_ECHO: "Echo of an export",
  MANUAL: "Manual hold",
};

export const HOLD_LABEL: Record<string, string> = {
  OWNER: "Owner hold",
  MAINTENANCE: "Maintenance hold",
  DIRECT_RESERVATION: "Direct reservation",
  RESTORED: "Restored dates",
};

export const EVIDENCE_LABEL: Record<string, string> = {
  HOST_OVERRIDE: "You classified these dates.",
  CONNECTION_POLICY:
    "Your answer for this calendar decides how its blocks count.",
  PLATFORM_LABEL_VERIFIED: "The platform's verified label identifies it.",
  NO_EVIDENCE: "Nothing reliable says what these dates are.",
  POLICY_LABEL_UNMAPPED:
    "Your answer for this calendar does not cover this label.",
  IDENTITY_UNCERTAIN:
    "The event has no reliable identity, so it stays unknown.",
  DUPLICATE_UID:
    "Two events share an identity but disagree, so it stays unknown.",
  FOREIGN_ECHO_UID:
    "It carries another calendar's export identity, so it stays unknown.",
  HOST_CREATED: "You created these dates.",
};

export const FLAG_LABEL: Record<string, string> = {
  IDENTITY_UNCERTAIN: "Identity uncertain",
  DUPLICATE_UID: "Conflicting duplicate event",
  INVALID_SOURCE_EVENT: "Unreadable event in the source",
  AMBIGUOUS_TIME: "Ambiguous time",
  OVERRIDE_SOURCE_CHANGED: "Source changed after your decision",
  CONTRADICTORY_HISTORY: "Returned after release",
  UPDATE_DEFERRED: "Change waiting for a trusted check",
  FOREIGN_ECHO_UID: "Another calendar's export",
  STALE_CANCELLATION_IGNORED: "Older cancellation ignored",
  BEYOND_COVERAGE: "Outside the calendar's current range",
};

/** What each review flag means and what the host can do about it. */
export const FLAG_EXPLANATION: Record<string, string> = {
  IDENTITY_UNCERTAIN:
    "The calendar gave this event no stable identifier, so it is matched by its dates. If its dates change, it can look like one stay ending and another beginning.",
  DUPLICATE_UID:
    "The calendar lists this event more than once with different details. Every version stays protected until you review it.",
  INVALID_SOURCE_EVENT:
    "The calendar still lists this event, but it could not be read. Its dates stay protected as last seen.",
  AMBIGUOUS_TIME:
    "The event’s time could not be placed exactly in the property’s time zone: it falls on a clock change, or names a time zone that is not recognized. The widest plausible range is protected.",
  OVERRIDE_SOURCE_CHANGED:
    "The calendar changed this event after you made a decision about it. Your decision still applies until you change it, and changing it here does not change the platform.",
  CONTRADICTORY_HISTORY:
    "This event came back after you reopened its dates, so they are protected again. Check the platform before deciding.",
  UPDATE_DEFERRED:
    "The calendar shows different dates, but applying them would remove protection, so the change waits for a complete, healthy check.",
  FOREIGN_ECHO_UID:
    "This event carries the identifier of an export link from this service, but not one of this property’s dates, for example another property’s link imported by mistake. It stays protected and unclassified; check the platform’s calendar settings.",
  STALE_CANCELLATION_IGNORED:
    "A cancellation older than the current version of this stay arrived and was ignored; the newer version stays protected.",
  BEYOND_COVERAGE:
    "The calendar no longer lists this event, but it falls after the last date the calendar currently shows, so its absence is not treated as a cancellation. If the stay was cancelled, reopen the dates; otherwise mark this reviewed.",
};

export const CONFLICT_LABEL: Record<string, string> = {
  RESERVATION_RESERVATION: "Possible double booking",
  RESERVATION_HOLD: "Reservation overlaps a hold",
  UNCERTAIN_OVERLAP: "Overlap with an unclassified block",
  BUFFER_ONLY: "Buffer days overlap",
};

export function blockTitle(b: CalendarBlock) {
  if (b.reservation && b.reservation.guestName !== "Guest details unavailable")
    return b.reservation.guestName;
  if (b.identityKind === "MANUAL")
    return b.reason || HOLD_LABEL[b.holdType ?? ""] || "Manual hold";
  return CLASS_LABEL[b.effectiveClass] ?? "Protected dates";
}

/** The block's protection state in words (section 12). */
export function blockState(b: CalendarBlock, now = Date.now()) {
  switch (b.lifecycle) {
    case "ACTIVE":
      return "Protected";
    case "MISSING_OBSERVED":
      return "Missing from its calendar; still protected";
    case "AWAITING_DECISION":
      return b.decisionReason === "CANCELLATION"
        ? "Cancelled at its source; protected until you decide"
        : "No longer in its calendar; protected until you decide";
    case "RETAINED_HOLD":
      return "Kept blocked by you";
    case "RELEASED":
      return b.restorableUntil && Date.parse(b.restorableUntil) > now
        ? `Released; can be restored until ${dateTime(b.restorableUntil)}`
        : "Released";
  }
}

export const needsDecision = (b: CalendarBlock) =>
  b.lifecycle === "AWAITING_DECISION";
export const needsClassification = (b: CalendarBlock) =>
  b.effectiveClass === "UNKNOWN" && b.lifecycle !== "RELEASED";
export const protective = (b: CalendarBlock) => b.lifecycle !== "RELEASED";

/** Why a turnover closed or waits for review (CLEAN 01/03). */
export const TASK_REASON: Record<string, string> = {
  RESERVATION_DATES_CHANGED:
    "The stay’s dates changed; a replacement task was created.",
  RESERVATION_CANCELLED: "The stay was cancelled.",
  RESERVATION_RELEASED: "You reopened the stay’s dates.",
  RESERVATION_RECLASSIFIED: "The dates are no longer classified as a stay.",
  RESERVATION_UNDER_REVIEW:
    "The stay is missing from its calendar. Decide on the calendar first.",
  RESERVATION_CANCELLED_AT_SOURCE:
    "The stay was cancelled at its source. Decide on the calendar first.",
  RESERVATION_CHANGED_DURING_WORK:
    "The stay changed while cleaning was under way.",
  RESERVATION_CANCELLED_DURING_WORK:
    "The stay was cancelled while cleaning was under way.",
  RESERVATION_RELEASED_DURING_WORK:
    "The stay’s dates were reopened while cleaning was under way.",
  RECLASSIFIED_DURING_WORK:
    "The dates stopped counting as a stay while cleaning was under way.",
};

/** How a label in a connection's policy question reads to the host. */
export const policyLabelName = (key: string, text: string | null) =>
  key === "none"
    ? "No label"
    : key === "other"
      ? "Any other label"
      : `“${text ?? key}”`;

/**
 * The answer pre-selected before the host has decided (CLASS 02). Label rules
 * are unverified (CLASS 01), so they only ever pre-select "by label", which
 * leaves every unmatched label Unknown; a blanket "guest reservations" would
 * turn a platform's owner closures into cleaning work (CLEAN 01). Without a
 * suggestion nothing is pre-selected and the host must choose.
 */
export function suggestedPolicyMode(
  labels: readonly { suggested: string | null }[],
): "BY_LABEL" | null {
  return labels.some(
    (l) => l.suggested === "RESERVATION" || l.suggested === "OWNER_BLOCK",
  )
    ? "BY_LABEL"
    : null;
}
