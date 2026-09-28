// QA 01: property-based tests over randomized observation histories. Every
// history mixes complete, partial, truncated, empty, cancelled, unchanged
// (304) and failed checks at random intervals, and after every step:
//   - protection: no observation releases or deletes a block, untrusted
//     observations never shrink protected nights, and a trusted one shrinks
//     them only where the source shows new dates for the same identity;
//   - identity: one block per source identity, and its id never changes;
//   - revisions: each committed change moves the property revision by
//     exactly one, and each changed block by exactly one;
//   - CAL 04: repeating the same observation right away changes nothing.
// Tenant boundaries across randomized histories are exercised against real
// PostgreSQL in tests/integration.
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { addDays } from "../src/domain/calendar/dates";
import { buildExportEvents, exportDigest } from "../src/domain/calendar/export";
import { bufferOf, detectConflicts } from "../src/domain/calendar/conflicts";
import { OWN_UID_SUFFIX } from "../src/domain/calendar/normalize";
import { isProtective, type BlockState } from "../src/domain/calendar/types";
import { broken, cal, harness, vevent } from "./helpers/calendar-harness";

const BASE = "2026-10-05";
const KEYS = ["a", "b", "c", "d", "e", "f"] as const;
const RUNS = Number(process.env.PROPERTY_RUNS) || 150;

type Ev = {
  key: string;
  start: number;
  nights: number;
  cancelled: boolean;
  sequence: number;
};
type Obs =
  | { kind: "BODY"; events: Ev[]; broken: boolean; truncated: boolean }
  | { kind: "NOT_MODIFIED" }
  | { kind: "FAILED" };

const eventArb: fc.Arbitrary<Ev> = fc.record({
  key: fc.constantFrom(...KEYS),
  start: fc.integer({ min: 0, max: 120 }),
  nights: fc.integer({ min: 1, max: 9 }),
  cancelled: fc.integer({ min: 0, max: 7 }).map((n) => n === 0),
  sequence: fc.integer({ min: 0, max: 3 }),
});
const observationArb: fc.Arbitrary<Obs> = fc.oneof(
  {
    weight: 7,
    arbitrary: fc.record({
      kind: fc.constant("BODY" as const),
      events: fc.uniqueArray(eventArb, {
        selector: (e) => e.key,
        maxLength: KEYS.length,
      }),
      broken: fc.integer({ min: 0, max: 5 }).map((n) => n === 0),
      truncated: fc.integer({ min: 0, max: 7 }).map((n) => n === 0),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "NOT_MODIFIED" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "FAILED" as const }) },
);
const historyArb = fc.array(
  fc.record({ gap: fc.integer({ min: 1, max: 240 }), obs: observationArb }),
  { minLength: 1, maxLength: 14 },
);

const range = (e: Ev) => ({
  startDate: addDays(BASE, e.start),
  endDate: addDays(BASE, e.start + e.nights),
});
function render(o: Extract<Obs, { kind: "BODY" }>) {
  const body = cal(
    ...o.events.map((e) =>
      vevent(e.key, range(e).startDate, range(e).endDate, [
        `SEQUENCE:${e.sequence}`,
        ...(e.cancelled ? ["STATUS:CANCELLED"] : []),
      ]),
    ),
    ...(o.broken ? [broken("junk")] : []),
  );
  return o.truncated ? body.slice(0, Math.floor(body.length * 0.8)) : body;
}
const fetchOf = (o: Obs) =>
  o.kind === "BODY"
    ? { outcome: "BODY" as const, body: render(o) }
    : o.kind === "NOT_MODIFIED"
      ? { outcome: "NOT_MODIFIED" as const }
      : { outcome: "FAILED" as const, code: "FETCH_TIMEOUT" as const };

const nightsOf = (b: Pick<BlockState, "startDate" | "endDate">) => {
  const out: string[] = [];
  for (let d = b.startDate; d < b.endDate; d = addDays(d, 1)) out.push(d);
  return out;
};

test("randomized histories keep protection, identity and revisions sound", () => {
  fc.assert(
    fc.property(historyArb, (history) => {
      const h = harness({ platform: "OTHER" });
      const idByKey = new Map<string, string>();
      let at = Date.parse("2026-10-01T00:00:00.000Z");
      for (const { gap, obs } of history) {
        at += gap * 60_000;
        const before = h.blocks.map((b) => ({ ...b }));
        const revisionBefore = h.revision;
        const plan = h.observe(fetchOf(obs), new Date(at).toISOString());
        const changed =
          plan.compare.creates.length + plan.compare.updates.length > 0;

        // Revisions (CAL 03 / EXPORT 04).
        assert.equal(h.revision, revisionBefore + (changed ? 1 : 0));
        for (const u of plan.compare.updates) {
          const prev = before.find((b) => b.id === u.id)!;
          assert.equal(u.revision, prev.revision + 1);
          assert.equal(u.committedRevision, h.revision);
        }

        // Protection: nothing released or deleted by an observation.
        for (const prev of before) {
          const next = h.blocks.find((b) => b.id === prev.id);
          assert.ok(next, "blocks are never deleted");
          if (isProtective(prev)) assert.ok(isProtective(next));
          const kept = new Set(nightsOf(next));
          const lost = nightsOf(prev).filter((n) => !kept.has(n));
          if (!lost.length || !isProtective(prev)) continue;
          // Only a trusted body showing new dates for this identity may
          // shrink protection (a date change at the source).
          assert.equal(
            plan.gate.updates,
            "ALL",
            "untrusted checks never shrink",
          );
          assert.equal(obs.kind, "BODY");
          const source =
            obs.kind === "BODY"
              ? obs.events.find((e) => e.key === prev.sourceKey)
              : undefined;
          assert.ok(source, "the identity is present with new dates");
          assert.deepEqual(
            [next.startDate, next.endDate],
            [range(source).startDate, range(source).endDate],
          );
        }

        // Identity (ID 01, DATA 02): one block per key; ids never change.
        const keys = h.blocks.map((b) => b.sourceKey);
        assert.equal(new Set(keys).size, keys.length);
        for (const b of h.blocks) {
          const first = idByKey.get(b.sourceKey!);
          if (first) assert.equal(first, b.id);
          else idByKey.set(b.sourceKey!, b.id);
        }

        // CAL 04: the same observation again changes nothing...
        const same = h.observe(fetchOf(obs), new Date(at).toISOString());
        assert.equal(
          same.compare.creates.length + same.compare.updates.length,
          0,
          "a repeated observation is a no-op",
        );
        // ...and moments later only the time-based review deadline may move:
        // "an unchanged feed cannot freeze a missing event forever".
        const settled = h.blocks.map((b) => ({ ...b }));
        const later = h.observe(
          fetchOf(obs),
          new Date(at + 60_000).toISOString(),
        );
        assert.equal(later.compare.creates.length, 0);
        for (const u of later.compare.updates) {
          const prev = settled.find((b) => b.id === u.id)!;
          assert.equal(prev.lifecycle, "MISSING_OBSERVED");
          assert.equal(u.lifecycle, "AWAITING_DECISION");
          assert.equal(u.decisionReason, "ABSENCE");
        }
        at += 60_000;
      }
    }),
    { numRuns: RUNS },
  );
});

const blockArb = (i: number): fc.Arbitrary<BlockState> =>
  fc
    .record({
      start: fc.integer({ min: 0, max: 60 }),
      nights: fc.integer({ min: 1, max: 8 }),
      connection: fc.constantFrom("conn-1", "conn-2", null),
      classification: fc.constantFrom(
        "RESERVATION",
        "OWNER_BLOCK",
        "UNKNOWN",
        "CONFIRMED_ECHO",
      ),
      lifecycle: fc.constantFrom(
        "ACTIVE",
        "MISSING_OBSERVED",
        "AWAITING_DECISION",
        "RETAINED_HOLD",
        "RELEASED",
      ),
      before: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }),
      after: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }),
    })
    .map(
      (r) =>
        ({
          id: `block-${String(i).padStart(2, "0")}`,
          listingId: "listing-1",
          connectionId: r.connection,
          sourceKey: r.connection ? `uid-${i}` : null,
          identityKind: r.connection ? "UID" : "MANUAL",
          startDate: addDays(BASE, r.start),
          endDate: addDays(BASE, r.start + r.nights),
          classification: r.connection
            ? r.classification
            : r.classification === "RESERVATION"
              ? "RESERVATION"
              : "MANUAL",
          classificationEvidence: { rule: "NO_EVIDENCE", rulesVersion: "test" },
          holdType: r.connection ? null : "OWNER",
          lifecycle: r.lifecycle,
          decisionReason:
            r.lifecycle === "AWAITING_DECISION" ? "ABSENCE" : null,
          sourceStatus: "CONFIRMED",
          sourceSequence: null,
          sourceStamp: null,
          sourceLabelKey: null,
          contentDigest: null,
          sourceRevision: 0,
          firstSeenAt: null,
          lastSeenAt: null,
          missingSince:
            r.lifecycle === "MISSING_OBSERVED"
              ? "2026-10-01T00:00:00.000Z"
              : null,
          missingObservations: 0,
          lastMissingObservationAt: null,
          bufferBeforeDays: r.before,
          bufferAfterDays: r.after,
          overrideClassification: null,
          overrideBasedOnRevision: null,
          reviewFlags: [],
          pendingChange: null,
          compensatesBlockId: null,
          releasedAt:
            r.lifecycle === "RELEASED" ? "2026-10-01T00:00:00.000Z" : null,
          revision: 0,
          committedRevision: 1,
        }) as BlockState,
    );

const blocksArb = fc
  .integer({ min: 0, max: 12 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => blockArb(i))));

test("EXPORT 01: exports hold protection, never the destination's own stays, and are order-independent", () => {
  fc.assert(
    fc.property(blocksArb, fc.integer({ min: 0, max: 3 }), (blocks, buffer) => {
      const events = buildExportEvents({
        blocks,
        destinationConnectionId: "conn-1",
        defaultBufferDays: buffer,
        today: BASE,
      });
      const uids = new Set(events.map((e) => e.uid));
      assert.equal(uids.size, events.length, "UIDs are unique");
      for (const b of blocks) {
        const base = `${b.id}${OWN_UID_SUFFIX}`;
        const exported =
          isProtective(b) && b.classification !== "CONFIRMED_ECHO";
        assert.equal(
          uids.has(base),
          exported && b.connectionId !== "conn-1",
          `base event for ${b.id}`,
        );
        const buf = bufferOf(b, buffer);
        assert.equal(
          uids.has(`${b.id}-post${OWN_UID_SUFFIX}`),
          exported && buf.after > 0,
          "buffers survive exclusion of the destination's own stays",
        );
      }
      const shuffled = [...blocks].reverse();
      assert.equal(
        exportDigest(
          buildExportEvents({
            blocks: shuffled,
            destinationConnectionId: "conn-1",
            defaultBufferDays: buffer,
            today: BASE,
          }),
        ),
        exportDigest(events),
      );
    }),
    { numRuns: RUNS },
  );
});

test("CONFLICT 01: conflict pairs are canonical, unique and cover real overlaps", () => {
  fc.assert(
    fc.property(blocksArb, fc.integer({ min: 0, max: 3 }), (blocks, buffer) => {
      const found = detectConflicts(blocks, buffer);
      const pairs = found.map((c) => `${c.blockAId}|${c.blockBId}`);
      assert.equal(new Set(pairs).size, pairs.length, "one case per pair");
      for (const c of found) {
        assert.ok(c.blockAId < c.blockBId, "canonical order");
        assert.ok(c.overlapStart < c.overlapEnd);
        const a = blocks.find((b) => b.id === c.blockAId)!;
        const b = blocks.find((x) => x.id === c.blockBId)!;
        assert.ok(isProtective(a) && isProtective(b));
      }
      // Every pair sharing a night is found unless both are closures, which
      // block dates but cannot double-book a guest.
      const closure = (b: BlockState) =>
        b.classification === "OWNER_BLOCK" || b.classification === "MANUAL";
      const live = blocks.filter(
        (b) => isProtective(b) && b.classification !== "CONFIRMED_ECHO",
      );
      for (const a of live)
        for (const b of live)
          if (
            a.id < b.id &&
            !(closure(a) && closure(b)) &&
            a.startDate < b.endDate &&
            b.startDate < a.endDate
          )
            assert.ok(pairs.includes(`${a.id}|${b.id}`), `${a.id} × ${b.id}`);
    }),
    { numRuns: RUNS },
  );
});
