// Guided setup against real PostgreSQL through the runtime role (AUTH 04 and
// the onboarding sequence): progress is saved per step, scoped to the
// workspace, resumable, and honest about what the host confirmed.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import type { NextRequest } from "next/server";
import { createTestDatabase, skip, type TestDatabase } from "./harness";

let t: TestDatabase | undefined;
let app: Awaited<ReturnType<typeof load>>;

async function load() {
  const db = await import("../../src/server/db");
  const accounts = await import("../../src/server/accounts/service");
  const routes = await import("../../src/server/routes/onboarding");
  const actions = await import("../../src/server/calendar/actions");
  const run = await import("../../src/server/calendar/run");
  const crypto = await import("../../src/server/crypto");
  const dates = await import("../../src/domain/calendar/dates");
  return {
    ...db,
    ...accounts,
    ...routes,
    ...actions,
    ...run,
    ...crypto,
    ...dates,
  };
}

const outbox: string[] = [];
const originalInfo = console.info;
before(async () => {
  if (skip) return;
  t = await createTestDatabase();
  app = await load();
  console.info = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.startsWith("[account-email]")) outbox.push(line);
    else originalInfo(...args);
  };
});
after(async () => {
  console.info = originalInfo;
  await app?.db.$disconnect();
  await t?.drop();
});

type Ctx = { workspaceId: string; actorId: string; role: "HOST" };
type State = {
  exists: boolean;
  step: string;
  completed: string[];
  skipped: string[];
  listingId: string | null;
  connectionId: string | null;
  exportConfirmedAt: string | null;
  completedAt: string | null;
  calendar: null | {
    dateRanges: number;
    reservations: number;
    unclassified: number;
    protectedNights: number;
  };
  rehearsal: { calendarMode: string; automationPaused: boolean };
};

async function call(ctx: Ctx, payload?: object): Promise<State> {
  const request = new Request("https://app.test/api/onboarding", {
    method: payload ? "POST" : "GET",
    body: payload ? JSON.stringify(payload) : undefined,
  }) as unknown as NextRequest;
  const response = await app.onboardingRoutes(
    request,
    ["onboarding"],
    payload ? "POST" : "GET",
    ctx,
  );
  assert.ok(response);
  return response.json();
}
const refused = (work: Promise<unknown>, code: string) =>
  assert.rejects(work, (e: { code?: string }) => e.code === code);

async function signUp(email: string): Promise<Ctx> {
  await app.register({
    name: "Setup Host",
    email,
    password: `${randomBytes(8).toString("hex")} orchard lantern`,
    workspaceName: "Setup Rentals",
  });
  const token = outbox.pop()!.match(/verify#token=([A-Za-z0-9_-]+)/)![1];
  const account = await app.verifyRegistration(token);
  return {
    workspaceId: account.workspaceId,
    actorId: account.userId,
    role: "HOST",
  };
}

async function listingFor(ctx: Ctx, name: string) {
  return app.tenant(ctx, (tx) =>
    tx.listing.create({
      data: {
        workspaceId: ctx.workspaceId,
        name,
        address: "Integration test address",
        timezone: "UTC",
        houseManualEncrypted: app.seal({}, ctx.workspaceId),
      },
    }),
  );
}

test(
  "a new sign-up lands in setup; steps save, advance and stay in their workspace (AUTH 04)",
  { skip },
  async () => {
    const ctx = await signUp("setup.one@example.com");
    const start = await call(ctx);
    assert.equal(start.exists, true);
    assert.equal(start.step, "PROPERTY");
    assert.equal(start.rehearsal.calendarMode, "SHADOW");
    assert.equal(start.rehearsal.automationPaused, true);

    await refused(
      call(ctx, { action: "complete", step: "PROPERTY" }),
      "PROPERTY_REQUIRED",
    );
    const other = await signUp("setup.other@example.com");
    const foreign = await listingFor(other, "Someone else's cabin");
    await refused(
      call(ctx, {
        action: "complete",
        step: "PROPERTY",
        listingId: foreign.id,
      }),
      "NOT_FOUND",
    );

    const listing = await listingFor(ctx, "Setup cabin");
    const afterProperty = await call(ctx, {
      action: "complete",
      step: "PROPERTY",
      listingId: listing.id,
    });
    assert.equal(afterProperty.step, "CALENDAR");
    assert.deepEqual(afterProperty.completed, ["PROPERTY"]);

    // Without a calendar there is no destination link, so both are skipped.
    const skipped = await call(ctx, { action: "skip", step: "CALENDAR" });
    assert.deepEqual(skipped.skipped.sort(), ["CALENDAR", "EXPORT"]);
    assert.equal(skipped.step, "CLEANER");

    await refused(
      call(ctx, { action: "goto", step: "REHEARSAL" }),
      "STEP_LOCKED",
    );
    const back = await call(ctx, { action: "goto", step: "PROPERTY" });
    assert.equal(back.step, "PROPERTY");
    const resumed = await call(ctx, {
      action: "complete",
      step: "PROPERTY",
      listingId: listing.id,
    });
    assert.equal(resumed.step, "CLEANER", "returns to the unfinished step");

    await call(ctx, { action: "skip", step: "CLEANER" });
    const done = await call(ctx, { action: "complete", step: "REHEARSAL" });
    assert.equal(done.step, "DONE");
    assert.ok(done.completedAt);
    await app.tenant(ctx, async (tx) =>
      assert.equal(
        await tx.auditLog.count({ where: { action: "SETUP_COMPLETED" } }),
        1,
      ),
    );
    // The other workspace's progress is untouched.
    assert.equal((await call(other)).step, "PROPERTY");
  },
);

test(
  "the calendar step shows counts, and the export link needs the host's own confirmation",
  { skip },
  async () => {
    const ctx = await signUp("setup.two@example.com");
    const listing = await listingFor(ctx, "Calendar cabin");
    await call(ctx, {
      action: "complete",
      step: "PROPERTY",
      listingId: listing.id,
    });
    const created = await app.tenant(ctx, (tx) =>
      app.createConnection(tx, ctx, {
        listingId: listing.id,
        platform: "AIRBNB",
        url: "https://www.airbnb.com/calendar/ical/77.ics?s=setup",
        label: null,
      }),
    );
    const saved = await call(ctx, {
      action: "save",
      connectionId: created.connection.id,
    });
    assert.equal(saved.step, "CALENDAR", "saving does not complete the step");
    assert.equal(saved.calendar?.dateRanges, 0);

    const day = (n: number) =>
      app.addDays(app.todayIn("UTC", Date.now()), n).replaceAll("-", "");
    const feed = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//setup//EN",
      "BEGIN:VEVENT",
      "UID:setup-stay@airbnb.com",
      `DTSTART;VALUE=DATE:${day(3)}`,
      `DTEND;VALUE=DATE:${day(6)}`,
      "SUMMARY:Reserved",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    await app.runConnection(ctx, created.connection.id, {
      trigger: "MANUAL",
      fetcher: async () => ({
        kind: "BODY",
        status: 200,
        body: feed,
        etag: null,
        lastModified: null,
      }),
    });
    const observed = await call(ctx);
    assert.deepEqual(
      [
        observed.calendar?.dateRanges,
        observed.calendar?.unclassified,
        observed.calendar?.protectedNights,
      ],
      [1, 1, 3],
      "one stay, unclassified until the policy question is answered",
    );

    const afterCalendar = await call(ctx, {
      action: "complete",
      step: "CALENDAR",
    });
    assert.equal(afterCalendar.step, "EXPORT");
    await refused(
      call(ctx, { action: "complete", step: "EXPORT" }),
      "CONFIRMATION_REQUIRED",
    );
    const confirmed = await call(ctx, {
      action: "complete",
      step: "EXPORT",
      exportConfirmed: true,
    });
    assert.ok(confirmed.exportConfirmedAt);
    assert.equal(confirmed.step, "CLEANER");
    await app.tenant(ctx, async (tx) => {
      const record = await tx.auditLog.findFirstOrThrow({
        where: { action: "EXPORT_LINK_CONFIRMED" },
      });
      assert.match(record.reason, /not an observed retrieval/);
      // The host's statement is not evidence of a retrieval.
      assert.equal(
        await tx.exportRetrieval.count({
          where: { connectionId: created.connection.id },
        }),
        0,
      );
    });
  },
);

test(
  "workspaces that did not start from sign-up have no setup record",
  { skip },
  async () => {
    const w = await app.db.workspace.create({ data: { name: "Older" } });
    const state = await call({
      workspaceId: w.id,
      actorId: "someone",
      role: "HOST",
    });
    assert.equal(state.exists, false);
    assert.equal(state.step, "PROPERTY");
  },
);
