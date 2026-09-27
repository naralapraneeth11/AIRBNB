// Pure calendar core: section 25 acceptance scenarios, the section 15 worked
// example, and the Appendix B Phase 1 rules, exercised without I/O.
import assert from "node:assert/strict";
import test from "node:test";
import {
  planObservation,
  type PlanInput,
} from "../src/domain/calendar/pipeline";
import { compare, type NewBlock } from "../src/domain/calendar/compare";
import { assessHealth } from "../src/domain/calendar/health";
import {
  releaseBlock,
  keepBlocked,
  restoreBlock,
  classifyBlock,
  manualHold,
} from "../src/domain/calendar/lifecycle";
import {
  detectConflicts,
  reconcileConflicts,
} from "../src/domain/calendar/conflicts";
import {
  buildExportEvents,
  exportDigest,
  renderExport,
} from "../src/domain/calendar/export";
import {
  nextFetch,
  parseRetryAfter,
  manualRefreshEligibility,
  isNearTerm,
} from "../src/domain/calendar/schedule";
import { rangeOf } from "../src/domain/calendar/normalize";
import type {
  BlockState,
  ConnectionPolicy,
} from "../src/domain/calendar/types";

const UNSET: ConnectionPolicy = { mode: "UNSET", labels: null, version: 0 };
const cal = (...events: string[][]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    ...events.flat(),
    "END:VCALENDAR",
  ].join("\r\n");
const vevent = (
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
const broken = (uid: string) => [
  "BEGIN:VEVENT",
  `UID:${uid}`,
  "DTSTART;VALUE=DATE:2026AB01",
  "END:VEVENT",
];

let counter = 0;
const materialize = (b: NewBlock): BlockState => ({
  ...b,
  id: `blk-${String(++counter).padStart(4, "0")}`,
});

/** A tiny in-memory store that applies plans exactly as the adapter does. */
function harness(
  opts: {
    platform?: PlanInput["connection"]["platform"];
    policy?: ConnectionPolicy;
  } = {},
) {
  let blocks: BlockState[] = [];
  let snapshot: PlanInput["snapshot"] = null;
  let fingerprint: string | null = null;
  let coverageEnd: string | null = null;
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
    set policy(p: ConnectionPolicy) {
      connection.policy = p;
    },
    observe(fetch: PlanInput["fetch"], at: string, today = at.slice(0, 10)) {
      const plan = planObservation({
        fetch,
        snapshot,
        lastAcceptedFingerprint: fingerprint,
        connection: { ...connection, coverageEnd },
        property: { zone: "UTC", checkoutHour: 11 },
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
        .concat(plan.compare.creates.map(materialize));
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

test("DATE 01: exclusive end dates, one-day default and reversed ranges", () => {
  const date = (d: string) => ({ kind: "DATE" as const, date: d });
  assert.deepEqual(
    rangeOf(date("2026-10-14"), date("2026-10-17"), null, "UTC", 11),
    {
      ok: true,
      startDate: "2026-10-14",
      endDate: "2026-10-17",
      ambiguous: false,
    },
  );
  const oneDay = rangeOf(date("2026-10-14"), null, null, "UTC", 11);
  assert.equal(oneDay.ok && oneDay.endDate, "2026-10-15");
  assert.equal(
    rangeOf(date("2026-10-17"), date("2026-10-14"), null, "UTC", 11).ok,
    false,
  );
  assert.equal(
    rangeOf(date("2026-10-14"), date("2026-10-14"), null, "UTC", 11).ok,
    false,
  );
  const leap = rangeOf(date("2028-02-28"), date("2028-03-01"), null, "UTC", 11);
  assert.equal(leap.ok && leap.endDate, "2028-03-01");
});

test("DATE 01: timed values use the property zone and never round 23:00 into another night", () => {
  const utc = (d: string, h: number) => ({
    kind: "UTC" as const,
    local: { date: d, hour: h, minute: 0, second: 0 },
  });
  // 23:00Z is local midnight in London during summer time: the night of the 14th.
  const london = rangeOf(
    utc("2026-10-13", 23),
    utc("2026-10-16", 23),
    null,
    "Europe/London",
    11,
  );
  assert.deepEqual(london.ok && [london.startDate, london.endDate], [
    "2026-10-14",
    "2026-10-17",
  ]);
  // In a UTC property the same instants are a late arrival on the 13th.
  const inUtc = rangeOf(
    utc("2026-10-13", 23),
    utc("2026-10-16", 23),
    null,
    "UTC",
    11,
  );
  assert.deepEqual(inUtc.ok && [inUtc.startDate, inUtc.endDate], [
    "2026-10-13",
    "2026-10-17",
  ]);
  // A departure after the property's checkout time protects that night too.
  const late = rangeOf(
    utc("2026-10-14", 15),
    utc("2026-10-17", 13),
    null,
    "UTC",
    11,
  );
  assert.deepEqual(late.ok && [late.startDate, late.endDate], [
    "2026-10-14",
    "2026-10-18",
  ]);
});

test("CAL 02: a valid addition applies while a malformed event keeps its old protection", () => {
  const h = harness();
  h.observe(
    {
      outcome: "BODY",
      body: cal(
        vevent("stay-a", "2026-10-14", "2026-10-17"),
        vevent("stay-b", "2026-11-01", "2026-11-04"),
      ),
    },
    "2026-09-27T10:00:00.000Z",
  );
  const plan = h.observe(
    {
      outcome: "BODY",
      body: cal(
        vevent("stay-a", "2026-10-14", "2026-10-17"),
        broken("stay-b"),
        vevent("stay-c", "2026-12-01", "2026-12-03"),
      ),
    },
    "2026-09-27T11:00:00.000Z",
  );
  assert.equal(plan.gate.health, "PARTIAL");
  assert.equal(plan.gate.absenceReview, false);
  assert.equal(h.byKey("stay-c").lifecycle, "ACTIVE", "new protection appears");
  assert.equal(h.byKey("stay-b").lifecycle, "ACTIVE", "old protection remains");
  assert.ok(h.byKey("stay-b").reviewFlags.includes("INVALID_SOURCE_EVENT"));
  assert.equal(plan.result, "NEEDS_REVIEW");
});

test("Worked example (section 15): absence needs two spaced healthy checks, then only a host releases", () => {
  const h = harness();
  const stay = () => vevent("stay-1", "2026-10-14", "2026-10-17");
  const other = () => vevent("other", "2026-12-01", "2026-12-05");
  h.observe(
    { outcome: "BODY", body: cal(stay(), other()) },
    "2026-09-27T10:00:00.000Z",
  );
  // Next feed omits the stay and also contains one invalid event: incomplete evidence.
  h.observe(
    { outcome: "BODY", body: cal(other(), broken("junk")) },
    "2026-09-27T10:05:00.000Z",
  );
  assert.equal(h.byKey("stay-1").lifecycle, "ACTIVE");
  // A later healthy feed also omits it: the missing lifecycle starts here.
  h.observe(
    { outcome: "BODY", body: cal(other()) },
    "2026-09-27T10:10:00.000Z",
  );
  assert.equal(h.byKey("stay-1").lifecycle, "MISSING_OBSERVED");
  // A second eligible observation sooner than 15 minutes does not escalate.
  h.observe({ outcome: "NOT_MODIFIED" }, "2026-09-27T10:20:00.000Z");
  assert.equal(h.byKey("stay-1").lifecycle, "MISSING_OBSERVED");
  // A 304 at least 15 minutes after the first absence counts as eligible.
  const escalated = h.observe(
    { outcome: "NOT_MODIFIED" },
    "2026-09-27T10:26:00.000Z",
  );
  const blocked = h.byKey("stay-1");
  assert.equal(blocked.lifecycle, "AWAITING_DECISION");
  assert.equal(blocked.decisionReason, "ABSENCE");
  assert.equal(escalated.result, "NEEDS_REVIEW");
  // Reconciliation never releases on its own, however often it runs.
  for (const minute of [30, 45, 59])
    h.observe({ outcome: "NOT_MODIFIED" }, `2026-09-27T10:${minute}:00.000Z`);
  assert.equal(h.byKey("stay-1").lifecycle, "AWAITING_DECISION");
  // The host approves release against the revision they reviewed.
  const stale = releaseBlock(blocked, {
    expectedRevision: blocked.revision - 1,
    now: "2026-09-27T11:00:00.000Z",
    nextRevision: 99,
  });
  assert.deepEqual(stale, { ok: false, error: "STALE_REVISION" });
  const released = releaseBlock(blocked, {
    expectedRevision: blocked.revision,
    now: "2026-09-27T11:00:00.000Z",
    nextRevision: 99,
  });
  assert.ok(released.ok);
  h.replace(released.block);
  // Restore within 24 hours creates a compensating hold, not a rewrite.
  const restored = restoreBlock(released.block, {
    expectedRevision: released.block.revision,
    now: "2026-09-28T10:00:00.000Z",
    nextRevision: 100,
  });
  assert.ok(restored.ok);
  assert.equal(restored.hold.compensatesBlockId, released.block.id);
  assert.equal(restored.hold.holdType, "RESTORED");
  assert.deepEqual(
    [restored.hold.startDate, restored.hold.endDate],
    ["2026-10-14", "2026-10-17"],
  );
  const hold = h.add(restored.hold);
  // A newly imported overlapping booking is kept and becomes a conflict.
  h.observe(
    {
      outcome: "BODY",
      body: cal(
        other(),
        vevent("new-guest", "2026-10-15", "2026-10-18", ["SUMMARY:Reserved"]),
      ),
    },
    "2026-09-28T11:00:00.000Z",
  );
  const guest = h.byKey("new-guest");
  assert.equal(guest.lifecycle, "ACTIVE", "not discarded as an echo");
  const conflicts = detectConflicts(h.blocks, 0);
  assert.ok(
    conflicts.some(
      (c) =>
        [c.blockAId, c.blockBId].includes(guest.id) &&
        [c.blockAId, c.blockBId].includes(hold.id),
    ),
  );
  const late = restoreBlock(released.block, {
    expectedRevision: released.block.revision,
    now: "2026-09-29T12:00:00.000Z",
    nextRevision: 101,
  });
  assert.deepEqual(late, { ok: false, error: "RESTORE_WINDOW_PASSED" });
});

test("LIFE 01: an event that vanishes then reappears keeps protection and clears the review", () => {
  const h = harness();
  const a = () => vevent("a", "2026-10-14", "2026-10-17");
  const b = () => vevent("b", "2026-11-01", "2026-11-03");
  h.observe(
    { outcome: "BODY", body: cal(a(), b()) },
    "2026-09-27T10:00:00.000Z",
  );
  h.observe({ outcome: "BODY", body: cal(b()) }, "2026-09-27T10:15:00.000Z");
  h.observe({ outcome: "BODY", body: cal(b()) }, "2026-09-27T10:31:00.000Z");
  assert.equal(h.byKey("a").lifecycle, "AWAITING_DECISION");
  const plan = h.observe(
    { outcome: "BODY", body: cal(a(), b()) },
    "2026-09-27T10:45:00.000Z",
  );
  const back = h.byKey("a");
  assert.equal(back.lifecycle, "ACTIVE");
  assert.equal(back.decisionReason, null);
  assert.equal(back.missingSince, null);
  assert.ok(plan.compare.decisions.some((d) => d.type === "REAPPEARED"));
});

test("CAL 04: repeating the same observation produces no further changes", () => {
  const h = harness();
  const body = cal(
    vevent("a", "2026-10-14", "2026-10-17"),
    vevent(null, "2026-11-01", "2026-11-02"),
  );
  const first = h.observe(
    { outcome: "BODY", body },
    "2026-09-27T10:00:00.000Z",
  );
  assert.equal(first.compare.creates.length, 2);
  const snapshotOfBlocks = JSON.stringify(h.blocks);
  for (const minute of ["05", "20", "40"]) {
    const again = h.observe(
      { outcome: "BODY", body },
      `2026-09-27T10:${minute}:00.000Z`,
    );
    assert.equal(
      again.compare.creates.length + again.compare.updates.length,
      0,
    );
    assert.equal(again.contentChanged, false);
    assert.equal(
      again.result,
      "NEEDS_REVIEW",
      "unknown blocks still await the policy question",
    );
  }
  assert.equal(JSON.stringify(h.blocks), snapshotOfBlocks);
});

test("Health gate: failures, empty feeds and mass disappearance never remove protection", () => {
  const keys = (...k: string[]) => new Set(k);
  assert.equal(
    assessHealth({
      outcome: "FAILED",
      complete: false,
      futureKeys: keys(),
      previousFutureKeys: keys("a"),
      coverageEnd: null,
      previousCoverageEnd: null,
    }).absenceReview,
    false,
  );
  const empty = assessHealth({
    outcome: "BODY",
    complete: true,
    futureKeys: keys(),
    previousFutureKeys: keys("a"),
    coverageEnd: null,
    previousCoverageEnd: "2026-12-01",
  });
  assert.equal(empty.health, "EMPTY_ANOMALY");
  assert.equal(empty.absenceReview, false);
  const drop = assessHealth({
    outcome: "BODY",
    complete: true,
    futureKeys: keys("a"),
    previousFutureKeys: keys("a", "b", "c"),
    coverageEnd: "2026-11-01",
    previousCoverageEnd: "2026-12-01",
  });
  assert.equal(drop.health, "DROP_ANOMALY");
  assert.equal(drop.absenceReview, false);
  assert.equal(drop.updates, "PROTECTIVE_ONLY");
  const shrink = assessHealth({
    outcome: "BODY",
    complete: true,
    futureKeys: keys("a", "b"),
    previousFutureKeys: keys("a", "b", "c"),
    coverageEnd: "2026-11-01",
    previousCoverageEnd: "2026-12-01",
  });
  assert.equal(shrink.health, "HEALTHY");
  assert.ok(shrink.reasons.includes("COVERAGE_SHRANK"));
});

test("An empty feed after protected stays holds everything and asks for review", () => {
  const h = harness();
  h.observe(
    { outcome: "BODY", body: cal(vevent("a", "2026-10-14", "2026-10-17")) },
    "2026-09-27T10:00:00.000Z",
  );
  const plan = h.observe(
    { outcome: "BODY", body: cal() },
    "2026-09-27T10:30:00.000Z",
  );
  assert.equal(plan.gate.health, "EMPTY_ANOMALY");
  assert.equal(h.byKey("a").lifecycle, "ACTIVE");
  assert.equal(plan.result, "NEEDS_REVIEW");
});

test("DATE 02 and coverage: a shorter horizon is never read as cancellation", () => {
  const h = harness();
  h.observe(
    {
      outcome: "BODY",
      body: cal(
        vevent("near", "2026-10-01", "2026-10-03"),
        vevent("mid", "2026-10-14", "2026-10-17"),
        vevent("far", "2027-03-01", "2027-03-05"),
      ),
    },
    "2026-09-27T10:00:00.000Z",
  );
  // The source now only reaches mid-October: "far" lies beyond its coverage.
  h.observe(
    {
      outcome: "BODY",
      body: cal(
        vevent("near", "2026-10-01", "2026-10-03"),
        vevent("mid", "2026-10-14", "2026-10-17"),
      ),
    },
    "2026-09-27T10:30:00.000Z",
  );
  const far = h.byKey("far");
  assert.equal(far.lifecycle, "ACTIVE");
  assert.ok(far.reviewFlags.includes("BEYOND_COVERAGE"));
});

test("DATE 02: hitting the recurrence bound marks the observation incomplete", () => {
  const h = harness({ platform: "GOOGLE" });
  // Five daily series exceed 3000 occurrences inside the 730-day window.
  const series = [1, 2, 3, 4, 5].map((n) => [
    "BEGIN:VEVENT",
    `UID:daily-${n}`,
    "DTSTART;VALUE=DATE:20260928",
    "DTEND;VALUE=DATE:20260929",
    "RRULE:FREQ=DAILY",
    "END:VEVENT",
  ]);
  const plan = h.observe(
    { outcome: "BODY", body: cal(...series) },
    "2026-09-27T10:00:00.000Z",
  );
  assert.ok(plan.reasons.includes("RECURRENCE_LIMIT"));
  assert.equal(plan.gate.absenceReview, false);
  assert.ok(h.blocks.length <= 3000);
});

test("ID 01: a recurrence instance that moves keeps one identity", () => {
  const h = harness({ platform: "GOOGLE" });
  const master = [
    "BEGIN:VEVENT",
    "UID:weekly",
    "DTSTART;VALUE=DATE:20261001",
    "DTEND;VALUE=DATE:20261003",
    "RRULE:FREQ=WEEKLY;COUNT=3",
    "END:VEVENT",
  ];
  h.observe({ outcome: "BODY", body: cal(master) }, "2026-09-27T10:00:00.000Z");
  const before = h.byKey("weekly#2026-10-08");
  const moved = [
    "BEGIN:VEVENT",
    "UID:weekly",
    "RECURRENCE-ID;VALUE=DATE:20261008",
    "DTSTART;VALUE=DATE:20261010",
    "DTEND;VALUE=DATE:20261012",
    "END:VEVENT",
  ];
  h.observe(
    { outcome: "BODY", body: cal(master, moved) },
    "2026-09-27T10:30:00.000Z",
  );
  const after = h.byKey("weekly#2026-10-08");
  assert.equal(after.id, before.id);
  assert.deepEqual(
    [after.startDate, after.endDate],
    ["2026-10-10", "2026-10-12"],
  );
  assert.equal(h.blocks.length, 3);
});

test("ID 01: duplicate identities that disagree go to review, not last-write-wins", () => {
  const h = harness();
  h.observe(
    { outcome: "BODY", body: cal(vevent("dup", "2026-10-14", "2026-10-17")) },
    "2026-09-27T10:00:00.000Z",
  );
  const original = h.byKey("dup");
  const plan = h.observe(
    {
      outcome: "BODY",
      body: cal(
        vevent("dup", "2026-10-14", "2026-10-17"),
        vevent("dup", "2026-10-20", "2026-10-22"),
      ),
    },
    "2026-09-27T10:30:00.000Z",
  );
  const kept = h.byKey("dup");
  assert.deepEqual(
    [kept.startDate, kept.endDate],
    [original.startDate, original.endDate],
  );
  assert.ok(kept.reviewFlags.includes("DUPLICATE_UID"));
  const variant = h.blocks.find((b) => b.identityKind === "DUPLICATE_VARIANT")!;
  assert.deepEqual(
    [variant.startDate, variant.classification],
    ["2026-10-20", "UNKNOWN"],
  );
  assert.equal(plan.result, "NEEDS_REVIEW");
});

test("ID 02: events without identity stay unknown and cannot authorize removals", () => {
  const h = harness({
    policy: { mode: "RESERVATIONS", labels: null, version: 1 },
  });
  h.observe(
    {
      outcome: "BODY",
      body: cal(
        vevent(null, "2026-10-14", "2026-10-17"),
        vevent("real", "2026-11-01", "2026-11-03"),
      ),
    },
    "2026-09-27T10:00:00.000Z",
  );
  const surrogate = h.blocks.find((b) => b.identityKind === "SURROGATE")!;
  assert.equal(
    surrogate.classification,
    "UNKNOWN",
    "a policy cannot classify an unidentified event",
  );
  assert.ok(surrogate.reviewFlags.includes("IDENTITY_UNCERTAIN"));
  assert.equal(h.byKey("real").classification, "RESERVATION");
  // The UID-less event "moves": the old surrogate is only ever sent to review.
  h.observe(
    {
      outcome: "BODY",
      body: cal(
        vevent(null, "2026-10-15", "2026-10-18"),
        vevent("real", "2026-11-01", "2026-11-03"),
      ),
    },
    "2026-09-27T10:30:00.000Z",
  );
  h.observe({ outcome: "NOT_MODIFIED" }, "2026-09-27T10:50:00.000Z");
  const old = h.blocks.find((b) => b.id === surrogate.id)!;
  assert.equal(old.lifecycle, "AWAITING_DECISION");
  assert.ok(h.blocks.every((b) => b.lifecycle !== "RELEASED"));
});

test("CLASS 01: a reservation matching an earlier export range is not treated as an echo", () => {
  const h = harness({
    policy: { mode: "RESERVATIONS", labels: null, version: 1 },
  });
  const hold = h.add(
    manualHold({
      listingId: "listing-1",
      startDate: "2026-10-14",
      endDate: "2026-10-17",
      holdType: "OWNER",
      now: "2026-09-27T09:00:00.000Z",
      nextRevision: 1,
      reservation: false,
    }),
  );
  // Same dates as the hold we export, but a platform UID: a real reservation.
  h.observe(
    {
      outcome: "BODY",
      body: cal(vevent("platform-uid-9", "2026-10-14", "2026-10-17")),
    },
    "2026-09-27T10:00:00.000Z",
  );
  const r = h.byKey("platform-uid-9");
  assert.equal(r.classification, "RESERVATION");
  assert.equal(r.lifecycle, "ACTIVE");
  // Our own export UID echoing back is recognized by provenance and excluded.
  const plan = h.observe(
    {
      outcome: "BODY",
      body: cal(
        vevent("platform-uid-9", "2026-10-14", "2026-10-17"),
        vevent(`${hold.id}@airbnb-automation`, "2026-10-14", "2026-10-17"),
      ),
    },
    "2026-09-27T10:30:00.000Z",
  );
  assert.ok(plan.compare.decisions.some((d) => d.type === "ECHO_EXCLUDED"));
  assert.equal(h.blocks.filter((b) => b.connectionId).length, 1);
});

test("CLASS 02: a single-label platform stays unknown until the host answers, then reclassifies", () => {
  const h = harness({ platform: "BOOKING" });
  const body = cal(
    vevent("bk-1", "2026-10-14", "2026-10-17", [
      "SUMMARY:CLOSED - Not available",
    ]),
    vevent("bk-2", "2026-11-01", "2026-11-03", [
      "SUMMARY:CLOSED - Not available",
    ]),
  );
  const before = h.observe(
    { outcome: "BODY", body },
    "2026-09-27T10:00:00.000Z",
  );
  assert.ok(h.blocks.every((b) => b.classification === "UNKNOWN"));
  assert.ok(before.policyQuestion);
  assert.equal(before.result, "NEEDS_REVIEW");
  h.policy = { mode: "RESERVATIONS", labels: null, version: 1 };
  const after = h.observe(
    { outcome: "NOT_MODIFIED" },
    "2026-09-27T10:30:00.000Z",
  );
  assert.ok(h.blocks.every((b) => b.classification === "RESERVATION"));
  assert.ok(
    h.blocks.every(
      (b) => b.classificationEvidence.rule === "CONNECTION_POLICY",
    ),
  );
  assert.equal(after.policyQuestion, false);
});

test("CLASS 01: unverified platform label rules only suggest an answer", () => {
  const h = harness({ platform: "AIRBNB" });
  h.observe(
    {
      outcome: "BODY",
      body: cal(
        vevent("r1", "2026-10-14", "2026-10-17", ["SUMMARY:Reserved"]),
        vevent("n1", "2026-11-01", "2026-11-03", [
          "SUMMARY:Airbnb (Not available)",
        ]),
      ),
    },
    "2026-09-27T10:00:00.000Z",
  );
  assert.equal(h.byKey("r1").classification, "UNKNOWN");
  assert.equal(h.byKey("r1").classificationEvidence.suggested, "RESERVATION");
  assert.equal(h.byKey("n1").classificationEvidence.suggested, "OWNER_BLOCK");
  h.policy = {
    mode: "BY_LABEL",
    labels: { reserved: "RESERVATION", "not-available": "OWNER_BLOCK" },
    version: 2,
  };
  h.observe({ outcome: "NOT_MODIFIED" }, "2026-09-27T10:30:00.000Z");
  assert.equal(h.byKey("r1").classification, "RESERVATION");
  assert.equal(h.byKey("n1").classification, "OWNER_BLOCK");
});

test("LIFE 01: explicit cancellations respect source ordering and wait for the host", () => {
  const h = harness();
  h.observe(
    {
      outcome: "BODY",
      body: cal(vevent("c", "2026-10-14", "2026-10-17", ["SEQUENCE:3"])),
    },
    "2026-09-27T10:00:00.000Z",
  );
  h.observe(
    {
      outcome: "BODY",
      body: cal(
        vevent("c", "2026-10-14", "2026-10-17", [
          "SEQUENCE:2",
          "STATUS:CANCELLED",
        ]),
      ),
    },
    "2026-09-27T10:10:00.000Z",
  );
  assert.equal(
    h.byKey("c").lifecycle,
    "ACTIVE",
    "an older cancellation is ignored",
  );
  assert.ok(h.byKey("c").reviewFlags.includes("STALE_CANCELLATION_IGNORED"));
  h.observe(
    {
      outcome: "BODY",
      body: cal(
        vevent("c", "2026-10-14", "2026-10-17", [
          "SEQUENCE:4",
          "STATUS:CANCELLED",
        ]),
      ),
    },
    "2026-09-27T10:20:00.000Z",
  );
  const cancelled = h.byKey("c");
  assert.equal(cancelled.lifecycle, "AWAITING_DECISION");
  assert.equal(cancelled.decisionReason, "CANCELLATION");
  assert.equal(cancelled.sourceStatus, "CANCELLED");
  const kept = keepBlocked(cancelled, {
    expectedRevision: cancelled.revision,
    nextRevision: 50,
  });
  assert.ok(kept.ok);
  assert.equal(kept.block.lifecycle, "RETAINED_HOLD");
  h.replace(kept.block);
  // A repeated cancellation does not recreate the question.
  const repeat = h.observe(
    {
      outcome: "BODY",
      body: cal(
        vevent("c", "2026-10-14", "2026-10-17", [
          "SEQUENCE:4",
          "STATUS:CANCELLED",
        ]),
      ),
    },
    "2026-09-27T10:40:00.000Z",
  );
  assert.equal(h.byKey("c").lifecycle, "RETAINED_HOLD");
  assert.ok(
    !repeat.compare.decisions.some((d) => d.type === "CANCELLATION_REVIEW"),
  );
});

test("LIFE 02: stays that already ended are not watched for absence", () => {
  const h = harness();
  h.observe(
    {
      outcome: "BODY",
      body: cal(
        vevent("past", "2026-09-20", "2026-09-25"),
        vevent("future", "2026-10-14", "2026-10-17"),
      ),
    },
    "2026-09-27T10:00:00.000Z",
  );
  const plan = h.observe(
    {
      outcome: "BODY",
      body: cal(vevent("future", "2026-10-14", "2026-10-17")),
    },
    "2026-09-27T10:30:00.000Z",
  );
  assert.equal(h.byKey("past").lifecycle, "ACTIVE");
  assert.ok(!plan.compare.decisions.some((d) => d.key === "past"));
});

test("CAL 02: untrusted feeds may widen protection but never shrink it", () => {
  const h = harness();
  h.observe(
    { outcome: "BODY", body: cal(vevent("w", "2026-10-14", "2026-10-17")) },
    "2026-09-27T10:00:00.000Z",
  );
  h.observe(
    {
      outcome: "BODY",
      body: cal(vevent("w", "2026-10-15", "2026-10-16"), broken("x")),
    },
    "2026-09-27T10:10:00.000Z",
  );
  const deferred = h.byKey("w");
  assert.deepEqual(
    [deferred.startDate, deferred.endDate],
    ["2026-10-14", "2026-10-17"],
  );
  assert.ok(deferred.reviewFlags.includes("UPDATE_DEFERRED"));
  assert.equal(deferred.pendingChange?.startDate, "2026-10-15");
  h.observe(
    {
      outcome: "BODY",
      body: cal(vevent("w", "2026-10-13", "2026-10-18"), broken("x")),
    },
    "2026-09-27T10:20:00.000Z",
  );
  assert.deepEqual(
    [h.byKey("w").startDate, h.byKey("w").endDate],
    ["2026-10-13", "2026-10-18"],
  );
});

test("MANUAL 02: a source change under a host override keeps protection and opens review", () => {
  const h = harness();
  h.observe(
    { outcome: "BODY", body: cal(vevent("o", "2026-10-14", "2026-10-17")) },
    "2026-09-27T10:00:00.000Z",
  );
  const b = h.byKey("o");
  const classified = classifyBlock(b, {
    expectedRevision: b.revision,
    classification: "RESERVATION",
    nextRevision: 10,
  });
  assert.ok(classified.ok);
  h.replace(classified.block);
  h.observe(
    { outcome: "BODY", body: cal(vevent("o", "2026-10-15", "2026-10-19")) },
    "2026-09-27T10:30:00.000Z",
  );
  const after = h.byKey("o");
  assert.equal(after.overrideClassification, "RESERVATION");
  assert.ok(after.reviewFlags.includes("OVERRIDE_SOURCE_CHANGED"));
});

test("Released dates that return are protected again and flagged", () => {
  const h = harness();
  h.observe(
    { outcome: "BODY", body: cal(vevent("r", "2026-10-14", "2026-10-17")) },
    "2026-09-27T10:00:00.000Z",
  );
  const r = h.byKey("r");
  const released = releaseBlock(r, {
    expectedRevision: r.revision,
    now: "2026-09-27T10:05:00.000Z",
    nextRevision: 5,
  });
  assert.ok(released.ok);
  h.replace(released.block);
  const plan = h.observe(
    { outcome: "BODY", body: cal(vevent("r", "2026-10-14", "2026-10-18")) },
    "2026-09-27T10:30:00.000Z",
  );
  const back = h.byKey("r");
  assert.equal(back.lifecycle, "ACTIVE");
  assert.ok(back.reviewFlags.includes("CONTRADICTORY_HISTORY"));
  assert.equal(back.endDate, "2026-10-18");
  assert.equal(plan.result, "NEEDS_REVIEW");
});

test("Compare alone never releases: every decision keeps or adds protection", () => {
  const base = harness().observe(
    { outcome: "BODY", body: cal(vevent("k", "2026-10-14", "2026-10-17")) },
    "2026-09-27T10:00:00.000Z",
  );
  const created = base.compare.creates.map(materialize);
  const gate = assessHealth({
    outcome: "BODY",
    complete: true,
    futureKeys: new Set(),
    previousFutureKeys: new Set(["x", "y"]),
    coverageEnd: null,
    previousCoverageEnd: null,
  });
  const result = compare({
    connection: { id: "conn-1", listingId: "listing-1", platform: "AIRBNB" },
    events: [],
    duplicateKeys: [],
    presentInvalidKeys: [],
    contentChanged: true,
    gate,
    policy: UNSET,
    blocks: created,
    knownBlockIds: new Set(),
    today: "2026-09-27",
    now: "2026-09-27T11:00:00.000Z",
    nextRevision: 2,
  });
  assert.ok(result.updates.every((u) => u.lifecycle !== "RELEASED"));
});

test("CONFLICT 01: canonical pairs, severity, updates without re-alert, no reopening", () => {
  const h = harness({
    policy: { mode: "RESERVATIONS", labels: null, version: 1 },
  });
  h.observe(
    {
      outcome: "BODY",
      body: cal(
        vevent("r1", "2026-10-14", "2026-10-17"),
        vevent("r2", "2026-10-16", "2026-10-19"),
      ),
    },
    "2026-09-27T10:00:00.000Z",
  );
  const found = detectConflicts(h.blocks, 1);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "RESERVATION_RESERVATION");
  assert.equal(found[0].severity, "HIGH");
  assert.ok(found[0].blockAId < found[0].blockBId);
  assert.deepEqual(
    [found[0].overlapStart, found[0].overlapEnd],
    ["2026-10-16", "2026-10-17"],
  );
  const open = {
    ...found[0],
    id: "case-1",
    state: "OPEN" as const,
    resolution: null,
    revision: 0,
  };
  assert.deepEqual(reconcileConflicts([open], found), {
    create: [],
    update: [],
    resolve: [],
  });
  const recorded = {
    ...open,
    state: "RESOLVED" as const,
    resolution: "HOST_RECORDED" as const,
  };
  assert.deepEqual(
    reconcileConflicts([recorded], found).create,
    [],
    "a host-recorded resolution is not reopened",
  );
  const widened = [{ ...found[0], overlapEnd: "2026-10-18" }];
  assert.equal(
    reconcileConflicts([recorded], widened).create.length,
    1,
    "changed facts reopen",
  );
  assert.deepEqual(reconcileConflicts([open], []).resolve, [{ id: "case-1" }]);
  // Adjacent stays do not overlap with zero buffers, but do with one.
  const adjacent = harness({
    policy: { mode: "RESERVATIONS", labels: null, version: 1 },
  });
  adjacent.observe(
    {
      outcome: "BODY",
      body: cal(
        vevent("a", "2026-10-14", "2026-10-17"),
        vevent("b", "2026-10-17", "2026-10-19"),
      ),
    },
    "2026-09-27T10:00:00.000Z",
  );
  assert.equal(detectConflicts(adjacent.blocks, 0).length, 0);
  assert.equal(detectConflicts(adjacent.blocks, 1)[0].kind, "BUFFER_ONLY");
});

test("EXPORT 01: exclusion keeps buffers, UIDs are frozen, content digests are stable", () => {
  const h = harness({
    policy: { mode: "RESERVATIONS", labels: null, version: 1 },
  });
  h.observe(
    { outcome: "BODY", body: cal(vevent("own", "2026-10-14", "2026-10-17")) },
    "2026-09-27T10:00:00.000Z",
  );
  const hold = h.add(
    manualHold({
      listingId: "listing-1",
      startDate: "2026-11-01",
      endDate: "2026-11-03",
      holdType: "MAINTENANCE",
      now: "2026-09-27T10:00:00.000Z",
      nextRevision: 2,
      reservation: false,
    }),
  );
  const own = h.byKey("own");
  const toOrigin = buildExportEvents({
    blocks: h.blocks,
    destinationConnectionId: "conn-1",
    defaultBufferDays: 1,
    today: "2026-09-27",
  });
  assert.deepEqual(
    toOrigin.map((e) => e.uid),
    [
      `${own.id}-pre@airbnb-automation`,
      `${own.id}-post@airbnb-automation`,
      `${hold.id}@airbnb-automation`,
    ],
  );
  const toOther = buildExportEvents({
    blocks: h.blocks,
    destinationConnectionId: "conn-2",
    defaultBufferDays: 1,
    today: "2026-09-27",
  });
  assert.ok(toOther.some((e) => e.uid === `${own.id}@airbnb-automation`));
  assert.equal(exportDigest(toOther), exportDigest([...toOther]));
  const body1 = renderExport(toOther, "2026-09-27T10:00:00.000Z");
  const body2 = renderExport(toOther, "2026-09-28T10:00:00.000Z");
  assert.notEqual(body1, body2, "DTSTAMP records the publication time");
  assert.match(body1, /^BEGIN:VCALENDAR\r\n/);
  assert.ok(
    !/Reserved|guest/i.test(body1),
    "privacy-minimal: no labels or guest data",
  );
  // Released blocks leave new versions.
  const released = releaseBlock(hold, {
    expectedRevision: hold.revision,
    now: "2026-09-27T11:00:00.000Z",
    nextRevision: 3,
  });
  assert.ok(released.ok);
  h.replace(released.block);
  const after = buildExportEvents({
    blocks: h.blocks,
    destinationConnectionId: "conn-2",
    defaultBufferDays: 1,
    today: "2026-09-27",
  });
  assert.ok(!after.some((e) => e.uid.startsWith(hold.id)));
  assert.notEqual(exportDigest(after), exportDigest(toOther));
});

test("FETCH 02/03: intervals, jitter bounds and Retry-After are honored, never truncated", () => {
  const now = Date.parse("2026-09-27T10:00:00Z");
  const normal = nextFetch({
    nowMs: now,
    succeeded: true,
    failures: 0,
    nearTerm: false,
    retryAfterMs: null,
    random: 0.5,
  });
  assert.equal(normal.atMs - now, 15 * 60_000);
  const near = nextFetch({
    nowMs: now,
    succeeded: true,
    failures: 0,
    nearTerm: true,
    retryAfterMs: null,
    random: 0,
  });
  assert.equal(near.atMs - now, 4.5 * 60_000);
  const wait = parseRetryAfter("7200", now)!;
  const delayed = nextFetch({
    nowMs: now,
    succeeded: false,
    failures: 1,
    nearTerm: true,
    retryAfterMs: wait,
    random: 0.5,
  });
  assert.equal(delayed.atMs, wait);
  assert.equal(delayed.pausedBySource, false);
  const long = nextFetch({
    nowMs: now,
    succeeded: false,
    failures: 1,
    nearTerm: false,
    retryAfterMs: now + 8 * 3_600_000,
    random: 0.5,
  });
  assert.equal(long.pausedBySource, true);
  assert.equal(
    parseRetryAfter("Sun, 27 Sep 2026 12:00:00 GMT", now),
    Date.parse("2026-09-27T12:00:00Z"),
  );
  assert.equal(parseRetryAfter("soon", now), null);
  const refresh = manualRefreshEligibility(
    {
      enabled: true,
      importing: true,
      leaseUntil: null,
      lastAttemptAt: "2026-09-27T09:59:30.000Z",
      sourceRetryAfter: null,
    },
    now,
  );
  assert.equal(refresh.status, "UNAVAILABLE");
  assert.equal(
    manualRefreshEligibility(
      {
        enabled: true,
        importing: true,
        leaseUntil: "2026-09-27T10:00:30.000Z",
        lastAttemptAt: null,
        sourceRetryAfter: null,
      },
      now,
    ).status,
    "IN_FLIGHT",
  );
  assert.equal(
    manualRefreshEligibility(
      {
        enabled: true,
        importing: true,
        leaseUntil: null,
        lastAttemptAt: null,
        sourceRetryAfter: null,
      },
      now,
    ).status,
    "QUEUED",
  );
  const h = harness();
  h.observe(
    { outcome: "BODY", body: cal(vevent("soon", "2026-09-28", "2026-09-30")) },
    "2026-09-27T10:00:00.000Z",
  );
  assert.equal(isNearTerm(h.blocks, "2026-09-27"), true);
  assert.equal(isNearTerm(h.blocks, "2026-08-01"), false);
});
