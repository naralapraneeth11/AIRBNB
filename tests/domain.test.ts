import assert from "node:assert/strict";
import test from "node:test";
import {
  canTransition,
  checkoutInstant,
  dayAdd,
  freshness,
  intentOf,
  isSensitive,
  overlaps,
  parseCommand,
} from "../src/lib/domain";

const date = (day: string) => new Date(`${day}T00:00:00Z`);
const stay = (start: string, end: string) => ({
  startDate: date(start),
  endDate: date(end),
});

test("cleaner must follow assigned workflow and cannot verify or skip steps", () => {
  assert.equal(canTransition("ASSIGNED", "ACCEPTED", "CLEANER"), true);
  assert.equal(canTransition("ASSIGNED", "NEEDS_SCHEDULING", "CLEANER"), true);
  assert.equal(canTransition("ACCEPTED", "IN_PROGRESS", "CLEANER"), true);
  assert.equal(canTransition("IN_PROGRESS", "DONE", "CLEANER"), true);
  assert.equal(canTransition("ASSIGNED", "DONE", "CLEANER", true), false);
  assert.equal(canTransition("DONE", "VERIFIED", "CLEANER", true), false);
  assert.equal(canTransition("NEEDS_SCHEDULING", "ASSIGNED", "CLEANER"), false);
});

test("host verification requires completed work and photo; verified work can be reopened", () => {
  for (const role of ["HOST", "COHOST"] as const) {
    assert.equal(canTransition("DONE", "VERIFIED", role, false), false);
    assert.equal(canTransition("IN_PROGRESS", "VERIFIED", role, true), false);
    assert.equal(canTransition("DONE", "VERIFIED", role, true), true);
    assert.equal(canTransition("VERIFIED", "DONE", role, true), true);
  }
  assert.equal(canTransition("DONE", "VERIFIED", "SYSTEM", true), false);
});

test("reservation bounds are exclusive and buffer conflicts are symmetric", () => {
  const first = stay("2026-09-20", "2026-09-22");
  const sameDayArrival = stay("2026-09-22", "2026-09-24");
  const afterBuffer = stay("2026-09-23", "2026-09-24");
  assert.equal(overlaps(first, sameDayArrival), false);
  assert.equal(overlaps(first, sameDayArrival, 1), true);
  assert.equal(overlaps(sameDayArrival, first, 1), true);
  assert.equal(overlaps(first, afterBuffer, 1), false);
  assert.equal(overlaps(first, stay("2026-09-21", "2026-09-23")), true);
  assert.equal(
    dayAdd("2028-02-28", 2).toISOString(),
    "2028-03-01T00:00:00.000Z",
  );
});

test("local checkout follows DST and fractional timezone offsets", () => {
  assert.equal(
    checkoutInstant(
      date("2026-03-07"),
      11,
      "America/Los_Angeles",
    ).toISOString(),
    "2026-03-07T19:00:00.000Z",
  );
  assert.equal(
    checkoutInstant(
      date("2026-03-08"),
      11,
      "America/Los_Angeles",
    ).toISOString(),
    "2026-03-08T18:00:00.000Z",
  );
  assert.equal(
    checkoutInstant(
      date("2026-11-01"),
      11,
      "America/Los_Angeles",
    ).toISOString(),
    "2026-11-01T19:00:00.000Z",
  );
  assert.equal(
    checkoutInstant(date("2026-09-22"), 11, "Asia/Kolkata").toISOString(),
    "2026-09-22T05:30:00.000Z",
  );
});

test("safety, refund, cancellation and legal requests require human intent", () => {
  for (const body of [
    "Please refund the charge",
    "Can I cancel?",
    "There is a gas leak",
    "I was injured",
    "My lawyer will call",
    "Quiero un reembolso",
    "需要退款",
  ]) {
    assert.equal(isSensitive(body), true, body);
    assert.equal(intentOf(body), "COMPLAINT", body);
  }
  assert.equal(isSensitive("What is the WiFi password?"), false);
  assert.equal(intentOf("What is the parking code?"), "QUESTION");
  assert.equal(intentOf("Can you offer a discount?"), "NEGOTIATION");
  assert.equal(intentOf("Can we extend our stay?"), "BOOKING_ADJACENT");
});

test("calendar health communicates missing, failed and stale syncs", () => {
  const now = Date.parse("2026-09-22T12:00:00Z");
  assert.equal(freshness("OK", null, now), "error");
  assert.equal(freshness("ERROR", new Date(now), now), "error");
  assert.equal(freshness("OK", new Date(now - 60_000), now), "fresh");
  assert.equal(freshness("OK", new Date(now - 30 * 60_000), now), "polling");
  assert.equal(freshness("OK", new Date(now - 90 * 60_000), now), "delayed");
  assert.equal(freshness("OK", new Date(now - 241 * 60_000), now), "error");
});

test("commands preserve reviewable dates and reject rollover or reversed date ranges", () => {
  const listings = [{ id: "listing-a", name: "Lake House" }];
  const now = date("2026-09-22");
  assert.deepEqual(
    parseCommand("Block Lake House December 24–26, 2026", listings, now),
    {
      intent: "BLOCK",
      listingId: "listing-a",
      from: "2026-12-24",
      to: "2026-12-27",
    },
  );
  assert.deepEqual(
    parseCommand("Block Lake House 2026-12-24 to 2026-12-27", listings, now),
    {
      intent: "BLOCK",
      listingId: "listing-a",
      from: "2026-12-24",
      to: "2026-12-27",
    },
  );
  for (const request of [
    "Block Lake House February 30–31, 2027",
    "Block Lake House March 9–2, 2027",
    "Block Lake House 2027-02-30 to 2027-03-04",
    "Block Lake House 2027-03-04 to 2027-03-04",
    "Block Lake House 2027-03-09 to 2027-03-04",
  ]) {
    assert.deepEqual(
      parseCommand(request, listings, now),
      { intent: "UNKNOWN" },
      request,
    );
  }
  assert.deepEqual(parseCommand("open cleaning", listings, now), {
    intent: "NAVIGATE",
    page: "cleaning",
  });
  assert.deepEqual(parseCommand("unread Airbnb messages", listings, now), {
    intent: "INBOX",
    platform: "AIRBNB",
    status: "NEEDS_REPLY",
  });
});
