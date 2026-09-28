// MIG 01 (Appendix B, Phase 0): evidence for the product owner's written
// confirmation that no real host data exists before the pre-launch rebuild.
// It prints row counts only: no names, emails, addresses or message content.
// Row-level security is forced even for the table owner, so tenant tables are
// counted once per workspace under that workspace's transaction-local scope.
//
//   pnpm db:prelaunch-check
//
// Run with the schema-owner connection as DIRECT_URL. The script decides
// nothing: the product owner reviews the counts, confirms in writing, and a
// verified backup is taken before any rebuild (docs/RELEASE_GATES.md).
import { PrismaClient } from "@prisma/client";

const GLOBAL = ["Workspace", "User", "Membership", "Session"] as const;
// Tables that hold host, guest or calendar data. Absent tables are skipped,
// so the check works before and after the calendar rebuild.
const TENANT = [
  "Listing",
  "Cleaner",
  "CleaningTask",
  "Asset",
  "Thread",
  "Message",
  "AutomationRule",
  "Integration",
  "PushSubscription",
  "Booking",
  "SyncSource",
  "SyncRun",
  "ChannelConnection",
  "AvailabilityBlock",
  "Reservation",
  "ConflictCase",
  "AuditLog",
] as const;
const CALENDAR = new Set([
  "Booking",
  "SyncSource",
  "SyncRun",
  "AvailabilityBlock",
  "Reservation",
]);

const quote = (table: string) => `"${table.replaceAll('"', '""')}"`;

async function main() {
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error("Set DIRECT_URL to the schema-owner connection.");
  const db = new PrismaClient({ datasourceUrl: url });
  try {
    const present = new Set(
      (
        await db.$queryRaw<{ table_name: string }[]>`
          SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
      ).map((r) => r.table_name),
    );
    const count = async (
      run: (sql: string) => Promise<{ n: bigint }[]>,
      table: string,
    ) => Number((await run(`SELECT count(*) AS n FROM ${quote(table)}`))[0].n);

    const global: Record<string, number> = {};
    for (const table of GLOBAL)
      if (present.has(table))
        global[table] = await count((q) => db.$queryRawUnsafe(q), table);

    const workspaces = await db.$queryRaw<{ id: string; createdAt: Date }[]>`
      SELECT id, "createdAt" FROM "Workspace" ORDER BY "createdAt"`;
    const perWorkspace = [];
    const totals: Record<string, number> = {};
    for (const w of workspaces) {
      const counts = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${w.id}, true)`;
        const out: Record<string, number> = {};
        for (const table of TENANT)
          if (present.has(table))
            out[table] = await count((q) => tx.$queryRawUnsafe(q), table);
        return out;
      });
      for (const [table, n] of Object.entries(counts))
        totals[table] = (totals[table] ?? 0) + n;
      perWorkspace.push({
        workspaceId: w.id,
        createdAt: w.createdAt.toISOString(),
        counts,
      });
    }
    const calendarRows = Object.entries(totals)
      .filter(([table]) => CALENDAR.has(table))
      .reduce((sum, [, n]) => sum + n, 0);
    console.log(
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          database: new URL(url).pathname.replace(/^\//, ""),
          global,
          totals,
          calendarRows,
          workspaces: perWorkspace,
          note:
            calendarRows > 0
              ? "Calendar rows exist. The pre-launch rebuild migration refuses to run; confirm whether they are real before planning an expand/backfill migration (MIG 01)."
              : "No calendar rows. Review every count above before confirming in writing that no real host data exists (MIG 01).",
        },
        null,
        2,
      ),
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
