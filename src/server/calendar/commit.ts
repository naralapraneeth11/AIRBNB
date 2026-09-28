// Stages 8-10 for one property, inside the caller's transaction (ARCH 01
// transaction boundary). Applying a calendar decision updates blocks,
// reservations, turnover work, conflict cases, domain events, audit, export
// versions and outbox intents atomically; provider calls happen after commit.
// Used by feed observations and host actions alike, so they cannot diverge.
import { randomUUID } from "node:crypto";
import type { Listing } from "@prisma/client";
import type { Decision, NewBlock } from "@/domain/calendar/compare";
import {
  detectConflicts,
  reconcileConflicts,
  type ConflictCaseState,
} from "@/domain/calendar/conflicts";
import { todayIn } from "@/domain/calendar/dates";
import {
  buildExportEvents,
  exportCoverage,
  exportDigest,
  exportRefreshOn,
  renderExport,
} from "@/domain/calendar/export";
import { effectiveClass, type BlockState } from "@/domain/calendar/types";
import { audit, event, notify } from "../audit";
import type { Context, Tx } from "../db";
import { AppError } from "../errors";
import { applyTurnover } from "../services/cleaning";
import { blockData, blockState, fromLocalDate, toLocalDate } from "./mappers";

export type CalendarMode = "SHADOW" | "LIVE";
export type CalendarCause =
  | { kind: "OBSERVATION"; observationId: string; connectionId: string }
  | { kind: "HOST"; action: string }
  | { kind: "SYSTEM"; action: string };

type CreateExtras = {
  reasonEncrypted?: string | null;
  clientRequestId?: string | null;
  createdBy?: string | null;
};
type UpdateExtras = {
  releasedBy?: string | null;
  releaseReasonEncrypted?: string | null;
  overrideBy?: string | null;
  overrideAt?: Date | null;
};

export type CalendarChange = {
  creates: NewBlock[];
  createExtras?: CreateExtras[];
  updates: BlockState[];
  updateExtras?: ReadonlyMap<string, UpdateExtras>;
  touches?: string[];
  decisions: Decision[];
};

/** Keep bodies for the newest versions; older rows keep digest and metadata. */
const RETAINED_EXPORT_BODIES = 3;

export async function loadPropertyBlocks(
  tx: Tx,
  ctx: Context,
  listingId: string,
) {
  const rows = await tx.availabilityBlock.findMany({
    where: { workspaceId: ctx.workspaceId, listingId },
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
  });
  return rows.map(blockState);
}

export async function calendarMode(
  tx: Tx,
  ctx: Context,
): Promise<CalendarMode> {
  const w = await tx.workspace.findUniqueOrThrow({
    where: { id: ctx.workspaceId },
  });
  return w.calendarMode === "LIVE" ? "LIVE" : "SHADOW";
}

const nightsText = (b: BlockState) => {
  const nights = Math.round(
    (Date.parse(b.endDate) - Date.parse(b.startDate)) / 86_400_000,
  );
  return `${nights} night${nights === 1 ? "" : "s"} from ${b.startDate}`;
};

export async function commitCalendarChange(
  tx: Tx,
  ctx: Context,
  input: {
    listing: Listing;
    mode: CalendarMode;
    change: CalendarChange;
    before: ReadonlyMap<string, BlockState>;
    cause: CalendarCause;
    now: Date;
    auditReason: string;
  },
): Promise<{ revision: number; changed: boolean; created: BlockState[] }> {
  const { listing, change, now } = input;
  if (change.touches?.length)
    await tx.availabilityBlock.updateMany({
      where: { workspaceId: ctx.workspaceId, id: { in: change.touches } },
      data: { lastSeenAt: now },
    });
  if (!change.creates.length && !change.updates.length)
    return { revision: listing.calendarRevision, changed: false, created: [] };

  // CAL 03: the property revision moves exactly once per committed change.
  const revision = listing.calendarRevision + 1;
  const bumped = await tx.listing.updateMany({
    where: {
      id: listing.id,
      workspaceId: ctx.workspaceId,
      calendarRevision: listing.calendarRevision,
    },
    data: { calendarRevision: revision },
  });
  if (bumped.count !== 1)
    throw new AppError(
      409,
      "CALENDAR_CHANGED",
      "The calendar changed while this decision was prepared. Review it again.",
    );
  for (const b of [...change.creates, ...change.updates])
    if (b.committedRevision !== revision)
      throw new Error("Calendar decision prepared for another revision");

  const created: BlockState[] = [];
  for (const [i, b] of change.creates.entries()) {
    const id = randomUUID();
    await tx.availabilityBlock.create({
      data: {
        id,
        workspaceId: ctx.workspaceId,
        ...blockData(b),
        ...(change.createExtras?.[i] ?? {}),
      },
    });
    created.push({ ...b, id });
  }
  for (const u of change.updates) {
    const written = await tx.availabilityBlock.updateMany({
      where: {
        id: u.id,
        workspaceId: ctx.workspaceId,
        revision: u.revision - 1,
      },
      data: { ...blockData(u), ...(change.updateExtras?.get(u.id) ?? {}) },
    });
    if (written.count !== 1)
      throw new AppError(
        409,
        "BLOCK_CHANGED",
        "These dates changed while you were reviewing them. Review them again.",
      );
  }

  // Each transition records its cause and the previous revision (section 12).
  const cause =
    input.cause.kind === "OBSERVATION"
      ? `observation:${input.cause.observationId}`
      : `${input.cause.kind.toLowerCase()}:${input.cause.action}`;
  for (const after of [...created, ...change.updates]) {
    const prior = input.before.get(after.id) ?? null;
    const type = !prior
      ? "BLOCK_CREATED"
      : prior.lifecycle !== after.lifecycle
        ? `BLOCK_${after.lifecycle}`
        : "BLOCK_UPDATED";
    await event(
      tx,
      ctx,
      type,
      after.id,
      `block:${after.id}:${after.revision}`,
      {
        cause,
        lifecycle: after.lifecycle,
        previousLifecycle: prior?.lifecycle ?? null,
        previousRevision: prior?.revision ?? null,
        revision: after.revision,
        calendarRevision: revision,
        startDate: after.startDate,
        endDate: after.endDate,
        classification: effectiveClass(after),
      },
    );
  }

  const blocks = await loadPropertyBlocks(tx, ctx, listing.id);
  const connections = await tx.channelConnection.findMany({
    where: { workspaceId: ctx.workspaceId, listingId: listing.id },
  });
  const platformOf = new Map(connections.map((c) => [c.id, c.platform]));
  const affected = [...created, ...change.updates].map((b) =>
    blocks.find((x) => x.id === b.id)!,
  );

  for (const b of affected) {
    const reservation = await syncReservation(
      tx,
      ctx,
      listing,
      b,
      b.connectionId ? (platformOf.get(b.connectionId) ?? "OTHER") : "DIRECT",
      now,
    );
    // CLEAN 01/03: turnover work is an operational effect, so shadow mode only observes.
    if (reservation && input.mode === "LIVE")
      await applyTurnover(tx, ctx, listing, reservation, b, now);
  }

  await reconcilePropertyConflicts(tx, ctx, listing, blocks, input.mode, now);
  await publishExports(
    tx,
    ctx,
    { ...listing, calendarRevision: revision },
    blocks,
    now,
  );

  if (input.mode === "LIVE")
    await notifyDecisions(tx, ctx, listing, change.decisions, blocks);
  await audit(
    tx,
    ctx,
    auditAction(input.cause),
    "Listing",
    listing.id,
    input.auditReason,
    {
      cause,
      calendarRevision: revision,
      created: created.map((b) => b.id),
      updated: change.updates.map((b) => b.id),
      decisions: change.decisions.map((d) => d.type),
      mode: input.mode,
    },
  );
  return { revision, changed: true, created };
}

/**
 * A property's buffer or checkout settings changed (the caller holds the
 * property lock). Buffers change protection, so the calendar revision moves
 * and exports and conflicts are recomputed; checkout timing moves turnovers.
 */
export async function propertySettingsChanged(
  tx: Tx,
  ctx: Context,
  listing: Listing,
  changed: { buffers: boolean; checkout: boolean },
  now = new Date(),
) {
  const mode = await calendarMode(tx, ctx);
  let current = listing;
  if (changed.buffers) {
    current = await tx.listing.update({
      where: { id: listing.id },
      data: { calendarRevision: { increment: 1 } },
    });
    const blocks = await loadPropertyBlocks(tx, ctx, listing.id);
    await reconcilePropertyConflicts(tx, ctx, current, blocks, mode, now);
    await publishExports(tx, ctx, current, blocks, now);
  }
  if (changed.checkout && mode === "LIVE") {
    const blocks = new Map(
      (await loadPropertyBlocks(tx, ctx, listing.id)).map((b) => [b.id, b]),
    );
    const reservations = await tx.reservation.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        listingId: listing.id,
        endDate: {
          gte: fromLocalDate(todayIn(listing.timezone, now.getTime())),
        },
      },
    });
    for (const r of reservations) {
      const block = r.blockId ? blocks.get(r.blockId) : undefined;
      if (block) await applyTurnover(tx, ctx, current, r, block, now);
    }
  }
  return current;
}

const auditAction = (c: CalendarCause) =>
  c.kind === "OBSERVATION"
    ? "CALENDAR_APPLY"
    : c.kind === "HOST"
      ? c.action
      : `SYSTEM_${c.action}`;

/** Reservations mirror their protecting block; guest fields stay host-entered. */
async function syncReservation(
  tx: Tx,
  ctx: Context,
  listing: Listing,
  b: BlockState,
  platform: string,
  now: Date,
) {
  const existing = await tx.reservation.findFirst({
    where: { workspaceId: ctx.workspaceId, blockId: b.id },
  });
  const cls = effectiveClass(b);
  const status =
    cls !== "RESERVATION"
      ? "RECLASSIFIED"
      : b.lifecycle === "RELEASED" || b.sourceStatus === "CANCELLED"
        ? "CANCELLED"
        : "CONFIRMED";
  if (!existing) {
    if (
      cls !== "RESERVATION" ||
      b.identityKind === "MANUAL" ||
      b.lifecycle === "RELEASED"
    )
      return null;
    return tx.reservation.create({
      data: {
        id: randomUUID(),
        workspaceId: ctx.workspaceId,
        listingId: listing.id,
        blockId: b.id,
        source: "IMPORTED",
        platform,
        sourceReservationKey: b.sourceKey,
        status,
        startDate: fromLocalDate(b.startDate),
        endDate: fromLocalDate(b.endDate),
        currency: listing.currency,
        firstObservedAt: b.firstSeenAt ? new Date(b.firstSeenAt) : now,
      },
    });
  }
  if (
    existing.status === status &&
    toLocalDate(existing.startDate) === b.startDate &&
    toLocalDate(existing.endDate) === b.endDate
  )
    return existing;
  return tx.reservation.update({
    where: { id: existing.id },
    data: {
      status,
      startDate: fromLocalDate(b.startDate),
      endDate: fromLocalDate(b.endDate),
      version: { increment: 1 },
    },
  });
}

export async function reconcilePropertyConflicts(
  tx: Tx,
  ctx: Context,
  listing: Listing,
  blocks: BlockState[],
  mode: CalendarMode,
  now: Date,
) {
  const desired = detectConflicts(blocks, listing.bufferDays);
  const rows = await tx.conflictCase.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      listingId: listing.id,
      OR: [
        { state: "OPEN" },
        ...(desired.length
          ? desired.map((d) => ({ blockAId: d.blockAId, blockBId: d.blockBId }))
          : []),
      ],
    },
    orderBy: { createdAt: "desc" },
  });
  const latest = new Map<string, ConflictCaseState>();
  for (const r of rows) {
    const key = `${r.blockAId}|${r.blockBId}`;
    const current = latest.get(key);
    if (current && (current.state === "OPEN" || r.state !== "OPEN")) continue;
    latest.set(key, {
      id: r.id,
      blockAId: r.blockAId,
      blockBId: r.blockBId,
      kind: r.kind as ConflictCaseState["kind"],
      severity: r.severity as ConflictCaseState["severity"],
      overlapStart: toLocalDate(r.overlapStart),
      overlapEnd: toLocalDate(r.overlapEnd),
      state: r.state as ConflictCaseState["state"],
      resolution: r.resolution as ConflictCaseState["resolution"],
      revision: r.revision,
    });
  }
  const plan = reconcileConflicts([...latest.values()], desired);
  for (const c of plan.create) {
    const id = randomUUID();
    await tx.conflictCase.create({
      data: {
        id,
        workspaceId: ctx.workspaceId,
        listingId: listing.id,
        blockAId: c.blockAId,
        blockBId: c.blockBId,
        kind: c.kind,
        severity: c.severity,
        overlapStart: fromLocalDate(c.overlapStart),
        overlapEnd: fromLocalDate(c.overlapEnd),
        firstDetectedAt: now,
        lastDetectedAt: now,
      },
    });
    await event(tx, ctx, "CONFLICT_OPENED", id, `conflict:${id}:0`, {
      kind: c.kind,
      severity: c.severity,
    });
    if (mode === "LIVE" && c.severity !== "LOW")
      await notify(
        tx,
        ctx,
        `cal:conflict:${id}:${c.severity}`,
        c.kind === "RESERVATION_RESERVATION"
          ? "Possible double booking"
          : "Overlapping dates need review",
        `${listing.name}: protected dates overlap from ${c.overlapStart}. Both stays remain protected; no booking was cancelled.`,
        "/calendar?conflict=" + id,
      );
  }
  for (const c of plan.update) {
    await tx.conflictCase.update({
      where: { id: c.id },
      data: {
        kind: c.kind,
        severity: c.severity,
        overlapStart: fromLocalDate(c.overlapStart),
        overlapEnd: fromLocalDate(c.overlapEnd),
        lastDetectedAt: now,
        revision: c.revision,
      },
    });
    // A changed overlap updates its case; only an escalation alerts again.
    if (mode === "LIVE" && c.escalated && c.severity !== "LOW")
      await notify(
        tx,
        ctx,
        `cal:conflict:${c.id}:${c.severity}`,
        "An overlap became more serious",
        `${listing.name}: review the overlapping dates from ${c.overlapStart}.`,
        "/calendar?conflict=" + c.id,
      );
  }
  for (const c of plan.resolve) {
    await tx.conflictCase.update({
      where: { id: c.id },
      data: {
        state: "RESOLVED",
        resolution: "NO_LONGER_OVERLAPPING",
        resolvedAt: now,
        resolvedBy: "system",
        revision: { increment: 1 },
      },
    });
    await event(
      tx,
      ctx,
      "CONFLICT_CLEARED",
      c.id,
      `conflict:${c.id}:cleared`,
      {},
    );
  }
}

/**
 * Stage 9: a new export version per destination whose content changed. The
 * listing records when its exports next change by time alone, so the
 * scheduler and the serving path can republish exactly then.
 */
export async function publishExports(
  tx: Tx,
  ctx: Context,
  listing: Listing,
  blocks: BlockState[],
  now: Date,
) {
  const connections = await tx.channelConnection.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      listingId: listing.id,
      enabled: true,
    },
  });
  const today = todayIn(listing.timezone, now.getTime());
  let refreshOn: string | null = null;
  for (const c of connections) {
    const events = buildExportEvents({
      blocks,
      destinationConnectionId: c.id,
      defaultBufferDays: listing.bufferDays,
      today,
    });
    const next = exportRefreshOn(events);
    if (next && (!refreshOn || next < refreshOn)) refreshOn = next;
    const digest = exportDigest(events);
    const latest = await tx.exportVersion.findFirst({
      where: { workspaceId: ctx.workspaceId, connectionId: c.id },
      orderBy: { version: "desc" },
    });
    if (latest?.bodyDigest === digest) continue;
    const version = (latest?.version ?? 0) + 1;
    const coverage = exportCoverage(events);
    await tx.exportVersion.create({
      data: {
        id: randomUUID(),
        workspaceId: ctx.workspaceId,
        connectionId: c.id,
        version,
        bodyDigest: digest,
        body: renderExport(events, now.toISOString()),
        sourceRevision: listing.calendarRevision,
        eventCount: events.length,
        coverageStart: coverage.start ? fromLocalDate(coverage.start) : null,
        coverageEnd: coverage.end ? fromLocalDate(coverage.end) : null,
      },
    });
    await tx.exportVersion.updateMany({
      where: {
        workspaceId: ctx.workspaceId,
        connectionId: c.id,
        version: { lte: version - RETAINED_EXPORT_BODIES },
        body: { not: null },
      },
      data: { body: null },
    });
  }
  const stored = await tx.listing.findUniqueOrThrow({
    where: { id: listing.id },
    select: { exportRefreshOn: true },
  });
  if (
    (stored.exportRefreshOn ? toLocalDate(stored.exportRefreshOn) : null) !==
    refreshOn
  )
    await tx.listing.update({
      where: { id: listing.id },
      data: { exportRefreshOn: refreshOn ? fromLocalDate(refreshOn) : null },
    });
}

async function notifyDecisions(
  tx: Tx,
  ctx: Context,
  listing: Listing,
  decisions: Decision[],
  blocks: BlockState[],
) {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  for (const d of decisions) {
    const b = d.blockId ? byId.get(d.blockId) : undefined;
    if (!b) continue;
    const href = "/calendar?block=" + b.id;
    if (d.type === "AWAIT_DECISION_ABSENCE" || d.type === "CANCELLATION_REVIEW")
      await notify(
        tx,
        ctx,
        `cal:decision:${b.id}:${b.revision}`,
        d.type === "CANCELLATION_REVIEW"
          ? "A stay was cancelled at its source"
          : "A stay is no longer in its calendar",
        `${listing.name}: ${nightsText(b)} stay protected until you decide whether to reopen them.`,
        href,
      );
    else if (d.type === "REAPPEARED_AFTER_RELEASE")
      await notify(
        tx,
        ctx,
        `cal:returned:${b.id}:${b.revision}`,
        "Released dates returned in a source calendar",
        `${listing.name}: ${nightsText(b)} are protected again. Check the platform for a new booking.`,
        href,
      );
    else if (d.type === "BEYOND_COVERAGE")
      await notify(
        tx,
        ctx,
        `cal:coverage:${b.id}`,
        "A stay is outside its calendar's current range",
        `${listing.name}: ${nightsText(b)} remain protected. Confirm on the platform before reopening them.`,
        href,
      );
  }
}
