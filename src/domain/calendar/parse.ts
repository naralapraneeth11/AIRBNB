// Stage 3 Parse: bounded, tolerant reading of an iCalendar body. A malformed
// event becomes an explicit invalid item and marks the observation incomplete;
// it never aborts the valid events around it (CAL 02). Summaries are read only
// to derive label keys downstream; descriptions are never read (DATA 03).
import ICAL from "ical.js";
import { isLocalDate, type LocalDate, type LocalDateTime } from "./dates";
import type { ReasonCode } from "./reasons";

export const PARSE_LIMITS = {
  maxLines: 200_000,
  maxLogicalLineLength: 32_768,
  maxEvents: 5_000,
  maxPropertiesPerEvent: 200,
} as const;

export type TimeValue =
  | { kind: "DATE"; date: LocalDate }
  | { kind: "UTC"; local: LocalDateTime }
  | { kind: "ZONED"; local: LocalDateTime; tzid: string }
  | { kind: "FLOATING"; local: LocalDateTime };

export type DurationValue = {
  negative: boolean;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
};

export type ParsedEvent = {
  index: number;
  uid: string | null;
  recurrenceId: TimeValue | null;
  start: TimeValue | null;
  end: TimeValue | null;
  duration: DurationValue | null;
  recurring: boolean;
  status: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  sequence: number | null;
  /** LAST-MODIFIED, else DTSTAMP, as a UTC ISO instant (ordering only). */
  stamp: string | null;
  created: string | null;
  summary: string | null;
  /** The event's own unfolded lines, kept for recurrence expansion. */
  text: string;
};

export type InvalidItem = {
  index: number;
  uid: string | null;
  code: ReasonCode;
};

export type ParsedCalendar = {
  kind: "CALENDAR";
  events: ParsedEvent[];
  invalid: InvalidItem[];
  unsupported: number;
  flags: ReasonCode[];
  complete: boolean;
};
export type ParseResult = { kind: "NOT_CALENDAR" } | ParsedCalendar;

type Pending = {
  index: number;
  lines: string[];
  properties: number;
  invalid: ReasonCode | null;
};

export function parseCalendar(body: string): ParseResult {
  const physical = body.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  const first = physical.find((l) => l.trim() !== "");
  if (!first || first.trim().toUpperCase() !== "BEGIN:VCALENDAR")
    return { kind: "NOT_CALENDAR" };

  const flags = new Set<ReasonCode>();
  if (physical.length > PARSE_LIMITS.maxLines) flags.add("LINE_LIMIT");

  // Unfold continuation lines (RFC 5545 §3.1), tracking oversized lines.
  const lines: { text: string; oversized: boolean }[] = [];
  for (const line of physical.slice(0, PARSE_LIMITS.maxLines)) {
    const last = lines[lines.length - 1];
    if ((line.startsWith(" ") || line.startsWith("\t")) && last) {
      if (!last.oversized) {
        last.text += line.slice(1);
        if (last.text.length > PARSE_LIMITS.maxLogicalLineLength) {
          last.oversized = true;
          last.text = last.text.slice(0, 512);
        }
      }
    } else
      lines.push({
        text:
          line.length > PARSE_LIMITS.maxLogicalLineLength
            ? line.slice(0, 512)
            : line,
        oversized: line.length > PARSE_LIMITS.maxLogicalLineLength,
      });
  }

  const events: ParsedEvent[] = [];
  const invalid: InvalidItem[] = [];
  let unsupported = 0;
  let eventCount = 0;
  let sawCalendarEnd = false;
  let current: Pending | null = null;
  const stack: string[] = [];

  const finish = (pending: Pending) => {
    const uid = rawUid(pending.lines);
    if (pending.invalid) {
      invalid.push({ index: pending.index, uid, code: pending.invalid });
      return;
    }
    try {
      events.push(extractEvent(pending));
    } catch {
      invalid.push({ index: pending.index, uid, code: "EVENT_INVALID" });
    }
  };

  for (const { text, oversized } of lines) {
    if (sawCalendarEnd) break;
    if (text.trim() === "") continue;
    const upper = text.toUpperCase();
    if (upper.startsWith("BEGIN:")) {
      const name = upper.slice(6).trim();
      stack.push(name);
      if (name === "VEVENT" && stack.length === 2) {
        if (eventCount >= PARSE_LIMITS.maxEvents) {
          flags.add("EVENT_LIMIT");
          current = null;
        } else
          current = {
            index: eventCount,
            lines: [text],
            properties: 0,
            invalid: null,
          };
        eventCount++;
      } else if (current) current.lines.push(text);
      else if (stack.length === 2 && name !== "VTIMEZONE") unsupported++;
      continue;
    }
    if (upper.startsWith("END:")) {
      const name = upper.slice(4).trim();
      if (stack[stack.length - 1] === name) stack.pop();
      else {
        // Recover by closing to the named component; anything open is broken.
        flags.add("FEED_STRUCTURE");
        if (current) current.invalid = "FEED_STRUCTURE";
        const at = stack.lastIndexOf(name);
        if (at >= 0) stack.length = at;
      }
      if (current) {
        current.lines.push(text);
        if (name === "VEVENT" && stack.length <= 1) {
          finish(current);
          current = null;
        }
      }
      if (name === "VCALENDAR" && stack.length === 0) sawCalendarEnd = true;
      continue;
    }
    if (current) {
      current.lines.push(text);
      current.properties++;
      if (oversized) current.invalid = "LINE_LIMIT";
      else if (current.properties > PARSE_LIMITS.maxPropertiesPerEvent)
        current.invalid = "PROPERTY_LIMIT";
    } else if (oversized) flags.add("LINE_LIMIT");
  }
  if (current) {
    current.invalid = "FEED_TRUNCATED";
    finish(current);
  }
  if (!sawCalendarEnd) flags.add("FEED_TRUNCATED");
  if (unsupported) flags.add("UNSUPPORTED_COMPONENT");
  for (const item of invalid) flags.add(item.code);

  const complete =
    invalid.length === 0 &&
    !flags.has("FEED_TRUNCATED") &&
    !flags.has("FEED_STRUCTURE") &&
    !flags.has("EVENT_LIMIT") &&
    !flags.has("LINE_LIMIT");
  return {
    kind: "CALENDAR",
    events,
    invalid,
    unsupported,
    flags: [...flags].sort(),
    complete,
  };
}

function rawUid(lines: string[]): string | null {
  for (const line of lines) {
    const m = /^UID(?:;[^:]*)?:(.*)$/i.exec(line);
    if (m) return m[1].trim() || null;
  }
  return null;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function timeValue(prop: ICAL.Property | null): TimeValue | null {
  if (!prop) return null;
  const tzid = prop.getParameter("tzid");
  return fromIcalTime(
    prop.getFirstValue(),
    typeof tzid === "string" ? tzid : null,
  );
}

/** Convert an ical.js time (whose TZID stays unresolved) into a TimeValue. */
export function fromIcalTime(v: unknown, tzid: string | null): TimeValue {
  if (!(v instanceof ICAL.Time)) throw new Error("not a time");
  const date = `${pad(v.year, 4)}-${pad(v.month)}-${pad(v.day)}`;
  if (!isLocalDate(date)) throw new Error("invalid date");
  if (v.isDate) return { kind: "DATE", date };
  if (v.hour > 23 || v.minute > 59 || v.second > 60)
    throw new Error("invalid time");
  const local = {
    date,
    hour: v.hour,
    minute: v.minute,
    second: Math.min(v.second, 59),
  };
  if (v.zone?.tzid === "UTC") return { kind: "UTC", local };
  if (tzid && tzid.trim()) return { kind: "ZONED", local, tzid: tzid.trim() };
  return { kind: "FLOATING", local };
}

function stampOf(prop: ICAL.Property | null): string | null {
  const t = timeValue(prop);
  if (!t) return null;
  if (t.kind === "DATE") return t.date + "T00:00:00.000Z";
  // Stamps only order versions of one event; read wall time as UTC.
  const l = t.local;
  return `${l.date}T${pad(l.hour)}:${pad(l.minute)}:${pad(l.second)}.000Z`;
}

function extractEvent(pending: Pending): ParsedEvent {
  const text = pending.lines.join("\r\n");
  const wrapped = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${text}\r\nEND:VCALENDAR`;
  const component = new ICAL.Component(
    ICAL.parse(wrapped),
  ).getFirstSubcomponent("vevent");
  if (!component) throw new Error("missing event");
  const uidValue = component.getFirstPropertyValue("uid");
  const uid = uidValue === null ? null : String(uidValue).trim() || null;
  const statusValue = String(component.getFirstPropertyValue("status") ?? "")
    .trim()
    .toUpperCase();
  const sequenceValue = component.getFirstPropertyValue("sequence");
  const sequence =
    typeof sequenceValue === "number" &&
    Number.isInteger(sequenceValue) &&
    sequenceValue >= 0
      ? sequenceValue
      : null;
  const durationValue = component.getFirstPropertyValue("duration");
  const summaryValue = component.getFirstPropertyValue("summary");
  return {
    index: pending.index,
    uid,
    recurrenceId: timeValue(component.getFirstProperty("recurrence-id")),
    start: timeValue(component.getFirstProperty("dtstart")),
    end: timeValue(component.getFirstProperty("dtend")),
    duration:
      durationValue instanceof ICAL.Duration
        ? {
            negative: durationValue.isNegative,
            weeks: durationValue.weeks,
            days: durationValue.days,
            hours: durationValue.hours,
            minutes: durationValue.minutes,
            seconds: durationValue.seconds,
          }
        : null,
    recurring: component.hasProperty("rrule") || component.hasProperty("rdate"),
    status:
      statusValue === "CANCELLED"
        ? "CANCELLED"
        : statusValue === "TENTATIVE"
          ? "TENTATIVE"
          : "CONFIRMED",
    sequence,
    stamp:
      stampOf(component.getFirstProperty("last-modified")) ??
      stampOf(component.getFirstProperty("dtstamp")),
    created: stampOf(component.getFirstProperty("created")),
    summary: summaryValue === null ? null : String(summaryValue),
    text,
  };
}
