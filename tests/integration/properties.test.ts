// Removing a property from the app, and restoring it, against real
// PostgreSQL through the runtime role. Removal stops everything the app does
// for the property without contacting any platform: its calendars are no
// longer fetched, its export links answer "not found" (never an empty
// calendar), cleaning work that has not begun is cancelled, unsent replies
// are held, and it disappears from every list. History is kept, and restoring
// brings back exactly what the removal paused.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase, skip, type TestDatabase } from "./harness";

let t: TestDatabase | undefined;
let app: Awaited<ReturnType<typeof load>>;

async function load() {
  const db = await import("../../src/server/db");
  const actions = await import("../../src/server/calendar/actions");
  const run = await import("../../src/server/calendar/run");
  const serve = await import("../../src/server/calendar/serve");
  const routes = await import("../../src/server/routes/calendar");
  const inbox = await import("../../src/server/routes/inbox");
  const onboarding = await import("../../src/server/routes/onboarding");
  const properties = await import("../../src/server/services/properties");
  const messaging = await import("../../src/server/services/messaging");
  const jobs = await import("../../src/server/services/jobs");
  const crypto = await import("../../src/server/crypto");
  const dates = await import("../../src/domain/calendar/dates");
  return {
    ...db,
    ...actions,
    ...run,
    ...serve,
    attention: routes.attention,
    threadSummaries: inbox.threadSummaries,
    onboardingRoutes: onboarding.onboardingRoutes,
    ...properties,
    ...messaging,
    dispatch: jobs.dispatch,
    ...crypto,
    ...dates,
  };
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

const day = (n: number) => app.addDays(app.todayIn("UTC", Date.now()), n);
const compact = (d: string) => d.replaceAll("-", "");
const ics = (...events: [string, number, number, string][]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//integration//EN",
    ...events.flatMap(([uid, from, to, summary]) => [
      "BEGIN:VEVENT",
      `UID:${uid}`,
      "DTSTAMP:20260101T000000Z",
      `DTSTART;VALUE=DATE:${compact(day(from))}`,
      `DTEND;VALUE=DATE:${compact(day(to))}`,
      `SUMMARY:${summary}`,
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ].join("\r\n");
const FEED = () =>
  ics(
    ["stay-1@airbnb.com", 5, 8, "Reserved"],
    ["stay-2@airbnb.com", 12, 15, "Reserved"],
  );
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
type Seeded = Awaited<ReturnType<typeof seed>>;

/**
 * A live workspace with one property: an Airbnb calendar (two upcoming
 * stays, so two turnovers, one assigned to a cleaner), the all-channel
 * export link, and a guest conversation with a reply queued but not sent.
 */
async function seed(name: string) {
  const w = await app.db.workspace.create({ data: { name } });
  const ctx: Ctx = {
    workspaceId: w.id,
    actorId: `owner-${name}`,
    role: "HOST",
  };
  const listing = await app.tenant(ctx, async (tx) => {
    await tx.automationSettings.create({
      data: { workspaceId: w.id, paused: false, cleaning: true },
    });
    return tx.listing.create({
      data: {
        workspaceId: w.id,
        name: `${name} cottage`,
        address: "Integration test address",
        timezone: "UTC",
        houseManualEncrypted: app.seal({}, w.id),
      },
    });
  });
  const created = await app.tenant(ctx, (tx) =>
    app.createConnection(tx, ctx, {
      listingId: listing.id,
      platform: "AIRBNB",
      url: `https://www.airbnb.com/calendar/ical/${randomUUID()}.ics?s=x`,
      label: null,
    }),
  );
  const master = await app.tenant(ctx, (tx) =>
    app.createConnection(tx, ctx, {
      listingId: listing.id,
      platform: "OTHER",
      url: null,
      label: "All-channel export link",
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
  const thread = await app.tenant(ctx, async (tx) => {
    const cleaner = await tx.cleaner.create({
      data: {
        workspaceId: w.id,
        name: "Cleaner",
        phoneEncrypted: app.encrypt("+15555550100", w.id),
        listingIds: [listing.id],
      },
    });
    const [first] = await tx.cleaningTask.findMany({
      where: { listingId: listing.id },
      orderBy: { scheduledAt: "asc" },
    });
    await tx.cleaningTask.update({
      where: { id: first.id },
      data: { status: "ASSIGNED", cleanerId: cleaner.id },
    });
    const reservation = await tx.reservation.findFirstOrThrow({
      where: { listingId: listing.id },
    });
    return tx.thread.create({
      data: {
        workspaceId: w.id,
        listingId: listing.id,
        reservationId: reservation.id,
        externalId: randomUUID(),
        platform: "AIRBNB",
      },
    });
  });
  await app.tenant(ctx, (tx) =>
    app.reply(tx, ctx, thread.id, "See you soon.", randomUUID()),
  );
  return {
    ctx,
    listing,
    thread,
    airbnb: {
      id: created.connection.id,
      token: tokenOf(created.exportUrl),
    },
    master: { id: master.connection.id, token: tokenOf(master.exportUrl) },
  };
}

const serve = (s: Seeded, link: { id: string; token: string }) =>
  app.serveExport({
    workspaceId: s.ctx.workspaceId,
    listingId: s.listing.id,
    token: link.token,
    connectionId: null,
    method: "GET",
    ifNoneMatch: null,
  });
const version = (s: Seeded) =>
  app.tenant(
    s.ctx,
    async (tx) =>
      (await tx.listing.findUniqueOrThrow({ where: { id: s.listing.id } }))
        .version,
  );
const remove = async (s: Seeded) =>
  app.tenant(s.ctx, async (tx) =>
    app.removeProperty(tx, s.ctx, s.listing.id, {
      confirmName: s.listing.name,
      version: (
        await tx.listing.findUniqueOrThrow({
          where: { id: s.listing.id },
        })
      ).version,
    }),
  );

test(
  "the preview says what removal will change, including links platforms still read",
  { skip },
  async () => {
    const s = await seed("Preview");
    assert.equal((await serve(s, s.airbnb)).status, 200);
    const preview = await app.tenant(s.ctx, (tx) =>
      app.removalPreview(tx, s.ctx, s.listing.id),
    );
    assert.equal(preview.name, "Preview cottage");
    assert.equal(preview.calendarsChecked, 1);
    assert.equal(preview.exportLinks, 2);
    assert.deepEqual(
      preview.linksInUse.map((l) => l.name),
      ["Airbnb"],
    );
    assert.equal(preview.upcomingStays, 2);
    assert.equal(preview.cleaningsToCancel, 2);
    assert.equal(preview.cleanersToTell, 1);
    assert.equal(preview.cleanersToldAutomatically, true);
    assert.equal(preview.cleaningUnderWay, false);
    assert.equal(preview.openConversations, 1);
  },
);

test(
  "removal needs the owner, the property's name and its current version",
  { skip },
  async () => {
    const s = await seed("Guarded");
    const current = await version(s);
    const attempt = (
      ctx: Ctx | (Omit<Ctx, "role"> & { role: "COHOST" }),
      confirmName: string,
      v: number,
    ) =>
      app.tenant(s.ctx, (tx) =>
        app.removeProperty(tx, ctx, s.listing.id, { confirmName, version: v }),
      );
    await refused(
      attempt({ ...s.ctx, role: "COHOST" }, s.listing.name, current),
      "OWNER_REQUIRED",
    );
    await refused(attempt(s.ctx, "Guarded", current), "CONFIRMATION_MISMATCH");
    await refused(attempt(s.ctx, "", current), "CONFIRMATION_MISMATCH");
    await refused(
      attempt(s.ctx, s.listing.name, current - 1),
      "VERSION_CONFLICT",
    );
    // Case and spacing do not matter; the words do.
    assert.equal(app.namesMatch("  guarded   COTTAGE ", s.listing.name), true);
    assert.equal(app.namesMatch("guarded cottages", s.listing.name), false);
    assert.equal(
      (
        await app.tenant(s.ctx, (tx) =>
          tx.listing.findUniqueOrThrow({ where: { id: s.listing.id } }),
        )
      ).archivedAt,
      null,
      "nothing was removed",
    );
  },
);

test(
  "removal waits for a cleaning under way, but not for one abandoned long ago",
  { skip },
  async () => {
    const s = await seed("Busy");
    const setStarted = (hoursAgo: number) =>
      app.tenant(s.ctx, async (tx) => {
        const task = await tx.cleaningTask.findFirstOrThrow({
          where: { listingId: s.listing.id, status: "ASSIGNED" },
        });
        await tx.cleaningTask.update({
          where: { id: task.id },
          data: {
            status: "IN_PROGRESS",
            acceptedAt: new Date(Date.now() - (hoursAgo + 1) * 3_600_000),
            startedAt: new Date(Date.now() - hoursAgo * 3_600_000),
          },
        });
      });
    await setStarted(1);
    await refused(remove(s), "CLEANING_UNDER_WAY");
    await app.tenant(s.ctx, (tx) =>
      tx.cleaningTask.updateMany({
        where: { listingId: s.listing.id, status: "IN_PROGRESS" },
        data: { startedAt: new Date(Date.now() - 13 * 3_600_000) },
      }),
    );
    const result = await remove(s);
    assert.ok(result.removedAt);
    await app.tenant(s.ctx, async (tx) => {
      // Started work is history: never cancelled.
      assert.equal(
        await tx.cleaningTask.count({
          where: { listingId: s.listing.id, status: "IN_PROGRESS" },
        }),
        1,
      );
    });
  },
);

test(
  "removing stops everything for the property and contacts no platform",
  { skip },
  async () => {
    const s = await seed("Removed");
    const before = await app.tenant(s.ctx, (tx) =>
      tx.channelConnection.findUniqueOrThrow({ where: { id: s.airbnb.id } }),
    );
    const result = await remove(s);
    assert.equal(result.linksPaused, 2);
    assert.equal(result.cleaningsCancelled, 2);
    assert.equal(result.repliesHeld, 1);

    await app.tenant(s.ctx, async (tx) => {
      const listing = await tx.listing.findUniqueOrThrow({
        where: { id: s.listing.id },
      });
      assert.ok(listing.archivedAt);
      const links = await tx.channelConnection.findMany({
        where: { listingId: s.listing.id },
      });
      for (const c of links) {
        assert.equal(c.enabled, false);
        assert.equal(c.health, "PROPERTY_REMOVED");
        assert.equal(c.leaseToken, null);
      }
      // A check that was running cannot apply what it fetched.
      const airbnb = links.find((c) => c.id === s.airbnb.id)!;
      assert.equal(airbnb.fence, before.fence + 1);

      const tasks = await tx.cleaningTask.findMany({
        where: { listingId: s.listing.id },
      });
      assert.ok(tasks.every((x) => x.status === "CANCELLED"));
      assert.ok(tasks.every((x) => x.closeReason === "PROPERTY_REMOVED"));
      // The cleaner who held a job is told not to come, as for any
      // cancellation; the host is not sent a notice per job.
      assert.equal(
        await tx.outbox.count({
          where: { kind: "CLEANER_NOTICE", status: "PENDING" },
        }),
        1,
      );
      assert.equal(
        await tx.notification.count({
          where: { key: { startsWith: "cleaning-cancelled:" } },
        }),
        0,
      );
      // The unsent reply is held back as a draft.
      const reply = await tx.message.findFirstOrThrow({
        where: { threadId: s.thread.id, sender: "HOST" },
      });
      assert.equal(reply.status, "DRAFT");
      assert.equal(
        await tx.outbox.count({
          where: { kind: "GUEST_MESSAGE", status: "PENDING" },
        }),
        0,
      );
      assert.equal(
        await tx.auditLog.count({
          where: { action: "REMOVE", entityId: s.listing.id },
        }),
        1,
      );
      // History is kept.
      assert.equal(
        await tx.reservation.count({ where: { listingId: s.listing.id } }),
        2,
      );
    });

    // Export links answer "not found", never an empty calendar.
    for (const link of [s.airbnb, s.master]) {
      const response = await serve(s, link);
      assert.equal(response.status, 404);
      assert.equal(await response.text(), "Calendar not found.");
    }
    // No calendar is fetched: the platform is never contacted.
    let contacted = false;
    const run = await app.runConnection(s.ctx, s.airbnb.id, {
      trigger: "MANUAL",
      fetcher: async () => {
        contacted = true;
        throw new Error("must not fetch");
      },
    });
    assert.equal(run, null);
    assert.equal(contacted, false);

    // It is gone from every list, and nothing can be done to it.
    const attention = await app.tenant(s.ctx, (tx) => app.attention(tx, s.ctx));
    assert.ok(attention.blocks.every((b) => b.listingId !== s.listing.id));
    assert.deepEqual(
      await app.tenant(s.ctx, (tx) => app.threadSummaries(tx, s.ctx, {})),
      [],
    );
    await refused(
      app.tenant(s.ctx, (tx) =>
        app.createHold(tx, s.ctx, {
          listingId: s.listing.id,
          from: day(30),
          to: day(32),
          holdType: "OWNER",
          reason: "Family visit",
          clientRequestId: randomUUID(),
          acknowledgeOverlaps: false,
        }),
      ),
      "PROPERTY_REMOVED",
    );
    await refused(
      app.tenant(s.ctx, (tx) =>
        app.reply(tx, s.ctx, s.thread.id, "Hello?", randomUUID()),
      ),
      "PROPERTY_REMOVED",
    );

    // Asking again changes nothing more.
    const versionAfter = await version(s);
    const again = await app.tenant(s.ctx, (tx) =>
      app.removeProperty(tx, s.ctx, s.listing.id, {
        confirmName: "anything",
        version: 0,
      }),
    );
    assert.equal(again.removedAt, result.removedAt);
    assert.equal(again.cleaningsCancelled, 0);
    assert.equal(await version(s), versionAfter);
  },
);

test(
  "a check that is fetching when the property is removed cannot apply it",
  { skip },
  async () => {
    const s = await seed("Racing");
    const run = await app.runConnection(s.ctx, s.airbnb.id, {
      trigger: "MANUAL",
      fetcher: async () => {
        // The host removes the property while the calendar is downloading.
        await remove(s);
        return fetched(
          ics(
            ["stay-1@airbnb.com", 5, 8, "Reserved"],
            ["stay-2@airbnb.com", 12, 15, "Reserved"],
            ["stay-3@airbnb.com", 20, 22, "Reserved"],
          ),
        )();
      },
    });
    assert.equal(run?.outcome, "LEASE_LOST");
    await app.tenant(s.ctx, async (tx) => {
      assert.equal(
        await tx.availabilityBlock.count({
          where: { listingId: s.listing.id },
        }),
        2,
        "the new stay was not applied",
      );
      assert.equal(
        await tx.cleaningTask.count({
          where: { listingId: s.listing.id, status: { not: "CANCELLED" } },
        }),
        0,
        "no cleaning work was created",
      );
    });
  },
);

test(
  "messages for a removed property get no prepared reply and are never sent",
  { skip },
  async () => {
    const s = await seed("Quiet");
    await remove(s);
    const { message, job } = await app.tenant(s.ctx, async (tx) => {
      const message = await tx.message.create({
        data: {
          workspaceId: s.ctx.workspaceId,
          threadId: s.thread.id,
          bodyEncrypted: app.encrypt("Where is the key?", s.ctx.workspaceId),
          sender: "GUEST",
          status: "RECEIVED",
        },
      });
      // A send that slipped in after the removal.
      const reply = await tx.message.create({
        data: {
          workspaceId: s.ctx.workspaceId,
          threadId: s.thread.id,
          bodyEncrypted: app.encrypt("Under the mat.", s.ctx.workspaceId),
          sender: "HOST",
          status: "QUEUED",
        },
      });
      const job = await tx.outbox.create({
        data: {
          workspaceId: s.ctx.workspaceId,
          kind: "GUEST_MESSAGE",
          entityId: reply.id,
          key: "send:" + reply.id,
          payloadEncrypted: app.seal({}, s.ctx.workspaceId),
          category: "MESSAGING",
          automated: false,
        },
      });
      return { message, job: { id: job.id, replyId: reply.id } };
    });
    await app.evaluateMessage(s.ctx, message.id);
    await app.dispatch(s.ctx, job.id);
    await app.tenant(s.ctx, async (tx) => {
      assert.equal(
        await tx.message.count({ where: { replyToId: message.id } }),
        0,
        "no reply was prepared",
      );
      assert.equal(
        await tx.notification.count({ where: { key: "human:" + message.id } }),
        0,
        "the host is not alerted about a removed property",
      );
      const reply = await tx.message.findUniqueOrThrow({
        where: { id: job.replyId },
      });
      assert.equal(reply.status, "DRAFT", "not sent");
      const row = await tx.outbox.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(row.status, "CANCELLED");
    });
  },
);

test(
  "restoring turns back on exactly the links the removal paused, and brings back cleaning",
  { skip },
  async () => {
    const s = await seed("Restored");
    // The host had switched off the all-channel link before removing.
    await app.tenant(s.ctx, (tx) =>
      app.setConnectionEnabled(tx, s.ctx, s.master.id, false),
    );
    const removed = await remove(s);
    assert.equal(removed.linksPaused, 1);
    // A platform keeps asking for the link after the removal.
    assert.equal((await serve(s, s.airbnb)).status, 404);
    const listed = await app.tenant(s.ctx, (tx) =>
      app.removedProperties(tx, s.ctx),
    );
    assert.equal(listed.length, 1);
    assert.deepEqual(
      listed[0].linksStillRequested.map((l) => l.name),
      ["Airbnb"],
    );

    await refused(
      app.tenant(s.ctx, (tx) =>
        app.restoreProperty(
          tx,
          { ...s.ctx, role: "COHOST" } as never,
          s.listing.id,
        ),
      ),
      "OWNER_REQUIRED",
    );
    const restored = await app.tenant(s.ctx, (tx) =>
      app.restoreProperty(tx, s.ctx, s.listing.id),
    );
    assert.equal(restored.linksResumed, 1);
    assert.equal(restored.cleaningsRecreated, true);
    await app.tenant(s.ctx, async (tx) => {
      const airbnb = await tx.channelConnection.findUniqueOrThrow({
        where: { id: s.airbnb.id },
      });
      assert.equal(airbnb.enabled, true);
      assert.equal(airbnb.health, "PENDING");
      assert.ok(airbnb.nextFetchAt.getTime() <= Date.now());
      const master = await tx.channelConnection.findUniqueOrThrow({
        where: { id: s.master.id },
      });
      assert.equal(master.enabled, false, "still off, as the host left it");
      assert.equal(master.health, "DISABLED");
      // Upcoming stays have turnover work again; cancelled jobs stay so.
      assert.equal(
        await tx.cleaningTask.count({
          where: { listingId: s.listing.id, status: "NEEDS_SCHEDULING" },
        }),
        2,
      );
      assert.equal(
        await tx.cleaningTask.count({
          where: { listingId: s.listing.id, status: "CANCELLED" },
        }),
        2,
      );
    });
    assert.equal((await serve(s, s.airbnb)).status, 200);
    assert.equal(
      (await app.tenant(s.ctx, (tx) => app.threadSummaries(tx, s.ctx, {})))
        .length,
      1,
    );
    assert.deepEqual(
      await app.tenant(s.ctx, (tx) => app.removedProperties(tx, s.ctx)),
      [],
    );
    // Restoring again changes nothing.
    const again = await app.tenant(s.ctx, (tx) =>
      app.restoreProperty(tx, s.ctx, s.listing.id),
    );
    assert.equal(again.linksResumed, 0);
  },
);

test(
  "setup started on a property that is then removed starts again from choosing one",
  { skip },
  async () => {
    const s = await seed("Setup");
    await app.tenant(s.ctx, (tx) =>
      tx.onboardingProgress.create({
        data: {
          workspaceId: s.ctx.workspaceId,
          step: "CLEANER",
          completed: ["PROPERTY", "CALENDAR"],
          skipped: ["EXPORT"],
          listingId: s.listing.id,
          connectionId: s.airbnb.id,
        },
      }),
    );
    await remove(s);
    const response = await app.onboardingRoutes(
      new NextRequest("https://app.test/api/onboarding"),
      ["onboarding"],
      "GET",
      s.ctx,
    );
    const state = await response!.json();
    assert.equal(state.step, "PROPERTY");
    assert.equal(state.listingId, null);
    assert.equal(state.connectionId, null);
    assert.deepEqual(state.completed, []);
    assert.deepEqual(state.skipped, []);
  },
);

test(
  "another workspace can neither see nor remove this workspace's property",
  { skip },
  async () => {
    const mine = await seed("Mine");
    const theirs = await seed("Theirs");
    await refused(
      app.tenant(theirs.ctx, (tx) =>
        app.removalPreview(tx, theirs.ctx, mine.listing.id),
      ),
      "NOT_FOUND",
    );
    await refused(
      app.tenant(theirs.ctx, (tx) =>
        app.removeProperty(tx, theirs.ctx, mine.listing.id, {
          confirmName: mine.listing.name,
          version: 0,
        }),
      ),
      "NOT_FOUND",
    );
    await remove(mine);
    assert.deepEqual(
      await app.tenant(theirs.ctx, (tx) =>
        app.removedProperties(tx, theirs.ctx),
      ),
      [],
    );
    await refused(
      app.tenant(theirs.ctx, (tx) =>
        app.restoreProperty(tx, theirs.ctx, mine.listing.id),
      ),
      "NOT_FOUND",
    );
  },
);
