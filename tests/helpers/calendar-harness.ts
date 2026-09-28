// Shared test harness: an in-memory store that applies calendar plans
// exactly as the database adapter does (creates, updates, snapshot and
// fingerprint bookkeeping), so pure-core tests exercise whole histories.
import {
  planObservation,
  type PlanInput,
} from "../../src/domain/calendar/pipeline";
import type { NewBlock } from "../../src/domain/calendar/compare";
import type {
  BlockState,
  ConnectionPolicy,
} from "../../src/domain/calendar/types";

export const UNSET: ConnectionPolicy = {
  mode: "UNSET",
  labels: null,
  version: 0,
};
export const cal = (...events: string[][]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    ...events.flat(),
    "END:VCALENDAR",
  ].join("\r\n");
export const vevent = (
  uid: string | null,
  start: string,
  end: string,
  extra: string[] = [],
) => [
  "BEGIN:VEVENT",
  ...(uid ? [`UID:${uid}`] : []),
  `DTSTART;VALUE=DATE:${start.replaceAll("-", "")}`,
  `DTEND;VALUE=DATE:${end.replaceAll("-", "")}`,
  ...extra,
  "END:VEVENT",
];
export const broken = (uid: string) => [
  "BEGIN:VEVENT",
  `UID:${uid}`,
  "DTSTART;VALUE=DATE:2026AB01",
  "END:VEVENT",
];

let counter = 0;
/**
 * Store JSON the way PostgreSQL jsonb returns it: object keys reordered
 * (shorter first, then bytewise). Code that compares evidence by key order
 * would see a change on every read; the harness makes that visible here.
 */
function jsonb<T>(value: T): T {
  if (Array.isArray(value)) return value.map(jsonb) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, jsonb(v)]),
    ) as T;
  return value;
}
const stored = (b: BlockState): BlockState => ({
  ...b,
  classificationEvidence: jsonb(b.classificationEvidence),
  pendingChange: jsonb(b.pendingChange),
});

export const materialize = (b: NewBlock): BlockState => ({
  ...b,
  id: `blk-${String(++counter).padStart(4, "0")}`,
});

/** A tiny in-memory store that applies plans exactly as the adapter does. */
export function harness(
  opts: {
    platform?: PlanInput["connection"]["platform"];
    policy?: ConnectionPolicy;
    zone?: string;
    checkoutHour?: number;
  } = {},
) {
  let blocks: BlockState[] = [];
  let snapshot: PlanInput["snapshot"] = null;
  let fingerprint: string | null = null;
  let coverageEnd: string | null = null;
  let anomaly: PlanInput["connection"]["anomaly"] = null;
  let revision = 0;
  const connection = {
    id: "conn-1",
    listingId: "listing-1",
    platform: opts.platform ?? ("AIRBNB" as const),
    policy: opts.policy ?? UNSET,
  };
  return {
    get blocks() {
      return blocks;
    },
    /** The property's calendar revision (CAL 03 / EXPORT 04). */
    get revision() {
      return revision;
    },
    set policy(p: ConnectionPolicy) {
      connection.policy = p;
    },
    observe(fetch: PlanInput["fetch"], at: string, today = at.slice(0, 10)) {
      const plan = planObservation({
        fetch,
        snapshot,
        lastAcceptedFingerprint: fingerprint,
        connection: { ...connection, coverageEnd, anomaly },
        property: {
          zone: opts.zone ?? "UTC",
          checkoutHour: opts.checkoutHour ?? 11,
        },
        blocks: blocks.filter((b) => b.connectionId === connection.id),
        knownBlockIds: new Set(blocks.map((b) => b.id)),
        today,
        now: at,
        nextRevision: revision + 1,
      });
      const changed =
        plan.compare.creates.length + plan.compare.updates.length > 0;
      if (changed) revision++;
      const updates = new Map(plan.compare.updates.map((u) => [u.id, u]));
      blocks = blocks
        .map((b) => updates.get(b.id) ?? b)
        .concat(plan.compare.creates.map(materialize))
        .map(stored);
      anomaly = plan.anomaly;
      if (plan.accepted && plan.snapshot) {
        if (plan.contentChanged) snapshot = plan.snapshot;
        fingerprint = plan.snapshot.fingerprint;
        coverageEnd = plan.snapshot.coverageEnd;
      }
      return plan;
    },
    replace(next: BlockState) {
      blocks = blocks.map((b) => (b.id === next.id ? next : b));
    },
    add(b: NewBlock) {
      const m = materialize(b);
      blocks = [...blocks, m];
      return m;
    },
    byKey: (key: string) => blocks.find((b) => b.sourceKey === key)!,
  };
}
