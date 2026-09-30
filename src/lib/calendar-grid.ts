import { localDate } from "./client";

/**
 * The days a calendar view shows, in the viewer's time zone, and the
 * half-open range [from, to) of dates to load for them. Weeks start on
 * Monday; a month view is six full weeks.
 *
 * Days are counted with calendar components, never in 24-hour steps: a day
 * lasts 23 or 25 hours when the clocks change, so "24 hours after midnight"
 * can still be the same date, and the last day shown would not be loaded.
 */
export function calendarGrid(anchor: string, mode: string) {
  const d = new Date(anchor + "T12:00:00");
  const first =
    mode === "Month" ? new Date(d.getFullYear(), d.getMonth(), 1) : d;
  const start = new Date(
    first.getFullYear(),
    first.getMonth(),
    first.getDate() - ((first.getDay() + 6) % 7),
  );
  const days = Array.from(
    { length: mode === "Month" ? 42 : 7 },
    (_, i) =>
      new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
  );
  const last = days.at(-1)!;
  return {
    days,
    from: localDate(days[0]),
    to: localDate(
      new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1),
    ),
  };
}
