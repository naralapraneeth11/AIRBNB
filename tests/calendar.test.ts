import assert from "node:assert/strict";
import test from "node:test";
import { parseFeed } from "../src/server/services/calendar";

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

test("iCal import preserves exclusive checkout and ignores the application export echo", () => {
  const events = parseFeed(
    calendar(
      event("external-one"),
      event("own-one@airbnb-automation"),
      event("cancelled-one", "STATUS:CANCELLED"),
    ),
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].start.toISOString(), "2026-09-22T00:00:00.000Z");
  assert.equal(events[0].end.toISOString(), "2026-09-24T00:00:00.000Z");
  assert.equal(
    events[0].confirmedAt?.toISOString(),
    "2026-09-01T12:00:00.000Z",
  );
  assert.equal(events[1].cancelled, true);
});

test("invalid feeds and empty date ranges cannot release protected availability", () => {
  assert.throws(
    () => parseFeed("<html>Provider error</html>"),
    /not an iCalendar/,
  );
  assert.throws(
    () =>
      parseFeed(
        calendar(
          event("bad-range").replace(
            "DTEND;VALUE=DATE:20260924",
            "DTEND;VALUE=DATE:20260922",
          ),
        ),
      ),
    /zero-length stay/,
  );
  assert.throws(
    () =>
      parseFeed(
        calendar(event("missing-uid").replace("UID:missing-uid\r\n", "")),
      ),
    /missing its UID/,
  );
});

test("recurrence exceptions replace their occurrence without creating a duplicate booking", () => {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 2);
  const compact = (offset: number) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10).replaceAll("-", "");
  };
  const first = [
    "BEGIN:VEVENT",
    "UID:recurring",
    `DTSTART;VALUE=DATE:${compact(0)}`,
    `DTEND;VALUE=DATE:${compact(1)}`,
    "RRULE:FREQ=DAILY;COUNT=3",
    "END:VEVENT",
  ].join("\r\n");
  const cancelled = [
    "BEGIN:VEVENT",
    "UID:recurring",
    `RECURRENCE-ID;VALUE=DATE:${compact(1)}`,
    `DTSTART;VALUE=DATE:${compact(1)}`,
    `DTEND;VALUE=DATE:${compact(2)}`,
    "STATUS:CANCELLED",
    "END:VEVENT",
  ].join("\r\n");
  const result = parseFeed(calendar(first, cancelled));
  assert.equal(result.length, 3);
  assert.equal(new Set(result.map((item) => item.uid)).size, 3);
  assert.equal(result.filter((item) => item.cancelled).length, 1);
  assert.equal(result[1].cancelled, true);
});
