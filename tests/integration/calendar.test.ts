// Phase 1 critical invariants against real PostgreSQL, through the same code
// paths production uses: fenced runs, commits, exports, host decisions and
// the go-live script, as a NOSUPERUSER NOBYPASSRLS role under forced RLS.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { after, before, test } from "node:test";
import fc from "fast-check";
import { createTestDatabase, skip, type TestDatabase } from "./harness";

type App = Awaited<ReturnType<typeof load>>;
let t: TestDatabase | undefined;
let app: App;

async function load() {
  const db = await import("../../src/server/db");
  const actions = await import("../../src/server/calendar/actions");
  const run = await import("../../src/server/calendar/run");
  const serve = await import("../../src/server/calendar/serve");
  const crypto = await import("../../src/server/crypto");
  const dates = await import("../../src/domain/calendar/dates");
  return { ...db, ...actions, ...run, ...serve, ...crypto, ...dates };
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

// Dates relative to today keep the suite valid whenever it runs.
const day = (n: number) => app.addDays(app.todayIn("UTC", Date.now()), n);
const compact = (d: string) => d.replaceAll("-", "");
const ics = (...events: [string, number, number, string?, string[]?][]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//integration//EN",
    ...events.flatMap(([uid, from, to, summary, extra]) => [
      "BEGIN:VEVENT",
      `UID:${uid}`,
      "DTSTAMP:20260101T000000Z",
      `DTSTART;VALUE=DATE:${compact(day(from))}`,
      `DTEND;VALUE=DATE:${compact(day(to))}`,
      ...(summary ? [`SUMMARY:${summary}`] : []),
      ...(extra ?? []),
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ].join("\r\n");
const body = (text: string) => async () => ({
  kind: "BODY" as const,
  status: 200 as const,
  body: text,
  etag: null,
  lastModified: null,
});
const minutes = (n: number) => new Date(Date.now() + n * 60_000);

async function seedWorkspace(name: string) {
  const w = await app.db.workspace.create({ data: { name } });
  const ctx = {
    workspaceId: w.id,
    actorId: `host-${name}`,
    role: "HOST" as const,
  };
  const listing = await app.tenant(ctx, async (tx) => {
    await tx.automationSettings.create({
      data: { workspaceId: w.id, paused: false, cleaning: true },
    });
    return tx.listing.create({
      data: {
        workspaceId: w.id,
        name: `${name} cabin`,
        address: "Integration test address",
        timezone: "UTC",
        houseManualEncrypted: app.seal({ wifi: "" }, w.id),
        bufferDays: 1,
      },
    });
  });
  return { ctx, listing };
}

const tokenOf = (exportUrl: string) =>
  new URL(exportUrl).searchParams.get("token")!;

let A: Awaited<ReturnType<typeof seedWorkspace>>;
let airbnb: { id: string; token: string };
let everywhere: { id: string; token: string };
const AIRBNB_FEED = () =>
  ics(
    ["stay-1@airbnb.com", 10, 13, "Reserved"],
    ["closed-1@airbnb.com", 16, 18, "Airbnb (Not available)"],
    ["stay-2@airbnb.com", 20, 24, "Reserved"],
  );

test(
  "a check applies, the host answers the policy question, exports are versioned (CAL 01, CLASS 02, EXPORT 01)",
  { skip },
  async () => {
    A = await seedWorkspace("A");
    const created = await app.tenant(A.ctx, (tx) =>
      app.createConnection(tx, A.ctx, {
        listingId: A.listing.id,
        platform: "AIRBNB",
        url: "https://www.airbnb.com/calendar/ical/123.ics?s=secret",
        label: null,
      }),
    );
    airbnb = { id: created.connection.id, token: tokenOf(created.exportUrl) };
    const exportOnly = await app.tenant(A.ctx, (tx) =>
      app.createConnection(tx, A.ctx, {
        listingId: A.listing.id,
        platform: "OTHER",
        url: null,
        label: "All-channel export link",
      }),
    );
    everywhere = {
      id: exportOnly.connection.id,
      token: tokenOf(exportOnly.exportUrl),
    };

    const first = await app.runConnection(A.ctx, airbnb.id, {
      trigger: "MANUAL",
      fetcher: body(AIRBNB_FEED()),
    });
    assert.equal(first?.outcome, "BODY");
    assert.equal(
      first?.result,
      "NEEDS_REVIEW",
      "the policy question is pending",
    );
    await app.tenant(A.ctx, async (tx) => {
      const blocks = await tx.availabilityBlock.findMany({
        where: { workspaceId: A.ctx.workspaceId },
      });
      assert.equal(blocks.length, 3);
      assert.ok(blocks.every((b) => b.classification === "UNKNOWN"));
      assert.equal(await tx.reservation.count(), 0);
      const observation = await tx.feedObservation.findFirstOrThrow({
        where: { connectionId: airbnb.id },
      });
      assert.equal(observation.accepted, true);
      assert.equal(observation.mode, "SHADOW");
      // DATA 03: no raw body or description is stored anywhere.
      assert.equal(JSON.stringify(observation).includes("Reserved"), false);
    });

    const sample = await app.tenant(A.ctx, (tx) =>
      app.policySample(tx, A.ctx, airbnb.id),
    );
    assert.deepEqual(
      sample.labels.map((l) => [l.key, l.count, l.suggested]).sort(),
      [
        ["not-available", 1, "OWNER_BLOCK"],
        ["reserved", 2, "RESERVATION"],
      ],
    );
    const answered = await app.tenant(A.ctx, (tx) =>
      app.setClassificationPolicy(tx, A.ctx, airbnb.id, {
        mode: "BY_LABEL",
        labels: { reserved: "RESERVATION", "not-available": "OWNER_BLOCK" },
        expectedVersion: 0,
        sampleDigest: sample.sampleDigest,
      }),
    );
    assert.equal(answered.reclassified, 3);
    await app.tenant(A.ctx, async (tx) => {
      const reservations = await tx.reservation.findMany();
      assert.equal(reservations.length, 2);
      assert.ok(reservations.every((r) => r.status === "CONFIRMED"));
      // Shadow mode withholds turnover work.
      assert.equal(await tx.cleaningTask.count(), 0);
      assert.ok(
        (await tx.exportVersion.count({
          where: { connectionId: airbnb.id },
        })) >= 1,
      );
    });
  },
);

test(
  "shadow mode serves no calendar; going live creates the withheld turnovers (REL 01, CLEAN 01)",
  { skip },
  async () => {
    const shadow = await app.serveExport({
      workspaceId: A.ctx.workspaceId,
      listingId: A.listing.id,
      token: everywhere.token,
      connectionId: null,
      method: "GET",
      ifNoneMatch: null,
    });
    assert.equal(shadow.status, 503);
    assert.equal(shadow.headers.get("retry-after"), "3600");

    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/calendar-mode.ts",
        A.ctx.workspaceId,
        "LIVE",
        "--reviewed",
        "integration test review",
      ],
      { cwd: path.resolve("."), env: { ...process.env, ...t!.env } },
    ).toString();
    const result = JSON.parse(output);
    assert.deepEqual([result.from, result.to], ["SHADOW", "LIVE"]);
    assert.equal(result.reconciledReservations, 2);
    await app.tenant(A.ctx, async (tx) => {
      const tasks = await tx.cleaningTask.findMany();
      assert.equal(tasks.length, 2);
      assert.ok(
        tasks.every((t) => t.taskType === "TURNOVER" && t.reservationId),
      );
    });
    // Idempotent: running it again changes nothing.
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/calendar-mode.ts",
        A.ctx.workspaceId,
        "LIVE",
        "--reviewed",
        "again",
      ],
      { cwd: path.resolve("."), env: { ...process.env, ...t!.env } },
    );
    await app.tenant(A.ctx, async (tx) =>
      assert.equal(await tx.cleaningTask.count(), 2),
    );
  },
);

test(
  "exports: own stays excluded, buffers kept, ETag/304/HEAD, rotation (EXPORT 01-03)",
  { skip },
  async () => {
    const request = (
      token: string,
      method: "GET" | "HEAD",
      ifNoneMatch: string | null = null,
      connectionId: string | null = null,
    ) =>
      app.serveExport({
        workspaceId: A.ctx.workspaceId,
        listingId: A.listing.id,
        token,
        connectionId,
        method,
        ifNoneMatch,
      });
    const own = await request(airbnb.token, "GET", null, airbnb.id);
    assert.equal(own.status, 200);
    const ownText = await own.text();
    const blocks = await app.tenant(A.ctx, (tx) =>
      tx.availabilityBlock.findMany(),
    );
    for (const b of blocks) {
      // Airbnb's own stays never go back to Airbnb; their buffers do.
      assert.equal(ownText.includes(`UID:${b.id}@airbnb-automation`), false);
    }
    assert.ok(ownText.includes("-post@airbnb-automation"));
    const all = await request(everywhere.token, "GET");
    const allText = await all.text();
    for (const b of blocks)
      assert.ok(allText.includes(`UID:${b.id}@airbnb-automation`));

    const etag = all.headers.get("etag")!;
    assert.match(etag, /^"[0-9a-f]{64}"$/);
    assert.equal((await request(everywhere.token, "GET", etag)).status, 304);
    const head = await request(everywhere.token, "HEAD");
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal(
      head.headers.get("content-length"),
      String(Buffer.byteLength(allText)),
    );

    const evidence = await app.tenant(A.ctx, (tx) =>
      app.exportEvidence(tx, A.ctx, everywhere.id),
    );
    assert.ok(evidence.latestVersionFirstRetrievedAt);
    assert.equal(evidence.lastValidation?.responseClass, "HEAD");

    const rotated = await app.tenant(A.ctx, (tx) =>
      app.rotateExportToken(tx, A.ctx, everywhere.id),
    );
    assert.ok(rotated);
    assert.equal((await request(everywhere.token, "GET")).status, 404);
    assert.equal((await request(tokenOf(rotated.url), "GET")).status, 200);
    const revoked = await app.tenant(A.ctx, (tx) =>
      tx.revokedExportToken.findFirstOrThrow({
        where: { connectionId: everywhere.id },
      }),
    );
    assert.equal(revoked.hits, 1);
    everywhere.token = tokenOf(rotated.url);
  },
);

test(
  "repeating the same check changes nothing (CAL 04)",
  { skip },
  async () => {
    const revision = async () =>
      (
        await app.tenant(A.ctx, (tx) =>
          tx.listing.findUniqueOrThrow({ where: { id: A.listing.id } }),
        )
      ).calendarRevision;
    const events = () => app.tenant(A.ctx, (tx) => tx.domainEvent.count());
    const [r0, e0] = [await revision(), await events()];
    const again = await app.runConnection(A.ctx, airbnb.id, {
      trigger: "MANUAL",
      fetcher: body(AIRBNB_FEED()),
    });
    assert.equal(again?.result, "NO_CHANGES");
    assert.equal(await revision(), r0);
    assert.equal(await events(), e0);
  },
);

test(
  "a vanished stay stays protected until the host reopens it; restore compensates (LIFE 01-03, CLEAN 03)",
  { skip },
  async () => {
    const withoutStay1 = ics(
      ["closed-1@airbnb.com", 16, 18, "Airbnb (Not available)"],
      ["stay-2@airbnb.com", 20, 24, "Reserved"],
    );
    const stay1 = () =>
      app.tenant(A.ctx, (tx) =>
        tx.availabilityBlock.findFirstOrThrow({
          where: { sourceKey: "stay-1@airbnb.com" },
        }),
      );
    await app.runConnection(A.ctx, airbnb.id, {
      trigger: "MANUAL",
      fetcher: body(withoutStay1),
      now: () => minutes(20),
    });
    assert.equal((await stay1()).lifecycle, "MISSING_OBSERVED");
    await app.runConnection(A.ctx, airbnb.id, {
      trigger: "MANUAL",
      fetcher: body(withoutStay1),
      now: () => minutes(40),
    });
    const waiting = await stay1();
    assert.equal(waiting.lifecycle, "AWAITING_DECISION");
    assert.equal(waiting.decisionReason, "ABSENCE");
    await app.tenant(A.ctx, async (tx) => {
      const reservation = await tx.reservation.findFirstOrThrow({
        where: { blockId: waiting.id },
      });
      const task = await tx.cleaningTask.findFirstOrThrow({
        where: { reservationId: reservation.id },
      });
      assert.equal(task.reviewRequired, true);
      assert.equal(task.reviewReason, "RESERVATION_UNDER_REVIEW");
    });
    const served = async () =>
      (
        await app.serveExport({
          workspaceId: A.ctx.workspaceId,
          listingId: A.listing.id,
          token: everywhere.token,
          connectionId: null,
          method: "GET",
          ifNoneMatch: null,
        })
      ).text();
    assert.ok(
      (await served()).includes(`UID:${waiting.id}@airbnb-automation`),
      "still protected everywhere",
    );

    // CAL 03: a decision against an older revision is refused.
    await assert.rejects(
      app.tenant(A.ctx, (tx) =>
        app.keepDatesBlocked(tx, A.ctx, waiting.id, {
          expectedRevision: waiting.revision - 1,
          reason: "stale",
        }),
      ),
      (e: { status?: number }) => e.status === 409,
    );
    // LIFE 03: an imported stay reopens only after the host confirms the platform.
    await assert.rejects(
      app.tenant(A.ctx, (tx) =>
        app.releaseDates(tx, A.ctx, waiting.id, {
          expectedRevision: waiting.revision,
          reason: "cancelled",
          externalResolutionConfirmed: false,
        }),
      ),
      (e: { code?: string }) => e.code === "CONFIRM_REQUIRED",
    );
    await app.tenant(A.ctx, (tx) =>
      app.releaseDates(tx, A.ctx, waiting.id, {
        expectedRevision: waiting.revision,
        reason: "guest cancelled",
        externalResolutionConfirmed: true,
      }),
    );
    const released = await stay1();
    assert.equal(released.lifecycle, "RELEASED");
    assert.equal(
      (await served()).includes(`UID:${waiting.id}@airbnb-automation`),
      false,
    );
    await app.tenant(A.ctx, async (tx) => {
      const reservation = await tx.reservation.findFirstOrThrow({
        where: { blockId: waiting.id },
      });
      assert.equal(reservation.status, "CANCELLED");
      const task = await tx.cleaningTask.findFirstOrThrow({
        where: { reservationId: reservation.id },
      });
      assert.equal(task.status, "CANCELLED");
      assert.equal(task.closeReason, "RESERVATION_RELEASED");
    });

    const hold = await app.tenant(A.ctx, (tx) =>
      app.restoreDates(tx, A.ctx, waiting.id, {
        expectedRevision: released.revision,
        reason: "guest rebooked",
      }),
    );
    assert.equal(hold.holdType, "RESTORED");
    assert.equal(hold.compensatesBlockId, waiting.id);
    assert.ok((await served()).includes(`UID:${hold.id}@airbnb-automation`));
  },
);

test(
  "failed, empty and repeated anomalous checks never remove protection (section 10, CAL 04)",
  { skip },
  async () => {
    const protectedCount = () =>
      app.tenant(A.ctx, (tx) =>
        tx.availabilityBlock.count({
          where: { lifecycle: { not: "RELEASED" } },
        }),
      );
    const before = await protectedCount();
    const failed = await app.runConnection(A.ctx, airbnb.id, {
      trigger: "MANUAL",
      fetcher: async () => ({
        kind: "FAILED" as const,
        code: "FETCH_TIMEOUT" as const,
        status: null,
        retryAfterMs: null,
      }),
      now: () => minutes(60),
    });
    assert.equal(failed?.result, "COULD_NOT_CHECK");
    const connection = () =>
      app.tenant(A.ctx, (tx) =>
        tx.channelConnection.findUniqueOrThrow({ where: { id: airbnb.id } }),
      );
    assert.equal((await connection()).health, "FAILING");
    assert.ok((await connection()).nextFetchAt > minutes(60));
    for (const at of [80, 100]) {
      const empty = await app.runConnection(A.ctx, airbnb.id, {
        trigger: "MANUAL",
        fetcher: body(ics()),
        now: () => minutes(at),
      });
      assert.equal(empty?.result, "NEEDS_REVIEW");
      assert.equal((await connection()).anomalyHealth, "EMPTY_ANOMALY");
    }
    assert.equal(await protectedCount(), before);
  },
);

test("a superseded worker cannot commit (CAL 03)", { skip }, async () => {
  const blocksBefore = await app.tenant(A.ctx, (tx) =>
    tx.availabilityBlock.count(),
  );
  const summary = await app.runConnection(A.ctx, airbnb.id, {
    trigger: "MANUAL",
    now: () => minutes(120),
    fetcher: async () => {
      // Another worker claims the connection while this fetch is in flight.
      await app.tenant(A.ctx, (tx) =>
        tx.channelConnection.update({
          where: { id: airbnb.id },
          data: { leaseToken: "another-worker", fence: { increment: 1 } },
        }),
      );
      return body(ics(["late@airbnb.com", 40, 42, "Reserved"]))();
    },
  });
  assert.equal(summary?.outcome, "LEASE_LOST");
  assert.equal(
    await app.tenant(A.ctx, (tx) => tx.availabilityBlock.count()),
    blocksBefore,
  );
  await app.tenant(A.ctx, (tx) =>
    tx.channelConnection.update({
      where: { id: airbnb.id },
      data: { leaseToken: null, leaseUntil: null },
    }),
  );
});

test(
  "overlaps across calendars open one canonical case each (CONFLICT 01)",
  { skip },
  async () => {
    const vrbo = await app.tenant(A.ctx, (tx) =>
      app.createConnection(tx, A.ctx, {
        listingId: A.listing.id,
        platform: "VRBO",
        url: "https://www.vrbo.com/icalendar/abc.ics",
        label: null,
      }),
    );
    const feed = ics(["vrbo-stay@vrbo.com", 21, 23, "Reserved - Guest"]);
    for (const at of [130, 150])
      await app.runConnection(A.ctx, vrbo.connection.id, {
        trigger: "MANUAL",
        fetcher: body(feed),
        now: () => minutes(at),
      });
    const cases = await app.tenant(A.ctx, (tx) =>
      tx.conflictCase.findMany({ where: { state: "OPEN" } }),
    );
    const overlap = cases.filter(
      (c) => c.overlapStart.toISOString().slice(0, 10) === day(21),
    );
    assert.equal(overlap.length, 1, "one case, not one per check");
    assert.ok(
      Buffer.compare(
        Buffer.from(overlap[0].blockAId),
        Buffer.from(overlap[0].blockBId),
      ) < 0,
    );
    await app.tenant(A.ctx, (tx) =>
      app.recordConflictResolution(tx, A.ctx, overlap[0].id, {
        expectedRevision: overlap[0].revision,
        note: "Guest moved to another property",
      }),
    );
    const resolved = await app.tenant(A.ctx, (tx) =>
      tx.conflictCase.findUniqueOrThrow({ where: { id: overlap[0].id } }),
    );
    assert.equal(resolved.state, "RESOLVED");
  },
);

test(
  "tenant boundaries hold for the application role across randomized writes (SEC 01, QA 01)",
  { skip },
  async () => {
    const B = await seedWorkspace("B");
    const owners = new Map<string, string>();
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            tenant: fc.boolean(),
            start: fc.integer({ min: 60, max: 400 }),
            nights: fc.integer({ min: 1, max: 5 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        async (holds) => {
          for (const h of holds) {
            const who = h.tenant ? A : B;
            const block = await app.tenant(who.ctx, (tx) =>
              app.createHold(tx, who.ctx, {
                listingId: who.listing.id,
                from: day(h.start),
                to: day(h.start + h.nights),
                holdType: "OWNER",
                reason: "randomized",
                clientRequestId: crypto.randomUUID(),
                acknowledgeOverlaps: true,
              }),
            );
            owners.set(block.id, who.ctx.workspaceId);
          }
          for (const who of [A, B]) {
            await app.tenant(who.ctx, async (tx) => {
              for (const table of [
                "availabilityBlock",
                "exportVersion",
                "domainEvent",
                "auditLog",
              ] as const) {
                const rows = await (
                  tx[table] as unknown as {
                    findMany: (a: object) => Promise<{ workspaceId: string }[]>;
                  }
                ).findMany({ select: { workspaceId: true } });
                assert.ok(
                  rows.every((r) => r.workspaceId === who.ctx.workspaceId),
                  table,
                );
              }
              const foreign = [...owners]
                .filter(([, w]) => w !== who.ctx.workspaceId)
                .map(([id]) => id);
              assert.equal(
                await tx.availabilityBlock.count({
                  where: { id: { in: foreign } },
                }),
                0,
              );
              const touched = await tx.availabilityBlock.updateMany({
                where: { id: { in: foreign } },
                data: { reviewFlags: [] },
              });
              assert.equal(touched.count, 0);
            });
          }
        },
      ),
      { numRuns: 12 },
    );
  },
);
