// Stage 4 Normalize: stable identities, property-local dates (DATE 01),
// bounded recurrence (DATE 02) and a meaningful content digest.
//
// Identity (ID 01/02, DATA 02): a UID is scoped to its connection; a recurrence
// instance is identified by its original recurrence reference, so moving its
// dates never creates a second stay. An event without a UID gets a surrogate
// key derived from its evidence; it is always classified Unknown and can never
// authorize removing another block.
import ICAL from "ical.js";
import {
  addDays,
  isValidTimeZone,
  maxDate,
  resolveWallTime,
  toLocal,
  type LocalDate,
  type LocalDateTime,
} from "./dates";
import { capabilityOf, labelKeyOf } from "./capabilities";
import { digestOf, sha256 } from "./digest";
import {
  fromIcalTime,
  type DurationValue,
  type InvalidItem,
  type ParsedCalendar,
  type ParsedEvent,
  type TimeValue,
} from "./parse";
import type { ReasonCode } from "./reasons";
import type { Platform, ReviewFlag, SourceStatus } from "./types";

export const NORMALIZE_DEFAULTS = {
  windowPastDays: 30,
  windowFutureDays: 730,
  /** DATE 02 initial bound on emitted recurrence occurrences per feed. */
  recurrenceLimit: 3000,
  /** Bound on recurrence iterator steps, including skipped history. */
  recurrenceIterationLimit: 50_000,
} as const;

/** Frozen export UID suffix (EXPORT 01, D15); a product rename must not change it. */
export const OWN_UID_SUFFIX = "@airbnb-automation";

export type EchoRef = { blockId: string; part: "base" | "pre" | "post" };

export type NormalizedEvent = {
  key: string;
  identityKind: "UID" | "RECURRENCE_INSTANCE" | "SURROGATE";
  uid: string | null;
  startDate: LocalDate;
  endDate: LocalDate;
  status: SourceStatus;
  sequence: number | null;
  stamp: string | null;
  created: string | null;
  labelKey: string;
  contentDigest: string;
  flags: ReviewFlag[];
  echo: EchoRef | null;
};

export type NormalizeContext = {
  platform: Platform;
  /** IANA zone of the property. */
  zone: string;
  /** Local checkout hour used by the timed-event adapter rule. */
  checkoutHour: number;
  today: LocalDate;
  windowPastDays?: number;
  windowFutureDays?: number;
  recurrenceLimit?: number;
  recurrenceIterationLimit?: number;
};

export type NormalizeResult = {
  /** May hold several entries for one key when duplicates disagree. */
  events: NormalizedEvent[];
  duplicateKeys: string[];
  /** Identities present in the feed but unreadable; never treated as missing. */
  presentInvalidKeys: string[];
  invalid: InvalidItem[];
  complete: boolean;
  flags: ReasonCode[];
  coverageStart: LocalDate;
  coverageEnd: LocalDate | null;
  fingerprint: string;
  counts: NormalizeCounts;
};

export type NormalizeCounts = {
  parsedEvents: number;
  events: number;
  invalid: number;
  unsupported: number;
  cancelled: number;
  surrogates: number;
  instances: number;
  duplicateConflicts: number;
  duplicatesMerged: number;
  echoes: number;
  historic: number;
  beyondWindow: number;
};

type Range =
  | { ok: true; startDate: LocalDate; endDate: LocalDate; ambiguous: boolean }
  | { ok: false };

const pad = (n: number) => String(n).padStart(2, "0");
const wallMs = (l: LocalDateTime) =>
  Date.parse(`${l.date}T${pad(l.hour)}:${pad(l.minute)}:${pad(l.second)}.000Z`);

function instantOf(
  t: Exclude<TimeValue, { kind: "DATE" }>,
  zone: string,
): { earliest: number; latest: number; ambiguous: boolean } {
  if (t.kind === "UTC") {
    const ms = wallMs(t.local);
    return { earliest: ms, latest: ms, ambiguous: false };
  }
  if (t.kind === "ZONED" && isValidTimeZone(t.tzid))
    return resolveWallTime(t.local, t.tzid);
  // Floating time, or a TZID that is not an IANA zone: read it in the
  // property's zone. A non-IANA TZID is always flagged for review.
  const resolved = resolveWallTime(t.local, zone);
  return t.kind === "ZONED" ? { ...resolved, ambiguous: true } : resolved;
}

const durationSeconds = (d: DurationValue) =>
  (((d.weeks * 7 + d.days) * 24 + d.hours) * 60 + d.minutes) * 60 + d.seconds;

/**
 * The tested adapter rule for timed values (DATE 01): the stay starts on the
 * property-local date of its start; it ends on the local date of its end, plus
 * one night when the end falls after the property's checkout time. Times are
 * never rounded into another night by a fixed hour.
 */
function exclusiveEndFromInstant(
  instant: number,
  zone: string,
  checkoutHour: number,
): LocalDate {
  const l = toLocal(instant, zone);
  const after = l.hour * 3600 + l.minute * 60 + l.second > checkoutHour * 3600;
  return after ? addDays(l.date, 1) : l.date;
}

export function rangeOf(
  start: TimeValue | null,
  end: TimeValue | null,
  duration: DurationValue | null,
  zone: string,
  checkoutHour: number,
): Range {
  if (!start) return { ok: false };
  if (duration && (duration.negative || durationSeconds(duration) <= 0) && !end)
    return { ok: false };
  if (start.kind === "DATE") {
    let endDate: LocalDate;
    let ambiguous = false;
    if (end) {
      if (end.kind === "DATE") endDate = end.date;
      else {
        const r = instantOf(end, zone);
        endDate = exclusiveEndFromInstant(r.latest, zone, checkoutHour);
        ambiguous = r.ambiguous;
      }
    } else if (duration)
      endDate = addDays(
        start.date,
        Math.max(1, Math.ceil(durationSeconds(duration) / 86400)),
      );
    // A valid all-day event with no end or duration protects one day.
    else endDate = addDays(start.date, 1);
    return endDate > start.date
      ? { ok: true, startDate: start.date, endDate, ambiguous }
      : { ok: false };
  }
  const s = instantOf(start, zone);
  let ambiguous = s.ambiguous;
  const startDate = toLocal(s.earliest, zone).date;
  let endDate: LocalDate;
  if (end && end.kind === "DATE") endDate = end.date;
  else {
    let endInstant = s.latest;
    if (end) {
      const r = instantOf(end, zone);
      if (r.latest < s.earliest) return { ok: false };
      endInstant = r.latest;
      ambiguous ||= r.ambiguous;
    } else if (duration)
      endInstant = s.latest + durationSeconds(duration) * 1000;
    endDate = exclusiveEndFromInstant(endInstant, zone, checkoutHour);
    if (endDate <= startDate) endDate = addDays(startDate, 1);
  }
  return endDate > startDate
    ? { ok: true, startDate, endDate, ambiguous }
    : { ok: false };
}

export function recurrenceKey(uid: string, rid: TimeValue): string {
  if (rid.kind === "DATE") return `${uid}#${rid.date}`;
  const l = rid.local;
  const time = `${l.date}T${pad(l.hour)}:${pad(l.minute)}:${pad(l.second)}`;
  if (rid.kind === "UTC") return `${uid}#${time}Z`;
  if (rid.kind === "ZONED") return `${uid}#${time};TZID=${rid.tzid}`;
  return `${uid}#${time}`;
}

export function echoOf(uid: string | null): EchoRef | null {
  if (!uid || !uid.toLowerCase().endsWith(OWN_UID_SUFFIX)) return null;
  const local = uid.slice(0, -OWN_UID_SUFFIX.length);
  const m = /^(.+?)(-pre|-post)?$/.exec(local);
  if (!m || !m[1]) return null;
  return {
    blockId: m[1],
    part: m[2] === "-pre" ? "pre" : m[2] === "-post" ? "post" : "base",
  };
}

type Draft = Omit<NormalizedEvent, "key" | "contentDigest"> & {
  instanceKey?: string;
  surrogateEvidence?: string;
};

export function normalizeCalendar(
  parsed: ParsedCalendar,
  ctx: NormalizeContext,
): NormalizeResult {
  const limits = {
    past: ctx.windowPastDays ?? NORMALIZE_DEFAULTS.windowPastDays,
    future: ctx.windowFutureDays ?? NORMALIZE_DEFAULTS.windowFutureDays,
    occurrences: ctx.recurrenceLimit ?? NORMALIZE_DEFAULTS.recurrenceLimit,
    iterations:
      ctx.recurrenceIterationLimit ??
      NORMALIZE_DEFAULTS.recurrenceIterationLimit,
  };
  const windowStart = addDays(ctx.today, -limits.past);
  const windowEnd = addDays(ctx.today, limits.future);
  const flags = new Set<ReasonCode>(parsed.flags);
  const invalid: InvalidItem[] = [...parsed.invalid];
  const presentInvalid = new Set<string>(
    parsed.invalid.flatMap((i) => (i.uid ? [i.uid] : [])),
  );
  const counts: NormalizeCounts = {
    parsedEvents: parsed.events.length,
    events: 0,
    invalid: 0,
    unsupported: parsed.unsupported,
    cancelled: 0,
    surrogates: 0,
    instances: 0,
    duplicateConflicts: 0,
    duplicatesMerged: 0,
    echoes: 0,
    historic: 0,
    beyondWindow: 0,
  };
  let complete = parsed.complete;
  const drafts: Draft[] = [];

  const accept = (
    ev: ParsedEvent,
    range: Extract<Range, { ok: true }>,
    identity:
      | { kind: "UID"; uid: string }
      | { kind: "RECURRENCE_INSTANCE"; uid: string; key: string }
      | { kind: "SURROGATE" },
    status: SourceStatus,
  ) => {
    if (range.endDate <= windowStart) {
      counts.historic++;
      return;
    }
    if (range.startDate >= windowEnd) {
      counts.beyondWindow++;
      return;
    }
    const labelKey = labelKeyOf(ctx.platform, ev.summary);
    const reviewFlags: ReviewFlag[] = range.ambiguous ? ["AMBIGUOUS_TIME"] : [];
    if (range.ambiguous) flags.add("AMBIGUOUS_TIME");
    const base = {
      uid: identity.kind === "SURROGATE" ? null : identity.uid,
      startDate: range.startDate,
      endDate: range.endDate,
      status,
      sequence: ev.sequence,
      stamp: ev.stamp,
      created: ev.created,
      labelKey,
      flags: reviewFlags,
      echo: identity.kind === "UID" ? echoOf(identity.uid) : null,
    };
    if (identity.kind === "SURROGATE")
      drafts.push({
        ...base,
        identityKind: "SURROGATE",
        surrogateEvidence: [
          range.startDate,
          range.endDate,
          labelKey,
          status,
        ].join("|"),
      });
    else if (identity.kind === "RECURRENCE_INSTANCE")
      drafts.push({
        ...base,
        identityKind: "RECURRENCE_INSTANCE",
        instanceKey: identity.key,
      });
    else drafts.push({ ...base, identityKind: "UID" });
  };

  const markInvalid = (ev: ParsedEvent, key: string | null) => {
    invalid.push({ index: ev.index, uid: ev.uid, code: "INVALID_RANGE" });
    if (key) presentInvalid.add(key);
    flags.add("INVALID_RANGE");
    complete = false;
  };

  // Group recurrence overrides with their masters (same UID).
  const exceptionsByUid = new Map<string, ParsedEvent[]>();
  const masters = new Set<string>();
  for (const ev of parsed.events) {
    if (ev.uid && ev.recurrenceId) {
      const list = exceptionsByUid.get(ev.uid) ?? [];
      list.push(ev);
      exceptionsByUid.set(ev.uid, list);
    }
    if (ev.uid && ev.recurring && !ev.recurrenceId) masters.add(ev.uid);
  }

  let occurrences = 0;
  let iterations = 0;
  for (const ev of parsed.events) {
    if (ev.recurrenceId && ev.uid && masters.has(ev.uid)) continue; // expanded with its master
    if (ev.recurring && !ev.recurrenceId) {
      const outcome = expandRecurring(
        ev,
        ev.uid ? (exceptionsByUid.get(ev.uid) ?? []) : [],
        ctx,
        windowStart,
        windowEnd,
        {
          occurrences: limits.occurrences - occurrences,
          iterations: limits.iterations - iterations,
        },
      );
      occurrences += outcome.emitted;
      iterations += outcome.iterations;
      if (outcome.limitHit) {
        flags.add("RECURRENCE_LIMIT");
        complete = false;
      }
      if (outcome.failed) {
        markInvalid(ev, ev.uid);
        continue;
      }
      for (const o of outcome.items) {
        counts.instances++;
        const key = ev.uid ? recurrenceKey(ev.uid, o.rid) : null;
        const range = rangeOf(o.start, o.end, null, ctx.zone, ctx.checkoutHour);
        if (!range.ok) {
          markInvalid(ev, key);
          continue;
        }
        accept(
          ev,
          range,
          ev.uid && key
            ? { kind: "RECURRENCE_INSTANCE", uid: ev.uid, key }
            : { kind: "SURROGATE" },
          o.status,
        );
      }
      continue;
    }
    const key =
      ev.uid && ev.recurrenceId
        ? recurrenceKey(ev.uid, ev.recurrenceId)
        : ev.uid;
    const range = rangeOf(
      ev.start,
      ev.end,
      ev.duration,
      ctx.zone,
      ctx.checkoutHour,
    );
    if (!range.ok) {
      markInvalid(ev, key);
      continue;
    }
    if (!ev.uid) {
      flags.add("MISSING_UID");
      accept(ev, range, { kind: "SURROGATE" }, ev.status);
    } else if (ev.recurrenceId)
      accept(
        ev,
        range,
        { kind: "RECURRENCE_INSTANCE", uid: ev.uid, key: key! },
        ev.status,
      );
    else accept(ev, range, { kind: "UID", uid: ev.uid }, ev.status);
  }

  // Assign keys and digests; surrogates are numbered within equal evidence.
  const surrogateOrdinals = new Map<string, number>();
  const keyed: NormalizedEvent[] = drafts.map((d) => {
    let key: string;
    if (d.identityKind === "SURROGATE") {
      const evidence = sha256(d.surrogateEvidence!).slice(0, 24);
      const n = surrogateOrdinals.get(evidence) ?? 0;
      surrogateOrdinals.set(evidence, n + 1);
      key = `surrogate:${evidence}:${n}`;
      counts.surrogates++;
    } else key = d.instanceKey ?? (d.uid as string);
    const contentDigest = digestOf({
      s: d.startDate,
      e: d.endDate,
      st: d.status,
      l: d.labelKey,
    });
    return {
      key,
      identityKind: d.identityKind,
      uid: d.uid,
      startDate: d.startDate,
      endDate: d.endDate,
      status: d.status,
      sequence: d.sequence,
      stamp: d.stamp,
      created: d.created,
      labelKey: d.labelKey,
      contentDigest,
      flags: d.flags,
      echo: d.echo,
    };
  });

  // ID 01: identical duplicates merge; disagreeing duplicates go to review.
  const byKey = new Map<string, NormalizedEvent[]>();
  for (const e of keyed) {
    const list = byKey.get(e.key) ?? [];
    list.push(e);
    byKey.set(e.key, list);
  }
  const events: NormalizedEvent[] = [];
  const duplicateKeys: string[] = [];
  for (const [key, list] of byKey) {
    const distinct = [
      ...new Map(list.map((e) => [e.contentDigest, e])).values(),
    ];
    counts.duplicatesMerged += list.length - distinct.length;
    if (distinct.length > 1) {
      duplicateKeys.push(key);
      counts.duplicateConflicts++;
      flags.add("DUPLICATE_UID_CONFLICT");
    }
    events.push(...distinct);
  }
  events.sort((a, b) =>
    a.key < b.key
      ? -1
      : a.key > b.key
        ? 1
        : a.contentDigest < b.contentDigest
          ? -1
          : 1,
  );

  let coverageEnd: LocalDate | null = null;
  for (const e of events) {
    if (e.status === "CANCELLED") counts.cancelled++;
    else
      coverageEnd = coverageEnd ? maxDate(coverageEnd, e.endDate) : e.endDate;
    if (e.echo) counts.echoes++;
  }
  const capability = capabilityOf(ctx.platform);
  if (capability.horizonVerified && capability.horizonDays !== null) {
    const horizon = addDays(ctx.today, capability.horizonDays);
    coverageEnd = coverageEnd ? maxDate(coverageEnd, horizon) : horizon;
  }
  counts.events = events.length;
  counts.invalid = invalid.length;
  const presentInvalidKeys = [...presentInvalid].sort();
  duplicateKeys.sort();
  return {
    events,
    duplicateKeys,
    presentInvalidKeys,
    invalid,
    complete,
    flags: [...flags].sort(),
    coverageStart: ctx.today,
    coverageEnd,
    fingerprint: digestOf({
      e: events.map((e) => [e.key, e.contentDigest]),
      i: presentInvalidKeys,
      d: duplicateKeys,
      c: complete,
    }),
    counts,
  };
}

type Occurrence = {
  rid: TimeValue;
  start: TimeValue;
  end: TimeValue | null;
  status: SourceStatus;
};

function statusOf(component: ICAL.Component): SourceStatus {
  const s = String(component.getFirstPropertyValue("status") ?? "")
    .trim()
    .toUpperCase();
  return s === "CANCELLED"
    ? "CANCELLED"
    : s === "TENTATIVE"
      ? "TENTATIVE"
      : "CONFIRMED";
}

function eventFromText(text: string) {
  const component = new ICAL.Component(
    ICAL.parse(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${text}\r\nEND:VCALENDAR`),
  ).getFirstSubcomponent("vevent");
  if (!component) throw new Error("missing event");
  return new ICAL.Event(component);
}

const tzidOf = (component: ICAL.Component) => {
  const tzid = component.getFirstProperty("dtstart")?.getParameter("tzid");
  return typeof tzid === "string" ? tzid : null;
};

/** DATE 02: expand within a declared window, bounded by shared budgets. */
function expandRecurring(
  master: ParsedEvent,
  exceptions: ParsedEvent[],
  ctx: NormalizeContext,
  windowStart: LocalDate,
  windowEnd: LocalDate,
  budget: { occurrences: number; iterations: number },
): {
  items: Occurrence[];
  emitted: number;
  iterations: number;
  limitHit: boolean;
  failed: boolean;
} {
  const items: Occurrence[] = [];
  let iterations = 0;
  try {
    const event = eventFromText(master.text);
    for (const ex of exceptions) event.relateException(eventFromText(ex.text));
    const masterTzid = tzidOf(event.component);
    const iterator = event.iterator();
    for (let next = iterator.next(); next; next = iterator.next()) {
      if (++iterations > budget.iterations)
        return {
          items,
          emitted: items.length,
          iterations,
          limitHit: true,
          failed: false,
        };
      const rid = fromIcalTime(next, masterTzid);
      const ridDate = rid.kind === "DATE" ? rid.date : rid.local.date;
      if (ridDate >= windowEnd) break;
      const details = event.getOccurrenceDetails(next);
      const source = details.item.component;
      const tzid = tzidOf(source) ?? masterTzid;
      const start = fromIcalTime(details.startDate, tzid);
      const end = details.endDate ? fromIcalTime(details.endDate, tzid) : null;
      const endDate =
        end?.kind === "DATE" ? end.date : end ? end.local.date : null;
      if (endDate && endDate < windowStart) continue;
      if (items.length >= budget.occurrences)
        return {
          items,
          emitted: items.length,
          iterations,
          limitHit: true,
          failed: false,
        };
      items.push({ rid, start, end, status: statusOf(source) });
    }
    return {
      items,
      emitted: items.length,
      iterations,
      limitHit: false,
      failed: false,
    };
  } catch {
    return { items: [], emitted: 0, iterations, limitHit: false, failed: true };
  }
}
