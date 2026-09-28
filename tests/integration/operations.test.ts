// Phase 0 operations against real PostgreSQL: the scheduler tick records
// durable progress under one lease (ARCH 03, OPS 01), the operations health
// endpoint reports heartbeat, progress, backup freshness and environment as
// separate signals (REC 01, SEC 04), and the shadow report prints evidence
// without guest details (REL 01).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { createTestDatabase, skip, type TestDatabase } from "./harness";

let t: TestDatabase | undefined;
let app: Awaited<ReturnType<typeof load>>;

async function load() {
  const db = await import("../../src/server/db");
  const jobs = await import("../../src/server/services/jobs");
  const ops = await import("../../src/server/routes/operations");
  const actions = await import("../../src/server/calendar/actions");
  const crypto = await import("../../src/server/crypto");
  const dates = await import("../../src/domain/calendar/dates");
  return { ...db, ...jobs, ...ops, ...actions, ...crypto, ...dates };
}

before(async () => {
  if (skip) return;
  t = await createTestDatabase();
  app = await load();
});
after(async () => {
  await app?.db.$disconnect();
  await t?.drop();
});

let workspaceId = "";
const FEED_SECRET = "s=feed-secret-value";

const health = (
  check?: string,
  auth = `Bearer ${process.env.MONITOR_SECRET}`,
) =>
  app.operationsHealth(
    new Request(
      `https://app.test/api/health/operations${check ? `?check=${check}` : ""}`,
      { headers: { authorization: auth } },
    ),
  );

test(
  "a tick claims due work and records durable progress (ARCH 03, OPS 01)",
  { skip },
  async () => {
    const w = await app.db.workspace.create({ data: { name: "Ops" } });
    workspaceId = w.id;
    const ctx = { workspaceId, actorId: "host", role: "HOST" as const };
    await app.tenant(ctx, async (tx) => {
      await tx.automationSettings.create({ data: { workspaceId } });
      const listing = await tx.listing.create({
        data: {
          workspaceId,
          name: "Ops cabin",
          address: "Integration test address",
          houseManualEncrypted: app.seal({}, workspaceId),
        },
      });
      await app.createConnection(tx, ctx, {
        listingId: listing.id,
        platform: "AIRBNB",
        url: `https://www.airbnb.com/calendar/ical/1.ics?${FEED_SECRET}`,
        label: null,
      });
    });
    const start = app.addDays(app.todayIn("UTC", Date.now()), 10);
    const end = app.addDays(start, 3);
    const feed = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//integration//EN",
      "BEGIN:VEVENT",
      "UID:ops-stay@airbnb.com",
      `DTSTART;VALUE=DATE:${start.replaceAll("-", "")}`,
      `DTEND;VALUE=DATE:${end.replaceAll("-", "")}`,
      "SUMMARY:Reserved",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const result = await app.runTick("WORKER", {
      fetcher: async () => ({
        kind: "BODY",
        status: 200,
        body: feed,
        etag: null,
        lastModified: null,
      }),
    });
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.claimed, 1);
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.backlog, 0);
    const tick = await app.db.schedulerTick.findUniqueOrThrow({
      where: { id: result.id },
    });
    assert.equal(tick.status, "COMPLETED");
    assert.equal(tick.claimed, 1);
    assert.ok(tick.completedAt && tick.durationMs !== null);
    const lease = await app.db.schedulerLease.findUniqueOrThrow({
      where: { id: "scheduler" },
    });
    assert.equal(lease.holder, null, "the lease is released");
    // Nothing is due any more, so the next tick claims nothing.
    const idle = await app.runTick("WORKER");
    assert.equal(idle.claimed, 0);
  },
);

test(
  "an overlapping tick is recorded as skipped and does no work",
  { skip },
  async () => {
    await app.db.schedulerLease.update({
      where: { id: "scheduler" },
      data: {
        holder: "another-clock",
        leaseUntil: new Date(Date.now() + 60_000),
      },
    });
    const skipped = await app.runTick("CRON_HTTP");
    assert.equal(skipped.status, "SKIPPED_OVERLAP");
    const row = await app.db.schedulerTick.findUniqueOrThrow({
      where: { id: skipped.id },
    });
    assert.equal(row.status, "SKIPPED_OVERLAP");
    await app.db.schedulerLease.update({
      where: { id: "scheduler" },
      data: { holder: null, leaseUntil: null },
    });
  },
);

test(
  "heartbeat, progress, backups and environment are separate checks (OPS 01, REC 01, SEC 04)",
  { skip },
  async () => {
    assert.equal((await health("heartbeat", "Bearer wrong")).status, 401);
    for (const check of ["heartbeat", "progress", "environment"]) {
      const response = await health(check);
      const json = await response.json();
      assert.equal(response.status, 200, `${check}: ${JSON.stringify(json)}`);
      assert.equal(json.checks[check].ok, true);
    }
    const noBackups = await health("backups");
    assert.equal(noBackups.status, 503);

    // Backup evidence is written by the backup role; here the owner stands in.
    const owner = new PrismaClient({ datasourceUrl: t!.ownerUrl });
    try {
      const now = new Date();
      for (const kind of ["POSTGRES", "STORAGE", "KEYS"])
        await owner.backupRun.create({
          data: {
            id: randomUUID(),
            kind,
            status: "SUCCEEDED",
            startedAt: now,
            completedAt: now,
            verifiedAt: now,
            recordedBy: "integration-tests",
          },
        });
    } finally {
      await owner.$disconnect();
    }
    assert.equal((await health("backups")).status, 200);
    assert.equal((await health()).status, 200, "every check passes");

    // A finished tick that left old due work behind fails progress, not heartbeat.
    const now = Date.now();
    await app.db.schedulerTick.create({
      data: {
        id: randomUUID(),
        trigger: "WORKER",
        status: "COMPLETED",
        startedAt: new Date(now - 1000),
        completedAt: new Date(now),
        durationMs: 1000,
        backlog: 7,
        oldestDueAt: new Date(now - 2 * 3_600_000),
      },
    });
    const progress = await health("progress");
    assert.equal(progress.status, 503);
    assert.match(
      (await progress.json()).checks.progress.detail,
      /falling behind/,
    );
    assert.equal((await health("heartbeat")).status, 200);
  },
);

test(
  "the shadow report prints evidence without secrets or guest details (REL 01)",
  { skip },
  async () => {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/shadow-report.ts",
        workspaceId,
        "--days",
        "7",
      ],
      { cwd: path.resolve("."), env: { ...process.env, ...t!.env } },
    ).toString();
    const report = JSON.parse(output);
    assert.equal(report.mode, "SHADOW");
    assert.equal(report.connections.length, 1);
    assert.equal(report.connections[0].checks, 1);
    assert.equal(report.connections[0].daysWithAcceptedCheck, 1);
    assert.equal(
      report.adjudicate.unknown.length,
      1,
      "the unanswered policy leaves the stay unknown",
    );
    assert.equal(output.includes(FEED_SECRET), false);
    assert.equal(output.includes("Reserved"), false);
    const markdown = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/shadow-report.ts",
        workspaceId,
        "--markdown",
      ],
      { cwd: path.resolve("."), env: { ...process.env, ...t!.env } },
    ).toString();
    assert.match(
      markdown,
      /## To adjudicate against source evidence and fixtures/,
    );
    assert.match(markdown, /- \[ \] /);
  },
);
