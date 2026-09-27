// OPS 01 / REC 01 / SEC 04: the endpoint an external monitor polls. It needs a
// bearer MONITOR_SECRET, reports only timestamps and counts (never tenant
// data), and answers 503 when any requested check fails, so an uptime monitor
// can alert on the status code alone. The scheduler heartbeat and the work
// progress signal are separate checks: a clock that fires while work stalls
// must alert just as loudly as a clock that stopped.
import { db, environmentMismatch } from "../db";
import { equal } from "../crypto";

const CHECKS = ["heartbeat", "progress", "backups", "environment"] as const;
type Check = (typeof CHECKS)[number];
type Result = { ok: boolean; detail: string } & Record<string, unknown>;

const BACKUP_KINDS = ["POSTGRES", "STORAGE", "KEYS"] as const;

const minutes = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** Thresholds, overridable per deployment without code changes. */
export const thresholds = () => ({
  heartbeatMs: minutes("OPS_HEARTBEAT_MAX_MINUTES", 5) * 60_000,
  progressMs: minutes("OPS_PROGRESS_MAX_MINUTES", 15) * 60_000,
  lagMs: minutes("OPS_BACKLOG_MAX_LAG_MINUTES", 30) * 60_000,
  backupMs: minutes("OPS_BACKUP_MAX_AGE_HOURS", 26) * 3_600_000,
});

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const age = (now: number, d: Date | null | undefined) =>
  d ? Math.round((now - d.getTime()) / 1000) : null;

/** The clock is calling: any recorded tick, including a skipped overlap. */
async function heartbeat(now: number): Promise<Result> {
  const { heartbeatMs } = thresholds();
  const tick = await db.schedulerTick.findFirst({
    orderBy: { startedAt: "desc" },
    select: { startedAt: true, trigger: true, status: true },
  });
  const ok = !!tick && now - tick.startedAt.getTime() <= heartbeatMs;
  return {
    ok,
    detail: !tick
      ? "No scheduler tick has been recorded."
      : ok
        ? "The scheduler is calling."
        : "The scheduler has not called recently.",
    lastTickAt: iso(tick?.startedAt),
    ageSeconds: age(now, tick?.startedAt),
    maxAgeSeconds: heartbeatMs / 1000,
    trigger: tick?.trigger ?? null,
  };
}

/**
 * Work advanced: a tick completed recently, and when it finished the oldest
 * due calendar check and the oldest due outbox action were not overdue.
 */
async function progress(now: number): Promise<Result> {
  const { progressMs, lagMs } = thresholds();
  const tick = await db.schedulerTick.findFirst({
    where: { status: "COMPLETED" },
    orderBy: { completedAt: "desc" },
  });
  const failedSince = await db.schedulerTick.count({
    where: {
      status: "FAILED",
      ...(tick?.completedAt ? { startedAt: { gt: tick.completedAt } } : {}),
    },
  });
  if (!tick?.completedAt)
    return {
      ok: false,
      detail: "No scheduler tick has completed.",
      failedTicksSinceLastCompleted: failedSince,
    };
  const at = tick.completedAt.getTime();
  const calendarLag = tick.oldestDueAt ? at - tick.oldestDueAt.getTime() : 0;
  const outboxLag = tick.oldestOutboxDueAt
    ? at - tick.oldestOutboxDueAt.getTime()
    : 0;
  const fresh = now - at <= progressMs;
  const ok = fresh && calendarLag <= lagMs && outboxLag <= lagMs;
  return {
    ok,
    detail: !fresh
      ? "No scheduler tick has completed recently."
      : calendarLag > lagMs
        ? "Due calendar checks are falling behind."
        : outboxLag > lagMs
          ? "Due outbox actions are falling behind."
          : "Due work is being claimed and completed.",
    lastCompletedAt: iso(tick.completedAt),
    ageSeconds: age(now, tick.completedAt),
    maxAgeSeconds: progressMs / 1000,
    claimed: tick.claimed,
    completed: tick.completed,
    failed: tick.failed,
    retries: tick.retries,
    dispatched: tick.dispatched,
    backlog: tick.backlog,
    oldestDueAt: iso(tick.oldestDueAt),
    oldestOutboxDueAt: iso(tick.oldestOutboxDueAt),
    maxLagSeconds: lagMs / 1000,
    failedTicksSinceLastCompleted: failedSince,
  };
}

/** REC 01: each backup path has a recent, verified success. */
async function backups(now: number): Promise<Result> {
  const { backupMs } = thresholds();
  const kinds: Record<string, unknown> = {};
  let ok = true;
  for (const kind of BACKUP_KINDS) {
    const success = await db.backupRun.findFirst({
      where: { kind, status: "SUCCEEDED", verifiedAt: { not: null } },
      orderBy: { completedAt: "desc" },
      select: { completedAt: true, verifiedAt: true },
    });
    const failure = await db.backupRun.findFirst({
      where: {
        kind,
        status: "FAILED",
        ...(success ? { completedAt: { gt: success.completedAt } } : {}),
      },
      orderBy: { completedAt: "desc" },
      select: { completedAt: true },
    });
    const fresh = !!success && now - success.completedAt.getTime() <= backupMs;
    ok &&= fresh;
    kinds[kind] = {
      ok: fresh,
      lastVerifiedAt: iso(success?.verifiedAt),
      lastSucceededAt: iso(success?.completedAt),
      ageSeconds: age(now, success?.completedAt),
      failedSinceSuccessAt: iso(failure?.completedAt),
    };
  }
  return {
    ok,
    detail: ok
      ? "Every backup path has a recent verified copy."
      : "A backup path has no recent verified copy.",
    maxAgeSeconds: backupMs / 1000,
    kinds,
  };
}

/** SEC 04: this deployment is attached to a database of its environment. */
async function environment(): Promise<Result> {
  const marker = await db.deploymentEnvironment.findUnique({
    where: { id: 1 },
    select: { name: true, markedAt: true },
  });
  const problem = environmentMismatch(
    process.env.APP_ENVIRONMENT,
    marker?.name ?? null,
    process.env.VERCEL_ENV,
  );
  return {
    ok: !problem,
    detail: problem ?? "The database environment matches this deployment.",
    appEnvironment: process.env.APP_ENVIRONMENT ?? null,
    databaseEnvironment: marker?.name ?? null,
    markedAt: iso(marker?.markedAt),
  };
}

const respond = (status: number, value: unknown) =>
  Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

export async function operationsHealth(request: Request) {
  const secret = process.env.MONITOR_SECRET;
  if (!secret || secret.length < 32)
    return respond(503, {
      status: "unconfigured",
      detail: "Set MONITOR_SECRET (at least 32 characters) to enable checks.",
    });
  if (!equal(request.headers.get("authorization") || "", `Bearer ${secret}`))
    return respond(401, { status: "unauthorized" });
  const requested = new URL(request.url).searchParams.get("check");
  const selected = requested
    ? requested.split(",").map((c) => c.trim())
    : [...CHECKS];
  if (!selected.every((c): c is Check => CHECKS.includes(c as Check)))
    return respond(400, {
      status: "invalid",
      detail: `check must list any of: ${CHECKS.join(", ")}`,
    });
  const now = Date.now();
  const results: Partial<Record<Check, Result>> = {};
  try {
    for (const check of selected as Check[])
      results[check] =
        check === "heartbeat"
          ? await heartbeat(now)
          : check === "progress"
            ? await progress(now)
            : check === "backups"
              ? await backups(now)
              : await environment();
  } catch (error) {
    return respond(503, {
      status: "failing",
      checkedAt: new Date(now).toISOString(),
      detail: "The operations database could not be read.",
      errorType: error instanceof Error ? error.name : "Unknown",
    });
  }
  const ok = Object.values(results).every((r) => r.ok);
  return respond(ok ? 200 : 503, {
    status: ok ? "ok" : "failing",
    checkedAt: new Date(now).toISOString(),
    checks: results,
  });
}
