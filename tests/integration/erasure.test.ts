// Deleting a removed property permanently (PRIV 02), against real
// PostgreSQL through the runtime role. Only the owner can do it, with their
// password and the property's name, and only once the property is out of the
// app; the scheduler does it 30 days after removal. Everything stored for the
// property goes: stays and guest details, conversations, cleaning jobs and
// photos (in storage too), calendar links and their history, the alerts and
// queued work about it. Nothing else changes: not another property, not
// another workspace, not the cleaners, and not the append-only audit log.
// A ledger records each deletion with ids and counts only, and the recorded
// deletions can be applied again after a backup restore.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { createTestDatabase, skip, type TestDatabase } from "./harness";

let t: TestDatabase | undefined;
let app: Awaited<ReturnType<typeof load>>;

async function load() {
  const db = await import("../../src/server/db");
  const actions = await import("../../src/server/calendar/actions");
  const run = await import("../../src/server/calendar/run");
  const serve = await import("../../src/server/calendar/serve");
  const properties = await import("../../src/server/services/properties");
  const erasure = await import("../../src/server/services/erasure");
  const messaging = await import("../../src/server/services/messaging");
  const jobs = await import("../../src/server/services/jobs");
  const audit = await import("../../src/server/audit");
  const crypto = await import("../../src/server/crypto");
  const dates = await import("../../src/domain/calendar/dates");
  return {
    ...db,
    ...actions,
    ...run,
    ...serve,
    ...properties,
    ...erasure,
    ...messaging,
    runTick: jobs.runTick,
    notify: audit.notify,
    ...crypto,
    ...dates,
  };
}

const STORAGE = "https://storage.erasure.test";
/** Storage requests the code under test made, and how storage answers. */
const storage = { deleted: [] as string[], answer: 200 };
const realFetch = globalThis.fetch;

before(async () => {
  if (skip) return;
  t = await createTestDatabase();
  process.env.SUPABASE_URL = STORAGE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "storage-test-key";
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(STORAGE)) return realFetch(input, init);
    assert.equal(init?.method, "DELETE", "storage is only asked to delete");
    if (storage.answer !== 200)
      return new Response("unavailable", { status: storage.answer });
    storage.deleted.push(
      decodeURIComponent(url.split("/storage/v1/object/")[1]),
    );
    return new Response("{}", { status: 200 });
  };
  app = await load();
});
after(async () => {
  globalThis.fetch = realFetch;
  await app?.db.$disconnect();
  await t?.drop();
});
beforeEach(() => {
  storage.deleted = [];
  storage.answer = 200;
});

const PASSWORD = "erasure-owner-password";
const day = (n: number) => app.addDays(app.todayIn("UTC", Date.now()), n);
const compact = (d: string) => d.replaceAll("-", "");
/** Two stays that overlap, so the calendar also records an overlap. */
const FEED = () =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//integration//EN",
    ...(
      [
        ["stay-1@airbnb.com", 5, 8],
        ["stay-2@airbnb.com", 7, 10],
      ] as const
    ).flatMap(([uid, from, to]) => [
      "BEGIN:VEVENT",
      `UID:${uid}`,
      "DTSTAMP:20260101T000000Z",
      `DTSTART;VALUE=DATE:${compact(day(from))}`,
      `DTEND;VALUE=DATE:${compact(day(to))}`,
      "SUMMARY:Reserved",
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ].join("\r\n");
const fetched = (text: string) => async () => ({
  kind: "BODY" as const,
  status: 200 as const,
  body: text,
  etag: null,
  lastModified: null,
});
const refused = (work: Promise<unknown>, code: string) =>
  assert.rejects(work, (e: { code?: string }) => e.code === code);
const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;

type Ctx = { workspaceId: string; actorId: string; role: "HOST" };

/** A property with a checked calendar, stays, cleaning, a conversation and photos. */
async function property(ctx: Ctx, name: string) {
  const w = ctx.workspaceId;
  const listing = await app.tenant(ctx, (tx) =>
    tx.listing.create({
      data: {
        workspaceId: w,
        name,
        address: `${name} street 1`,
        timezone: "UTC",
        houseManualEncrypted: app.seal({ wifi: "secret" }, w),
      },
    }),
  );
  const created = await app.tenant(ctx, (tx) =>
    app.createConnection(tx, ctx, {
      listingId: listing.id,
      platform: "AIRBNB",
      url: `https://www.airbnb.com/calendar/ical/${randomUUID()}.ics?s=x`,
      label: null,
    }),
  );
  await app.runConnection(ctx, created.connection.id, {
    trigger: "MANUAL",
    fetcher: fetched(FEED()),
  });
  const sample = await app.tenant(ctx, (tx) =>
    app.policySample(tx, ctx, created.connection.id),
  );
  await app.tenant(ctx, (tx) =>
    app.setClassificationPolicy(tx, ctx, created.connection.id, {
      mode: "RESERVATIONS",
      labels: null,
      expectedVersion: 0,
      sampleDigest: sample.sampleDigest,
    }),
  );
  return {
    listing,
    connectionId: created.connection.id,
    token: tokenOf(created.exportUrl),
  };
}

/** Conversation, photos, a rule and an alert, once the workspace is live. */
async function dress(ctx: Ctx, p: Awaited<ReturnType<typeof property>>) {
  const w = ctx.workspaceId;
  const thread = await app.tenant(ctx, async (tx) => {
    const reservation = await tx.reservation.findFirstOrThrow({
      where: { listingId: p.listing.id },
      orderBy: { startDate: "asc" },
    });
    await tx.reservation.update({
      where: { id: reservation.id },
      data: {
        guestNameEncrypted: app.encrypt("Guest Person", w),
        guestContactEncrypted: app.encrypt("guest@example.test", w),
      },
    });
    const task = await tx.cleaningTask.findFirstOrThrow({
      where: { listingId: p.listing.id },
      orderBy: { scheduledAt: "asc" },
    });
    const photo = await tx.asset.create({
      data: {
        workspaceId: w,
        taskId: task.id,
        storageKey: `${w}/${randomUUID()}.webp`,
        mime: "image/webp",
        bytes: 10,
        sha256: "0".repeat(64),
      },
    });
    await tx.cleaningTask.update({
      where: { id: task.id },
      data: { photoId: photo.id },
    });
    const cover = await tx.asset.create({
      data: {
        workspaceId: w,
        listingId: p.listing.id,
        storageKey: `${w}/${randomUUID()}.webp`,
        mime: "image/webp",
        bytes: 10,
        sha256: "1".repeat(64),
      },
    });
    await tx.listing.update({
      where: { id: p.listing.id },
      data: { photoIds: [cover.id] },
    });
    await tx.automationRule.create({
      data: {
        workspaceId: w,
        listingId: p.listing.id,
        name: `${p.listing.name} check-in`,
        keywords: ["check in"],
        templateEncrypted: app.encrypt("Check-in is at 4pm.", w),
      },
    });
    await app.notify(
      tx,
      ctx,
      `buffer:${p.listing.id}:1`,
      "Buffer changed",
      `${p.listing.name}: the buffer changed.`,
      "/calendar",
    );
    return tx.thread.create({
      data: {
        workspaceId: w,
        listingId: p.listing.id,
        reservationId: reservation.id,
        externalId: randomUUID(),
        platform: "AIRBNB",
      },
    });
  });
  await app.tenant(ctx, (tx) =>
    tx.message.create({
      data: {
        workspaceId: w,
        threadId: thread.id,
        externalId: randomUUID(),
        sender: "GUEST",
        bodyEncrypted: app.encrypt("Is early check-in possible?", w),
      },
    }),
  );
  await app.tenant(ctx, (tx) =>
    app.reply(tx, ctx, thread.id, "See you soon.", randomUUID()),
  );
  // A platform reads the export link: versions and retrievals exist.
  const served = await app.serveExport({
    workspaceId: w,
    listingId: p.listing.id,
    token: p.token,
    connectionId: null,
    method: "GET",
    ifNoneMatch: null,
  });
  assert.equal(served.status, 200);
  return { ...p, thread };
}

/**
 * A live workspace with an owner who has a password, two properties (one to
 * delete, one to keep), a cleaner for both, and setup progress pointing at
 * the one to delete. Another workspace exists alongside it.
 */
async function seed(name: string) {
  const w = await app.db.workspace.create({ data: { name } });
  const owner = await app.db.user.create({
    data: {
      emailHash: randomUUID(),
      emailEncrypted: "test",
      name: `${name} owner`,
      passwordHash: app.passwordHash(PASSWORD),
    },
  });
  const ctx: Ctx = { workspaceId: w.id, actorId: owner.id, role: "HOST" };
  await app.tenant(ctx, (tx) =>
    tx.automationSettings.create({
      data: { workspaceId: w.id, paused: false, cleaning: true },
    }),
  );
  const gone = await property(ctx, `${name} cottage`);
  const kept = await property(ctx, `${name} lodge`);
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/calendar-mode.ts",
      w.id,
      "LIVE",
      "--reviewed",
      "integration test review",
    ],
    { cwd: path.resolve("."), env: { ...process.env, ...t!.env } },
  );
  const cleaner = await app.tenant(ctx, async (tx) => {
    const c = await tx.cleaner.create({
      data: {
        workspaceId: w.id,
        name: "Cleaner",
        phoneEncrypted: app.encrypt("+15555550100", w.id),
        listingIds: [gone.listing.id, kept.listing.id],
      },
    });
    for (const p of [gone, kept]) {
      const first = await tx.cleaningTask.findFirstOrThrow({
        where: { listingId: p.listing.id },
        orderBy: { scheduledAt: "asc" },
      });
      await tx.cleaningTask.update({
        where: { id: first.id },
        data: { status: "ASSIGNED", cleanerId: c.id },
      });
      await tx.magicLink.create({
        data: {
          workspaceId: w.id,
          taskId: first.id,
          cleanerId: c.id,
          tokenHash: randomUUID(),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
    }
    await tx.onboardingProgress.create({
      data: {
        workspaceId: w.id,
        step: "CLEANER",
        completed: ["PROPERTY", "CALENDAR"],
        skipped: ["EXPORT"],
        listingId: gone.listing.id,
        connectionId: gone.connectionId,
      },
    });
    return c;
  });
  return {
    ctx,
    owner,
    cleaner,
    gone: await dress(ctx, gone),
    kept: await dress(ctx, kept),
  };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

const remove = (s: Seeded) =>
  app.tenant(s.ctx, async (tx) =>
    app.removeProperty(tx, s.ctx, s.gone.listing.id, {
      confirmName: s.gone.listing.name,
      version: (
        await tx.listing.findUniqueOrThrow({
          where: { id: s.gone.listing.id },
        })
      ).version,
    }),
  );
const erase = (
  s: Seeded,
  input: Partial<{ confirmName: string; password: string }> = {},
) =>
  app.eraseProperty(s.ctx, s.gone.listing.id, {
    confirmName: s.gone.listing.name,
    password: PASSWORD,
    ...input,
  });

/**
 * Every row anywhere that belongs to, or points at, one property. `known`
 * adds ids seen earlier, so alerts and queued work about rows that are
 * gone are still found.
 */
async function footprint(ctx: Ctx, listingId: string, known: string[] = []) {
  return app.tenant(ctx, async (tx) => {
    const scope = { workspaceId: ctx.workspaceId, listingId };
    const connections = (
      await tx.channelConnection.findMany({
        where: scope,
        select: { id: true },
      })
    ).map((c) => c.id);
    const tasks = (
      await tx.cleaningTask.findMany({ where: scope, select: { id: true } })
    ).map((c) => c.id);
    const threads = (
      await tx.thread.findMany({ where: scope, select: { id: true } })
    ).map((c) => c.id);
    const byConnection = { connectionId: { in: connections } };
    const messages = (
      await tx.message.findMany({
        where: { threadId: { in: threads } },
        select: { id: true },
      })
    ).map((m) => m.id);
    const notifications = await tx.notification.findMany({
      select: { key: true, href: true, body: true },
    });
    const owned = [
      listingId,
      ...connections,
      ...tasks,
      ...threads,
      ...messages,
      ...known,
    ];
    return {
      listing: await tx.listing.count({ where: { id: listingId } }),
      connections: connections.length,
      observations: await tx.feedObservation.count({ where: byConnection }),
      exportVersions: await tx.exportVersion.count({ where: byConnection }),
      retrievals: await tx.exportRetrieval.count({ where: byConnection }),
      revoked: await tx.revokedExportToken.count({ where: byConnection }),
      blocks: await tx.availabilityBlock.count({ where: scope }),
      reservations: await tx.reservation.count({ where: scope }),
      conflicts: await tx.conflictCase.count({ where: scope }),
      tasks: tasks.length,
      magicLinks: await tx.magicLink.count({
        where: { taskId: { in: tasks } },
      }),
      assets: await tx.asset.count({
        where: { OR: [{ listingId }, { taskId: { in: tasks } }] },
      }),
      threads: threads.length,
      messages: messages.length,
      rules: await tx.automationRule.count({ where: scope }),
      queued: await tx.outbox.count({ where: { entityId: { in: owned } } }),
      alerts: notifications.filter((n) =>
        owned.some((id) => n.key.includes(id) || n.href.includes(id)),
      ).length,
    };
  });
}

/** The ids of a property's own rows, for checking what points at them. */
const idsOf = (ctx: Ctx, listingId: string) =>
  app.tenant(ctx, async (tx) => {
    const scope = { workspaceId: ctx.workspaceId, listingId };
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
    const threads = ids(
      await tx.thread.findMany({ where: scope, select: { id: true } }),
    );
    return [
      ...ids(
        await tx.channelConnection.findMany({
          where: scope,
          select: { id: true },
        }),
      ),
      ...ids(
        await tx.availabilityBlock.findMany({
          where: scope,
          select: { id: true },
        }),
      ),
      ...ids(
        await tx.reservation.findMany({ where: scope, select: { id: true } }),
      ),
      ...ids(
        await tx.conflictCase.findMany({ where: scope, select: { id: true } }),
      ),
      ...ids(
        await tx.cleaningTask.findMany({ where: scope, select: { id: true } }),
      ),
      ...threads,
      ...ids(
        await tx.message.findMany({
          where: { threadId: { in: threads } },
          select: { id: true },
        }),
      ),
    ];
  });
const archive = (ctx: Ctx, listingId: string, daysAgo: number) =>
  app.tenant(ctx, (tx) =>
    tx.listing.update({
      where: { id: listingId },
      data: { archivedAt: new Date(Date.now() - daysAgo * 86_400_000) },
    }),
  );

test(
  "deleting permanently needs the owner, their password and the property's name, after removal",
  { skip },
  async () => {
    const s = await seed("Guarded");
    // Still in the app: it must be removed first.
    await refused(erase(s), "NOT_REMOVED");
    await remove(s);
    await refused(
      app.eraseProperty(
        { ...s.ctx, role: "COHOST" as never },
        s.gone.listing.id,
        { confirmName: s.gone.listing.name, password: PASSWORD },
      ),
      "OWNER_REQUIRED",
    );
    await refused(
      erase(s, { password: "not the password" }),
      "PASSWORD_MISMATCH",
    );
    await refused(
      erase(s, { confirmName: "Guarded" }),
      "CONFIRMATION_MISMATCH",
    );
    await refused(
      app.eraseProperty(
        { ...s.ctx, actorId: "someone-else" },
        s.gone.listing.id,
        {
          confirmName: s.gone.listing.name,
          password: PASSWORD,
        },
      ),
      "PASSWORD_MISMATCH",
    );
    // Another workspace's owner cannot reach it at all.
    const other = await seed("Elsewhere");
    await refused(
      app.eraseProperty(other.ctx, s.gone.listing.id, {
        confirmName: s.gone.listing.name,
        password: PASSWORD,
      }),
      "NOT_FOUND",
    );
    assert.equal((await footprint(s.ctx, s.gone.listing.id)).listing, 1);
    assert.equal(storage.deleted.length, 0, "no photo was touched");

    // The preview is the owner's too, and only for a removed property.
    const preview = await app.tenant(s.ctx, (tx) =>
      app.erasurePreview(tx, s.ctx, s.gone.listing.id),
    );
    assert.equal(preview.name, s.gone.listing.name);
    assert.equal(preview.stays, 2);
    assert.equal(preview.conversations, 1);
    assert.equal(preview.messages, 2);
    assert.equal(preview.photos, 2);
    assert.equal(preview.calendarLinks, 1);
    assert.equal(preview.cleaners, 1);
    assert.equal(
      Date.parse(preview.erasesAt) - Date.parse(preview.removedAt),
      30 * 86_400_000,
    );
    await refused(
      app.tenant(s.ctx, (tx) =>
        app.erasurePreview(tx, s.ctx, s.kept.listing.id),
      ),
      "NOT_FOUND",
    );
    await refused(
      app.tenant(s.ctx, (tx) =>
        app.erasurePreview(
          tx,
          { ...s.ctx, role: "COHOST" as never },
          s.gone.listing.id,
        ),
      ),
      "OWNER_REQUIRED",
    );
  },
);

test(
  "deleting removes everything stored for the property and nothing else",
  { skip },
  async () => {
    const s = await seed("Erased");
    const other = await seed("Neighbour");
    await remove(s);
    const before = await footprint(s.ctx, s.gone.listing.id);
    for (const [k, v] of Object.entries(before))
      if (k !== "revoked") assert.ok(v > 0, `the property has ${k} to delete`);
    const keptBefore = await footprint(s.ctx, s.kept.listing.id);
    const otherBefore = await footprint(other.ctx, other.gone.listing.id);
    const history = await app.tenant(s.ctx, async (tx) => ({
      audit: await tx.auditLog.findMany({ orderBy: { id: "asc" } }),
      events: await tx.domainEvent.count(),
    }));
    const known = await idsOf(s.ctx, s.gone.listing.id);
    const photos = await app.tenant(s.ctx, (tx) =>
      tx.asset.findMany({
        select: { storageKey: true, taskId: true, listingId: true },
      }),
    );
    const goneTasks = await app.tenant(s.ctx, (tx) =>
      tx.cleaningTask.findMany({
        where: { listingId: s.gone.listing.id },
        select: { id: true },
      }),
    );
    const goneKeys = photos
      .filter(
        (a) =>
          a.listingId === s.gone.listing.id ||
          goneTasks.some((x) => x.id === a.taskId),
      )
      .map((a) => a.storageKey)
      .sort();

    const result = await erase(s);
    assert.equal(result.id, s.gone.listing.id);
    assert.equal(result.photosPending, 0);
    assert.equal(result.counts.stays, 2);
    assert.equal(result.counts.photos, 2);
    assert.equal(result.counts.calendarLinks, 1);
    assert.equal(result.counts.conversations, 1);
    assert.equal(result.counts.messages, 2);
    assert.ok(result.counts.overlaps >= 1);

    // Nothing of it is left, in the database or in storage.
    const afterwards = await footprint(s.ctx, s.gone.listing.id, known);
    for (const [k, v] of Object.entries(afterwards))
      assert.equal(v, 0, `${k} of the deleted property`);
    assert.deepEqual(
      storage.deleted.sort(),
      goneKeys.map((k) => `airbnb-private/${k}`),
    );

    // Nothing else changed.
    assert.deepEqual(await footprint(s.ctx, s.kept.listing.id), keptBefore);
    assert.deepEqual(
      await footprint(other.ctx, other.gone.listing.id),
      otherBefore,
    );
    await app.tenant(s.ctx, async (tx) => {
      const cleaner = await tx.cleaner.findUniqueOrThrow({
        where: { id: s.cleaner.id },
      });
      assert.deepEqual(cleaner.listingIds, [s.kept.listing.id]);
      const setup = await tx.onboardingProgress.findUniqueOrThrow({
        where: { workspaceId: s.ctx.workspaceId },
      });
      assert.equal(setup.step, "PROPERTY");
      assert.equal(setup.listingId, null);
      assert.equal(setup.connectionId, null);
      assert.deepEqual(setup.completed, []);
      assert.deepEqual(setup.skipped, []);
      // The audit log is append-only: every earlier entry is untouched, and
      // one more says what happened. Domain events are untouched too.
      const audit = await tx.auditLog.findMany({ orderBy: { id: "asc" } });
      const earlier = new Map(history.audit.map((a) => [a.id, a]));
      assert.deepEqual(
        audit.filter((a) => earlier.has(a.id)),
        history.audit,
      );
      const added = audit.filter((a) => !earlier.has(a.id));
      assert.deepEqual(
        added.map((a) => [a.action, a.entityId]),
        [["ERASE", s.gone.listing.id]],
      );
      assert.equal(await tx.domainEvent.count(), history.events);
      // The ledger says it happened, with ids and counts only.
      const ledger = await tx.erasure.findMany();
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].subjectId, s.gone.listing.id);
      assert.equal(ledger[0].trigger, "OWNER");
      assert.equal(ledger[0].actorId, s.owner.id);
      assert.deepEqual(ledger[0].pendingObjects, []);
      const text = JSON.stringify(ledger);
      for (const secret of [s.gone.listing.name, "street", "Guest Person"])
        assert.ok(!text.includes(secret), `the ledger holds no ${secret}`);
    });

    // Its export link answers "not found", as after removal.
    const response = await app.serveExport({
      workspaceId: s.ctx.workspaceId,
      listingId: s.gone.listing.id,
      token: s.gone.token,
      connectionId: null,
      method: "GET",
      ifNoneMatch: null,
    });
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Calendar not found.");
    // It is no longer listed as removed, and the other property still works.
    const removed = await app.tenant(s.ctx, (tx) =>
      app.removedProperties(tx, s.ctx),
    );
    assert.deepEqual(removed, []);
    const kept = await app.serveExport({
      workspaceId: s.ctx.workspaceId,
      listingId: s.kept.listing.id,
      token: s.kept.token,
      connectionId: null,
      method: "GET",
      ifNoneMatch: null,
    });
    assert.equal(kept.status, 200);

    // Asking again after a lost answer returns the same deletion.
    const again = await erase(s, { confirmName: "anything" });
    assert.deepEqual(again, result);
  },
);

test(
  "photos storage cannot confirm stay listed and are tried again by the scheduler",
  { skip },
  async () => {
    const s = await seed("Offline");
    await remove(s);
    storage.answer = 503;
    const result = await erase(s);
    assert.equal(result.photosPending, 2);
    assert.equal(storage.deleted.length, 0);
    // The rows are gone even though storage was down.
    assert.equal((await footprint(s.ctx, s.gone.listing.id)).assets, 0);

    // A key outside the workspace's folder is never sent to storage.
    await app.tenant(
      s.ctx,
      (tx) => tx.$executeRaw`
        UPDATE "Erasure"
           SET "pendingObjects" = array_append("pendingObjects", 'another-workspace/x.webp')
         WHERE "subjectId" = ${s.gone.listing.id}`,
    );
    storage.answer = 200;
    await app.eraseExpired(s.ctx.workspaceId);
    assert.equal(storage.deleted.length, 2);
    assert.ok(storage.deleted.every((k) => k.includes(s.ctx.workspaceId)));
    const ledger = await app.tenant(s.ctx, (tx) =>
      tx.erasure.findFirstOrThrow({
        where: { subjectId: s.gone.listing.id },
      }),
    );
    assert.deepEqual(ledger.pendingObjects, ["another-workspace/x.webp"]);
  },
);

test(
  "the scheduler deletes a property 30 days after its removal, not before",
  { skip },
  async () => {
    const s = await seed("Retained");
    await remove(s);
    const tick = () => app.runTick("WORKER", { fetcher: fetched(FEED()) });
    await archive(s.ctx, s.gone.listing.id, 29);
    const early = await tick();
    assert.equal(early.status, "COMPLETED");
    assert.equal(early.failed, 0);
    assert.equal((await footprint(s.ctx, s.gone.listing.id)).listing, 1);

    await archive(s.ctx, s.gone.listing.id, 31);
    const due = await tick();
    assert.equal(due.status, "COMPLETED");
    assert.equal(due.failed, 0);
    assert.equal((await footprint(s.ctx, s.gone.listing.id)).listing, 0);
    // A property still in the app is never due.
    assert.equal((await footprint(s.ctx, s.kept.listing.id)).listing, 1);
    const ledger = await app.tenant(s.ctx, (tx) =>
      tx.erasure.findFirstOrThrow({
        where: { subjectId: s.gone.listing.id },
      }),
    );
    assert.equal(ledger.trigger, "RETENTION");
    assert.equal(ledger.actorId, "worker");
    assert.equal(storage.deleted.length, 2);
  },
);

test(
  "a message being sent right now holds the deletion back",
  { skip },
  async () => {
    const s = await seed("Sending");
    await remove(s);
    const job = await app.tenant(s.ctx, async (tx) => {
      const message = await tx.message.findFirstOrThrow({
        where: { threadId: s.gone.thread.id, sender: "GUEST" },
      });
      return tx.outbox.create({
        data: {
          workspaceId: s.ctx.workspaceId,
          kind: "EVALUATE_MESSAGE",
          entityId: message.id,
          key: `evaluate:${message.id}:test`,
          payloadEncrypted: app.seal({}, s.ctx.workspaceId),
          category: "MESSAGING",
          status: "SENDING",
          leaseUntil: new Date(Date.now() + 45_000),
        },
      });
    });
    await refused(erase(s), "SENDING");
    assert.equal((await footprint(s.ctx, s.gone.listing.id)).listing, 1);
    await app.tenant(s.ctx, (tx) =>
      tx.outbox.update({
        where: { id: job.id },
        data: { status: "DELIVERED", leaseUntil: null },
      }),
    );
    await erase(s);
    assert.equal((await footprint(s.ctx, s.gone.listing.id)).listing, 0);
  },
);

test(
  "the database allows deletion only through its checks, never by the application directly",
  { skip },
  async () => {
    const s = await seed("Database");
    const sqlFails = (work: Promise<unknown>, pattern: RegExp) =>
      assert.rejects(work, (e: Error) => pattern.test(e.message));
    // Outside a workspace scope the function refuses.
    await sqlFails(
      app.db
        .$queryRaw`SELECT erase_listing(${s.gone.listing.id}, 'OWNER', 'test')`,
      /only inside a workspace scope/,
    );
    await app.tenant(s.ctx, async (tx) => {
      // A property still in the app is refused, whoever asks.
      await sqlFails(
        tx.$queryRaw`SELECT erase_listing(${s.gone.listing.id}, 'OWNER', 'test')`,
        /removed from the app/,
      );
    });
    // Another workspace's property is simply not found.
    const other = await seed("Database other");
    await archive(other.ctx, other.gone.listing.id, 0);
    await app.tenant(s.ctx, async (tx) => {
      await sqlFails(
        tx.$queryRaw`SELECT erase_listing(${other.gone.listing.id}, 'OWNER', 'test')`,
        /not found/,
      );
    });
    // The runtime role still cannot delete history, or change the ledger
    // beyond striking photos, or write it at all.
    const denied = (sql: string) =>
      app.tenant(s.ctx, (tx) =>
        sqlFails(tx.$executeRawUnsafe(sql), /permission denied/),
      );
    await denied(`DELETE FROM "Reservation"`);
    await denied(`DELETE FROM "AvailabilityBlock"`);
    await denied(`DELETE FROM "CleaningTask"`);
    await denied(`DELETE FROM "AuditLog"`);
    await denied(`UPDATE "AuditLog" SET "detailEncrypted" = NULL`);
    await denied(`DELETE FROM "Erasure"`);
    await denied(`UPDATE "Erasure" SET "counts" = '{}'`);
    await denied(
      `INSERT INTO "Erasure" ("id","workspaceId","subject","subjectId","trigger","actorId","counts") VALUES ('x','${s.ctx.workspaceId}','LISTING','y','OWNER','z','{}')`,
    );
    assert.equal((await footprint(s.ctx, s.gone.listing.id)).listing, 1);
  },
);

test(
  "deletions are applied again after a backup restore",
  { skip },
  async () => {
    const s = await seed("Restored");
    await remove(s);
    await erase(s);
    const records = await app.exportErasures();
    const mine = records.filter((r) => r.workspaceId === s.ctx.workspaceId);
    assert.deepEqual(
      mine.map((r) => [r.subjectId, r.trigger]),
      [[s.gone.listing.id, "OWNER"]],
    );
    assert.ok(
      !JSON.stringify(records).includes(s.gone.listing.name),
      "the export holds ids only",
    );
    // A property already deleted is absent from restored data that was
    // taken afterwards: nothing to do.
    assert.equal(await app.reapplyErasure(mine[0], "operator:test"), "ABSENT");
    // Restored data from before a deletion still holds the property, even
    // in the app: it is taken out and deleted again.
    const record = {
      workspaceId: s.ctx.workspaceId,
      subjectId: s.kept.listing.id,
    };
    assert.equal(await app.reapplyErasure(record, "operator:test"), "ERASED");
    const after = await footprint(s.ctx, s.kept.listing.id);
    for (const [k, v] of Object.entries(after))
      assert.equal(v, 0, `${k} after re-applying`);
    const ledger = await app.tenant(s.ctx, (tx) =>
      tx.erasure.findFirstOrThrow({ where: { subjectId: s.kept.listing.id } }),
    );
    assert.equal(ledger.trigger, "REAPPLIED");
    assert.equal(ledger.actorId, "operator:test");
    // Running it again is safe.
    assert.equal(await app.reapplyErasure(record, "operator:test"), "ABSENT");
  },
);
