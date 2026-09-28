// QA 01 / CLASS 01: make a platform export collected with the host's
// permission safe to commit as a fixture. The engine's evidence survives:
// component nesting, date forms and TZIDs, recurrence, status, sequence and
// stamps, and the platform's label text in canonical form. Everything else is
// dropped by allowlist, so an unexpected property can never leak: guest
// names, reservation codes, phone digits, URLs, locations and descriptions.
// UIDs are replaced by a keyed hash, stable within one run (or across runs
// sharing a salt) so duplicates, recurrence overrides and horizon pairs keep
// their identity relationships.
import { createHmac } from "node:crypto";
import { labelKeyOf } from "../../src/domain/calendar/capabilities";
import { OWN_UID_SUFFIX } from "../../src/domain/calendar/normalize";
import type { Platform } from "../../src/domain/calendar/types";

/** Label text re-emitted in canonical form; the source text may hold names. */
const CANONICAL: Partial<Record<Platform, Record<string, string>>> = {
  AIRBNB: { reserved: "Reserved", "not-available": "Airbnb (Not available)" },
  VRBO: { reserved: "Reserved - Guest", blocked: "Blocked" },
  BOOKING: { closed: "CLOSED - Not available" },
};
const PLATFORM_DOMAINS = [
  "airbnb.com",
  "vrbo.com",
  "homeaway.com",
  "booking.com",
  "google.com",
];
const CALENDAR_KEEP = new Set(["VERSION", "PRODID", "CALSCALE", "METHOD"]);
const EVENT_KEEP = new Set([
  "UID",
  "DTSTART",
  "DTEND",
  "DURATION",
  "DTSTAMP",
  "CREATED",
  "LAST-MODIFIED",
  "RECURRENCE-ID",
  "RRULE",
  "RDATE",
  "EXDATE",
  "SEQUENCE",
  "STATUS",
  "TRANSP",
  "SUMMARY",
]);
const DATED = new Set([
  "DTSTART",
  "DTEND",
  "DTSTAMP",
  "CREATED",
  "LAST-MODIFIED",
  "RECURRENCE-ID",
  "RDATE",
  "EXDATE",
]);

export type AnonymizeReport = {
  events: number;
  uidsRewritten: number;
  summariesReplaced: number;
  removed: Record<string, number>;
  shiftDays: number;
};

const unfold = (text: string) =>
  text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n[ \t]/g, "");

/** RFC 5545 folding at 75 octets, continuation lines starting with a space. */
function fold(line: string) {
  const out: string[] = [];
  let current = "";
  for (const ch of line) {
    const limit = out.length ? 74 : 75;
    if (Buffer.byteLength(current + ch) > limit) {
      out.push(current);
      current = "";
    }
    current += ch;
  }
  out.push(current);
  return out.join("\r\n ");
}

function shiftDate(yyyymmdd: string, days: number) {
  const d = new Date(
    Date.UTC(
      +yyyymmdd.slice(0, 4),
      +yyyymmdd.slice(4, 6) - 1,
      +yyyymmdd.slice(6, 8),
    ),
  );
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10).replaceAll("-", "");
}

/** Shift every YYYYMMDD at the start of a value or after UNTIL=. */
const shiftValue = (value: string, days: number) =>
  days
    ? value.replace(
        /(^|,|UNTIL=)(\d{8})/g,
        (_, p: string, d: string) => p + shiftDate(d, days),
      )
    : value;

export function anonymizeCalendar(
  text: string,
  options: {
    platform: Platform;
    salt: string;
    shiftDays?: number;
    date?: string;
  },
): { text: string; report: AnonymizeReport } {
  const shiftDays = options.shiftDays ?? 0;
  const report: AnonymizeReport = {
    events: 0,
    uidsRewritten: 0,
    summariesReplaced: 0,
    removed: {},
    shiftDays,
  };
  const removed = (name: string) =>
    (report.removed[name] = (report.removed[name] ?? 0) + 1);
  const uid = (value: string) => {
    report.uidsRewritten++;
    const at = value.lastIndexOf("@");
    const domain = at >= 0 ? value.slice(at + 1).toLowerCase() : "";
    const keep =
      "@" + domain === OWN_UID_SUFFIX ||
      PLATFORM_DOMAINS.some((d) => domain === d || domain.endsWith("." + d));
    const local = at >= 0 ? value.slice(0, at) : value;
    const digest = createHmac("sha256", options.salt)
      .update(local)
      .digest("hex")
      .slice(0, 24);
    return `anon-${digest}${keep ? "@" + domain : ""}`;
  };
  const stack: string[] = [];
  const out: string[] = [];
  for (const line of unfold(text).split("\n")) {
    if (!line.trim()) continue;
    const colon = line.indexOf(":");
    if (colon < 0) {
      removed("MALFORMED_LINE");
      continue;
    }
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const name = head.split(";")[0].toUpperCase();
    if (name === "BEGIN") {
      const component = value.trim().toUpperCase();
      // Alarms carry reminder text; they never matter to availability.
      if (stack.includes("VALARM") || component === "VALARM") {
        stack.push(component);
        continue;
      }
      stack.push(component);
      out.push(`BEGIN:${component}`);
      if (component === "VCALENDAR")
        out.push(
          `X-HOSTSPHERE-FIXTURE:anonymized;platform=${options.platform};date=${options.date ?? new Date().toISOString().slice(0, 10)}`,
        );
      if (component === "VEVENT") report.events++;
      continue;
    }
    if (name === "END") {
      const component = stack.pop();
      if (component === "VALARM" || stack.includes("VALARM")) continue;
      out.push(`END:${value.trim().toUpperCase()}`);
      continue;
    }
    const inside = stack.at(-1) ?? "";
    if (stack.includes("VALARM")) continue;
    if (stack.includes("VTIMEZONE")) {
      out.push(line);
      continue;
    }
    if (inside === "VCALENDAR") {
      if (CALENDAR_KEEP.has(name)) out.push(line);
      else if (name === "X-WR-TIMEZONE") out.push(line);
      else if (name === "X-WR-CALNAME") out.push("X-WR-CALNAME:Fixture");
      else removed(name);
      continue;
    }
    if (!EVENT_KEEP.has(name)) {
      removed(name);
      continue;
    }
    if (name === "UID") out.push(`UID:${uid(value.trim())}`);
    else if (name === "SUMMARY") {
      const key = labelKeyOf(options.platform, value.trim());
      const canonical = CANONICAL[options.platform]?.[key];
      if (canonical !== value.trim()) report.summariesReplaced++;
      out.push(`SUMMARY:${canonical ?? "Private event"}`);
    } else if (DATED.has(name) || name === "RRULE")
      out.push(`${head}:${shiftValue(value, shiftDays)}`);
    else out.push(line);
  }
  return { text: out.map(fold).join("\r\n") + "\r\n", report };
}
