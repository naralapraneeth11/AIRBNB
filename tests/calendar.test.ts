// The original iCal import guarantees, restated against the Phase 1 parser and
// normalizer: exclusive checkout, recognised export echoes, preserved
// cancellations, unreadable input that cannot release anything, and recurrence
// exceptions that replace their occurrence instead of duplicating it.
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCalendar,
  type ParsedCalendar,
} from "../src/domain/calendar/parse";
import { normalizeCalendar } from "../src/domain/calendar/normalize";

const calendar = (...events: string[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Isolated tests//EN",
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");
const event = (uid: string, extra = "") =>
  [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTART;VALUE=DATE:20260922",
    "DTEND;VALUE=DATE:20260924",
    "DTSTAMP:20260901T120000Z",
    extra,
    "END:VEVENT",
  ]
    .filter(Boolean)
    .join("\r\n");

const parsed = (body: string): ParsedCalendar => {
  const result = parseCalendar(body);
  assert.equal(result.kind, "CALENDAR");
  return result as ParsedCalendar;
};
const normalize = (body: string, today = "2026-09-01") =>
  normalizeCalendar(parsed(body), {
    platform: "AIRBNB",
    zone: "UTC",
    checkoutHour: 11,
    today,
  });

test("iCal import keeps exclusive checkout, preserves cancellations and recognises its own export", () => {
  const result = normalize(
    calendar(
      event("external-one"),
      event("own-one@airbnb-automation"),
      event("cancelled-one", "STATUS:CANCELLED"),
    ),
  );
  assert.equal(result.complete, true);
  const byUid = new Map(result.events.map((e) => [e.uid, e]));
  const external = byUid.get("external-one")!;
  assert.equal(external.startDate, "2026-09-22");
  assert.equal(external.endDate, "2026-09-24");
  assert.equal(external.status, "CONFIRMED");
  assert.equal(external.echo, null);
  assert.equal(external.stamp, "2026-09-01T12:00:00.000Z");
  assert.deepEqual(byUid.get("own-one@airbnb-automation")!.echo, {
    blockId: "own-one",
    part: "base",
  });
  assert.equal(result.counts.echoes, 1);
  assert.equal(byUid.get("cancelled-one")!.status, "CANCELLED");
  assert.equal(result.counts.cancelled, 1);
});

test("unreadable feeds, empty ranges and missing UIDs can never release protection", () => {
  assert.equal(
    parseCalendar("<html>Provider error</html>").kind,
    "NOT_CALENDAR",
  );

  const empty = normalize(
    calendar(
      event("bad-range").replace(
        "DTEND;VALUE=DATE:20260924",
        "DTEND;VALUE=DATE:20260922",
      ),
    ),
  );
  assert.equal(empty.events.length, 0);
  assert.equal(empty.complete, false);
  assert.deepEqual(empty.presentInvalidKeys, ["bad-range"]);

  const anonymous = normalize(
    calendar(event("missing-uid").replace("UID:missing-uid\r\n", "")),
  );
  assert.equal(anonymous.events.length, 1);
  assert.equal(anonymous.events[0].identityKind, "SURROGATE");
  assert.equal(anonymous.events[0].uid, null);
  assert.ok(anonymous.flags.includes("MISSING_UID"));
});

test("recurrence exceptions replace their occurrence without creating a duplicate stay", () => {
  const first = [
    "BEGIN:VEVENT",
    "UID:recurring",
    "DTSTART;VALUE=DATE:20260903",
    "DTEND;VALUE=DATE:20260904",
    "RRULE:FREQ=DAILY;COUNT=3",
    "END:VEVENT",
  ].join("\r\n");
  const cancelled = [
    "BEGIN:VEVENT",
    "UID:recurring",
    "RECURRENCE-ID;VALUE=DATE:20260904",
    "DTSTART;VALUE=DATE:20260904",
    "DTEND;VALUE=DATE:20260905",
    "STATUS:CANCELLED",
    "END:VEVENT",
  ].join("\r\n");
  const result = normalize(calendar(first, cancelled));
  assert.equal(result.events.length, 3);
  assert.equal(new Set(result.events.map((e) => e.key)).size, 3);
  assert.ok(
    result.events.every((e) => e.identityKind === "RECURRENCE_INSTANCE"),
  );
  assert.deepEqual(
    result.events.filter((e) => e.status === "CANCELLED").map((e) => e.key),
    ["recurring#2026-09-04"],
  );
});
