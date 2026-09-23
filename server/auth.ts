import { cookies } from "next/headers";
import { db, tenant, lock, type Context } from "./db";
import {
  hash,
  blind,
  passwordMatches,
  randomToken,
  encrypt,
  decrypt,
} from "./crypto";
import { appUrl, cookieOptions } from "./config";
import { AppError, ensure } from "./errors";
import { audit } from "./audit";
export async function rateLimit(key: string, limit = 60, seconds = 60) {
  const now = new Date();
  const row = await db.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "RateLimit" ("key","count","expiresAt") VALUES (${key},1,${new Date(Date.now() + seconds * 1000)}) ON CONFLICT ("key") DO UPDATE SET "count" = CASE WHEN "RateLimit"."expiresAt" < ${now} THEN 1 ELSE "RateLimit"."count"+1 END, "expiresAt" = CASE WHEN "RateLimit"."expiresAt" < ${now} THEN ${new Date(Date.now() + seconds * 1000)} ELSE "RateLimit"."expiresAt" END`;
    return tx.rateLimit.findUniqueOrThrow({ where: { key } });
  });
  ensure(
    row.count <= limit,
    429,
    "RATE_LIMIT",
    "Too many requests. Please try again shortly.",
  );
}
export function checkOrigin(request: Request) {
  ensure(
    request.headers.get("origin") === appUrl(),
    403,
    "ORIGIN",
    "This request must come from your application.",
  );
}
export async function currentContext(): Promise<Context | null> {
  const token = (await cookies()).get("str_session")?.value;
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: hash(token) },
  });
  if (!session || session.expiresAt < new Date()) return null;
  const user = await db.user.findUnique({ where: { id: session.userId } });
  if (!user || user.disabled) return null;
  const member = await db.membership.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: session.workspaceId,
        userId: session.userId,
      },
    },
  });
  if (!member) return null;
  return {
    workspaceId: session.workspaceId,
    actorId: session.userId,
    role: member.role as Context["role"],
  };
}
export async function requireHost(request?: Request) {
  const ctx = await currentContext();
  ensure(ctx, 401, "AUTH_REQUIRED", "Please sign in again.");
  ensure(
    ["HOST", "COHOST"].includes(ctx.role),
    403,
    "FORBIDDEN",
    "This action is available to hosts only.",
  );
  ctx.requestId = request?.headers.get("x-request-id") || crypto.randomUUID();
  await rateLimit(`api:${ctx.actorId}`, 180, 60);
  return ctx;
}
export const ownerOnly = (ctx: Context) =>
  ensure(
    ctx.role === "HOST",
    403,
    "OWNER_REQUIRED",
    "Only the workspace owner can change access or integrations.",
  );
export async function login(email: string, password: string) {
  await rateLimit("login:" + blind(email), 8, 900);
  const user = await db.user.findUnique({ where: { emailHash: blind(email) } });
  const dummy = "scrypt:00000000000000000000000000000000:" + "0".repeat(128);
  const valid = passwordMatches(password, user?.passwordHash || dummy);
  ensure(
    user && !user.disabled && valid,
    401,
    "INVALID_LOGIN",
    "Email or password is incorrect.",
  );
  const membership = await db.membership.findFirst({
    where: { userId: user.id },
    orderBy: { id: "asc" },
  });
  ensure(membership, 403, "NO_WORKSPACE", "No workspace access is available.");
  const token = randomToken();
  await db.session.create({
    data: {
      userId: user.id,
      workspaceId: membership.workspaceId,
      tokenHash: hash(token),
      expiresAt: new Date(Date.now() + 12 * 3600000),
    },
  });
  (await cookies()).set("str_session", token, {
    ...cookieOptions(),
    maxAge: 12 * 3600,
  });
  return { name: user.name };
}
export async function logout() {
  const jar = await cookies(),
    token = jar.get("str_session")?.value;
  if (token) await db.session.deleteMany({ where: { tokenHash: hash(token) } });
  jar.delete("str_session");
}
export async function cleanerContext(
  requireAssignment = true,
): Promise<Context> {
  const token = (await cookies()).get("str_cleaner")?.value;
  ensure(
    token,
    401,
    "LINK_REQUIRED",
    "Open your assigned job link to continue.",
  );
  const link = await db.magicLink.findUnique({
    where: { sessionHash: hash(token) },
  });
  ensure(
    link && !link.revokedAt && link.expiresAt > new Date(),
    401,
    "LINK_EXPIRED",
    "This link has expired or was replaced. Ask your host for a fresh link.",
  );
  const ctx: Context = {
    workspaceId: link.workspaceId,
    actorId: link.cleanerId,
    role: "CLEANER",
    cleanerId: link.cleanerId,
    taskId: link.taskId,
    cleanerSessionId: link.id,
  };
  await tenant(ctx, async (tx) => {
    const cleaner = await tx.cleaner.findFirst({
        where: {
          id: link.cleanerId,
          workspaceId: link.workspaceId,
          enabled: true,
        },
      }),
      task = await tx.cleaningTask.findFirst({
        where: {
          id: link.taskId,
          workspaceId: link.workspaceId,
          cleanerId: link.cleanerId,
        },
      });
    ensure(
      cleaner &&
        (!requireAssignment ||
          (task && cleaner.listingIds.includes(task.listingId))),
      403,
      "ASSIGNMENT_REVOKED",
      "This job is no longer assigned to you.",
    );
  });
  return ctx;
}
export async function redeemMagic(token: string) {
  await rateLimit("magic:" + hash(token), 8, 300);
  const session = randomToken();
  const link = await db.magicLink.findUnique({
    where: { tokenHash: hash(token) },
  });
  ensure(
    link && !link.revokedAt && link.expiresAt > new Date() && !link.redeemedAt,
    401,
    "LINK_EXPIRED",
    "This job link was already used or has expired. Ask your host for a new one.",
  );
  const changed = await db.magicLink.updateMany({
    where: { id: link.id, redeemedAt: null, revokedAt: null },
    data: { redeemedAt: new Date(), sessionHash: hash(session) },
  });
  ensure(
    changed.count === 1,
    409,
    "LINK_USED",
    "This job link has already been used.",
  );
  (await cookies()).set("str_cleaner", session, {
    ...cookieOptions(),
    maxAge: Math.max(
      0,
      Math.floor((link.expiresAt.getTime() - Date.now()) / 1000),
    ),
  });
  return { ok: true };
}

export async function selectCleanerTask(ctx: Context, taskId: string) {
  ensure(
    ctx.role === "CLEANER" && ctx.cleanerId,
    403,
    "CLEANER_REQUIRED",
    "Open a cleaner job link to continue.",
  );
  const jar = await cookies(),
    currentToken = jar.get("str_cleaner")?.value;
  const current = currentToken
    ? await db.magicLink.findUnique({
        where: { sessionHash: hash(currentToken) },
      })
    : null;
  ensure(
    current &&
      current.cleanerId === ctx.cleanerId &&
      current.workspaceId === ctx.workspaceId &&
      !current.revokedAt &&
      current.expiresAt > new Date(),
    401,
    "LINK_EXPIRED",
    "Your cleaner session has expired.",
  );
  const session = randomToken();
  await tenant(ctx, async (tx) => {
    await lock(tx, "magic:" + current.id);
    await lock(tx, "task:" + taskId);
    const active = await tx.magicLink.findFirst({
      where: {
        id: current.id,
        workspaceId: ctx.workspaceId,
        cleanerId: ctx.cleanerId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    ensure(
      active,
      401,
      "LINK_EXPIRED",
      "Your cleaner session has expired or changed.",
    );
    const cleaner = await tx.cleaner.findFirst({
      where: { workspaceId: ctx.workspaceId, id: ctx.cleanerId, enabled: true },
    });
    const task = await tx.cleaningTask.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        id: taskId,
        cleanerId: ctx.cleanerId,
        status: { in: ["ASSIGNED", "ACCEPTED", "IN_PROGRESS", "DONE"] },
      },
    });
    ensure(
      cleaner && task && cleaner.listingIds.includes(task.listingId),
      404,
      "NOT_FOUND",
      "No active job is assigned to you with that identifier.",
    );
    if (task.bookingId) {
      const booking = await tx.booking.findFirst({
        where: { workspaceId: ctx.workspaceId, id: task.bookingId },
      });
      ensure(
        booking?.status === "CONFIRMED",
        409,
        "BOOKING_REVIEW",
        "Your host needs to review this reservation before you can continue.",
      );
    }
    await tx.magicLink.create({
      data: {
        workspaceId: ctx.workspaceId,
        taskId: task.id,
        cleanerId: ctx.cleanerId!,
        tokenHash: hash(randomToken()),
        sessionHash: hash(session),
        redeemedAt: new Date(),
        expiresAt: current.expiresAt,
      },
    });
    await tx.magicLink.update({
      where: { id: current.id },
      data: { revokedAt: new Date() },
    });
    await audit(
      tx,
      ctx,
      "SELECT_JOB",
      "CleaningTask",
      task.id,
      "Cleaner switched to another active assigned job; a fresh task-scoped session replaced the previous session without extending its lifetime.",
    );
  });
  jar.set("str_cleaner", session, {
    ...cookieOptions(),
    maxAge: Math.max(
      0,
      Math.floor((current.expiresAt.getTime() - Date.now()) / 1000),
    ),
  });
  return { ...ctx, taskId };
}
