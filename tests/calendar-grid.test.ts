// The days a calendar view shows and the range it loads for them, in the
// viewer's own time zone. The range must end on the day after the last day
// shown, including on the days the clocks change, when a day lasts 23 or 25
// hours. Node applies a change to process.env.TZ immediately.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { calendarGrid } from "../src/lib/calendar-grid";
import { dayAdd, dateOnly } from "../src/lib/domain";

const originalZone = process.env.TZ;
after(() => {
  process.env.TZ = originalZone;
});
function inZone<T>(zone: string, work: () => T): T {
  process.env.TZ = zone;
  return work();
}
const next = (date: string) => dateOnly(dayAdd(date, 1));

test("the week the clocks go back loads its last day", () => {
  for (const [zone, anchor, sunday] of [
    ["Europe/London", "2026-10-21", "2026-10-25"],
    ["America/New_York", "2026-10-28", "2026-11-01"],
    ["Australia/Sydney", "2026-04-01", "2026-04-05"],
  ]) {
    const grid = inZone(zone, () => calendarGrid(anchor, "Week"));
    assert.equal(
      grid.to,
      next(sunday),
      `${zone}: the range ends after ${sunday}`,
    );
  }
});

test("a month view that ends when the clocks go back loads its last day", () => {
  // October 2027 starts on a Friday, so its six-week grid ends on Sunday
  // 7 November, when clocks go back in the United States.
  const grid = inZone("America/New_York", () =>
    calendarGrid("2027-10-15", "Month"),
  );
  assert.equal(grid.from, "2027-09-27");
  assert.equal(grid.to, "2027-11-08");
});

test("every view is whole consecutive days from a Monday, in any zone", () => {
  for (const zone of [
    "UTC",
    "America/New_York",
    "Europe/London",
    "Australia/Lord_Howe", // clocks move by 30 minutes
    "Pacific/Chatham",
  ]) {
    inZone(zone, () => {
      for (let i = 0; i < 2 * 366; i += 3) {
        const anchor = dateOnly(dayAdd("2026-01-01", i));
        for (const mode of ["Month", "Week", "Agenda"]) {
          const { days, from, to } = calendarGrid(anchor, mode);
          const shown = days.map(
            (d) =>
              `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
          );
          assert.equal(days.length, mode === "Month" ? 42 : 7);
          assert.equal(days[0].getDay(), 1, `${zone} ${anchor}: starts Monday`);
          assert.equal(from, shown[0]);
          shown.forEach((date, n) =>
            assert.equal(date, dateOnly(dayAdd(from, n)), `${zone} ${anchor}`),
          );
          assert.equal(to, next(shown.at(-1)!), `${zone} ${anchor} ${mode}`);
          assert.ok(
            shown.includes(anchor) || mode === "Month",
            "the week includes its anchor",
          );
        }
      }
    });
  }
});
