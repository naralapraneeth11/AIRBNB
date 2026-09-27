// CLEAN 01 and CLEAN 03 as a pure planner. Turnover work exists only for
// confirmed reservations (or explicit manual requests); owner blocks and
// unknown events never create guest turnover work. A reservation change
// supersedes work that has not begun, asks the host to review work that has
// begun, and never rewrites verified work (a follow-up task is created).
import type { LocalDate } from "../calendar/dates";
import type { Lifecycle } from "../calendar/types";

export type TaskStatus =
  | "NEEDS_SCHEDULING"
  | "ASSIGNED"
  | "ACCEPTED"
  | "IN_PROGRESS"
  | "DONE"
  | "VERIFIED"
  | "CANCELLED"
  | "SUPERSEDED";

export type TurnoverTask = {
  id: string;
  departureDate: LocalDate | null;
  status: TaskStatus;
  reviewRequired: boolean;
  reviewReason: string | null;
};

export type ReservationView = {
  id: string;
  status: "CONFIRMED" | "CANCELLED" | "RECLASSIFIED";
  blockLifecycle: Lifecycle;
  departureDate: LocalDate;
};

export type TurnoverOp =
  | {
      type: "CREATE";
      departureDate: LocalDate;
      supersedesTaskId: string | null;
    }
  | { type: "SUPERSEDE"; taskId: string; reason: string }
  | { type: "CANCEL"; taskId: string; reason: string }
  | { type: "FLAG_REVIEW"; taskId: string; reason: string }
  | { type: "CLEAR_REVIEW"; taskId: string };

const NOT_STARTED: ReadonlySet<TaskStatus> = new Set([
  "NEEDS_SCHEDULING",
  "ASSIGNED",
  "ACCEPTED",
]);
const STARTED: ReadonlySet<TaskStatus> = new Set(["IN_PROGRESS", "DONE"]);
const CLOSED: ReadonlySet<TaskStatus> = new Set(["CANCELLED", "SUPERSEDED"]);
/** Review reasons this planner owns (and may therefore clear). */
export const CALENDAR_REVIEW_REASONS = new Set([
  "RESERVATION_UNDER_REVIEW",
  "RESERVATION_CANCELLED_AT_SOURCE",
  "RESERVATION_CHANGED_DURING_WORK",
  "RESERVATION_CANCELLED_DURING_WORK",
  "RESERVATION_RELEASED_DURING_WORK",
  "RECLASSIFIED_DURING_WORK",
]);

/** Whether the stay is expected to happen, so its turnover and access stand. */
export function stayExpected(
  r: Pick<ReservationView, "status" | "blockLifecycle">,
) {
  return (
    r.status === "CONFIRMED" &&
    (r.blockLifecycle === "ACTIVE" ||
      r.blockLifecycle === "MISSING_OBSERVED" ||
      r.blockLifecycle === "RETAINED_HOLD")
  );
}

export function planTurnover(
  r: ReservationView,
  tasks: readonly TurnoverTask[],
): TurnoverOp[] {
  const ops: TurnoverOp[] = [];
  const open = tasks.filter((t) => !CLOSED.has(t.status));
  const flag = (t: TurnoverTask, reason: string) => {
    if (!(t.reviewRequired && t.reviewReason === reason))
      ops.push({ type: "FLAG_REVIEW", taskId: t.id, reason });
  };

  if (stayExpected(r)) {
    const current = open.find((t) => t.departureDate === r.departureDate);
    let superseded: string | null = null;
    let workInProgress = false;
    for (const t of open) {
      if (t === current) continue;
      if (NOT_STARTED.has(t.status)) {
        ops.push({
          type: "SUPERSEDE",
          taskId: t.id,
          reason: "RESERVATION_DATES_CHANGED",
        });
        superseded = t.id;
      } else if (STARTED.has(t.status)) {
        flag(t, "RESERVATION_CHANGED_DURING_WORK");
        workInProgress = true;
      }
    }
    if (current) {
      if (
        current.reviewRequired &&
        current.reviewReason &&
        CALENDAR_REVIEW_REASONS.has(current.reviewReason)
      )
        ops.push({ type: "CLEAR_REVIEW", taskId: current.id });
    } else if (!workInProgress) {
      ops.push({
        type: "CREATE",
        departureDate: r.departureDate,
        supersedesTaskId: superseded,
      });
    }
    return ops;
  }

  if (r.blockLifecycle === "AWAITING_DECISION") {
    // Keep the work, but flag it and withhold access until the host decides.
    const reason =
      r.status === "CANCELLED"
        ? "RESERVATION_CANCELLED_AT_SOURCE"
        : "RESERVATION_UNDER_REVIEW";
    for (const t of open) if (t.status !== "VERIFIED") flag(t, reason);
    return ops;
  }

  // Cancelled, released or reclassified: close work that has not begun.
  const reason =
    r.status === "RECLASSIFIED"
      ? "RESERVATION_RECLASSIFIED"
      : r.blockLifecycle === "RELEASED"
        ? "RESERVATION_RELEASED"
        : "RESERVATION_CANCELLED";
  for (const t of open) {
    if (NOT_STARTED.has(t.status))
      ops.push({ type: "CANCEL", taskId: t.id, reason });
    else if (STARTED.has(t.status))
      flag(
        t,
        r.status === "RECLASSIFIED"
          ? "RECLASSIFIED_DURING_WORK"
          : r.blockLifecycle === "RELEASED"
            ? "RESERVATION_RELEASED_DURING_WORK"
            : "RESERVATION_CANCELLED_DURING_WORK",
      );
  }
  return ops;
}
