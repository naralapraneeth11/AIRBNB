import { NextRequest, after } from "next/server";
import { z, ZodError } from "zod";
import { createHmac } from "node:crypto";
import { db, tenant, lock, ensureDatabaseSafety, type Context } from "./db";
import {
  requireHost,
  currentContext,
  cleanerContext,
  redeemMagic,
  selectCleanerTask,
  checkOrigin,
  login,
  logout,
  ownerOnly,
  rateLimit,
  startSession,
} from "./auth";
import { accountFeatures } from "./accounts/email";
import { passwordProblem } from "./accounts/passwords";
import {
  register,
  requestPasswordReset,
  resetPassword,
  verifyRegistration,
} from "./accounts/service";
import { AppError, ensure } from "./errors";
import { required, providerStatus } from "./config";
import {
  encrypt,
  decrypt,
  seal,
  unseal,
  hash,
  blind,
  equal,
  passwordHash,
  passwordMatches,
} from "./crypto";
import { audit, notify, event } from "./audit";
import * as V from "./validation";
import {
  activeListing,
  activeListingIds,
  listingDTO,
} from "./services/listings";
import {
  assignTask,
  transitionTask,
  cleanerJob,
  cleanerJobs,
  turnoverStanding,
} from "./services/cleaning";
import { inbound, reply } from "./services/messaging";
import { dispatchOutbox, runTick } from "./services/jobs";
import { uploadPhoto, readPhoto } from "./services/storage";
import { insights } from "./services/insights";
import { command } from "./services/commands";
import { allowedHost } from "./integrations/http";
import { reportError } from "./observability";
import { dayAdd } from "@/lib/domain";
import { body, bytes, formBody, json, range } from "./http";
import { calendarRoutes } from "./routes/calendar";
import { onboardingRoutes } from "./routes/onboarding";
import { inboxRoutes } from "./routes/inbox";
import {
  removalPreview,
  removeProperty,
  removedProperties,
  restoreProperty,
} from "./services/properties";
import { eraseProperty, erasurePreview } from "./services/erasure";
import { operationsHealth } from "./routes/operations";
import { createConnection } from "./calendar/actions";
import { propertySettingsChanged } from "./calendar/commit";
import { connectionDTO } from "./calendar/dto";
import { serveExport } from "./calendar/serve";

/** Resolve no sooner than `ms`, so response time does not reveal the path taken. */
async function atLeast<T>(ms: number, work: Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await work;
  } finally {
    const wait = ms - (Date.now() - started);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
function kick(workspaceId: string) {
  after(async () => {
    try {
      await dispatchOutbox(workspaceId, 20000);
    } catch (error) {
      reportError(error, "background-dispatch");
    }
  });
}
export async function handle(request: NextRequest) {
  const started = Date.now(),
    requestId = crypto.randomUUID();
  const path = new URL(request.url).pathname
      .replace(/^\/api\/?/, "")
      .split("/")
      .filter(Boolean),
    method = request.method;
  try {
    if (method === "GET" && path[0] === "health") {
      if (path[1] === "operations") return operationsHealth(request);
      await db.$queryRaw`SELECT 1`;
      return json({ status: "ok", database: "reachable" });
    }
    // SEC 04: refuse to touch data from an incompatible environment.
    await ensureDatabaseSafety();
    if (path[0] === "cron") {
      ensure(
        equal(
          request.headers.get("authorization") || "",
          `Bearer ${required("CRON_SECRET")}`,
        ),
        401,
        "UNAUTHORIZED",
        "Invalid scheduler authorization.",
      );
      return json(await runTick("CRON_HTTP"));
    }
    if (path[0] === "webhooks" && path[1] === "messages" && method === "POST") {
      const raw = (await bytes(request, 64000)).toString("utf8");
      ensure(
        Buffer.byteLength(raw) <= 64000,
        413,
        "BODY_LIMIT",
        "Payload too large.",
      );
      const timestamp = request.headers.get("x-str-timestamp") || "";
      ensure(
        /^\d+$/.test(timestamp) &&
          Math.abs(Date.now() / 1000 - Number(timestamp)) < 300,
        401,
        "WEBHOOK_EXPIRED",
        "Invalid webhook timestamp.",
      );
      const input = V.incoming.parse(JSON.parse(raw));
      const ctx: Context = {
        workspaceId: input.workspaceId,
        actorId: "provider:" + input.platform,
        role: "SYSTEM",
        requestId,
      };
      const result = await tenant(ctx, async (tx) => {
        const integration = await tx.integration.findUnique({
          where: {
            workspaceId_platform: {
              workspaceId: ctx.workspaceId,
              platform: input.platform,
            },
          },
        });
        ensure(
          integration?.enabled,
          401,
          "INTEGRATION_DISABLED",
          "Integration is unavailable.",
        );
        const signature = createHmac(
          "sha256",
          decrypt(integration.secretEncrypted, ctx.workspaceId),
        )
          .update(timestamp + "." + raw)
          .digest("hex");
        ensure(
          equal(signature, request.headers.get("x-str-signature") || ""),
          401,
          "WEBHOOK_SIGNATURE",
          "Invalid webhook signature.",
        );
        return inbound(tx, ctx, input);
      });
      kick(ctx.workspaceId);
      return json({ id: result.id }, 202);
    }
    if (
      (method === "GET" || method === "HEAD") &&
      path[0] === "listings" &&
      path[2] === "export.ics"
    ) {
      const q = request.nextUrl.searchParams,
        workspaceId = V.id.parse(q.get("workspace")),
        token = z.string().min(20).max(100).parse(q.get("token")),
        source = q.get("source");
      await rateLimit("feed:" + hash(token), 100, 60);
      return serveExport({
        workspaceId,
        listingId: V.id.parse(path[1]),
        token,
        connectionId: source ? V.id.parse(source) : null,
        method,
        ifNoneMatch: request.headers.get("if-none-match"),
      });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) checkOrigin(request);
    if (path[0] === "auth") {
      // AUTH 01 / AUTH 03. Sign-up and reset requests answer the same way
      // whether or not an account exists, and take at least as long either
      // way, so neither the answer nor its timing tells.
      if (path[1] === "register" && method === "POST") {
        ensure(
          accountFeatures().signup,
          404,
          "SIGNUP_UNAVAILABLE",
          "Sign-up is not open on this deployment.",
        );
        const input = z
          .object({
            name: z.string().trim().min(1).max(100),
            email: z.email().max(254),
            password: z.string().max(512),
            workspaceName: z.string().trim().min(1).max(100),
          })
          .parse(await body(request));
        return json(await atLeast(900, register(input)), 202);
      }
      if (path[1] === "verify" && method === "POST") {
        ensure(
          accountFeatures().signup,
          404,
          "SIGNUP_UNAVAILABLE",
          "Sign-up is not open on this deployment.",
        );
        const input = z
          .object({ token: z.string().min(30).max(100) })
          .parse(await body(request));
        const account = await verifyRegistration(input.token);
        await startSession(account.userId, account.workspaceId);
        return json({ ok: true, next: "/setup" });
      }
      if (path[1] === "forgot" && method === "POST") {
        ensure(
          accountFeatures().reset,
          404,
          "RESET_UNAVAILABLE",
          "Password reset by email is not set up on this deployment.",
        );
        const input = z
          .object({ email: z.email().max(254) })
          .parse(await body(request));
        return json(await atLeast(900, requestPasswordReset(input.email)), 202);
      }
      if (path[1] === "reset" && method === "POST") {
        ensure(
          accountFeatures().reset,
          404,
          "RESET_UNAVAILABLE",
          "Password reset by email is not set up on this deployment.",
        );
        const input = z
          .object({
            token: z.string().min(30).max(100),
            password: z.string().max(512),
          })
          .parse(await body(request));
        return json(await resetPassword(input.token, input.password));
      }
      if (path[1] === "login" && method === "POST") {
        await rateLimit("login-global", 100, 60);
        const input = z
          .object({ email: z.email(), password: z.string().min(1).max(512) })
          .parse(await body(request));
        return json(await login(input.email, input.password));
      }
      if (path[1] === "logout" && method === "POST") {
        await logout();
        return json({ ok: true });
      }
    }
    if (path[0] === "cleaner") {
      if (path[1] === "redeem" && method === "POST") {
        const input = z
          .object({ token: z.string().min(30).max(100) })
          .parse(await body(request));
        return json(await redeemMagic(input.token));
      }
      const ctx = await cleanerContext(!["jobs", "select"].includes(path[1]));
      ctx.requestId = requestId;
      await rateLimit("cleaner:" + ctx.cleanerId, 100, 60);
      if (method === "GET" && path.length === 1)
        return json(await tenant(ctx, (tx) => cleanerJob(tx, ctx)));
      if (method === "GET" && path[1] === "jobs")
        return json(await tenant(ctx, (tx) => cleanerJobs(tx, ctx)));
      if (method === "POST" && path[1] === "select") {
        const input = z.object({ taskId: V.id }).parse(await body(request));
        const selected = await selectCleanerTask(ctx, input.taskId);
        return json(await tenant(selected, (tx) => cleanerJob(tx, selected)));
      }
      if (method === "POST" && path[1] === "transition") {
        const input = z
          .object({
            status: z.enum([
              "ACCEPTED",
              "NEEDS_SCHEDULING",
              "IN_PROGRESS",
              "DONE",
            ]),
            version: z.number().int(),
          })
          .parse(await body(request));
        return json(
          await tenant(ctx, (tx) =>
            transitionTask(tx, ctx, ctx.taskId!, input.status, input.version),
          ),
        );
      }
      if (method === "POST" && path[1] === "door-code")
        return json(
          await tenant(ctx, async (tx) => {
            const t = await tx.cleaningTask.findUniqueOrThrow({
              where: { id: ctx.taskId! },
            });
            ensure(
              t.cleanerId === ctx.cleanerId &&
                t.codeReleasedAt &&
                ["ACCEPTED", "IN_PROGRESS", "DONE"].includes(t.status),
              403,
              "CODE_WITHHELD",
              "Accept the assigned job before requesting access. Your host may need to release the code while automation is paused.",
            );
            const standing = await turnoverStanding(tx, ctx, t);
            ensure(
              standing.expected && !t.reviewRequired,
              409,
              "BOOKING_REVIEW",
              "The reservation needs host review before access is released.",
            );
            const l = await tx.listing.findUniqueOrThrow({
              where: { id: t.listingId },
            });
            await audit(
              tx,
              ctx,
              "REVEAL",
              "Listing",
              l.id,
              "Assigned cleaner revealed a code after acceptance and authorization.",
            );
            return {
              code: decrypt(l.doorCodeEncrypted, ctx.workspaceId) || null,
            };
          }),
        );
      if (method === "POST" && path[1] === "photo") {
        const form = await formBody(request),
          file = form.get("file");
        ensure(file instanceof File, 400, "FILE_REQUIRED", "Choose a photo.");
        return json(await uploadPhoto(ctx, file, ctx.taskId));
      }
      if (method === "POST" && path[1] === "note") {
        const input = z
          .object({ note: z.string().max(4000) })
          .parse(await body(request));
        return json(
          await tenant(ctx, async (tx) => {
            const task = await tx.cleaningTask.findFirst({
              where: {
                id: ctx.taskId,
                cleanerId: ctx.cleanerId,
                workspaceId: ctx.workspaceId,
              },
            });
            ensure(task, 404, "NOT_FOUND", "Task not found.");
            await tx.cleaningTask.update({
              where: { id: task.id },
              data: { noteEncrypted: encrypt(input.note, ctx.workspaceId) },
            });
            await audit(
              tx,
              ctx,
              "NOTE",
              "CleaningTask",
              task.id,
              "Assigned cleaner added an operational note.",
            );
            return { ok: true };
          }),
        );
      }
      throw new AppError(404, "NOT_FOUND", "Cleaner endpoint not found.");
    }
    if (path[0] === "assets" && method === "GET") {
      const ctx = (await currentContext()) || (await cleanerContext());
      return readPhoto(ctx, path[1]);
    }
    const ctx = await requireHost(request);
    ctx.requestId = requestId;
    if (method === "GET" && path[0] === "workspace")
      return json(
        await tenant(ctx, async (tx) => {
          const [
            workspace,
            user,
            listings,
            connections,
            tasks,
            cleaners,
            settings,
            rules,
            notifications,
            integrations,
          ] = await Promise.all([
            tx.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId } }),
            tx.user.findUniqueOrThrow({ where: { id: ctx.actorId } }),
            tx.listing.findMany({
              where: { workspaceId: ctx.workspaceId, archivedAt: null },
              orderBy: { createdAt: "asc" },
            }),
            tx.channelConnection.findMany({
              where: { workspaceId: ctx.workspaceId },
              orderBy: { createdAt: "asc" },
            }),
            tx.cleaningTask.findMany({
              where: {
                workspaceId: ctx.workspaceId,
                scheduledAt: {
                  gte: dayAdd(new Date(), -30),
                  lte: dayAdd(new Date(), 90),
                },
              },
              orderBy: { scheduledAt: "asc" },
              take: 500,
            }),
            tx.cleaner.findMany({
              where: { workspaceId: ctx.workspaceId },
              select: { id: true, name: true, listingIds: true, enabled: true },
            }),
            tx.automationSettings.findUniqueOrThrow({
              where: { workspaceId: ctx.workspaceId },
            }),
            tx.automationRule.findMany({
              where: { workspaceId: ctx.workspaceId },
              orderBy: { priority: "asc" },
            }),
            tx.notification.findMany({
              where: { workspaceId: ctx.workspaceId },
              orderBy: { createdAt: "desc" },
              take: 50,
            }),
            tx.integration.findMany({
              where: { workspaceId: ctx.workspaceId },
              select: { platform: true, enabled: true },
            }),
          ]);
          await audit(
            tx,
            ctx,
            "READ",
            "Workspace",
            ctx.workspaceId,
            "Host viewed properties, operational tasks, structured manuals, and automation rules.",
          );
          const active = new Set(listings.map((l) => l.id));
          return {
            workspace: {
              id: workspace.id,
              name: workspace.name,
              calendarMode: workspace.calendarMode,
            },
            user: { name: user.name, role: ctx.role },
            listings: listings.map((l) => listingDTO(l, ctx)),
            // A removed property's links, work and rules are not shown.
            connections: connections
              .filter((c) => active.has(c.listingId))
              .map((c) => connectionDTO(c)),
            tasks: tasks
              .filter((t) => active.has(t.listingId))
              .map(({ noteEncrypted, ...t }) => ({
                ...t,
                note: decrypt(noteEncrypted, ctx.workspaceId),
              })),
            cleaners,
            settings,
            rules: rules
              .filter((r) => !r.listingId || active.has(r.listingId))
              .map(({ templateEncrypted, ...r }) => ({
                ...r,
                template: decrypt(templateEncrypted, ctx.workspaceId),
              })),
            notifications,
            integrations,
            providers: providerStatus(),
            vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
            staleMinutes: Number(process.env.SYNC_STALE_MINUTES) || 240,
          };
        }),
      );
    if (path[0] === "listings") {
      // Removing a property from the app, and restoring it (see
      // services/properties.ts). Anyone hosting may see what removal would
      // change; only the owner may remove or restore.
      if (method === "GET" && path[1] === "removed" && path.length === 2)
        return json(await tenant(ctx, (tx) => removedProperties(tx, ctx)));
      if (method === "GET" && path[2] === "removal" && path.length === 3)
        return json(
          await tenant(ctx, (tx) => removalPreview(tx, ctx, path[1])),
        );
      if (
        method === "POST" &&
        ["remove", "restore"].includes(path[2]) &&
        path.length === 3
      ) {
        if (path[2] === "restore") {
          const result = await tenant(ctx, (tx) =>
            restoreProperty(tx, ctx, path[1]),
          );
          return json(result);
        }
        const input = z
          .object({
            confirmName: z.string().max(200),
            version: z.number().int().nonnegative(),
          })
          .parse(await body(request));
        const result = await tenant(ctx, (tx) =>
          removeProperty(tx, ctx, path[1], input),
        );
        // Cleaners whose jobs were cancelled hear about it now, not at the
        // next scheduled tick.
        kick(ctx.workspaceId);
        return json(result);
      }
      // Deleting a removed property permanently (services/erasure.ts): the
      // owner only, with their password, a few attempts at a time.
      if (method === "GET" && path[2] === "erasure" && path.length === 3)
        return json(
          await tenant(ctx, (tx) => erasurePreview(tx, ctx, path[1])),
        );
      if (method === "POST" && path[2] === "erase" && path.length === 3) {
        await rateLimit("erase:" + ctx.actorId, 5, 900);
        const input = z
          .object({
            confirmName: z.string().max(200),
            password: z.string().min(1).max(512),
          })
          .parse(await body(request));
        return json(await eraseProperty(ctx, V.id.parse(path[1]), input));
      }
      if (method === "GET" && path.length === 1)
        return json(
          await tenant(ctx, async (tx) => {
            const rows = await tx.listing.findMany({
              where: { workspaceId: ctx.workspaceId, archivedAt: null },
            });
            await audit(
              tx,
              ctx,
              "READ",
              "Listing",
              null,
              "Host read listing records and structured manuals.",
            );
            return rows.map((l) => listingDTO(l, ctx));
          }),
        );
      if (method === "POST" && path.length === 1) {
        const input = V.listingInput.parse(await body(request));
        return json(
          await tenant(ctx, async (tx) => {
            const l = await tx.listing.create({
              data: {
                workspaceId: ctx.workspaceId,
                ...input,
                doorCode: undefined,
                houseManual: undefined,
                doorCodeEncrypted: input.doorCode
                  ? encrypt(input.doorCode, ctx.workspaceId)
                  : null,
                houseManualEncrypted: seal(input.houseManual, ctx.workspaceId),
              } as never,
            });
            await audit(
              tx,
              ctx,
              "CREATE",
              "Listing",
              l.id,
              "Host created a listing. Automation remains governed by workspace controls.",
            );
            const master = await createConnection(tx, ctx, {
              listingId: l.id,
              platform: "OTHER",
              url: null,
              label: "All-channel export link",
            });
            return { ...listingDTO(l, ctx), exportUrl: master.exportUrl };
          }),
          201,
        );
      }
      if (method === "PATCH" && path.length === 2) {
        const input = V.listingInput
          .extend({ version: z.number().int() })
          .parse(await body(request));
        return json(
          await tenant(ctx, async (tx) => {
            await lock(tx, "listing:" + path[1]);
            const before = await activeListing(tx, ctx, path[1]);
            ensure(
              before.version === input.version,
              409,
              "VERSION_CONFLICT",
              "This listing changed. Refresh before saving.",
            );
            if (input.currency !== before.currency)
              ensure(
                (await tx.reservation.count({
                  where: { workspaceId: ctx.workspaceId, listingId: before.id },
                })) === 0,
                409,
                "CURRENCY_IN_USE",
                "Currency cannot change after reservations exist; recorded prices must retain their original currency.",
              );
            const l = await tx.listing.update({
              where: { id: before.id },
              data: {
                name: input.name,
                address: input.address,
                timezone: input.timezone,
                color: input.color,
                currency: input.currency,
                bufferDays: input.bufferDays,
                checkoutHour: input.checkoutHour,
                cleaningBufferHours: input.cleaningBufferHours,
                houseManualEncrypted: seal(input.houseManual, ctx.workspaceId),
                ...(input.doorCode !== undefined
                  ? {
                      doorCodeEncrypted: encrypt(
                        input.doorCode,
                        ctx.workspaceId,
                      ),
                    }
                  : {}),
                version: { increment: 1 },
              },
            });
            await audit(
              tx,
              ctx,
              "UPDATE",
              "Listing",
              l.id,
              "Host updated listing settings and structured manual.",
              { before: listingDTO(before, ctx), afterVersion: l.version },
            );
            const buffers = input.bufferDays !== before.bufferDays;
            const checkout =
              input.checkoutHour !== before.checkoutHour ||
              input.cleaningBufferHours !== before.cleaningBufferHours ||
              input.timezone !== before.timezone;
            if (buffers || checkout)
              await propertySettingsChanged(tx, ctx, l, { buffers, checkout });
            if (buffers) {
              await notify(
                tx,
                ctx,
                `buffer:${l.id}:${l.version}`,
                "Buffer policy updated",
                "Existing reservations are preserved. Review the calendar for newly overlapping buffers.",
                "/calendar",
              );
            }
            return listingDTO(l, ctx);
          }),
        );
      }
      if (method === "POST" && path[2] === "door-code")
        return json(
          await tenant(ctx, async (tx) => {
            const l = await activeListing(tx, ctx, path[1]);
            await audit(
              tx,
              ctx,
              "REVEAL",
              "Listing",
              l.id,
              "Host explicitly revealed the encrypted door code.",
            );
            return {
              code: decrypt(l.doorCodeEncrypted, ctx.workspaceId) || null,
            };
          }),
        );
      if (method === "POST" && path[2] === "photo") {
        const form = await formBody(request),
          file = form.get("file");
        ensure(file instanceof File, 400, "FILE_REQUIRED", "Choose a photo.");
        return json(await uploadPhoto(ctx, file, undefined, path[1]));
      }
    }
    const calendar = await calendarRoutes(request, path, method, ctx);
    if (calendar) return calendar;
    const onboarding = await onboardingRoutes(request, path, method, ctx);
    if (onboarding) return onboarding;
    if (path[0] === "cleaning-tasks") {
      if (method === "GET")
        return json(
          await tenant(ctx, async (tx) =>
            tx.cleaningTask.findMany({
              where: {
                workspaceId: ctx.workspaceId,
                listingId: { in: await activeListingIds(tx, ctx) },
              },
              orderBy: { scheduledAt: "asc" },
              take: 500,
            }),
          ),
        );
      if (method === "POST" && path.length === 1) {
        const input = z
          .object({
            listingId: V.id,
            title: z.string().min(1).max(100),
            scheduledAt: z.iso.datetime(),
            verifyBy: z.iso.datetime(),
          })
          .parse(await body(request));
        ensure(
          input.verifyBy > input.scheduledAt,
          400,
          "TIME_RANGE",
          "Verification must be after the task begins.",
        );
        return json(
          await tenant(ctx, async (tx) => {
            // Locked like a removal, so no work is added to a property
            // while it is being removed.
            await lock(tx, "listing:" + input.listingId);
            await activeListing(tx, ctx, input.listingId);
            const t = await tx.cleaningTask.create({
              data: {
                workspaceId: ctx.workspaceId,
                ...input,
                scheduledAt: new Date(input.scheduledAt),
                verifyBy: new Date(input.verifyBy),
              },
            });
            await event(
              tx,
              ctx,
              "CLEANING_CREATED",
              t.id,
              "manual-task:" + t.id,
              { manual: true },
            );
            await audit(
              tx,
              ctx,
              "CREATE",
              "CleaningTask",
              t.id,
              "Host scheduled a manual operational task.",
            );
            return t;
          }),
          201,
        );
      }
      if (method === "POST" && path[2] === "assign") {
        const input = z
          .object({ cleanerId: V.id, version: z.number().int() })
          .parse(await body(request));
        const result = await tenant(ctx, (tx) =>
          assignTask(tx, ctx, path[1], input.cleanerId, input.version),
        );
        kick(ctx.workspaceId);
        return json(result);
      }
      if (method === "POST" && ["verify", "transition"].includes(path[2])) {
        const input = z
          .object({ version: z.number().int(), status: z.string().optional() })
          .parse(await body(request));
        return json(
          await tenant(ctx, (tx) =>
            transitionTask(
              tx,
              ctx,
              path[1],
              path[2] === "verify" ? "VERIFIED" : input.status || "",
              input.version,
            ),
          ),
        );
      }
      if (method === "POST" && path[2] === "release-code")
        return json(
          await tenant(ctx, async (tx) => {
            await lock(tx, "task:" + path[1]);
            const task = await tx.cleaningTask.findFirst({
              where: { workspaceId: ctx.workspaceId, id: path[1] },
            });
            ensure(
              task && ["ACCEPTED", "IN_PROGRESS"].includes(task.status),
              409,
              "ACCEPT_REQUIRED",
              "The cleaner must accept first.",
            );
            // No door code is released for a property removed from the app.
            await activeListing(tx, ctx, task.listingId);
            const standing = await turnoverStanding(tx, ctx, task);
            ensure(
              standing.expected && !task.reviewRequired,
              409,
              "BOOKING_REVIEW",
              "Resolve the reservation before releasing access.",
            );
            await tx.cleaningTask.update({
              where: { id: task.id },
              data: { codeReleasedAt: new Date() },
            });
            await audit(
              tx,
              ctx,
              "RELEASE_CODE",
              "CleaningTask",
              task.id,
              "Host explicitly authorized door-code access for the assigned, accepted task.",
            );
            return { ok: true };
          }),
        );
    }
    if (path[0] === "cleaners" && method === "POST") {
      const input = z
        .object({
          name: z.string().min(1).max(100),
          phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
          listingIds: z.array(V.id).min(1),
        })
        .parse(await body(request));
      return json(
        await tenant(ctx, async (tx) => {
          ensure(
            (await tx.listing.count({
              where: {
                workspaceId: ctx.workspaceId,
                id: { in: input.listingIds },
                archivedAt: null,
              },
            })) === new Set(input.listingIds).size,
            400,
            "LISTING_SCOPE",
            "Choose listings in this workspace.",
          );
          const cleaner = await tx.cleaner.create({
            data: {
              workspaceId: ctx.workspaceId,
              name: input.name,
              phoneEncrypted: encrypt(input.phone, ctx.workspaceId),
              listingIds: input.listingIds,
            },
          });
          await audit(
            tx,
            ctx,
            "CREATE",
            "Cleaner",
            cleaner.id,
            "Host added a cleaner with an explicit listing scope.",
          );
          return { id: cleaner.id, name: cleaner.name };
        }),
        201,
      );
    }
    if (path[0] === "threads" && method === "POST" && path[2] === "reply") {
      const input = z
        .object({
          body: z.string().trim().min(1).max(12000),
          idempotencyKey: z.uuid(),
          draftId: V.id.optional(),
        })
        .parse(await body(request));
      const result = await tenant(ctx, (tx) =>
        reply(
          tx,
          ctx,
          path[1],
          input.body,
          input.idempotencyKey,
          input.draftId,
        ),
      );
      kick(ctx.workspaceId);
      return json(result, 202);
    }
    const inbox = await inboxRoutes(request, path, method, ctx);
    if (inbox) return inbox;
    if (
      path[0] === "automation" &&
      method === "POST" &&
      path[1] === "kill-switch"
    ) {
      const input = z
        .object({ paused: z.boolean() })
        .parse(await body(request));
      return json(
        await tenant(ctx, async (tx) => {
          await lock(tx, "automation:" + ctx.workspaceId);
          const before = await tx.automationSettings.findUniqueOrThrow({
            where: { workspaceId: ctx.workspaceId },
          });
          const settings = await tx.automationSettings.update({
            where: { workspaceId: ctx.workspaceId },
            data: { paused: input.paused, version: { increment: 1 } },
          });
          await audit(
            tx,
            ctx,
            "KILL_SWITCH",
            "AutomationSettings",
            ctx.workspaceId,
            input.paused
              ? "All automated dispatch paused. In-flight provider requests cannot be recalled."
              : "Automation resumed under the current category controls.",
            { before, afterVersion: settings.version },
          );
          return settings;
        }),
      );
    }
    if (path[0] === "automation" && method === "PATCH") {
      const input = V.settingsInput.parse(await body(request));
      const result = await tenant(ctx, async (tx) => {
        await lock(tx, "automation:" + ctx.workspaceId);
        const before = await tx.automationSettings.findUniqueOrThrow({
          where: { workspaceId: ctx.workspaceId },
        });
        ensure(
          before.version === input.version,
          409,
          "VERSION_CONFLICT",
          "Automation settings changed. Refresh before saving.",
        );
        const updated = await tx.automationSettings.update({
          where: { workspaceId: ctx.workspaceId },
          data: { ...input, version: { increment: 1 } },
        });
        await audit(
          tx,
          ctx,
          "UPDATE",
          "AutomationSettings",
          ctx.workspaceId,
          "Host changed automation categories and confidence guardrails.",
          { before, afterVersion: updated.version },
        );
        return updated;
      });
      kick(ctx.workspaceId);
      return json(result);
    }
    if (path[0] === "automation-rules") {
      if (method === "GET")
        return json(
          await tenant(ctx, async (tx) => {
            const rows = await tx.automationRule.findMany({
              where: { workspaceId: ctx.workspaceId },
              orderBy: { priority: "asc" },
            });
            await audit(
              tx,
              ctx,
              "READ",
              "AutomationRule",
              null,
              "Host read editable response templates.",
            );
            return rows.map(({ templateEncrypted, ...r }) => ({
              ...r,
              template: decrypt(templateEncrypted, ctx.workspaceId),
            }));
          }),
        );
      if (["POST", "PATCH"].includes(method)) {
        const input = V.ruleInput
          .extend({ id: V.id.optional(), version: z.number().int().optional() })
          .parse(await body(request));
        return json(
          await tenant(ctx, async (tx) => {
            if (input.id) await lock(tx, "rule:" + input.id);
            if (input.listingId)
              ensure(
                await tx.listing.findFirst({
                  where: { workspaceId: ctx.workspaceId, id: input.listingId },
                }),
                404,
                "NOT_FOUND",
                "Listing not found.",
              );
            const before = input.id
              ? await tx.automationRule.findFirst({
                  where: { id: input.id, workspaceId: ctx.workspaceId },
                })
              : null;
            if (input.id)
              ensure(
                before && before.version === input.version,
                409,
                "VERSION_CONFLICT",
                "Rule changed. Refresh before saving.",
              );
            const data = {
              workspaceId: ctx.workspaceId,
              listingId: input.listingId,
              name: input.name,
              keywords: input.keywords,
              manualField: input.manualField,
              templateEncrypted: encrypt(input.template, ctx.workspaceId),
              action: input.action,
              enabled: input.enabled,
              priority: input.priority,
            };
            const r = before
              ? await tx.automationRule.update({
                  where: { id: before.id },
                  data: { ...data, version: { increment: 1 } },
                })
              : await tx.automationRule.create({ data });
            await audit(
              tx,
              ctx,
              before ? "UPDATE" : "CREATE",
              "AutomationRule",
              r.id,
              "Host edited an ordered response rule. First matching rule wins.",
              { before, afterVersion: r.version },
            );
            return { id: r.id };
          }),
        );
      }
    }
    if (path[0] === "insights" && method === "GET") {
      const r = range(request);
      return json(await tenant(ctx, (tx) => insights(tx, ctx, r.from, r.to)));
    }
    if (path[0] === "command" && method === "POST") {
      const input = z
        .object({ text: z.string().min(1).max(500) })
        .parse(await body(request));
      const listings = await tenant(ctx, (tx) =>
        tx.listing.findMany({
          where: { workspaceId: ctx.workspaceId, archivedAt: null },
          select: { id: true, name: true },
        }),
      );
      const result = await command(input.text, listings);
      await tenant(ctx, (tx) =>
        audit(
          tx,
          ctx,
          "COMMAND_PREVIEW",
          "Command",
          null,
          "Natural-language intent parsed. No mutation executed; user confirmation is required.",
          { input: input.text, result },
        ),
      );
      return json(result);
    }
    if (path[0] === "activity" && method === "GET")
      return json(
        await tenant(ctx, async (tx) => {
          const before = request.nextUrl.searchParams.get("before");
          const rows = await tx.auditLog.findMany({
            where: {
              workspaceId: ctx.workspaceId,
              ...(before ? { createdAt: { lt: new Date(before) } } : {}),
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 100,
            select: {
              id: true,
              actorId: true,
              action: true,
              entity: true,
              entityId: true,
              reason: true,
              createdAt: true,
            },
          });
          const outbox = await tx.outbox.findMany({
            where: {
              workspaceId: ctx.workspaceId,
              status: { in: ["PENDING", "SENDING", "UNKNOWN"] },
            },
            orderBy: { createdAt: "desc" },
            take: 50,
            select: {
              id: true,
              kind: true,
              entityId: true,
              status: true,
              automated: true,
              category: true,
              attempts: true,
              error: true,
              createdAt: true,
            },
          });
          return { entries: rows, outbox };
        }),
      );
    if (path[0] === "explain" && method === "GET")
      return json(
        await tenant(ctx, async (tx) => {
          const rows = await tx.auditLog.findMany({
            where: { workspaceId: ctx.workspaceId, entityId: path[1] },
            orderBy: { createdAt: "desc" },
            take: 30,
          });
          await audit(
            tx,
            ctx,
            "READ",
            "AuditLog",
            path[1],
            "Host opened action provenance; sensitive prompt details remain encrypted until explicitly requested.",
          );
          return rows.map(({ detailEncrypted: _detail, ...r }) => r);
        }),
      );
    if (path[0] === "audit" && path[2] === "detail" && method === "POST") {
      ownerOnly(ctx);
      return json(
        await tenant(ctx, async (tx) => {
          const row = await tx.auditLog.findFirst({
            where: { workspaceId: ctx.workspaceId, id: path[1] },
          });
          ensure(row, 404, "NOT_FOUND", "Audit event not found.");
          await audit(
            tx,
            ctx,
            "READ_SENSITIVE_AUDIT",
            "AuditLog",
            row.id,
            "Owner explicitly accessed the encrypted action snapshot or AI prompt.",
          );
          return {
            detail: row.detailEncrypted
              ? unseal(row.detailEncrypted, ctx.workspaceId)
              : null,
          };
        }),
      );
    }
    if (path[0] === "outbox" && method === "POST") {
      const input = z
        .object({
          action: z.enum(["CANCEL", "RETRY", "CONFIRM_DELIVERED"]),
          reason: z.string().min(10).max(1000),
        })
        .parse(await body(request));
      return json(
        await tenant(ctx, async (tx) => {
          await lock(tx, "outbox:" + path[1]);
          const job = await tx.outbox.findFirst({
            where: { id: path[1], workspaceId: ctx.workspaceId },
          });
          ensure(
            job && !["SENDING", "DELIVERED"].includes(job.status),
            409,
            "JOB_STATE",
            "This action is in flight or already completed.",
          );
          ensure(
            input.action === "CANCEL" || job.status === "UNKNOWN",
            409,
            "JOB_STATE",
            "Reconcile only an uncertain action.",
          );
          const status =
            input.action === "CANCEL"
              ? "CANCELLED"
              : input.action === "RETRY"
                ? "PENDING"
                : "DELIVERED";
          await tx.outbox.update({
            where: { id: job.id },
            data: { status, error: null, dueAt: new Date() },
          });
          if (job.kind === "GUEST_MESSAGE")
            await tx.message.update({
              where: { id: job.entityId },
              data: {
                status:
                  input.action === "RETRY"
                    ? "QUEUED"
                    : input.action === "CONFIRM_DELIVERED"
                      ? "SENT"
                      : "DRAFT",
                ...(input.action === "CONFIRM_DELIVERED"
                  ? { sentAt: new Date() }
                  : {}),
              },
            });
          await audit(tx, ctx, "RECONCILE", "Outbox", job.id, input.reason, {
            action: input.action,
          });
          return { status };
        }),
      );
    }
    if (path[0] === "notifications" && method === "POST")
      return json(
        await tenant(ctx, (tx) =>
          tx.notification.updateMany({
            where: { workspaceId: ctx.workspaceId },
            data: { readAt: new Date() },
          }),
        ),
      );
    if (path[0] === "push" && method === "POST") {
      const input = z
        .object({
          endpoint: z.url(),
          keys: z.object({ auth: z.string(), p256dh: z.string() }),
        })
        .parse(await body(request));
      const u = new URL(input.endpoint);
      ensure(
        u.protocol === "https:" &&
          !u.username &&
          !u.password &&
          (!u.port || u.port === "443") &&
          allowedHost(
            u.hostname,
            "*.push.services.mozilla.com,fcm.googleapis.com,*.push.apple.com,web.push.apple.com,*.notify.windows.com",
          ),
        400,
        "PUSH_ENDPOINT",
        "Unsupported push-service endpoint.",
      );
      return json(
        await tenant(ctx, async (tx) => {
          await tx.pushSubscription.upsert({
            where: { endpointHash: hash(input.endpoint) },
            create: {
              workspaceId: ctx.workspaceId,
              userId: ctx.actorId,
              endpointHash: hash(input.endpoint),
              subscriptionEncrypted: seal(input, ctx.workspaceId),
            },
            update: { subscriptionEncrypted: seal(input, ctx.workspaceId) },
          });
          return { ok: true };
        }),
      );
    }
    if (path[0] === "integrations" && method === "POST") {
      ownerOnly(ctx);
      const input = z
        .object({
          platform: z.enum(["AIRBNB", "VRBO", "EXPEDIA", "BOOKING", "DIRECT"]),
          endpoint: z.url(),
          secret: z.string().min(32),
          enabled: z.boolean(),
        })
        .parse(await body(request));
      const u = new URL(input.endpoint);
      ensure(
        u.protocol === "https:" &&
          !u.username &&
          !u.password &&
          (!u.port || u.port === "443") &&
          allowedHost(u.hostname, process.env.MESSAGING_ALLOWED_HOSTS || ""),
        400,
        "HOST_BLOCKED",
        "Messaging bridge host must be on the server allowlist.",
      );
      return json(
        await tenant(ctx, async (tx) => {
          await tx.integration.upsert({
            where: {
              workspaceId_platform: {
                workspaceId: ctx.workspaceId,
                platform: input.platform,
              },
            },
            create: {
              workspaceId: ctx.workspaceId,
              platform: input.platform,
              endpointEncrypted: encrypt(input.endpoint, ctx.workspaceId),
              secretEncrypted: encrypt(input.secret, ctx.workspaceId),
              enabled: input.enabled,
            },
            update: {
              endpointEncrypted: encrypt(input.endpoint, ctx.workspaceId),
              secretEncrypted: encrypt(input.secret, ctx.workspaceId),
              enabled: input.enabled,
            },
          });
          await audit(
            tx,
            ctx,
            "CONNECT",
            "Integration",
            null,
            "Owner configured a signed native messaging bridge.",
          );
          return { ok: true };
        }),
      );
    }
    if (path[0] === "team") {
      ownerOnly(ctx);
      if (method === "GET") {
        const members = await db.membership.findMany({
          where: { workspaceId: ctx.workspaceId },
        });
        const users = await db.user.findMany({
          where: { id: { in: members.map((m) => m.userId) } },
        });
        await tenant(ctx, (tx) =>
          audit(
            tx,
            ctx,
            "READ",
            "Membership",
            null,
            "Owner viewed team names and roles.",
          ),
        );
        return json(
          members.map((m) => ({
            id: m.id,
            userId: m.userId,
            name: users.find((u) => u.id === m.userId)?.name,
            role: m.role,
          })),
        );
      }
      if (method === "POST") {
        const input = z
          .object({
            name: z.string().min(1).max(100),
            email: z.email(),
            password: z.string().min(14).max(200),
            role: z.enum(["COHOST"]),
          })
          .parse(await body(request));
        const existing = await db.user.findUnique({
          where: { emailHash: blind(input.email) },
        });
        ensure(
          !existing,
          409,
          "EXISTING_ACCOUNT",
          "This email already has an account. Use the administrator workflow to grant workspace access.",
        );
        const user = await db.$transaction(async (tx) => {
          const u = await tx.user.create({
            data: {
              name: input.name,
              emailHash: blind(input.email),
              emailEncrypted: encrypt(input.email, "identity"),
              passwordHash: passwordHash(input.password),
            },
          });
          await tx.membership.create({
            data: {
              workspaceId: ctx.workspaceId,
              userId: u.id,
              role: input.role,
            },
          });
          return u;
        });
        await tenant(ctx, (tx) =>
          audit(
            tx,
            ctx,
            "GRANT",
            "Membership",
            user.id,
            "Owner granted co-host access. Share the initial password through a secure channel.",
          ),
        );
        return json({ id: user.id }, 201);
      }
      if (method === "DELETE" && path[1]) {
        const member = await db.membership.findFirst({
          where: { workspaceId: ctx.workspaceId, id: path[1] },
        });
        ensure(
          member && member.role !== "HOST",
          400,
          "OWNER_PROTECTED",
          "The workspace owner cannot be removed.",
        );
        await db.$transaction([
          db.membership.delete({ where: { id: member.id } }),
          db.session.deleteMany({
            where: { workspaceId: ctx.workspaceId, userId: member.userId },
          }),
        ]);
        await tenant(ctx, (tx) =>
          audit(
            tx,
            ctx,
            "REVOKE",
            "Membership",
            member.id,
            "Co-host membership and workspace sessions revoked.",
          ),
        );
        return json({ ok: true });
      }
    }
    if (path[0] === "auth" && path[1] === "password" && method === "POST") {
      const input = z
        .object({
          currentPassword: z.string().max(512),
          newPassword: z.string().max(512),
        })
        .parse(await body(request));
      const u = await db.user.findUniqueOrThrow({ where: { id: ctx.actorId } });
      ensure(
        passwordMatches(input.currentPassword, u.passwordHash),
        401,
        "PASSWORD",
        "Current password is incorrect.",
      );
      const weak = await passwordProblem(input.newPassword, {
        email: decrypt(u.emailEncrypted, "identity"),
      });
      ensure(!weak, 400, "WEAK_PASSWORD", weak ?? "");
      await db.$transaction([
        db.user.update({
          where: { id: u.id },
          data: { passwordHash: passwordHash(input.newPassword) },
        }),
        db.session.deleteMany({ where: { userId: u.id } }),
      ]);
      await tenant(ctx, (tx) =>
        audit(
          tx,
          ctx,
          "PASSWORD_CHANGE",
          "User",
          u.id,
          "User changed password; all sessions were revoked.",
        ),
      );
      await logout();
      return json({ ok: true });
    }
    throw new AppError(404, "NOT_FOUND", "Endpoint not found.");
  } catch (error) {
    if (error instanceof ZodError)
      return json(
        {
          error: "Some fields are invalid.",
          code: "VALIDATION",
          details: error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
          requestId,
        },
        400,
      );
    if (error instanceof AppError)
      return json(
        {
          error: error.message,
          code: error.code,
          ...(error.details === undefined ? {} : { details: error.details }),
          requestId,
        },
        error.status,
      );
    reportError(error, requestId);
    return json(
      {
        error:
          "The request could not be completed. Your saved data is unchanged unless a provider action was already in flight. Please retry or review Activity.",
        code: "INTERNAL",
        requestId,
      },
      500,
    );
  } finally {
    console.info(
      JSON.stringify({
        event: "request",
        requestId,
        method,
        route: path[0],
        durationMs: Date.now() - started,
      }),
    );
  }
}
