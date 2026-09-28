// QA 01: the fixture anonymizer removes identifying content by allowlist and
// keeps exactly the evidence the calendar engine reads.
import assert from "node:assert/strict";
import test from "node:test";
import { parseCalendar } from "../src/domain/calendar/parse";
import { normalizeCalendar } from "../src/domain/calendar/normalize";
import { anonymizeCalendar } from "../scripts/lib/anonymize";

const EXPORT = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//HomeAway.com, Inc.//EN",
  "X-WR-CALNAME:Jane Doe – Lakeside Cabin",
  "X-WR-CALDESC:Private calendar of Jane Doe",
  "BEGIN:VEVENT",
  "UID:8812345-vrbo-reservation-HA-ABC123@vrbo.com",
  "DTSTAMP:20260927T120000Z",
  "DTSTART;VALUE=DATE:20261105",
  "DTEND;VALUE=DATE:20261108",
  "SUMMARY:Reserved - John Smith",
  "DESCRIPTION:Guest John Smith\\, phone +1 555 0100\\, code HA-ABC123",
  "LOCATION:12 Lake Road",
  "ATTENDEE;CN=John Smith:mailto:john@example.test",
  "URL:https://www.vrbo.com/traveler/reservations/HA-ABC123",
  "X-CUSTOM-NOTE:door code 4242",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "DESCRIPTION:Call John Smith",
  "TRIGGER:-PT15M",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:weekly@vrbo.com",
  "DTSTAMP:20260927T120000Z",
  "DTSTART;VALUE=DATE:20261201",
  "DTEND;VALUE=DATE:20261202",
  "RRULE:FREQ=WEEKLY;UNTIL=20261222",
  "SUMMARY:Blocked",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:weekly@vrbo.com",
  "DTSTAMP:20260927T120000Z",
  "RECURRENCE-ID;VALUE=DATE:20261208",
  "DTSTART;VALUE=DATE:20261209",
  "DTEND;VALUE=DATE:20261210",
  "SUMMARY:Blocked for Jane's family",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const normalize = (text: string) => {
  const parsed = parseCalendar(text);
  assert.equal(parsed.kind, "CALENDAR");
  if (parsed.kind !== "CALENDAR") throw new Error("not a calendar");
  return normalizeCalendar(parsed, {
    platform: "VRBO",
    zone: "UTC",
    checkoutHour: 11,
    today: "2026-10-01",
  });
};

test("identifying content is removed by allowlist", () => {
  const { text, report } = anonymizeCalendar(EXPORT, {
    platform: "VRBO",
    salt: "test-salt",
    date: "2026-10-01",
  });
  for (const secret of [
    "John",
    "Smith",
    "Jane",
    "555",
    "HA-ABC123",
    "Lake Road",
    "example.test",
    "4242",
    "8812345",
    "Lakeside",
  ])
    assert.equal(text.includes(secret), false, secret);
  assert.match(text, /SUMMARY:Reserved - Guest\r\n/);
  assert.match(text, /SUMMARY:Blocked\r\n/);
  // An unrecognized label never passes through, even when it matches a rule.
  assert.match(text, /SUMMARY:Blocked\r\n[\s\S]*SUMMARY:Blocked\r\n/);
  assert.match(
    text,
    /X-HOSTSPHERE-FIXTURE:anonymized;platform=VRBO;date=2026-10-01/,
  );
  assert.ok(text.split("\r\n").every((l) => Buffer.byteLength(l) <= 75));
  assert.deepEqual(report.removed, {
    "X-WR-CALDESC": 1,
    DESCRIPTION: 1,
    LOCATION: 1,
    ATTENDEE: 1,
    URL: 1,
    "X-CUSTOM-NOTE": 1,
  });
  assert.equal(report.events, 3);
});

test("the engine sees the same dates, identities and labels after anonymizing", () => {
  const before = normalize(EXPORT);
  const { text } = anonymizeCalendar(EXPORT, { platform: "VRBO", salt: "s" });
  const after = normalize(text);
  const shape = (n: ReturnType<typeof normalize>) =>
    n.events
      .map((e) => [
        e.identityKind,
        e.startDate,
        e.endDate,
        e.status,
        e.labelKey,
      ])
      .sort();
  assert.deepEqual(shape(after), shape(before));
  // The recurrence override still matches its master.
  assert.equal(
    new Set(
      after.events
        .filter((e) => e.identityKind === "RECURRENCE_INSTANCE")
        .map((e) => e.uid),
    ).size,
    1,
  );
});

test("identities are stable for one salt, different across salts, and dates can shift", () => {
  const a = anonymizeCalendar(EXPORT, { platform: "VRBO", salt: "one" }).text;
  const b = anonymizeCalendar(EXPORT, { platform: "VRBO", salt: "one" }).text;
  const c = anonymizeCalendar(EXPORT, { platform: "VRBO", salt: "two" }).text;
  const uids = (t: string) => [...t.matchAll(/^UID:(.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(uids(a), uids(b));
  assert.notDeepEqual(uids(a), uids(c));
  assert.ok(uids(a).every((u) => /^anon-[0-9a-f]{24}@vrbo\.com$/.test(u)));
  const shifted = anonymizeCalendar(EXPORT, {
    platform: "VRBO",
    salt: "one",
    shiftDays: 7,
  }).text;
  assert.match(shifted, /DTSTART;VALUE=DATE:20261112/);
  assert.match(shifted, /RRULE:FREQ=WEEKLY;UNTIL=20261229/);
  assert.match(shifted, /RECURRENCE-ID;VALUE=DATE:20261215/);
});
