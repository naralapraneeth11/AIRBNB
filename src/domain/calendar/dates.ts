// Calendar dates for night-based availability (DATE 01). A LocalDate is a
// property-local calendar date "YYYY-MM-DD". Ranges are [start, end): the end
// date is exclusive, so 14 Oct → 17 Oct protects the nights of 14, 15 and 16.
// Nothing here reads the system clock; callers supply every instant.

export type LocalDate = string;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLocalDate(value: unknown): value is LocalDate {
  if (typeof value !== "string") return false;
  const m = DATE_PATTERN.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toISOString().slice(0, 10) === value;
}

export function assertLocalDate(value: string): LocalDate {
  if (!isLocalDate(value))
    throw new RangeError(`Invalid calendar date: ${value}`);
  return value;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round(
    (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) /
      86_400_000,
  );
}

export const minDate = (a: LocalDate, b: LocalDate) => (a < b ? a : b);
export const maxDate = (a: LocalDate, b: LocalDate) => (a > b ? a : b);

export type DateRange = { startDate: LocalDate; endDate: LocalDate };

/** Overlap of two [start, end) ranges, or null when they share no night. */
export function intersect(a: DateRange, b: DateRange): DateRange | null {
  const startDate = maxDate(a.startDate, b.startDate);
  const endDate = minDate(a.endDate, b.endDate);
  return startDate < endDate ? { startDate, endDate } : null;
}

export const contains = (outer: DateRange, inner: DateRange) =>
  outer.startDate <= inner.startDate && outer.endDate >= inner.endDate;

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export type LocalDateTime = {
  date: LocalDate;
  hour: number;
  minute: number;
  second: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(zone, f);
  }
  return f;
}

/** The wall-clock reading of an instant in a zone. */
export function toLocal(instantMs: number, zone: string): LocalDateTime {
  const p = Object.fromEntries(
    formatter(zone)
      .formatToParts(new Date(instantMs))
      .map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: +p.hour,
    minute: +p.minute,
    second: +p.second,
  };
}

export const localDateOf = (instantMs: number, zone: string) =>
  toLocal(instantMs, zone).date;

function wallAsUtc(t: LocalDateTime) {
  return (
    Date.parse(t.date + "T00:00:00Z") +
    ((t.hour * 60 + t.minute) * 60 + t.second) * 1000
  );
}

/**
 * Instants at which a zone shows a wall-clock time. Usually one; none inside a
 * daylight-saving gap; two inside a repeated hour. Callers treat anything other
 * than exactly one as ambiguous and protect the widest interpretation.
 */
export function wallTimeInstants(local: LocalDateTime, zone: string): number[] {
  const wall = wallAsUtc(local);
  const found = new Set<number>();
  for (const probe of [wall - 36 * 3_600_000, wall + 36 * 3_600_000]) {
    const offset = wallAsUtc(toLocal(probe, zone)) - probe;
    const candidate = wall - offset;
    if (wallAsUtc(toLocal(candidate, zone)) === wall) found.add(candidate);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Resolve a wall-clock time to an instant. For a gap or overlap, returns the
 * earliest and latest plausible instants with ambiguous=true.
 */
export function resolveWallTime(
  local: LocalDateTime,
  zone: string,
): { earliest: number; latest: number; ambiguous: boolean } {
  const instants = wallTimeInstants(local, zone);
  if (instants.length === 1)
    return { earliest: instants[0], latest: instants[0], ambiguous: false };
  if (instants.length === 2)
    return { earliest: instants[0], latest: instants[1], ambiguous: true };
  // A nonexistent local time: bracket it by the offsets on either side.
  const wall = wallAsUtc(local);
  const before =
    wall -
    (wallAsUtc(toLocal(wall - 36 * 3_600_000, zone)) - (wall - 36 * 3_600_000));
  const after =
    wall -
    (wallAsUtc(toLocal(wall + 36 * 3_600_000, zone)) - (wall + 36 * 3_600_000));
  return {
    earliest: Math.min(before, after),
    latest: Math.max(before, after),
    ambiguous: true,
  };
}

/** The property-local calendar date at an instant ("today" for a property). */
export const todayIn = (zone: string, nowMs: number) =>
  localDateOf(nowMs, zone);
