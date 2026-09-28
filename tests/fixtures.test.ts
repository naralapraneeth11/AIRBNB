// QA 01: every fixture in tests/fixtures runs through the calendar pipeline
// with a supplied clock, and its outcome is asserted. Platform fixtures are
// synthetic until anonymized real exports replace them (see the fixtures
// README); synthetic cases cover DST, leap days, duplicate UIDs, recurrence
// exceptions, malformed and truncated input, horizon changes, cancellations,
// output loops, empty feeds and non-calendar responses.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseCalendar } from "../src/domain/calendar/parse";
import { normalizeCalendar } from "../src/domain/calendar/normalize";
import { manualHold } from "../src/domain/calendar/lifecycle";
import type { ConnectionPolicy } from "../src/domain/calendar/types";
import { harness } from "./helpers/calendar-harness";

const ROOT = path.join(process.cwd(), "tests/fixtures");
const fixture = (name: string) => readFileSync(path.join(ROOT, name), "utf8");
const body = (name: string) => ({
  outcome: "BODY" as const,
  body: fixture(name),
});
const policy = (
  mode: ConnectionPolicy["mode"],
  labels: ConnectionPolicy["labels"] = null,
): ConnectionPolicy => ({ mode, labels, version: 1 });
const AT = "2026-10-01T10:00:00.000Z";
const later = (minutes: number) =>
  new Date(Date.parse(AT) + minutes * 60_000).toISOString();

test("the fixtures README lists every fixture file, and every listed file exists", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (!entry.endsWith(".md"))
        files.push(path.relative(ROOT, full).replaceAll(path.sep, "/"));
    }
  };
  walk(ROOT);
  const readme = fixture("README.md");
  const listed = [...readme.matchAll(/`([\w./-]+\.(?:ics|html))`/g)].map(
    (m) => m[1],
  );
  assert.deepEqual([...new Set(listed)].sort(), files.sort());
});

test("Airbnb: unverified labels only suggest until the host answers (CLASS 01/02)", () => {
  const unset = harness({ platform: "AIRBNB" });
  const plan = unset.observe(body("platforms/airbnb.ics"), AT);
  assert.equal(plan.gate.health, "HEALTHY");
  assert.equal(plan.policyQuestion, true);
  assert.equal(plan.result, "NEEDS_REVIEW");
  assert.deepEqual(
    unset.blocks.map((b) => [
      b.startDate,
      b.endDate,
      b.classification,
      b.classificationEvidence.suggested,
    ]),
    [
      ["2026-10-10", "2026-10-13", "UNKNOWN", "RESERVATION"],
      ["2026-10-16", "2026-10-18", "UNKNOWN", "OWNER_BLOCK"],
      ["2026-10-20", "2026-10-24", "UNKNOWN", "RESERVATION"],
    ],
  );
  const answered = harness({
    platform: "AIRBNB",
    policy: policy("BY_LABEL", {
      reserved: "RESERVATION",
      "not-available": "OWNER_BLOCK",
    }),
  });
  const next = answered.observe(body("platforms/airbnb.ics"), AT);
  assert.equal(next.policyQuestion, false);
  assert.equal(next.result, "UPDATED");
  assert.deepEqual(
    answered.blocks.map((b) => [
      b.classification,
      b.classificationEvidence.rule,
    ]),
    [
      ["RESERVATION", "CONNECTION_POLICY"],
      ["OWNER_BLOCK", "CONNECTION_POLICY"],
      ["RESERVATION", "CONNECTION_POLICY"],
    ],
  );
  // The reservation description is never stored: only the label key.
  assert.ok(
    unset.blocks.every(
      (b) =>
        b.sourceLabelKey === "reserved" || b.sourceLabelKey === "not-available",
    ),
  );
});

test("Vrbo and Booking.com: one answer per connection classifies every block", () => {
  const booking = harness({ platform: "BOOKING" });
  const asked = booking.observe(body("platforms/booking.ics"), AT);
  assert.equal(asked.policyQuestion, true);
  assert.ok(booking.blocks.every((b) => b.classification === "UNKNOWN"));
  const closures = harness({
    platform: "BOOKING",
    policy: policy("OWNER_BLOCKS"),
  });
  closures.observe(body("platforms/booking.ics"), AT);
  assert.ok(closures.blocks.every((b) => b.classification === "OWNER_BLOCK"));
  const vrbo = harness({ platform: "VRBO", policy: policy("RESERVATIONS") });
  vrbo.observe(body("platforms/vrbo.ics"), AT);
  assert.deepEqual(
    vrbo.blocks.map((b) => [b.startDate, b.endDate, b.classification]),
    [
      ["2026-11-05", "2026-11-08", "RESERVATION"],
      ["2026-11-12", "2026-11-14", "RESERVATION"],
    ],
  );
});

test("Google: zoned times map to property nights and weekly exceptions hold", () => {
  const h = harness({ platform: "GOOGLE", zone: "America/Los_Angeles" });
  h.observe(body("platforms/google.ics"), AT);
  assert.deepEqual(
    h.blocks.map((b) => [b.sourceKey, b.startDate, b.endDate]),
    [
      ["fixture-google-0001@google.com", "2026-10-15", "2026-10-18"],
      ["fixture-google-0002@google.com", "2026-11-01", "2026-11-03"],
      ["fixture-google-0003@google.com#2026-11-06", "2026-11-06", "2026-11-07"],
      // 2026-11-13 is excluded by EXDATE.
      ["fixture-google-0003@google.com#2026-11-20", "2026-11-20", "2026-11-21"],
    ],
  );
});

test("DST: ambiguous and skipped wall times go to review; late arrivals keep their night", () => {
  const h = harness({ platform: "OTHER", zone: "America/Los_Angeles" });
  const plan = h.observe(body("synthetic/dst.ics"), AT);
  const byKey = new Map(h.blocks.map((b) => [b.sourceKey, b]));
  assert.ok(plan.reasons.includes("AMBIGUOUS_TIME"));
  assert.deepEqual(byKey.get("dst-fall-back-ambiguous")!.reviewFlags, [
    "AMBIGUOUS_TIME",
  ]);
  assert.deepEqual(byKey.get("dst-spring-forward-gap")!.reviewFlags, [
    "AMBIGUOUS_TIME",
  ]);
  // 06:00Z is 22:00 on the 30th in Los Angeles: that night, not the next.
  const late = byKey.get("utc-late-evening-arrival")!;
  assert.deepEqual(
    [late.startDate, late.endDate],
    ["2026-11-30", "2026-12-03"],
  );
  const allDay = byKey.get("all-day-across-fall-back")!;
  assert.deepEqual(
    [allDay.startDate, allDay.endDate],
    ["2026-10-31", "2026-11-02"],
  );
});

test("leap day: exclusive ends and the one-day default across February 29", () => {
  const parsed = parseCalendar(fixture("synthetic/leap-day.ics"));
  assert.equal(parsed.kind, "CALENDAR");
  if (parsed.kind !== "CALENDAR") return;
  const n = normalizeCalendar(parsed, {
    platform: "OTHER",
    zone: "UTC",
    checkoutHour: 11,
    today: "2028-02-01",
  });
  assert.deepEqual(
    n.events.map((e) => [e.key, e.startDate, e.endDate]),
    [
      ["leap-across", "2028-02-28", "2028-03-01"],
      ["leap-arrival", "2028-02-29", "2028-03-02"],
      ["leap-one-day-default", "2028-02-29", "2028-03-01"],
    ],
  );
});

test("duplicate UIDs: identical copies merge, disagreeing copies are all protected for review", () => {
  const h = harness({ platform: "OTHER" });
  const plan = h.observe(body("synthetic/duplicate-uid.ics"), AT);
  assert.ok(plan.reasons.includes("DUPLICATE_UID_CONFLICT"));
  const variants = h.blocks.filter(
    (b) => b.identityKind === "DUPLICATE_VARIANT",
  );
  assert.equal(variants.length, 2);
  assert.ok(
    variants.every(
      (b) =>
        b.classification === "UNKNOWN" &&
        b.lifecycle === "ACTIVE" &&
        b.reviewFlags.includes("DUPLICATE_UID"),
    ),
  );
  assert.equal(
    h.blocks.filter((b) => b.sourceKey === "dup-identical").length,
    1,
  );
});

test("recurrence: EXDATE removes, an override keeps its identity, a cancelled instance is not protected", () => {
  const h = harness({ platform: "OTHER" });
  const plan = h.observe(body("synthetic/recurrence.ics"), AT);
  assert.deepEqual(
    h.blocks.map((b) => [b.sourceKey, b.startDate, b.endDate]),
    [
      ["weekly-stay#2026-10-05", "2026-10-05", "2026-10-07"],
      ["weekly-stay#2026-10-19", "2026-10-20", "2026-10-22"],
    ],
  );
  assert.ok(
    plan.compare.decisions.some(
      (d) =>
        d.type === "CANCELLED_UNKNOWN_IGNORED" &&
        d.key === "weekly-stay#2026-10-26",
    ),
  );
});

test("malformed and truncated feeds add what is readable and release nothing", () => {
  for (const name of ["synthetic/malformed.ics", "synthetic/truncated.ics"]) {
    const h = harness({ platform: "OTHER" });
    h.observe(body("platforms/vrbo.ics"), AT);
    const plan = h.observe(body(name), later(30));
    assert.equal(plan.gate.health, "PARTIAL", name);
    assert.equal(plan.gate.absenceReview, false, name);
    assert.equal(plan.result, "NEEDS_REVIEW", name);
    assert.ok(
      h.blocks.every((b) => b.lifecycle === "ACTIVE"),
      `${name}: every earlier stay stays protected`,
    );
  }
});

test("empty and non-calendar responses never remove protection (section 10)", () => {
  const h = harness({ platform: "OTHER" });
  h.observe(body("platforms/vrbo.ics"), AT);
  const empty = h.observe(body("synthetic/empty.ics"), later(30));
  assert.equal(empty.gate.health, "EMPTY_ANOMALY");
  assert.ok(empty.reasons.includes("EMPTY_FEED_ANOMALY"));
  const html = h.observe(body("synthetic/not-calendar.html"), later(60));
  assert.equal(html.gate.health, "FAILED");
  assert.equal(html.result, "COULD_NOT_CHECK");
  assert.equal(html.accepted, false);
  assert.ok(h.blocks.every((b) => b.lifecycle === "ACTIVE"));
});

test("horizon: a shorter calendar is never read as cancellation (DATE 02)", () => {
  const h = harness({ platform: "OTHER" });
  h.observe(body("synthetic/horizon/long.ics"), AT);
  const plan = h.observe(body("synthetic/horizon/short.ics"), later(30));
  const far = h.blocks.find((b) => b.sourceKey === "far-stay")!;
  assert.equal(far.lifecycle, "ACTIVE");
  assert.ok(far.reviewFlags.includes("BEYOND_COVERAGE"));
  assert.ok(plan.reasons.includes("COVERAGE_SHRANK"));
  // Repeated checks change nothing (CAL 04).
  const again = h.observe(body("synthetic/horizon/short.ics"), later(60));
  assert.equal(again.compare.creates.length + again.compare.updates.length, 0);
});

test("cancellations follow source ordering and wait for the host (LIFE 01)", () => {
  const h = harness({ platform: "OTHER" });
  h.observe(body("synthetic/cancellation/confirmed.ics"), AT);
  h.observe(body("synthetic/cancellation/stale.ics"), later(30));
  const stay = () => h.blocks.find((b) => b.sourceKey === "cancel-me")!;
  assert.equal(stay().lifecycle, "ACTIVE");
  assert.ok(stay().reviewFlags.includes("STALE_CANCELLATION_IGNORED"));
  h.observe(body("synthetic/cancellation/cancelled.ics"), later(60));
  assert.equal(stay().lifecycle, "AWAITING_DECISION");
  assert.equal(stay().decisionReason, "CANCELLATION");
});

test("output loops: this property's own export is excluded; an unknown export UID stays protected", () => {
  const known = harness({ platform: "AIRBNB" });
  const hold = known.add(
    manualHold({
      listingId: "listing-1",
      startDate: "2026-11-05",
      endDate: "2026-11-08",
      holdType: "OWNER",
      now: AT,
      nextRevision: 1,
      reservation: false,
    }),
  );
  const echo = fixture("synthetic/output-loop.ics").replaceAll(
    "11111111-1111-4111-8111-111111111111",
    hold.id,
  );
  const plan = known.observe({ outcome: "BODY", body: echo }, AT);
  assert.equal(
    plan.compare.decisions.filter((d) => d.type === "ECHO_EXCLUDED").length,
    2,
  );
  assert.deepEqual(
    known.blocks.map((b) => b.sourceKey),
    [null, "genuine-stay@airbnb.com"],
  );

  const foreign = harness({ platform: "AIRBNB" });
  foreign.observe(body("synthetic/output-loop.ics"), AT);
  const suspects = foreign.blocks.filter((b) =>
    b.reviewFlags.includes("FOREIGN_ECHO_UID"),
  );
  assert.equal(suspects.length, 2);
  assert.ok(
    suspects.every(
      (b) => b.classification === "UNKNOWN" && b.lifecycle === "ACTIVE",
    ),
  );
});
