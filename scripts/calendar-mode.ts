// REL 01: switch a workspace between SHADOW (calendar decisions are recorded
// without serving exports, alerts or turnover changes) and LIVE.
//
//   pnpm calendar:mode <workspace-id> LIVE --reviewed <evidence>
//   pnpm calendar:mode <workspace-id> SHADOW --reason <text>
//
// Going live needs a reference to the adjudicated shadow review (an issue or
// document link; docs/RELEASE_GATES.md). It then creates the turnover work
// that shadow mode withheld, one property per transaction, so an interrupted
// run is safe to repeat. Returning to SHADOW stops new effects but keeps work
// already created. Runs as the application role, inside tenant scope.
import { db, tenant, type Context } from "../src/server/db";
import { audit, notify } from "../src/server/audit";
import { reconcileListingTurnovers } from "../src/server/calendar/actions";

function option(args: string[], flag: string) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1]?.trim() : undefined;
}

async function main(args: string[]) {
  const [workspaceId, target] = args;
  if (!workspaceId || (target !== "LIVE" && target !== "SHADOW"))
    throw new Error(
      "Usage: pnpm calendar:mode <workspace-id> LIVE --reviewed <evidence> | SHADOW --reason <text>",
    );
  const evidence =
    target === "LIVE" ? option(args, "--reviewed") : option(args, "--reason");
  if (!evidence || evidence.length < 5)
    throw new Error(
      target === "LIVE"
        ? "Going live requires --reviewed with a link to the adjudicated shadow review."
        : "Returning to shadow mode requires --reason.",
    );
  const operator = process.env.USER || process.env.USERNAME || "operator";
  const ctx: Context = {
    workspaceId,
    actorId: `operator:${operator}`,
    role: "SYSTEM",
  };
  const previous = await tenant(ctx, async (tx) => {
    const w = await tx.workspace.findUnique({ where: { id: workspaceId } });
    if (!w) throw new Error("Workspace not found.");
    if (w.calendarMode !== target) {
      await tx.workspace.update({
        where: { id: workspaceId },
        data: { calendarMode: target },
      });
      await audit(
        tx,
        ctx,
        "CALENDAR_MODE",
        "Workspace",
        workspaceId,
        target === "LIVE"
          ? "Calendar changes went live after the shadow review: export links serve, alerts send and turnover work follows reservations."
          : "Calendar changes returned to shadow mode: decisions are recorded without new external effects.",
        { from: w.calendarMode, to: target, evidence },
      );
    }
    return w.calendarMode;
  });
  let reservations = 0;
  if (target === "LIVE") {
    const listings = await tenant(ctx, (tx) =>
      tx.listing.findMany({
        where: { workspaceId, archivedAt: null },
        select: { id: true },
      }),
    );
    for (const l of listings)
      reservations += await tenant(ctx, (tx) =>
        reconcileListingTurnovers(tx, ctx, l.id),
      );
    await tenant(ctx, async (tx) => {
      const [decisions, conflicts] = await Promise.all([
        tx.availabilityBlock.count({
          where: { workspaceId, lifecycle: "AWAITING_DECISION" },
        }),
        tx.conflictCase.count({ where: { workspaceId, state: "OPEN" } }),
      ]);
      // Shadow mode sent no alerts, so summarize what is already waiting.
      const waiting = [
        decisions &&
          `${decisions} date range${decisions === 1 ? " waits" : "s wait"} for your decision`,
        conflicts &&
          `${conflicts} overlap${conflicts === 1 ? " is" : "s are"} open`,
      ]
        .filter(Boolean)
        .join(" and ");
      if (waiting)
        await notify(
          tx,
          ctx,
          `calendar-live:${new Date().toISOString().slice(0, 10)}`,
          "Calendar changes are live",
          `${waiting[0].toUpperCase()}${waiting.slice(1)}. Nothing reopens without your review.`,
          "/calendar",
        );
    });
  }
  console.log(
    JSON.stringify({
      workspaceId,
      from: previous,
      to: target,
      reconciledReservations: reservations,
    }),
  );
}

main(process.argv.slice(2))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
