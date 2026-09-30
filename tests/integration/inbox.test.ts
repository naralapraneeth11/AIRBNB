// The Inbox API against real PostgreSQL through the runtime role. Open
// screens refresh these routes every few seconds, so: the list is bounded
// and stable, a conversation opens on its newest messages and pages back
// without skipping or repeating one, reads are logged once per window, and
// a retried reply is sent once while a reused request with other words is
// refused.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase, skip, type TestDatabase } from "./harness";

let t: TestDatabase | undefined;
let app: Awaited<ReturnType<typeof load>>;

async function load() {
  const db = await import("../../src/server/db");
  const inbox = await import("../../src/server/routes/inbox");
  const messaging = await import("../../src/server/services/messaging");
  const audit = await import("../../src/server/audit");
  const crypto = await import("../../src/server/crypto");
  return { ...db, ...inbox, ...messaging, ...audit, ...crypto };
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

type Ctx = { workspaceId: string; actorId: string; role: "HOST" };
type Row = { id: string; body: string; status: string; createdAt: string };
type Page = { messages: Row[]; hasOlder: boolean };
type Summary = { id: string; guestName: string; preview: string };

async function call<T>(
  ctx: Ctx,
  path: string,
  method = "GET",
  payload?: object,
): Promise<T> {
  const url = "https://app.test/api/" + path;
  const request = new NextRequest(url, {
    method,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const route = new URL(url).pathname.split("/").slice(2);
  const response = await app.inboxRoutes(request, route, method, ctx);
  assert.ok(response, `no route for ${method} ${path}`);
  return response.json();
}
const refused = (work: Promise<unknown>, code: string) =>
  assert.rejects(work, (e: { code?: string }) => e.code === code);

let counter = 0;
async function workspace(): Promise<Ctx & { listingId: string }> {
  const w = await app.db.workspace.create({
    data: { name: `Inbox ${++counter}` },
  });
  const ctx: Ctx = { workspaceId: w.id, actorId: "host-a", role: "HOST" };
  const listing = await app.tenant(ctx, (tx) =>
    tx.listing.create({
      data: {
        workspaceId: w.id,
        name: "Inbox cabin",
        address: "Integration test address",
        timezone: "UTC",
        houseManualEncrypted: app.seal({}, w.id),
      },
    }),
  );
  return { ...ctx, listingId: listing.id };
}

async function conversation(
  ctx: Ctx & { listingId: string },
  guest: string,
  patch: { platform?: string; status?: string; updatedAt?: Date } = {},
) {
  return app.tenant(ctx, async (tx) => {
    const reservation = await tx.reservation.create({
      data: {
        workspaceId: ctx.workspaceId,
        listingId: ctx.listingId,
        source: "DIRECT",
        platform: "DIRECT",
        startDate: new Date("2026-11-02"),
        endDate: new Date("2026-11-05"),
        guestNameEncrypted: app.encrypt(guest, ctx.workspaceId),
        currency: "USD",
        firstObservedAt: new Date(),
      },
    });
    return tx.thread.create({
      data: {
        workspaceId: ctx.workspaceId,
        listingId: ctx.listingId,
        reservationId: reservation.id,
        externalId: randomUUID(),
        platform: patch.platform ?? "DIRECT",
        status: patch.status ?? "NEEDS_REPLY",
        ...(patch.updatedAt ? { updatedAt: patch.updatedAt } : {}),
      },
    });
  });
}

async function messages(
  ctx: Ctx,
  threadId: string,
  rows: { body: string; at: Date; status?: string; sender?: string }[],
) {
  await app.tenant(ctx, (tx) =>
    tx.message.createMany({
      data: rows.map((r) => ({
        workspaceId: ctx.workspaceId,
        threadId,
        bodyEncrypted: app.encrypt(r.body, ctx.workspaceId),
        sender: r.sender ?? "GUEST",
        status: r.status ?? "RECEIVED",
        createdAt: r.at,
      })),
    }),
  );
}

test(
  "the list previews each conversation's newest visible message, in a stable order",
  { skip },
  async () => {
    const ctx = await workspace();
    const same = new Date("2026-09-01T10:00:00Z");
    const a = await conversation(ctx, "Ada Guest", { updatedAt: same });
    const b = await conversation(ctx, "Ben Guest", { updatedAt: same });
    const quiet = await conversation(ctx, "Cy Guest", {
      platform: "AIRBNB",
      status: "RESOLVED",
      updatedAt: new Date("2026-08-01T10:00:00Z"),
    });
    await messages(ctx, a.id, [
      { body: "Is there parking?", at: new Date("2026-09-01T09:00:00Z") },
      {
        body: "Yes, two spaces.",
        at: new Date("2026-09-01T09:01:00Z"),
        status: "DRAFT",
        sender: "AI",
      },
      {
        body: "A dismissed suggestion",
        at: new Date("2026-09-01T09:02:00Z"),
        status: "DISMISSED",
        sender: "AI",
      },
    ]);
    const list = await call<Summary[]>(ctx, "threads");
    // Equal activity times fall back to the id, so refreshes never reorder.
    assert.deepEqual(
      list.map((s) => s.id),
      [...[a.id, b.id].sort().reverse(), quiet.id],
    );
    const byId = new Map(list.map((s) => [s.id, s]));
    assert.equal(byId.get(a.id)?.guestName, "Ada Guest");
    assert.equal(byId.get(a.id)?.preview, "Yes, two spaces.");
    assert.equal(byId.get(b.id)?.preview, "", "no messages yet");

    const filtered = await call<Summary[]>(
      ctx,
      "threads?platform=AIRBNB&status=RESOLVED",
    );
    assert.deepEqual(
      filtered.map((s) => s.id),
      [quiet.id],
    );
  },
);

test("the list is capped, newest activity first", { skip }, async () => {
  const ctx = await workspace();
  const total = app.THREAD_LIST_LIMIT + 5;
  await app.tenant(ctx, async (tx) => {
    const reservations = Array.from({ length: total }, () => ({
      id: randomUUID(),
      workspaceId: ctx.workspaceId,
      listingId: ctx.listingId,
      source: "DIRECT",
      platform: "DIRECT",
      startDate: new Date("2026-11-02"),
      endDate: new Date("2026-11-05"),
      currency: "USD",
      firstObservedAt: new Date(),
    }));
    await tx.reservation.createMany({ data: reservations });
    await tx.thread.createMany({
      data: reservations.map((r, i) => ({
        workspaceId: ctx.workspaceId,
        listingId: ctx.listingId,
        reservationId: r.id,
        externalId: `capped-${i}`,
        platform: "DIRECT",
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      })),
    });
  });
  const list = await call<(Summary & { externalId: string })[]>(ctx, "threads");
  assert.equal(list.length, app.THREAD_LIST_LIMIT);
  assert.equal(list[0].externalId, `capped-${total - 1}`);
  assert.equal(list[0].guestName, "Guest", "a reservation without a name");
});

test(
  "a conversation opens on its newest messages and pages back without skipping or repeating",
  { skip },
  async () => {
    const ctx = await workspace();
    const thread = await conversation(ctx, "Dee Guest");
    // 130 messages; every three share a timestamp, and every tenth is a
    // dismissed suggestion that is never shown.
    const rows = Array.from({ length: 130 }, (_, i) => ({
      body: `message ${i}`,
      at: new Date(Date.UTC(2026, 8, 1, 0, Math.floor(i / 3))),
      ...(i % 10 === 9 ? { status: "DISMISSED", sender: "AI" } : {}),
    }));
    await messages(ctx, thread.id, rows);
    const expected = await app.tenant(ctx, (tx) =>
      tx.message.findMany({
        where: { threadId: thread.id, status: { not: "DISMISSED" } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      }),
    );
    assert.equal(expected.length, 117);

    const first = await call<Page & { thread: { id: string } }>(
      ctx,
      `threads/${thread.id}`,
    );
    assert.equal(first.thread.id, thread.id);
    assert.equal(first.messages.length, app.MESSAGE_PAGE);
    assert.equal(first.hasOlder, true);
    assert.deepEqual(
      first.messages.map((m) => m.id),
      expected.slice(-app.MESSAGE_PAGE).map((m) => m.id),
      "the newest page, oldest first",
    );

    const seen = [...first.messages];
    let hasOlder: boolean = first.hasOlder;
    while (hasOlder) {
      const page = await call<Page>(
        ctx,
        `threads/${thread.id}/messages?before=${seen[0].id}`,
      );
      seen.unshift(...page.messages);
      hasOlder = page.hasOlder;
    }
    assert.deepEqual(
      seen.map((m) => m.id),
      expected.map((m) => m.id),
      "every visible message exactly once, in order",
    );
    assert.ok(seen.every((m) => m.status !== "DISMISSED"));
  },
);

test(
  "reads are logged once per person and conversation within the window",
  { skip },
  async () => {
    const ctx = await workspace();
    const thread = await conversation(ctx, "Eve Guest");
    await messages(ctx, thread.id, [
      { body: "Hello", at: new Date("2026-09-01T09:00:00Z") },
    ]);
    for (let i = 0; i < 3; i++) {
      await call(ctx, `threads/${thread.id}`);
      await call(ctx, "threads");
    }
    await call({ ...ctx, actorId: "host-b" }, `threads/${thread.id}`);
    const reads = () =>
      app.tenant(ctx, (tx) =>
        tx.auditLog.findMany({
          where: { action: "READ", entity: "Thread" },
          select: { actorId: true, entityId: true },
        }),
      );
    const logged = await reads();
    assert.equal(logged.length, 3);
    assert.equal(
      logged.filter((r) => r.entityId === thread.id && r.actorId === "host-a")
        .length,
      1,
    );
    assert.equal(logged.filter((r) => r.entityId === null).length, 1);

    // After the window, the next read is recorded again.
    await app.tenant(ctx, (tx) =>
      app.auditRead(
        tx,
        ctx,
        "Thread",
        thread.id,
        "Later read.",
        new Date(Date.now() + app.READ_AUDIT_WINDOW_MS + 1000),
      ),
    );
    assert.equal((await reads()).length, 4);
  },
);

test(
  "a retried reply is sent once; the same request with other words is refused",
  { skip },
  async () => {
    const ctx = await workspace();
    const thread = await conversation(ctx, "Fay Guest");
    const send = (body: string, key: string, draftId?: string) =>
      app.tenant(ctx, (tx) =>
        app.reply(tx, ctx, thread.id, body, key, draftId),
      );
    const counts = () =>
      app.tenant(ctx, async (tx) => ({
        messages: await tx.message.count({ where: { threadId: thread.id } }),
        jobs: await tx.outbox.count({ where: { kind: "GUEST_MESSAGE" } }),
        approvals: await tx.auditLog.count({
          where: { action: "APPROVE_SEND" },
        }),
      }));

    const key = randomUUID();
    const sent = await send("See you at four.", key);
    const again = await send("See you at four.", key);
    assert.deepEqual(again, sent, "the retry returns the first result");
    assert.deepEqual(await counts(), { messages: 1, jobs: 1, approvals: 1 });
    await refused(send("See you at five.", key), "IDEMPOTENCY_KEY_REUSED");
    assert.deepEqual(await counts(), { messages: 1, jobs: 1, approvals: 1 });

    const draft = await app.tenant(ctx, (tx) =>
      tx.message.create({
        data: {
          workspaceId: ctx.workspaceId,
          threadId: thread.id,
          bodyEncrypted: app.encrypt("Suggested words", ctx.workspaceId),
          sender: "AI",
          automated: true,
          aiConfidence: 0.9,
          status: "DRAFT",
        },
      }),
    );
    const approved = await send("Edited words", randomUUID(), draft.id);
    assert.equal(approved.id, draft.id);
    assert.equal(approved.status, "QUEUED");
    // The approval landed but its response was lost: the retry succeeds.
    const retried = await send("Edited words", randomUUID(), draft.id);
    assert.deepEqual(retried, approved);
    await refused(
      send("Different words", randomUUID(), draft.id),
      "DRAFT_CHANGED",
    );
    assert.deepEqual(await counts(), { messages: 2, jobs: 2, approvals: 2 });
  },
);

test(
  "another workspace's conversations and messages are out of reach",
  { skip },
  async () => {
    const mine = await workspace();
    const theirs = await workspace();
    const thread = await conversation(theirs, "Gus Guest");
    await messages(theirs, thread.id, [
      { body: "Private", at: new Date("2026-09-01T09:00:00Z") },
    ]);
    const [message] = await app.tenant(theirs, (tx) =>
      tx.message.findMany({ where: { threadId: thread.id } }),
    );
    await refused(call(mine, `threads/${thread.id}`), "NOT_FOUND");
    await refused(
      call(mine, `threads/${thread.id}/messages?before=${message.id}`),
      "NOT_FOUND",
    );
    assert.deepEqual(await call(mine, "threads"), []);
  },
);
