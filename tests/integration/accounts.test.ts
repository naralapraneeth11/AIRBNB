// Self-service accounts against real PostgreSQL as the NOSUPERUSER
// NOBYPASSRLS runtime role (AUTH 01, AUTH 03). With APP_ENVIRONMENT=test the
// emails go to the log transport; the tests read the links from it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { createTestDatabase, skip, type TestDatabase } from "./harness";

let t: TestDatabase | undefined;
let app: Awaited<ReturnType<typeof load>>;

async function load() {
  const db = await import("../../src/server/db");
  const accounts = await import("../../src/server/accounts/service");
  const crypto = await import("../../src/server/crypto");
  return { ...db, ...accounts, ...crypto };
}

/** Emails printed by the log transport since the last call. */
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

const takeEmails = () => outbox.splice(0, outbox.length);
const linkToken = (email: string, page: "verify" | "reset") => {
  const match = email.match(new RegExp(`/${page}#token=([A-Za-z0-9_-]+)`));
  assert.ok(match, `no ${page} link in: ${email}`);
  return match[1];
};
// Random words: never in a breach list, whether or not the check can run.
const password = () =>
  `${randomBytes(6).toString("hex")} lantern ${randomBytes(6).toString("hex")}`;
const rejects = (work: Promise<unknown>, code: string) =>
  assert.rejects(work, (e: { code?: string }) => e.code === code);

const EMAIL = "new.host@example.com";
let firstPassword = "";

test(
  "sign-up creates nothing until the emailed link is used, then a paused, shadow-mode workspace (AUTH 01)",
  { skip },
  async () => {
    firstPassword = password();
    const answer = await app.register({
      name: "New Host",
      email: EMAIL,
      password: firstPassword,
      workspaceName: "New Host Rentals",
    });
    assert.equal(answer.message, app.SIGNUP_SENT);
    assert.equal(await app.db.user.count(), 0, "no account yet");
    assert.equal(await app.db.pendingRegistration.count(), 1);
    const [email] = takeEmails();
    assert.match(email, /to=new\.host@example\.com/);
    assert.match(email, /Finish creating your/);
    const token = linkToken(email, "verify");

    const created = await app.verifyRegistration(token);
    const user = await app.db.user.findUniqueOrThrow({
      where: { id: created.userId },
    });
    assert.equal(user.name, "New Host");
    assert.ok(app.passwordMatches(firstPassword, user.passwordHash));
    assert.equal(app.decrypt(user.emailEncrypted, "identity"), EMAIL);
    const membership = await app.db.membership.findFirstOrThrow({
      where: { userId: user.id },
    });
    assert.equal(membership.role, "HOST");
    const workspace = await app.db.workspace.findUniqueOrThrow({
      where: { id: created.workspaceId },
    });
    assert.equal(workspace.name, "New Host Rentals");
    assert.equal(workspace.calendarMode, "SHADOW");
    const ctx = {
      workspaceId: created.workspaceId,
      actorId: user.id,
      role: "HOST" as const,
    };
    await app.tenant(ctx, async (tx) => {
      const settings = await tx.automationSettings.findFirstOrThrow();
      assert.equal(settings.paused, true);
      const rules = await tx.automationRule.findMany();
      assert.equal(rules.length, 4);
      assert.ok(rules.every((r) => r.action === "DRAFT"));
      assert.equal(
        await tx.auditLog.count({ where: { action: "WORKSPACE_CREATED" } }),
        1,
      );
    });
    assert.equal(await app.db.pendingRegistration.count(), 0);
    await rejects(app.verifyRegistration(token), "LINK_INVALID");
  },
);

test(
  "an address that already has an account gets the same answer, and its owner an email (AUTH 01)",
  { skip },
  async () => {
    const answer = await app.register({
      name: "Someone Else",
      email: " New.Host@Example.com ",
      password: password(),
      workspaceName: "Another",
    });
    assert.equal(answer.message, app.SIGNUP_SENT);
    assert.equal(await app.db.pendingRegistration.count(), 0);
    assert.equal(await app.db.user.count(), 1);
    const [email] = takeEmails();
    assert.match(email, /already has one/);
    assert.doesNotMatch(email, /token=/);
  },
);

test(
  "a sign-up link expires, and asking again replaces the link",
  { skip },
  async () => {
    const second = "second.host@example.com";
    const details = {
      name: "Second Host",
      email: second,
      password: password(),
      workspaceName: "Second",
    };
    await app.register(details);
    const firstToken = linkToken(takeEmails()[0], "verify");
    await app.register(details);
    const secondToken = linkToken(takeEmails()[0], "verify");
    assert.notEqual(firstToken, secondToken);
    await rejects(app.verifyRegistration(firstToken), "LINK_INVALID");
    await app.db.pendingRegistration.updateMany({
      data: {
        createdAt: new Date(Date.now() - 3 * 86_400_000),
        expiresAt: new Date(Date.now() - 86_400_000),
      },
    });
    await rejects(app.verifyRegistration(secondToken), "LINK_INVALID");
    assert.equal(await app.db.user.count(), 1);
  },
);

test(
  "weak passwords are refused with a reason before anything is stored",
  { skip },
  async () => {
    await rejects(
      app.register({
        name: "Weak",
        email: "weak@example.com",
        password: "tooshort",
        workspaceName: "Weak",
      }),
      "WEAK_PASSWORD",
    );
    assert.equal(
      await app.db.pendingRegistration.count({
        where: { emailHash: app.blind("weak@example.com") },
      }),
      0,
    );
    assert.equal(takeEmails().length, 0);
  },
);

test(
  "a reset link works once, within 30 minutes, and signs out every session (AUTH 03)",
  { skip },
  async () => {
    const user = await app.db.user.findUniqueOrThrow({
      where: { emailHash: app.blind(EMAIL) },
    });
    const membership = await app.db.membership.findFirstOrThrow({
      where: { userId: user.id },
    });
    for (const n of [1, 2])
      await app.db.session.create({
        data: {
          userId: user.id,
          workspaceId: membership.workspaceId,
          tokenHash: app.hash(`session-${n}`),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });

    const unknown = await app.requestPasswordReset("nobody@example.com");
    assert.equal(unknown.message, app.RESET_SENT);
    assert.equal(
      takeEmails().length,
      0,
      "nothing is sent for an unknown address",
    );

    const known = await app.requestPasswordReset(EMAIL.toUpperCase());
    assert.equal(known.message, app.RESET_SENT, "the same answer either way");
    const token = linkToken(takeEmails()[0], "reset");
    await rejects(app.resetPassword(token, "short"), "WEAK_PASSWORD");

    const next = password();
    await app.resetPassword(token, next);
    const updated = await app.db.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    assert.ok(app.passwordMatches(next, updated.passwordHash));
    assert.equal(
      app.passwordMatches(firstPassword, updated.passwordHash),
      false,
    );
    assert.equal(
      await app.db.session.count({ where: { userId: user.id } }),
      0,
      "every session is signed out",
    );
    await app.tenant(
      { workspaceId: membership.workspaceId, actorId: user.id, role: "HOST" },
      async (tx) =>
        assert.equal(
          await tx.auditLog.count({ where: { action: "PASSWORD_RESET" } }),
          1,
        ),
    );
    await rejects(app.resetPassword(token, password()), "LINK_INVALID");

    // Only the newest link works, and none after 30 minutes.
    await app.requestPasswordReset(EMAIL);
    const older = linkToken(takeEmails()[0], "reset");
    await app.requestPasswordReset(EMAIL);
    const newest = linkToken(takeEmails()[0], "reset");
    await rejects(app.resetPassword(older, password()), "LINK_INVALID");
    await app.db.passwordReset.updateMany({
      where: { usedAt: null },
      data: {
        createdAt: new Date(Date.now() - 60 * 60_000),
        expiresAt: new Date(Date.now() - 31 * 60_000),
      },
    });
    await rejects(app.resetPassword(newest, password()), "LINK_INVALID");
  },
);

test(
  "reset requests are rate limited per address, not locked out for good",
  { skip },
  async () => {
    const address = "limited@example.com";
    for (let i = 0; i < 5; i++) await app.requestPasswordReset(address);
    await rejects(app.requestPasswordReset(address), "RATE_LIMIT");
    // The window is an hour, then requests are accepted again.
    await app.db.rateLimit.update({
      where: { key: "forgot:" + app.blind(address) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const again = await app.requestPasswordReset(address);
    assert.equal(again.message, app.RESET_SENT);
  },
);
