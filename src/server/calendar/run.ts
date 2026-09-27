// One calendar run for one connection (CAL 01): claim under a lease fence,
// fetch outside any transaction, then decide and apply in a single fenced
// transaction. Every run, including failures, records an observation with its
// rules version, outcome and reason codes.
import { randomUUID } from "node:crypto";
import { RULES_VERSION } from "@/domain/calendar/capabilities";
import { todayIn } from "@/domain/calendar/dates";
import type { Gate } from "@/domain/calendar/health";
import {
  planObservation,
  type FetchOutcome,
  type ObservationPlan,
  type Snapshot,
} from "@/domain/calendar/pipeline";
import { REASONS } from "@/domain/calendar/reasons";
import { isNearTerm, nextFetch } from "@/domain/calendar/schedule";
import { audit, notify } from "../audit";
import { appUrl } from "../config";
import { decrypt, randomToken, seal, unseal } from "../crypto";
import { lock, tenant, type Context, type Tx } from "../db";
import { reportError } from "../observability";
import {
  calendarMode,
  commitCalendarChange,
  loadPropertyBlocks,
} from "./commit";
import { fetchFeed, type FetchResult } from "./fetch";
import {
  connectionPolicy,
  fromLocalDate,
  platformOf,
  toLocalDate,
} from "./mappers";

export const LEASE_MS = 60_000;
/** DATA 03: keep comparison snapshots for the latest two accepted versions. */
const RETAINED_SNAPSHOTS = 2;
const MAX_RECORDED_DECISIONS = 50;

export type RunTrigger = "SCHEDULED" | "MANUAL";
export type RunSummary = {
  connectionId: string;
  outcome: "BODY" | "NOT_MODIFIED" | "FAILED" | "LEASE_LOST";
  result: string | null;
  retry: boolean;
};
type Fetcher = typeof fetchFeed;

/** FETCH 02: an honest user agent and a contact page identify the fetcher. */
export const userAgent = () =>
  `Hostsphere-CalendarFetcher/1.0 (+${appUrl()}/fetcher)`;

const allowedOps = (g: Gate) =>
  [
    g.additions && "ADDITIONS",
    g.updates !== "NONE" &&
      (g.updates === "ALL" ? "UPDATES" : "PROTECTIVE_UPDATES"),
    g.cancellationReview && "CANCELLATION_REVIEW",
    g.absenceReview && "ABSENCE_REVIEW",
  ].filter((x): x is string => !!x);

function toOutcome(f: FetchResult): FetchOutcome {
  if (f.kind === "BODY") return { outcome: "BODY", body: f.body };
  if (f.kind === "NOT_MODIFIED") return { outcome: "NOT_MODIFIED" };
  return { outcome: "FAILED", code: f.code };
}

export async function runConnection(
  ctx: Context,
  connectionId: string,
  opts: {
    trigger: RunTrigger;
    fetcher?: Fetcher;
    now?: () => Date;
    random?: () => number;
  },
): Promise<RunSummary | null> {
  const now = opts.now ?? (() => new Date());
  const random = opts.random ?? Math.random;
  const token = randomToken();
  const startedAt = now();

  // Stage 1: claim bounded work under a lease fence and capture the
  // property revision before any network work (CAL 03).
  const claim = await tenant(ctx, async (tx) => {
    const claimed = await tx.channelConnection.updateMany({
      where: {
        id: connectionId,
        workspaceId: ctx.workspaceId,
        enabled: true,
        importUrlEncrypted: { not: null },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: startedAt } }],
      },
      data: {
        leaseToken: token,
        leaseUntil: new Date(startedAt.getTime() + LEASE_MS),
        fence: { increment: 1 },
        lastAttemptAt: startedAt,
      },
    });
    if (!claimed.count) return null;
    const c = await tx.channelConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    const listing = await tx.listing.findUniqueOrThrow({
      where: { id: c.listingId },
    });
    const snapshotRow = c.lastAcceptedFingerprint
      ? await tx.feedObservation.findFirst({
          where: {
            workspaceId: ctx.workspaceId,
            connectionId,
            accepted: true,
            snapshotEncrypted: { not: null },
          },
          orderBy: { observedAt: "desc" },
          select: { snapshotEncrypted: true },
        })
      : null;
    return {
      fence: c.fence,
      platform: platformOf(c),
      etag: c.etag,
      lastModified: c.lastModified,
      retry: c.failures > 0,
      expectedRevision: listing.calendarRevision,
      url: decrypt(c.importUrlEncrypted, ctx.workspaceId),
      snapshot: snapshotRow?.snapshotEncrypted
        ? unseal<Snapshot>(snapshotRow.snapshotEncrypted, ctx.workspaceId)
        : null,
    };
  });
  if (!claim) return null;

  // Stage 2: bounded network work, outside any transaction. Validators are
  // sent only when a snapshot exists to interpret a 304 against (FETCH 02).
  let fetched: FetchResult;
  try {
    fetched = await (opts.fetcher ?? fetchFeed)(claim.url, {
      platform: claim.platform,
      etag: claim.snapshot ? claim.etag : null,
      lastModified: claim.snapshot ? claim.lastModified : null,
      userAgent: userAgent(),
    });
  } catch {
    fetched = {
      kind: "FAILED",
      code: "FETCH_INTERNAL",
      status: null,
      retryAfterMs: null,
    };
  }

  try {
    return await tenant(ctx, (tx) =>
      decideAndApply(tx, ctx, {
        connectionId,
        token,
        claim,
        fetched,
        startedAt,
        now,
        random,
        trigger: opts.trigger,
      }),
    );
  } catch (error) {
    reportError(error, "calendar-run");
    // Keep protection, record the failure, release the lease with a backoff.
    await tenant(ctx, async (tx) => {
      const c = await tx.channelConnection.findFirst({
        where: {
          id: connectionId,
          workspaceId: ctx.workspaceId,
          leaseToken: token,
        },
      });
      if (!c) return;
      const at = now();
      const failures = c.failures + 1;
      const schedule = nextFetch({
        nowMs: at.getTime(),
        succeeded: false,
        failures,
        nearTerm: c.nearTerm,
        retryAfterMs: null,
        random: random(),
      });
      const observationId = randomUUID();
      await tx.feedObservation.create({
        data: {
          id: observationId,
          workspaceId: ctx.workspaceId,
          connectionId,
          trigger: opts.trigger,
          mode: await calendarMode(tx, ctx),
          startedAt,
          observedAt: at,
          durationMs: at.getTime() - startedAt.getTime(),
          fence: c.fence,
          outcome: "FAILED",
          failureCode: "FETCH_INTERNAL",
          complete: false,
          health: "FAILED",
          reasonCodes: ["FETCH_INTERNAL"],
          counts: {},
          rulesVersion: RULES_VERSION,
          result: "COULD_NOT_CHECK",
        },
      });
      await tx.channelConnection.update({
        where: { id: connectionId },
        data: {
          health: "FAILING",
          lastResult: "COULD_NOT_CHECK",
          lastObservationId: observationId,
          failures,
          nextFetchAt: new Date(schedule.atMs),
          leaseToken: null,
          leaseUntil: null,
        },
      });
    }).catch((e) => reportError(e, "calendar-run-recovery"));
    return {
      connectionId,
      outcome: "FAILED",
      result: "COULD_NOT_CHECK",
      retry: claim.retry,
    };
  }
}

async function decideAndApply(
  tx: Tx,
  ctx: Context,
  input: {
    connectionId: string;
    token: string;
    claim: {
      fence: number;
      retry: boolean;
      expectedRevision: number;
      snapshot: Snapshot | null;
      platform: ReturnType<typeof platformOf>;
    };
    fetched: FetchResult;
    startedAt: Date;
    now: () => Date;
    random: () => number;
    trigger: RunTrigger;
  },
): Promise<RunSummary> {
  const { connectionId, claim, fetched } = input;
  // CAL 03: an expired or superseded worker cannot commit stale decisions.
  const c = await tx.channelConnection.findFirst({
    where: { id: connectionId, workspaceId: ctx.workspaceId },
  });
  if (!c || c.leaseToken !== input.token || c.fence !== claim.fence)
    return {
      connectionId,
      outcome: "LEASE_LOST",
      result: null,
      retry: claim.retry,
    };
  await lock(tx, "listing:" + c.listingId);
  const listing = await tx.listing.findUniqueOrThrow({
    where: { id: c.listingId },
  });
  const mode = await calendarMode(tx, ctx);
  const blocks = await loadPropertyBlocks(tx, ctx, listing.id);
  const at = input.now();
  const today = todayIn(listing.timezone, at.getTime());
  // Stages 3-7 against the current committed state: a concurrent change during
  // the fetch simply means the plan is computed on the newer state.
  const plan: ObservationPlan = planObservation({
    fetch: toOutcome(fetched),
    snapshot: claim.snapshot,
    lastAcceptedFingerprint: c.lastAcceptedFingerprint,
    connection: {
      id: c.id,
      listingId: c.listingId,
      platform: claim.platform,
      policy: connectionPolicy(c),
      coverageEnd: c.coverageEnd ? toLocalDate(c.coverageEnd) : null,
    },
    property: { zone: listing.timezone, checkoutHour: listing.checkoutHour },
    blocks: blocks.filter((b) => b.connectionId === c.id),
    knownBlockIds: new Set(blocks.map((b) => b.id)),
    today,
    now: at.toISOString(),
    nextRevision: listing.calendarRevision + 1,
  });
  const observationId = randomUUID();
  const recomputed = listing.calendarRevision !== claim.expectedRevision;

  // Stages 8-10.
  await commitCalendarChange(tx, ctx, {
    listing,
    mode,
    change: {
      creates: plan.compare.creates,
      updates: plan.compare.updates,
      touches: plan.compare.touches,
      decisions: plan.compare.decisions,
    },
    before: new Map(blocks.map((b) => [b.id, b])),
    cause: { kind: "OBSERVATION", observationId, connectionId: c.id },
    now: at,
    auditReason: `Calendar source checked: ${REASONS[plan.reasons[0] ?? "BLOCK_UPDATED"] ?? "availability changed"}`,
  });

  const storeSnapshot = plan.accepted && plan.contentChanged && plan.snapshot;
  await tx.feedObservation.create({
    data: {
      id: observationId,
      workspaceId: ctx.workspaceId,
      connectionId: c.id,
      trigger: input.trigger,
      mode,
      startedAt: input.startedAt,
      observedAt: at,
      durationMs: Math.max(0, at.getTime() - input.startedAt.getTime()),
      fence: c.fence,
      httpStatus: fetched.status,
      outcome: plan.outcome,
      failureCode:
        plan.outcome === "FAILED"
          ? (plan.reasons[0] ?? "FETCH_INTERNAL")
          : null,
      complete: plan.snapshot?.complete ?? false,
      health: plan.gate.health,
      allowedOps: allowedOps(plan.gate),
      reasonCodes: plan.reasons,
      fingerprint: plan.snapshot?.fingerprint ?? null,
      coverageStart: plan.accepted ? fromLocalDate(today) : null,
      coverageEnd: plan.snapshot?.coverageEnd
        ? fromLocalDate(plan.snapshot.coverageEnd)
        : null,
      counts: plan.counts,
      decisions: {
        total: plan.compare.decisions.length,
        list: plan.compare.decisions
          .slice(0, MAX_RECORDED_DECISIONS)
          .map((d) => ({
            type: d.type,
            blockId: d.blockId,
            reasons: d.reasons,
          })),
      },
      rulesVersion: RULES_VERSION,
      result: plan.result,
      recomputed,
      accepted: plan.accepted,
      snapshotEncrypted: storeSnapshot
        ? seal(plan.snapshot, ctx.workspaceId)
        : null,
    },
  });
  if (storeSnapshot) {
    const keep = await tx.feedObservation.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        connectionId: c.id,
        snapshotEncrypted: { not: null },
      },
      orderBy: { observedAt: "desc" },
      take: RETAINED_SNAPSHOTS,
      select: { id: true },
    });
    await tx.feedObservation.updateMany({
      where: {
        workspaceId: ctx.workspaceId,
        connectionId: c.id,
        snapshotEncrypted: { not: null },
        id: { notIn: keep.map((k) => k.id) },
      },
      data: { snapshotEncrypted: null },
    });
  }

  // Health, validators and the next eligible check (FETCH 02/03).
  const failures = plan.accepted ? 0 : c.failures + 1;
  const retryAfterMs = fetched.kind === "FAILED" ? fetched.retryAfterMs : null;
  const nearTerm = isNearTerm(
    await loadPropertyBlocks(tx, ctx, listing.id),
    today,
  );
  const schedule = nextFetch({
    nowMs: at.getTime(),
    succeeded: plan.accepted,
    failures,
    nearTerm,
    retryAfterMs,
    random: input.random(),
  });
  const health = !plan.accepted
    ? schedule.pausedBySource
      ? "PAUSED_BY_SOURCE"
      : "FAILING"
    : plan.gate.health === "HEALTHY"
      ? "HEALTHY"
      : "DEGRADED";
  // Validators are kept only for complete bodies, so a truncated download is
  // fetched in full next time instead of being confirmed by a 304.
  const validators =
    fetched.kind === "BODY"
      ? plan.snapshot?.complete
        ? { etag: fetched.etag, lastModified: fetched.lastModified }
        : { etag: null, lastModified: null }
      : fetched.kind === "NOT_MODIFIED" && plan.accepted
        ? {
            etag: fetched.etag ?? c.etag,
            lastModified: fetched.lastModified ?? c.lastModified,
          }
        : plan.reasons.includes("SNAPSHOT_MISSING")
          ? { etag: null, lastModified: null }
          : {};
  await tx.channelConnection.update({
    where: { id: c.id },
    data: {
      health,
      lastResult: plan.result,
      lastObservationId: observationId,
      ...(plan.accepted && plan.snapshot
        ? {
            lastSuccessAt: at,
            lastAcceptedAt: at,
            lastAcceptedFingerprint: plan.snapshot.fingerprint,
            lastAcceptedComplete: plan.snapshot.complete,
            coverageEnd: plan.snapshot.coverageEnd
              ? fromLocalDate(plan.snapshot.coverageEnd)
              : null,
          }
        : {}),
      ...validators,
      failures,
      nearTerm,
      nextFetchAt: new Date(schedule.atMs),
      sourceRetryAfter: retryAfterMs ? new Date(retryAfterMs) : null,
      leaseToken: null,
      leaseUntil: null,
    },
  });
  if (mode === "LIVE")
    await notifyConnection(tx, ctx, {
      c,
      listingName: listing.name,
      plan,
      failures,
      paused: schedule.pausedBySource,
      retryAfterMs,
    });
  if (health === "PAUSED_BY_SOURCE")
    await audit(
      tx,
      ctx,
      "SOURCE_PAUSE",
      "ChannelConnection",
      c.id,
      "The calendar asked for a delay beyond the automatic retry window; checks wait until then. Dates remain protected.",
    );
  return {
    connectionId,
    outcome: plan.outcome,
    result: plan.result,
    retry: claim.retry,
  };
}

async function notifyConnection(
  tx: Tx,
  ctx: Context,
  input: {
    c: { id: string; policyVersion: number };
    listingName: string;
    plan: ObservationPlan;
    failures: number;
    paused: boolean;
    retryAfterMs: number | null;
  },
) {
  const { c, plan } = input;
  const href = "/properties?connection=" + c.id;
  if (!plan.accepted) {
    if (input.paused && input.retryAfterMs)
      await notify(
        tx,
        ctx,
        `cal:paused:${c.id}:${new Date(input.retryAfterMs).toISOString()}`,
        "A calendar asked us to wait",
        `${input.listingName}: checks resume after the time the source requested. Existing dates remain protected.`,
        href,
      );
    else if (input.failures === 3)
      await notify(
        tx,
        ctx,
        `cal:failing:${c.id}:${new Date().toISOString().slice(0, 10)}`,
        "A calendar could not be checked",
        `${input.listingName}: recent checks failed. Existing dates remain protected; review the connection.`,
        href,
      );
    return;
  }
  const fingerprint = plan.snapshot?.fingerprint ?? "none";
  if (
    plan.gate.health === "EMPTY_ANOMALY" ||
    plan.gate.health === "DROP_ANOMALY"
  )
    await notify(
      tx,
      ctx,
      `cal:anomaly:${c.id}:${fingerprint}`,
      plan.gate.health === "EMPTY_ANOMALY"
        ? "A calendar became empty"
        : "Many stays disappeared at once",
      `${input.listingName}: dates remain protected. Check the platform before reopening anything.`,
      href,
    );
  else if (plan.gate.health === "PARTIAL")
    await notify(
      tx,
      ctx,
      `cal:review:${c.id}:${fingerprint}`,
      "Some calendar events need review",
      `${input.listingName}: part of the calendar could not be read. Nothing was released.`,
      href,
    );
  if (plan.policyQuestion)
    await notify(
      tx,
      ctx,
      `cal:policy:${c.id}:${c.policyVersion}`,
      "How should this calendar's blocks be treated?",
      `${input.listingName}: answer once so stays can create turnover work. Until then dates stay protected and no cleaning is scheduled.`,
      href,
    );
}
