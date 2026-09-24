import { NextRequest, NextResponse, after } from "next/server";
import { z, ZodError } from "zod";
import { createHmac } from "node:crypto";
import { db, tenant, lock, type Context } from "./db";
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
} from "./auth";
import { AppError, ensure } from "./errors";
import { required, providerStatus } from "./config";
import {
  encrypt,
  decrypt,
  seal,
  unseal,
  hash,
  blind,
  randomToken,
  equal,
  passwordHash,
  passwordMatches,
} from "./crypto";
import { audit, notify, event } from "./audit";
import * as V from "./validation";
import {
  bookingDTO,
  listingDTO,
  blockDates,
  calendarFeed,
  exportLink,
  reconcileListingConflicts,
  createDirectBooking,
} from "./services/calendar";
import {
  assignTask,
  transitionTask,
  cleanerJob,
  cleanerJobs,
  createTurnover,
} from "./services/cleaning";
import { inbound, reply } from "./services/messaging";
import { drainWorkspace, runCron } from "./services/jobs";
import { uploadPhoto, readPhoto } from "./services/storage";
import { insights } from "./services/insights";
import { command } from "./services/commands";
import { allowedHost } from "./integrations/http";
import { reportError } from "./observability";
import { dateOnly, dayAdd, overlaps } from "@/lib/domain";
async function bytes(request: Request, limit: number) {
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new AppError(413, "BODY_LIMIT", "Request is too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
async function formBody(request: Request) {
  const data = await bytes(request, 4 * 1024 * 1024 + 65536);
  return new Response(new Uint8Array(data), {
    headers: { "Content-Type": request.headers.get("content-type") || "" },
  }).formData();
}
async function body(request: Request, limit = 64000) {
  const text = (await bytes(request, limit)).toString("utf8");
  ensure(
    Buffer.byteLength(text) <= limit,
    413,
    "BODY_LIMIT",
    "Request is too large.",
  );
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(400, "INVALID_JSON", "Request must contain valid JSON.");
  }
}
function range(request: Request) {
  const q = new URL(request.url).searchParams;
  const from = V.date.parse(q.get("from") || dateOnly(dayAdd(new Date(), -30))),
    to = V.date.parse(q.get("to") || dateOnly(dayAdd(new Date(), 90)));
  ensure(
    to > from && (+new Date(to) - +new Date(from)) / 86400000 <= 731,
    400,
    "RANGE",
    "Select a range of up to two years.",
  );
  return {
    from: new Date(from + "T00:00:00Z"),
    to: new Date(to + "T00:00:00Z"),
  };
}
function json(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
function kick(workspaceId: string) {
  after(async () => {
    try {
      await drainWorkspace(workspaceId, 20000);
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
      await db.$queryRaw`SELECT 1`;
      return json({ status: "ok", database: "reachable" });
    }
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
      return json(await runCron());
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
      method === "GET" &&
      path[0] === "listings" &&
      path[2] === "export.ics"
    ) {
      const q = request.nextUrl.searchParams,
        workspaceId = V.id.parse(q.get("workspace")),
        token = z.string().min(20).max(100).parse(q.get("token"));
      await rateLimit("feed:" + hash(token), 100, 60);
      const feed = await calendarFeed(
        { workspaceId, actorId: "calendar-client", role: "SYSTEM", requestId },
        path[1],
        token,
        q.get("source") || undefined,
      );
      return new Response(feed, {
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Cache-Control": "private, no-store",
          "Content-Disposition": 'inline; filename="availability.ics"',
        },
      });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) checkOrigin(request);
    if (path[0] === "auth") {
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
            if (t.bookingId) {
              const b = await tx.booking.findUniqueOrThrow({
                where: { id: t.bookingId },
              });
              ensure(
                b.status === "CONFIRMED",
                409,
                "BOOKING_REVIEW",
                "The reservation needs host review before access is released.",
              );
            }
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
            sources,
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
            tx.syncSource.findMany({
              where: { workspaceId: ctx.workspaceId },
              select: {
                id: true,
                listingId: true,
                platform: true,
                status: true,
                lastSyncedAt: true,
                lastAttemptAt: true,
                nextPollAt: true,
                error: true,
                enabled: true,
              },
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
          return {
            workspace: { id: workspace.id, name: workspace.name },
            user: { name: user.name, role: ctx.role },
            listings: listings.map((l) => listingDTO(l, ctx)),
            sources,
            tasks: tasks.map(({ noteEncrypted, ...t }) => ({
              ...t,
              note: decrypt(noteEncrypted, ctx.workspaceId),
            })),
            cleaners,
            settings,
            rules: rules.map(({ templateEncrypted, ...r }) => ({
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
        const input = V.listingInput.parse(await body(request)),
          token = randomToken();
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
                exportTokenHash: hash(token),
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
            return {
              ...listingDTO(l, ctx),
              exportUrl: exportLink(ctx.workspaceId, l.id, token),
            };
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
            const before = await tx.listing.findFirst({
              where: { id: path[1], workspaceId: ctx.workspaceId },
            });
            ensure(before, 404, "NOT_FOUND", "Listing not found.");
            ensure(
              before.version === input.version,
              409,
              "VERSION_CONFLICT",
              "This listing changed. Refresh before saving.",
            );
            if (input.currency !== before.currency)
              ensure(
                (await tx.booking.count({
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
            if (input.bufferDays !== before.bufferDays) {
              await reconcileListingConflicts(tx, ctx, l);
              await tx.syncSource.updateMany({
                where: { workspaceId: ctx.workspaceId, listingId: l.id },
                data: { nextPollAt: new Date() },
              });
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
            const l = await tx.listing.findFirst({
              where: { id: path[1], workspaceId: ctx.workspaceId },
            });
            ensure(l, 404, "NOT_FOUND", "Listing not found.");
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
      if (method === "POST" && path[2] === "export-token") {
        ownerOnly(ctx);
        const token = randomToken();
        return json(
          await tenant(ctx, async (tx) => {
            await tx.listing.update({
              where: { id: path[1] },
              data: { exportTokenHash: hash(token) },
            });
            await audit(
              tx,
              ctx,
              "ROTATE",
              "Listing",
              path[1],
              "Public feed capability rotated; the old master feed URL is invalid.",
            );
            return { url: exportLink(ctx.workspaceId, path[1], token) };
          }),
        );
      }
      if (method === "POST" && path[2] === "photo") {
        const form = await formBody(request),
          file = form.get("file");
        ensure(file instanceof File, 400, "FILE_REQUIRED", "Choose a photo.");
        return json(await uploadPhoto(ctx, file, undefined, path[1]));
      }
      if (method === "GET" && path[2] === "sync-status")
        return json(
          await tenant(ctx, (tx) =>
            tx.syncSource.findMany({
              where: { workspaceId: ctx.workspaceId, listingId: path[1] },
              select: {
                id: true,
                platform: true,
                status: true,
                error: true,
                lastSyncedAt: true,
                nextPollAt: true,
              },
            }),
          ),
        );
    }
    if (path[0] === "sources" && method === "POST") {
      ownerOnly(ctx);
      const input = z
        .object({
          listingId: V.id,
          platform: z.enum(["AIRBNB", "VRBO", "EXPEDIA", "BOOKING"]),
          url: z.url().max(2000),
        })
        .parse(await body(request));
      const u = new URL(input.url);
      ensure(
        u.protocol === "https:" &&
          !u.username &&
          !u.password &&
          (!u.port || u.port === "443") &&
          allowedHost(u.hostname, process.env.ICAL_ALLOWED_HOSTS || ""),
        400,
        "URL_BLOCKED",
        "Use an HTTPS iCal URL on an allowed provider domain.",
      );
      const token = randomToken();
      const result = await tenant(ctx, async (tx) => {
        ensure(
          await tx.listing.findFirst({
            where: { id: input.listingId, workspaceId: ctx.workspaceId },
          }),
          404,
          "NOT_FOUND",
          "Listing not found.",
        );
        const s = await tx.syncSource.upsert({
          where: {
            workspaceId_listingId_platform_direction: {
              workspaceId: ctx.workspaceId,
              listingId: input.listingId,
              platform: input.platform,
              direction: "IMPORT",
            },
          },
          create: {
            workspaceId: ctx.workspaceId,
            listingId: input.listingId,
            platform: input.platform,
            urlEncrypted: encrypt(input.url, ctx.workspaceId),
            tokenHash: hash(token),
          },
          update: {
            urlEncrypted: encrypt(input.url, ctx.workspaceId),
            tokenHash: hash(token),
            enabled: true,
            nextPollAt: new Date(),
            etag: null,
            lastModified: null,
          },
        });
        await audit(
          tx,
          ctx,
          "CONNECT",
          "SyncSource",
          s.id,
          "Import feed configured; channel-specific export excludes its origin reservations.",
        );
        return {
          id: s.id,
          exportUrl: exportLink(ctx.workspaceId, input.listingId, token, s.id),
        };
      });
      kick(ctx.workspaceId);
      return json(result);
    }
    if (path[0] === "sync" && method === "POST") {
      await tenant(ctx, (tx) =>
        tx.syncSource.updateMany({
          where: { workspaceId: ctx.workspaceId, enabled: true },
          data: { nextPollAt: new Date() },
        }),
      );
      kick(ctx.workspaceId);
      return json({ status: "queued" }, 202);
    }
    if (path[0] === "calendar" && method === "GET") {
      const r = range(request);
      return json(
        await tenant(ctx, async (tx) => {
          const rows = await tx.booking.findMany({
            where: {
              workspaceId: ctx.workspaceId,
              startDate: { lt: dayAdd(r.to, 14) },
              endDate: { gt: dayAdd(r.from, -14) },
              status: { notIn: ["CANCELLED", "DISMISSED"] },
            },
            orderBy: { startDate: "asc" },
            take: 2000,
          });
          await audit(
            tx,
            ctx,
            "READ",
            "Booking",
            null,
            "Host read calendar reservations and decrypted guest names.",
            { from: dateOnly(r.from), to: dateOnly(r.to), count: rows.length },
          );
          return {
            bookings: rows.map((b) => bookingDTO(b, ctx)),
            capped: rows.length === 2000,
          };
        }),
      );
    }
    if (path[0] === "calendar" && path[1] === "block" && method === "POST") {
      const input = V.blockInput.parse(await body(request));
      return json(await tenant(ctx, (tx) => blockDates(tx, ctx, input)), 201);
    }
    if (path[0] === "bookings") {
      if (method === "POST" && path.length === 1) {
        const input = V.directBookingInput.parse(await body(request));
        return json(
          await tenant(ctx, (tx) => createDirectBooking(tx, ctx, input)),
          201,
        );
      }
      if (method === "GET") {
        const r = range(request);
        return json(
          await tenant(ctx, async (tx) => {
            const rows = await tx.booking.findMany({
              where: {
                workspaceId: ctx.workspaceId,
                startDate: { lt: r.to },
                endDate: { gt: r.from },
              },
              orderBy: { startDate: "asc" },
              take: 1000,
            });
            await audit(
              tx,
              ctx,
              "READ",
              "Booking",
              null,
              "Host read guest booking details.",
            );
            return rows.map((b) => bookingDTO(b, ctx));
          }),
        );
      }
      if (method === "PATCH" && path.length === 2) {
        const input = z
          .object({
            guestName: z.string().max(200),
            guestContact: z.string().max(320),
            price: z.number().nonnegative().max(999999999).nullable(),
            version: z.number().int(),
          })
          .parse(await body(request));
        return json(
          await tenant(ctx, async (tx) => {
            await lock(tx, "booking:" + path[1]);
            const b = await tx.booking.findFirst({
              where: { id: path[1], workspaceId: ctx.workspaceId },
            });
            ensure(
              b && b.version === input.version,
              409,
              "VERSION_CONFLICT",
              "Booking changed. Refresh and try again.",
            );
            const updated = await tx.booking.update({
              where: { id: b.id },
              data: {
                guestNameEncrypted: encrypt(input.guestName, ctx.workspaceId),
                guestContactEncrypted: encrypt(
                  input.guestContact,
                  ctx.workspaceId,
                ),
                guestHash: input.guestContact
                  ? blind(input.guestContact)
                  : null,
                price: input.price,
                version: { increment: 1 },
              },
            });
            await audit(
              tx,
              ctx,
              "ENRICH",
              "Booking",
              b.id,
              "Host added guest details and price; iCal feeds often do not provide these fields.",
            );
            return bookingDTO(updated, ctx);
          }),
        );
      }
      if (method === "POST" && path[2] === "resolve-conflict") {
        const input = z
          .object({
            action: z.enum([
              "KEEP",
              "DISMISS",
              "REMOVE_BLOCK",
              "CONFIRM_REMOVAL",
            ]),
            reason: z.string().min(10).max(1000),
            version: z.number().int(),
            externalResolutionConfirmed: z.boolean(),
          })
          .parse(await body(request));
        return json(
          await tenant(ctx, async (tx) => {
            const initial = await tx.booking.findFirst({
              where: { id: path[1], workspaceId: ctx.workspaceId },
            });
            ensure(initial, 404, "NOT_FOUND", "Booking not found.");
            await lock(tx, "listing:" + initial.listingId);
            const b = await tx.booking.findUniqueOrThrow({
              where: { id: initial.id },
            });
            ensure(
              b.version === input.version,
              409,
              "VERSION_CONFLICT",
              "Booking changed. Refresh and try again.",
            );
            if (input.action === "REMOVE_BLOCK")
              ensure(
                b.kind === "BLOCK",
                400,
                "NOT_BLOCK",
                "Only a manual block can be removed.",
              );
            else {
              ensure(
                b.kind === "RESERVATION",
                400,
                "NOT_RESERVATION",
                "Use remove block for a manual date block.",
              );
              if (input.action === "CONFIRM_REMOVAL")
                ensure(
                  b.status === "PENDING_REMOVAL",
                  409,
                  "REMOVAL_STATE",
                  "Only a reservation missing from its feed can be confirmed removed.",
                );
              ensure(
                input.externalResolutionConfirmed,
                400,
                "CONFIRM_REQUIRED",
                "Confirm the outcome was handled with the platform and guest.",
              );
            }
            let status =
              input.action === "KEEP"
                ? "CONFIRMED"
                : input.action === "REMOVE_BLOCK"
                  ? "CANCELLED"
                  : "DISMISSED";
            if (input.action === "KEEP") {
              const l = await tx.listing.findUniqueOrThrow({
                where: { id: b.listingId },
              });
              const others = await tx.booking.findMany({
                where: {
                  workspaceId: ctx.workspaceId,
                  listingId: b.listingId,
                  id: { not: b.id },
                  status: { in: ["CONFIRMED", "CONFLICT", "PENDING_REMOVAL"] },
                },
              });
              for (const other of others.filter((o) =>
                overlaps(b, o, l.bufferDays),
              ))
                await tx.booking.update({
                  where: { id: other.id },
                  data: {
                    status:
                      other.status === "PENDING_REMOVAL"
                        ? "PENDING_REMOVAL"
                        : "CONFLICT",
                    conflictWithId: b.id,
                    priorityOverride: false,
                    version: { increment: 1 },
                  },
                });
            }
            const updated = await tx.booking.update({
              where: { id: b.id },
              data: {
                status,
                priorityOverride: input.action === "KEEP",
                conflictWithId: null,
                version: { increment: 1 },
              },
            });
            await reconcileListingConflicts(
              tx,
              ctx,
              await tx.listing.findUniqueOrThrow({
                where: { id: b.listingId },
              }),
            );
            await event(
              tx,
              ctx,
              "CONFLICT_RESOLVED",
              b.id,
              `resolve:${b.id}:${updated.version}`,
              { action: input.action },
            );
            await audit(tx, ctx, "RESOLVE", "Booking", b.id, input.reason, {
              beforeStatus: b.status,
              afterStatus: status,
              externalResolutionConfirmed: input.externalResolutionConfirmed,
            });
            return bookingDTO(updated, ctx);
          }),
        );
      }
    }
    if (path[0] === "cleaning-tasks") {
      if (method === "GET")
        return json(
          await tenant(ctx, (tx) =>
            tx.cleaningTask.findMany({
              where: { workspaceId: ctx.workspaceId },
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
            ensure(
              await tx.listing.findFirst({
                where: { id: input.listingId, workspaceId: ctx.workspaceId },
              }),
              404,
              "NOT_FOUND",
              "Listing not found.",
            );
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
            if (task.bookingId) {
              const booking = await tx.booking.findFirst({
                where: { workspaceId: ctx.workspaceId, id: task.bookingId },
              });
              ensure(
                booking?.status === "CONFIRMED",
                409,
                "BOOKING_REVIEW",
                "Resolve the reservation before releasing access.",
              );
            }
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
    if (path[0] === "threads") {
      if (method === "GET" && path.length === 1)
        return json(
          await tenant(ctx, async (tx) => {
            const q = request.nextUrl.searchParams;
            const threads = await tx.thread.findMany({
              where: {
                workspaceId: ctx.workspaceId,
                ...(q.get("listing") ? { listingId: q.get("listing")! } : {}),
                ...(q.get("platform") ? { platform: q.get("platform")! } : {}),
                ...(q.get("status") ? { status: q.get("status")! } : {}),
              },
              orderBy: { updatedAt: "desc" },
              take: 200,
            });
            const rows = [];
            for (const t of threads) {
              const booking = await tx.booking.findUniqueOrThrow({
                where: { id: t.bookingId },
              });
              const latest = await tx.message.findFirst({
                where: { threadId: t.id, workspaceId: ctx.workspaceId },
                orderBy: { createdAt: "desc" },
              });
              rows.push({
                ...t,
                guestName:
                  decrypt(booking.guestNameEncrypted, ctx.workspaceId) ||
                  "Guest",
                preview: latest
                  ? decrypt(latest.bodyEncrypted, ctx.workspaceId).slice(0, 140)
                  : "",
              });
            }
            await audit(
              tx,
              ctx,
              "READ",
              "Thread",
              null,
              "Host read conversation summaries and decrypted guest names.",
            );
            return rows;
          }),
        );
      if (method === "GET" && path.length === 2)
        return json(
          await tenant(ctx, async (tx) => {
            const t = await tx.thread.findFirst({
              where: { id: path[1], workspaceId: ctx.workspaceId },
            });
            ensure(t, 404, "NOT_FOUND", "Conversation not found.");
            const booking = await tx.booking.findUniqueOrThrow({
                where: { id: t.bookingId },
              }),
              messages = await tx.message.findMany({
                where: { workspaceId: ctx.workspaceId, threadId: t.id },
                orderBy: { createdAt: "asc" },
                take: 500,
              });
            const pastStays = booking.guestHash
              ? await tx.booking.count({
                  where: {
                    workspaceId: ctx.workspaceId,
                    guestHash: booking.guestHash,
                    endDate: { lt: new Date() },
                    status: "CONFIRMED",
                  },
                })
              : 0;
            await audit(
              tx,
              ctx,
              "READ",
              "Thread",
              t.id,
              "Host read guest conversation, booking context, and repeat-stay count.",
            );
            return {
              thread: t,
              booking: bookingDTO(booking, ctx),
              pastStays,
              messages: messages.map(({ bodyEncrypted, ...m }) => ({
                ...m,
                body: decrypt(bodyEncrypted, ctx.workspaceId),
              })),
            };
          }),
        );
      if (method === "POST" && path[2] === "reply") {
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
      if (method === "POST" && path[2] === "toggle-manual") {
        const input = z
          .object({ manual: z.boolean() })
          .parse(await body(request));
        return json(
          await tenant(ctx, async (tx) => {
            const t = await tx.thread.update({
              where: { id: path[1] },
              data: { manual: input.manual },
            });
            if (input.manual) {
              const drafts = await tx.message.findMany({
                where: {
                  workspaceId: ctx.workspaceId,
                  threadId: t.id,
                  automated: true,
                  status: "QUEUED",
                },
                select: { id: true },
              });
              await tx.outbox.updateMany({
                where: {
                  workspaceId: ctx.workspaceId,
                  entityId: { in: drafts.map((d) => d.id) },
                  status: "PENDING",
                },
                data: { status: "CANCELLED" },
              });
              await tx.message.updateMany({
                where: { id: { in: drafts.map((d) => d.id) } },
                data: { status: "DRAFT" },
              });
            }
            await audit(
              tx,
              ctx,
              "TAKEOVER",
              "Thread",
              t.id,
              input.manual
                ? "Host disabled automation for this conversation."
                : "Host restored automation for future incoming messages.",
            );
            return { manual: t.manual };
          }),
        );
      }
      if (method === "POST" && path[2] === "resolve")
        return json(
          await tenant(ctx, async (tx) => {
            await tx.thread.update({
              where: { id: path[1] },
              data: { status: "RESOLVED" },
            });
            await audit(
              tx,
              ctx,
              "RESOLVE",
              "Thread",
              path[1],
              "Host marked this conversation resolved.",
            );
            return { ok: true };
          }),
        );
    }
    if (path[0] === "messages" && path[2] === "dismiss" && method === "POST")
      return json(
        await tenant(ctx, async (tx) => {
          const m = await tx.message.findFirst({
            where: {
              id: path[1],
              workspaceId: ctx.workspaceId,
              status: "DRAFT",
            },
          });
          ensure(m, 409, "DRAFT_CHANGED", "Draft is unavailable.");
          await tx.message.update({
            where: { id: m.id },
            data: { status: "DISMISSED" },
          });
          await tx.thread.update({
            where: { id: m.threadId },
            data: { status: "NEEDS_REPLY" },
          });
          await audit(
            tx,
            ctx,
            "DISMISS",
            "Message",
            m.id,
            "Host dismissed a suggestion without sending it.",
          );
          return { ok: true };
        }),
      );
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
          return rows.map(({ detailEncrypted, ...r }) => r);
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
          newPassword: z.string().min(14).max(200),
        })
        .parse(await body(request));
      const u = await db.user.findUniqueOrThrow({ where: { id: ctx.actorId } });
      ensure(
        passwordMatches(input.currentPassword, u.passwordHash),
        401,
        "PASSWORD",
        "Current password is incorrect.",
      );
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
        { error: error.message, code: error.code, requestId },
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
