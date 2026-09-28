// Self-service accounts (AUTH 01, AUTH 03). Sign-up creates nothing but a
// pending registration until the emailed link is used, so sign-in never sees
// an unverified account and existing accounts are unaffected. Responses to
// sign-up and reset requests are identical whether or not an account exists;
// only the address's owner learns that, by email. Tokens are random, stored
// only as hashes, and single use.
import { rateLimit } from "../auth";
import {
  blind,
  decrypt,
  encrypt,
  hash,
  passwordHash,
  randomToken,
} from "../crypto";
import { db, ensureDatabaseSafety } from "../db";
import { ensure } from "../errors";
import { createOwnerAccount } from "./bootstrap";
import {
  deliver,
  existingAccountEmail,
  resetEmail,
  verificationEmail,
} from "./email";
import { passwordProblem } from "./passwords";

export const REGISTRATION_TTL_MS = 24 * 3_600_000;
export const RESET_TTL_MS = 30 * 60_000;

export const SIGNUP_SENT =
  "If this address can be used, we've sent a link to finish creating your account. It expires in 24 hours.";
export const RESET_SENT =
  "If an account uses this address, we've sent a link to reset its password. It expires in 30 minutes.";

const INVALID_SIGNUP_LINK =
  "This link has expired or was already used. Sign up again to get a new one.";
const INVALID_RESET_LINK =
  "This reset link has expired or was already used. Ask for a new one.";

async function strongPassword(password: string, email: string) {
  const problem = await passwordProblem(password, { email });
  ensure(!problem, 400, "WEAK_PASSWORD", problem ?? "");
}

export async function register(input: {
  name: string;
  email: string;
  password: string;
  workspaceName: string;
}) {
  await ensureDatabaseSafety();
  await rateLimit("register-global", 60, 60);
  await rateLimit("register:" + blind(input.email), 5, 3600);
  await strongPassword(input.password, input.email);
  // Hash before looking the address up, so both outcomes cost the same.
  const hashed = passwordHash(input.password);
  const now = new Date();
  await db.pendingRegistration.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  const existing = await db.user.findUnique({
    where: { emailHash: blind(input.email) },
  });
  if (existing) {
    await deliver(existingAccountEmail(input.email));
    return { message: SIGNUP_SENT };
  }
  const token = randomToken();
  const pending = {
    emailEncrypted: encrypt(input.email.trim(), "identity"),
    name: input.name,
    workspaceName: input.workspaceName,
    passwordHash: hashed,
    tokenHash: hash(token),
    expiresAt: new Date(now.getTime() + REGISTRATION_TTL_MS),
  };
  // One pending sign-up per address: asking again replaces the link.
  await db.pendingRegistration.upsert({
    where: { emailHash: blind(input.email) },
    create: { emailHash: blind(input.email), ...pending },
    update: pending,
  });
  await deliver(verificationEmail(input.email.trim(), input.name, token));
  return { message: SIGNUP_SENT };
}

/** Use a sign-up link: create the account and workspace. */
export async function verifyRegistration(token: string) {
  await ensureDatabaseSafety();
  await rateLimit("verify-global", 60, 60);
  await rateLimit("verify:" + hash(token), 10, 600);
  return db.$transaction(async (tx) => {
    const pending = await tx.pendingRegistration.findUnique({
      where: { tokenHash: hash(token) },
    });
    ensure(
      pending && pending.expiresAt > new Date(),
      400,
      "LINK_INVALID",
      INVALID_SIGNUP_LINK,
    );
    // Single use: only the transaction that removes the row continues.
    const claimed = await tx.pendingRegistration.deleteMany({
      where: { id: pending.id, tokenHash: pending.tokenHash },
    });
    ensure(claimed.count === 1, 400, "LINK_INVALID", INVALID_SIGNUP_LINK);
    const taken = await tx.user.findUnique({
      where: { emailHash: pending.emailHash },
    });
    ensure(
      !taken,
      409,
      "ACCOUNT_EXISTS",
      "An account already uses this address. Sign in instead.",
    );
    return createOwnerAccount(tx, {
      email: decrypt(pending.emailEncrypted, "identity"),
      name: pending.name,
      passwordHash: pending.passwordHash,
      workspaceName: pending.workspaceName,
      reason:
        "Account created by email sign-up after the address was verified. Automation starts paused; FAQ rules start in draft mode.",
    });
  });
}

export async function requestPasswordReset(email: string) {
  await ensureDatabaseSafety();
  await rateLimit("forgot-global", 60, 60);
  await rateLimit("forgot:" + blind(email), 5, 3600);
  const now = new Date();
  await db.passwordReset.deleteMany({
    where: { expiresAt: { lt: new Date(now.getTime() - 86_400_000) } },
  });
  const user = await db.user.findUnique({ where: { emailHash: blind(email) } });
  if (user && !user.disabled) {
    const token = randomToken();
    // Only the newest link works.
    await db.$transaction([
      db.passwordReset.deleteMany({ where: { userId: user.id, usedAt: null } }),
      db.passwordReset.create({
        data: {
          userId: user.id,
          tokenHash: hash(token),
          createdAt: now,
          expiresAt: new Date(now.getTime() + RESET_TTL_MS),
        },
      }),
    ]);
    await deliver(resetEmail(email.trim(), user.name, token));
  }
  return { message: RESET_SENT };
}

/** Use a reset link: set the password and sign out every session. */
export async function resetPassword(token: string, password: string) {
  await ensureDatabaseSafety();
  await rateLimit("reset-global", 60, 60);
  await rateLimit("reset:" + hash(token), 10, 600);
  const link = await db.passwordReset.findUnique({
    where: { tokenHash: hash(token) },
  });
  ensure(
    link && !link.usedAt && link.expiresAt > new Date(),
    400,
    "LINK_INVALID",
    INVALID_RESET_LINK,
  );
  const user = await db.user.findUniqueOrThrow({ where: { id: link.userId } });
  ensure(!user.disabled, 400, "LINK_INVALID", INVALID_RESET_LINK);
  await strongPassword(password, decrypt(user.emailEncrypted, "identity"));
  const hashed = passwordHash(password);
  await db.$transaction(async (tx) => {
    const claimed = await tx.passwordReset.updateMany({
      where: { id: link.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    ensure(claimed.count === 1, 400, "LINK_INVALID", INVALID_RESET_LINK);
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash: hashed },
    });
    // AUTH 03: a successful reset invalidates every session.
    await tx.session.deleteMany({ where: { userId: user.id } });
    for (const m of await tx.membership.findMany({
      where: { userId: user.id },
    })) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id',${m.workspaceId},true)`;
      await tx.auditLog.create({
        data: {
          workspaceId: m.workspaceId,
          actorId: user.id,
          action: "PASSWORD_RESET",
          entity: "User",
          entityId: user.id,
          reason:
            "Password reset through an emailed link; all sessions were revoked.",
        },
      });
    }
  });
  return { ok: true };
}
