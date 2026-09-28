// Stage 9 (pure part): the privacy-minimal calendar for one destination
// connection, built from committed protection (EXPORT 01). It includes manual
// holds, unknown blocks, eligible reservations and buffers; it excludes the
// destination's own imported base blocks, while their buffer nights stay,
// because the destination does not know this property's buffer policy.
import { addDays, type LocalDate } from "./dates";
import { digestOf } from "./digest";
import { bufferOf } from "./conflicts";
import { OWN_UID_SUFFIX } from "./normalize";
import { effectiveClass, isProtective, type BlockState } from "./types";

export type ExportEvent = {
  uid: string;
  startDate: LocalDate;
  endDate: LocalDate;
};

/** Past events stay visible this long, then drop out of new versions. */
export const EXPORT_HISTORY_DAYS = 7;
export const EXPORT_PRODID = "-//Airbnb Automation//Protected Availability//EN";

export function buildExportEvents(input: {
  blocks: readonly BlockState[];
  destinationConnectionId: string;
  defaultBufferDays: number;
  today: LocalDate;
}): ExportEvent[] {
  const since = addDays(input.today, -EXPORT_HISTORY_DAYS);
  const events: ExportEvent[] = [];
  const add = (
    b: BlockState,
    suffix: string,
    startDate: LocalDate,
    endDate: LocalDate,
  ) => {
    if (endDate > startDate && endDate > since)
      events.push({
        uid: `${b.id}${suffix}${OWN_UID_SUFFIX}`,
        startDate,
        endDate,
      });
  };
  for (const b of input.blocks) {
    if (!isProtective(b) || effectiveClass(b) === "CONFIRMED_ECHO") continue;
    if (b.connectionId !== input.destinationConnectionId)
      add(b, "", b.startDate, b.endDate);
    const buffer = bufferOf(b, input.defaultBufferDays);
    if (buffer.before)
      add(b, "-pre", addDays(b.startDate, -buffer.before), b.startDate);
    if (buffer.after)
      add(b, "-post", b.endDate, addDays(b.endDate, buffer.after));
  }
  return events.sort((a, b) =>
    a.startDate !== b.startDate
      ? a.startDate < b.startDate
        ? -1
        : 1
      : a.endDate !== b.endDate
        ? a.endDate < b.endDate
          ? -1
          : 1
        : a.uid < b.uid
          ? -1
          : 1,
  );
}

/** Stable content digest: identical content keeps the same digest and ETag. */
export const exportDigest = (events: readonly ExportEvent[]) =>
  digestOf({ format: 1, events });

const compact = (d: LocalDate) => d.replaceAll("-", "");

/**
 * Render a version. DTSTAMP is the time the version was published, the
 * calendar-level "last revised" time; it is not part of the content digest.
 */
export function renderExport(
  events: readonly ExportEvent[],
  publishedAt: string,
): string {
  const stamp = publishedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${EXPORT_PRODID}`,
    "CALSCALE:GREGORIAN",
  ];
  for (const e of events)
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(e.startDate)}`,
      `DTEND;VALUE=DATE:${compact(e.endDate)}`,
      "SUMMARY:Unavailable",
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

/**
 * The first property-local date on which these events change by the passage
 * of time alone: the day the earliest-ending event leaves the history window.
 */
export function exportRefreshOn(
  events: readonly ExportEvent[],
): LocalDate | null {
  if (!events.length) return null;
  let end = events[0].endDate;
  for (const e of events) if (e.endDate < end) end = e.endDate;
  return addDays(end, EXPORT_HISTORY_DAYS);
}

export function exportCoverage(events: readonly ExportEvent[]) {
  if (!events.length) return { start: null, end: null };
  let end = events[0].endDate;
  for (const e of events) if (e.endDate > end) end = e.endDate;
  return { start: events[0].startDate, end };
}
