import { db, tenant } from "../src/server/db";
import { audit } from "../src/server/audit";
import { cleaningStates } from "../src/lib/domain";

// Rebuild the cleaning state from immutable events without dispatching side effects.
// This deliberately cannot resend a message, release a code, or alter a reservation.
async function main() {
  const [workspaceId, entityId] = process.argv.slice(2);
  if (!workspaceId || !entityId)
    throw new Error(
      "Usage: pnpm events:replay <workspace-id> <cleaning-task-id>",
    );
  const ctx = {
    workspaceId,
    actorId: "operator:event-replay",
    role: "SYSTEM" as const,
  };
  const result = await tenant(ctx, async (tx) => {
    const task = await tx.cleaningTask.findFirst({
      where: { workspaceId, id: entityId },
    });
    if (!task)
      throw new Error("Cleaning task not found in the selected workspace.");
    const events = await tx.domainEvent.findMany({
      where: { workspaceId, entityId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    let reconstructed: string | null = null;
    const discontinuities: string[] = [];
    const timeline = events.map((e) => {
      const payload = e.payload as Record<string, unknown>;
      const next =
        e.type === "CLEANING_CREATED"
          ? "NEEDS_SCHEDULING"
          : e.type.replace(/^CLEANING_/, "");
      if (cleaningStates.includes(next as (typeof cleaningStates)[number])) {
        if (payload.from && reconstructed && payload.from !== reconstructed)
          discontinuities.push(e.id);
        reconstructed = next;
      }
      return { id: e.id, at: e.createdAt, type: e.type, state: reconstructed };
    });
    await audit(
      tx,
      ctx,
      "EVENT_REPLAY",
      "CleaningTask",
      entityId,
      "Read-only reconstruction of immutable workflow events; no effects redispatched.",
    );
    return {
      entityId,
      reconstructed,
      persisted: task.status,
      matches: reconstructed === task.status,
      discontinuities,
      timeline,
    };
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.matches || result.discontinuities.length) process.exitCode = 2;
}
main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
