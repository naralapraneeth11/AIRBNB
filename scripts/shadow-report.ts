// REL 01: evidence for the shadow review. Summarizes what the calendar engine
// observed and decided over the window, per connection, and lists every item
// to adjudicate against source evidence and the agreed fixtures: decisions
// awaiting the host, unknown classifications, flagged evidence, overlaps, and
// checks that could not complete. Prints identifiers and dates only: no guest
// details, feed URLs or tokens.
//
//   pnpm calendar:shadow-report <workspace-id> [--days 7] [--markdown]
import { db, tenant, type Context } from "../src/server/db";
import { REASONS, isReasonCode } from "../src/domain/calendar/reasons";

const day = (d: Date) => d.toISOString().slice(0, 10);
const tally = (values: Iterable<string>) => {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
};

async function main(args: string[]) {
  const workspaceId = args[0];
  const daysArg = args.indexOf("--days");
  const days = daysArg >= 0 ? Number(args[daysArg + 1]) : 7;
  if (!workspaceId || !Number.isInteger(days) || days < 1 || days > 90)
    throw new Error(
      "Usage: pnpm calendar:shadow-report <workspace-id> [--days 1-90] [--markdown]",
    );
  const since = new Date(Date.now() - days * 86_400_000);
  const ctx: Context = {
    workspaceId,
    actorId: "operator:shadow-report",
    role: "SYSTEM",
  };
  const report = await tenant(ctx, async (tx) => {
    const workspace = await tx.workspace.findUnique({
      where: { id: workspaceId },
      select: { calendarMode: true },
    });
    if (!workspace) throw new Error("Workspace not found.");
    const [listings, connections, observations, blocks, conflicts] =
      await Promise.all([
        tx.listing.findMany({
          where: { workspaceId },
          select: { id: true, name: true },
        }),
        tx.channelConnection.findMany({ where: { workspaceId } }),
        tx.feedObservation.findMany({
          where: { workspaceId, observedAt: { gte: since } },
          select: {
            connectionId: true,
            observedAt: true,
            mode: true,
            outcome: true,
            health: true,
            result: true,
            reasonCodes: true,
            recomputed: true,
            accepted: true,
            decisions: true,
          },
        }),
        tx.availabilityBlock.findMany({
          where: { workspaceId },
          select: {
            id: true,
            listingId: true,
            connectionId: true,
            identityKind: true,
            startDate: true,
            endDate: true,
            classification: true,
            overrideClassification: true,
            classificationEvidence: true,
            lifecycle: true,
            decisionReason: true,
            reviewFlags: true,
          },
        }),
        tx.conflictCase.findMany({ where: { workspaceId, state: "OPEN" } }),
      ]);
    const property = new Map(listings.map((l) => [l.id, l.name]));
    const perConnection = connections
      .filter((c) => c.importUrlEncrypted)
      .map((c) => {
        const mine = observations.filter((o) => o.connectionId === c.id);
        const decisions: string[] = mine.flatMap((o) =>
          (
            (o.decisions as { list?: { type: string }[] } | null)?.list ?? []
          ).map((d) => d.type),
        );
        return {
          connectionId: c.id,
          property: property.get(c.listingId) ?? c.listingId,
          platform: c.platform,
          label: c.label,
          // UNSET after an explicit answer means "classify each block".
          policy:
            c.policyMode === "UNSET" && c.policyDecidedAt
              ? "PER_BLOCK"
              : c.policyMode,
          checks: mine.length,
          shadowChecks: mine.filter((o) => o.mode === "SHADOW").length,
          daysWithAcceptedCheck: new Set(
            mine.filter((o) => o.accepted).map((o) => day(o.observedAt)),
          ).size,
          results: tally(mine.map((o) => o.result)),
          health: tally(mine.map((o) => o.health)),
          reasons: tally(mine.flatMap((o) => o.reasonCodes)),
          decisions: tally(decisions),
          recomputed: mine.filter((o) => o.recomputed).length,
          lastResult: c.lastResult,
          currentHealth: c.health,
        };
      });
    const effective = (b: (typeof blocks)[number]) =>
      b.overrideClassification ?? b.classification;
    const live = blocks.filter((b) => b.lifecycle !== "RELEASED");
    const blockRow = (b: (typeof blocks)[number]) => ({
      blockId: b.id,
      property: property.get(b.listingId) ?? b.listingId,
      platform:
        connections.find((c) => c.id === b.connectionId)?.platform ?? "MANUAL",
      dates: `${day(b.startDate)} → ${day(b.endDate)}`,
    });
    return {
      workspaceId,
      mode: workspace.calendarMode,
      window: { from: since.toISOString(), to: new Date().toISOString(), days },
      connections: perConnection,
      blocks: {
        byLifecycle: tally(blocks.map((b) => b.lifecycle)),
        byClass: tally(live.map(effective)),
      },
      adjudicate: {
        awaitingDecision: live
          .filter((b) => b.lifecycle === "AWAITING_DECISION")
          .map((b) => ({ ...blockRow(b), reason: b.decisionReason })),
        unknown: live
          .filter((b) => effective(b) === "UNKNOWN")
          .map((b) => ({
            ...blockRow(b),
            identity: b.identityKind,
            evidence: (b.classificationEvidence as { rule?: string }).rule,
          })),
        flagged: live
          .filter((b) => b.reviewFlags.length)
          .map((b) => ({ ...blockRow(b), flags: b.reviewFlags })),
        overlaps: conflicts.map((c) => ({
          conflictId: c.id,
          property: property.get(c.listingId) ?? c.listingId,
          kind: c.kind,
          severity: c.severity,
          overlap: `${day(c.overlapStart)} → ${day(c.overlapEnd)}`,
        })),
        failingConnections: perConnection.filter(
          (c) =>
            c.lastResult === "COULD_NOT_CHECK" ||
            ["FAILING", "PAUSED_BY_SOURCE"].includes(c.currentHealth),
        ),
      },
    };
  });
  if (!args.includes("--markdown"))
    return console.log(JSON.stringify(report, null, 2));
  const lines = [
    `# Shadow review: workspace ${report.workspaceId}`,
    "",
    `Mode: ${report.mode}. Window: ${report.window.from} to ${report.window.to} (${report.window.days} days).`,
    "",
    "## Connections",
    "",
    "| Property | Platform | Policy | Checks | Days with an accepted check | Results | Decisions |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.connections.map(
      (c) =>
        `| ${c.property} | ${c.label ?? c.platform} | ${c.policy} | ${c.checks} | ${c.daysWithAcceptedCheck} | ${Object.entries(
          c.results,
        )
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")} | ${
          Object.entries(c.decisions)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ") || "none"
        } |`,
    ),
    "",
    "## Reason codes observed",
    "",
    ...report.connections.flatMap((c) =>
      Object.entries(c.reasons).map(
        ([code, n]) =>
          `- ${c.property} / ${c.label ?? c.platform}: ${code} (${n}): ${isReasonCode(code) ? REASONS[code] : "unknown code"}`,
      ),
    ),
    "",
    "## To adjudicate against source evidence and fixtures",
    "",
    ...(
      [
        ["Awaiting a decision", report.adjudicate.awaitingDecision],
        ["Unknown classification", report.adjudicate.unknown],
        ["Flagged evidence", report.adjudicate.flagged],
        ["Open overlaps", report.adjudicate.overlaps],
        [
          "Connections that could not be checked",
          report.adjudicate.failingConnections,
        ],
      ] as const
    ).flatMap(([title, rows]) => [
      `### ${title} (${rows.length})`,
      "",
      ...(rows.length
        ? rows.map((r) => `- [ ] ${JSON.stringify(r)} — verdict: `)
        : ["None."]),
      "",
    ]),
  ];
  console.log(lines.join("\n"));
}

main(process.argv.slice(2))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
