// CONFLICT 01 detection (the triage view is Phase 4). Overlapping protection
// is recorded and surfaced, never rejected (DATA 01). One case per canonically
// ordered pair; a changed overlap updates its case instead of re-alerting.
import { addDays, intersect, type DateRange, type LocalDate } from "./dates";
import {
  effectiveClass,
  isProtective,
  type BlockState,
  type Classification,
} from "./types";

export type ConflictKind =
  | "RESERVATION_RESERVATION"
  | "RESERVATION_HOLD"
  | "UNCERTAIN_OVERLAP"
  | "BUFFER_ONLY";
export type Severity = "HIGH" | "MEDIUM" | "LOW";

export type DesiredConflict = {
  blockAId: string;
  blockBId: string;
  kind: ConflictKind;
  severity: Severity;
  overlapStart: LocalDate;
  overlapEnd: LocalDate;
};

export type ConflictCaseState = DesiredConflict & {
  id: string;
  state: "OPEN" | "RESOLVED";
  resolution: "NO_LONGER_OVERLAPPING" | "HOST_RECORDED" | null;
  revision: number;
};

/** Buffer days are capped by database checks on listings and blocks. */
export const MAX_BUFFER_DAYS = 14;

/** Buffers protect turnover time around stays, including possible stays. */
export function bufferOf(b: BlockState, defaultDays: number) {
  const cls = effectiveClass(b);
  if (cls !== "RESERVATION" && cls !== "UNKNOWN")
    return { before: 0, after: 0 };
  return {
    before: b.bufferBeforeDays ?? defaultDays,
    after: b.bufferAfterDays ?? defaultDays,
  };
}

const isHold = (c: Classification) => c === "OWNER_BLOCK" || c === "MANUAL";

function classify(
  a: BlockState,
  b: BlockState,
): { kind: ConflictKind; severity: Severity } | null {
  const ca = effectiveClass(a);
  const cb = effectiveClass(b);
  if (ca === "CONFIRMED_ECHO" || cb === "CONFIRMED_ECHO") return null;
  if (ca === "RESERVATION" && cb === "RESERVATION")
    return { kind: "RESERVATION_RESERVATION", severity: "HIGH" };
  if (
    (ca === "RESERVATION" && cb === "UNKNOWN") ||
    (ca === "UNKNOWN" && cb === "RESERVATION")
  )
    return { kind: "UNCERTAIN_OVERLAP", severity: "MEDIUM" };
  if (ca === "UNKNOWN" && cb === "UNKNOWN")
    return {
      kind: "UNCERTAIN_OVERLAP",
      severity:
        a.connectionId && a.connectionId === b.connectionId ? "LOW" : "MEDIUM",
    };
  if (
    (ca === "RESERVATION" && isHold(cb)) ||
    (isHold(ca) && cb === "RESERVATION")
  )
    return { kind: "RESERVATION_HOLD", severity: "LOW" };
  if ((ca === "UNKNOWN" && isHold(cb)) || (isHold(ca) && cb === "UNKNOWN"))
    return { kind: "UNCERTAIN_OVERLAP", severity: "LOW" };
  return null; // Two holds only block dates; they cannot double-book a guest.
}

export function detectConflicts(
  blocks: readonly BlockState[],
  defaultBufferDays: number,
): DesiredConflict[] {
  const active = blocks
    .filter((b) => isProtective(b))
    .sort((a, b) =>
      a.startDate < b.startDate
        ? -1
        : a.startDate > b.startDate
          ? 1
          : a.id < b.id
            ? -1
            : 1,
    );
  const found: DesiredConflict[] = [];
  for (let i = 0; i < active.length; i++) {
    const a = active[i];
    const ba = bufferOf(a, defaultBufferDays);
    const reachA = addDays(a.endDate, ba.after);
    for (let j = i + 1; j < active.length; j++) {
      const b = active[j];
      const bb = bufferOf(b, defaultBufferDays);
      // Sorted by start, so once b starts beyond a's post-buffer and even a
      // maximal pre-buffer from b cannot reach a, no later block can either.
      if (
        b.startDate >= reachA &&
        addDays(b.startDate, -MAX_BUFFER_DAYS) >= a.endDate
      )
        break;
      const kind = classify(a, b);
      if (!kind) continue;
      const [first, second] = a.id < b.id ? [a, b] : [b, a];
      const nights = intersect(a, b);
      if (nights) {
        found.push({
          blockAId: first.id,
          blockBId: second.id,
          ...kind,
          overlapStart: nights.startDate,
          overlapEnd: nights.endDate,
        });
        continue;
      }
      const extA: DateRange = {
        startDate: addDays(a.startDate, -ba.before),
        endDate: addDays(a.endDate, ba.after),
      };
      const extB: DateRange = {
        startDate: addDays(b.startDate, -bb.before),
        endDate: addDays(b.endDate, bb.after),
      };
      const buffer = intersect(extA, b) ?? intersect(extB, a);
      if (buffer)
        found.push({
          blockAId: first.id,
          blockBId: second.id,
          kind: "BUFFER_ONLY",
          severity: "LOW",
          overlapStart: buffer.startDate,
          overlapEnd: buffer.endDate,
        });
    }
  }
  return found.sort((x, y) =>
    x.blockAId === y.blockAId
      ? x.blockBId < y.blockBId
        ? -1
        : 1
      : x.blockAId < y.blockAId
        ? -1
        : 1,
  );
}

export type ConflictPlan = {
  create: DesiredConflict[];
  update: (DesiredConflict & {
    id: string;
    revision: number;
    escalated: boolean;
  })[];
  resolve: { id: string }[];
};

const rank: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const sameFacts = (a: DesiredConflict, b: DesiredConflict) =>
  a.kind === b.kind &&
  a.severity === b.severity &&
  a.overlapStart === b.overlapStart &&
  a.overlapEnd === b.overlapEnd;

/**
 * Reconcile desired conflicts with stored cases. `latest` holds, per pair, the
 * open case or else the most recent resolved one; a host-recorded resolution
 * is not reopened unless the overlap facts change.
 */
export function reconcileConflicts(
  latest: readonly ConflictCaseState[],
  desired: readonly DesiredConflict[],
): ConflictPlan {
  const pair = (c: { blockAId: string; blockBId: string }) =>
    `${c.blockAId}|${c.blockBId}`;
  const byPair = new Map(latest.map((c) => [pair(c), c]));
  const want = new Map(desired.map((d) => [pair(d), d]));
  const plan: ConflictPlan = { create: [], update: [], resolve: [] };
  for (const [p, d] of want) {
    const c = byPair.get(p);
    if (!c) plan.create.push(d);
    else if (c.state === "OPEN") {
      if (!sameFacts(c, d))
        plan.update.push({
          ...d,
          id: c.id,
          revision: c.revision + 1,
          escalated: rank[d.severity] > rank[c.severity],
        });
    } else if (c.resolution === "NO_LONGER_OVERLAPPING" || !sameFacts(c, d))
      plan.create.push(d);
  }
  for (const [p, c] of byPair)
    if (c.state === "OPEN" && !want.has(p)) plan.resolve.push({ id: c.id });
  return plan;
}
