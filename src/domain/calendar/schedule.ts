// Stage 1 Schedule (pure parts): fetch intervals, Retry-After, near-term
// detection, manual refresh eligibility and per-platform budgets (FETCH 02/03).
// These are Hostsphere fetch intervals, not destination refresh guarantees.
import { CAPABILITIES } from "./capabilities";
import { addDays, type LocalDate } from "./dates";
import {
  effectiveClass,
  isProtective,
  type BlockState,
  type Platform,
} from "./types";

export const FETCH_POLICY = {
  normalMs: 15 * 60_000,
  nearTermMs: 5 * 60_000,
  /** ±10% spread so connections do not align on the same second. */
  jitter: 0.1,
  failureBaseMs: 5 * 60_000,
  failureMaxMs: 60 * 60_000,
  /** A source delay beyond this pauses the connection for review. */
  autoRetryWindowMs: 6 * 3_600_000,
  manualCooldownMs: 60_000,
  nearTermDays: 3,
} as const;

export function nextFetch(input: {
  nowMs: number;
  succeeded: boolean;
  /** Consecutive failures including this attempt. */
  failures: number;
  nearTerm: boolean;
  /** Source-requested earliest retry (FETCH 02), as epoch ms. */
  retryAfterMs: number | null;
  /** Supplied randomness in [0, 1); the core never calls Math.random. */
  random: number;
}): { atMs: number; pausedBySource: boolean } {
  const base = input.succeeded
    ? input.nearTerm
      ? FETCH_POLICY.nearTermMs
      : FETCH_POLICY.normalMs
    : Math.min(
        FETCH_POLICY.failureMaxMs,
        FETCH_POLICY.failureBaseMs *
          2 ** Math.min(Math.max(input.failures - 1, 0), 4),
      );
  const spread =
    1 - FETCH_POLICY.jitter + 2 * FETCH_POLICY.jitter * input.random;
  let atMs = input.nowMs + Math.round(base * spread);
  let pausedBySource = false;
  if (input.retryAfterMs !== null && input.retryAfterMs > atMs) {
    // Never truncate the source's delay and retry earlier.
    atMs = input.retryAfterMs;
    pausedBySource =
      input.retryAfterMs - input.nowMs > FETCH_POLICY.autoRetryWindowMs;
  }
  return { atMs, pausedBySource };
}

/** Retry-After as delta-seconds or an HTTP-date; null when absent or invalid. */
export function parseRetryAfter(
  value: string | null | undefined,
  nowMs: number,
) {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return nowMs + Math.min(Number(v), 30 * 86_400) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(at, nowMs) : null;
}

/** Near-term: an arrival or departure within the next few property days. */
export function isNearTerm(blocks: readonly BlockState[], today: LocalDate) {
  const until = addDays(today, FETCH_POLICY.nearTermDays);
  return blocks.some(
    (b) =>
      isProtective(b) &&
      effectiveClass(b) !== "CONFIRMED_ECHO" &&
      ((b.startDate >= today && b.startDate < until) ||
        (b.endDate >= today && b.endDate < until)),
  );
}

export type RefreshEligibility =
  | { status: "QUEUED" }
  | { status: "IN_FLIGHT"; reason: string }
  | { status: "UNAVAILABLE"; reason: string; nextEligibleAt: string | null };

/** FETCH 03: manual refresh joins the same budgets and says why it waits. */
export function manualRefreshEligibility(
  c: {
    enabled: boolean;
    importing: boolean;
    leaseUntil: string | null;
    lastAttemptAt: string | null;
    sourceRetryAfter: string | null;
  },
  nowMs: number,
): RefreshEligibility {
  if (!c.importing)
    return {
      status: "UNAVAILABLE",
      reason:
        "This connection only publishes an export link; there is nothing to check.",
      nextEligibleAt: null,
    };
  if (!c.enabled)
    return {
      status: "UNAVAILABLE",
      reason: "This connection is disabled.",
      nextEligibleAt: null,
    };
  if (c.leaseUntil && Date.parse(c.leaseUntil) > nowMs)
    return {
      status: "IN_FLIGHT",
      reason: "A check is already running; it will finish shortly.",
    };
  if (c.sourceRetryAfter && Date.parse(c.sourceRetryAfter) > nowMs)
    return {
      status: "UNAVAILABLE",
      reason: "The calendar asked us to wait before checking again.",
      nextEligibleAt: c.sourceRetryAfter,
    };
  if (
    c.lastAttemptAt &&
    nowMs - Date.parse(c.lastAttemptAt) < FETCH_POLICY.manualCooldownMs
  )
    return {
      status: "UNAVAILABLE",
      reason: "This calendar was checked moments ago.",
      nextEligibleAt: new Date(
        Date.parse(c.lastAttemptAt) + FETCH_POLICY.manualCooldownMs,
      ).toISOString(),
    };
  return { status: "QUEUED" };
}

/** Per-tick platform budget shared by scheduled and manual work. */
export function platformBudget() {
  const remaining = new Map<Platform, number>(
    Object.values(CAPABILITIES).map((c) => [c.platform, c.budgetPerTick]),
  );
  return {
    take(platform: Platform) {
      const left = remaining.get(platform) ?? 0;
      if (left <= 0) return false;
      remaining.set(platform, left - 1);
      return true;
    },
    remaining: (platform: Platform) => remaining.get(platform) ?? 0,
  };
}
