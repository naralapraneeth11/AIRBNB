// Bounded reason codes recorded with every run and decision (CAL 01). The text
// is what a host can read; codes never embed URLs, tokens or guest data.
export const REASONS = {
  // Fetch (stage 2)
  FETCH_TIMEOUT: "The calendar did not answer within 10 seconds.",
  FETCH_DNS: "The calendar's address could not be resolved.",
  FETCH_ADDRESS_BLOCKED:
    "The calendar resolved to a private or reserved network.",
  FETCH_CONNECTION: "The connection to the calendar failed.",
  FETCH_HTTP_STATUS: "The calendar answered with an error status.",
  FETCH_TOO_LARGE: "The calendar exceeded the 2 MB size limit.",
  FETCH_REDIRECT_LIMIT: "The calendar redirected more than three times.",
  FETCH_REDIRECT_BLOCKED:
    "The calendar redirected to an address that is not allowed.",
  FETCH_RATE_LIMITED: "The calendar asked us to slow down.",
  FETCH_UNAVAILABLE: "The calendar service was temporarily unavailable.",
  FETCH_URL_INVALID: "The calendar address is not an allowed HTTPS URL.",
  FETCH_DECODE: "The calendar response could not be decoded.",
  FETCH_INTERNAL: "The check stopped because of an internal error.",
  NOT_CALENDAR: "The response was not an iCalendar document.",
  // Parse and normalize (stages 3-4)
  NOT_MODIFIED:
    "The calendar reported no change since the last accepted version.",
  SNAPSHOT_MISSING:
    "The calendar reported no change, but the last accepted version is unavailable; the next check downloads it again.",
  UNCHANGED_CONTENT:
    "The calendar content was identical to the last accepted version.",
  FEED_TRUNCATED: "The calendar ended early; it may have been cut off.",
  FEED_STRUCTURE: "The calendar's structure was malformed.",
  EVENT_INVALID: "An event could not be read.",
  INVALID_RANGE: "An event had a missing, reversed or zero-length date range.",
  EVENT_LIMIT: "The calendar has more events than can be processed safely.",
  LINE_LIMIT: "The calendar contains an oversized line.",
  PROPERTY_LIMIT: "An event has too many properties.",
  RECURRENCE_LIMIT: "A repeating event exceeded the safe expansion limit.",
  UNSUPPORTED_COMPONENT:
    "The calendar contains items other than events; they were ignored.",
  DUPLICATE_UID_CONFLICT: "Two events share an identity but disagree.",
  MISSING_UID:
    "An event has no identity; its dates are protected but it cannot be matched reliably.",
  AMBIGUOUS_TIME: "An event time was ambiguous in the property's time zone.",
  // Health gate (stage 5)
  PREVIOUS_ACCEPTANCE_PARTIAL: "The last accepted version was incomplete.",
  EMPTY_FEED_ANOMALY:
    "The calendar became empty although future dates were protected.",
  IDENTITY_DROP_ANOMALY:
    "More than half of the future stays disappeared at once.",
  COVERAGE_SHRANK: "The calendar now covers fewer future dates than before.",
  // Decisions (stages 6-8)
  BLOCK_CREATED: "New dates were protected.",
  BLOCK_UPDATED: "Protected dates changed.",
  UPDATE_DEFERRED:
    "A change that would remove protection waits for a complete, healthy check.",
  RECLASSIFIED: "The block's classification changed.",
  MISSING_OBSERVED:
    "An event is missing from a complete check; its dates remain protected.",
  AWAITING_DECISION_ABSENCE:
    "An event stayed missing; its dates remain protected until you decide.",
  CANCELLATION_REVIEW:
    "The source marked a stay cancelled; its dates remain protected until you decide.",
  STALE_CANCELLATION_IGNORED:
    "An older cancellation arrived after a newer version and was ignored.",
  REAPPEARED: "A missing event reappeared; the pending review was cleared.",
  REAPPEARED_AFTER_RELEASE:
    "An event returned after its dates were released; dates are protected again.",
  REINSTATED: "The source reinstated a cancelled stay.",
  BEYOND_COVERAGE:
    "An event is no longer observed, but it lies outside the calendar's current range.",
  ECHO_EXCLUDED:
    "An event was recognized as this property's own export and excluded.",
  CANCELLED_UNKNOWN_IGNORED:
    "A cancellation referred to a stay that was never protected.",
  ADDITION_BLOCKED:
    "New events were not applied because the check was not trusted.",
  INVALID_EVENT_PRESENT:
    "An existing event is present but unreadable; its dates remain protected.",
} as const;

export type ReasonCode = keyof typeof REASONS;

export const isReasonCode = (value: string): value is ReasonCode =>
  Object.prototype.hasOwnProperty.call(REASONS, value);
