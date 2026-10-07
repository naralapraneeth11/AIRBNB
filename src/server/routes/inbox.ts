// The Inbox: conversation summaries, a conversation's newest messages with
// older ones on request, and the host's actions on a conversation. Open
// screens refresh these every few seconds, so every query is bounded by a
// fixed number of statements and rows however many conversations or
// messages exist, and reads are logged once per window instead of per
// refresh. Sending a reply stays in the router, which dispatches it.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { audit, auditRead } from "../audit";
import { reservationDTO } from "../calendar/dto";
import { decrypt } from "../crypto";
import { tenant, type Context, type Tx } from "../db";
import { ensure } from "../errors";
import { body, json } from "../http";
import * as V from "../validation";
import { activeListing, activeListingIds } from "../services/listings";

/** Messages per page: the newest page first, then older pages on request. */
export const MESSAGE_PAGE = 50;
/** The most conversations one list returns, most recently active first. */
export const THREAD_LIST_LIMIT = 200;

type Filters = {
  listing?: string | null;
  platform?: string | null;
  status?: string | null;
  reservation?: string | null;
};

export async function threadSummaries(tx: Tx, ctx: Context, f: Filters) {
  const active = await activeListingIds(tx, ctx);
  const threads = await tx.thread.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      listingId: f.listing
        ? { in: active.filter((id) => id === f.listing) }
        : { in: active },
      ...(f.platform ? { platform: f.platform } : {}),
      ...(f.status ? { status: f.status } : {}),
      ...(f.reservation ? { reservationId: f.reservation } : {}),
    },
    // The id breaks ties so equal times never swap places between refreshes.
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: THREAD_LIST_LIMIT,
  });
  if (!threads.length) return [];
  const reservations = await tx.reservation.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      id: { in: [...new Set(threads.map((t) => t.reservationId))] },
    },
    select: { id: true, guestNameEncrypted: true },
  });
  // Each conversation's newest message, in one statement.
  const latest = await tx.$queryRaw<
    { threadId: string; bodyEncrypted: string }[]
  >`SELECT DISTINCT ON ("threadId") "threadId", "bodyEncrypted"
    FROM "Message"
    WHERE "workspaceId" = ${ctx.workspaceId}
      AND "threadId" = ANY(${threads.map((t) => t.id)})
      AND "status" <> 'DISMISSED'
    ORDER BY "threadId", "createdAt" DESC, "id" DESC`;
  const names = new Map(reservations.map((r) => [r.id, r.guestNameEncrypted]));
  const previews = new Map(latest.map((m) => [m.threadId, m.bodyEncrypted]));
  return threads.map((t) => ({
    ...t,
    guestName: decrypt(names.get(t.reservationId), ctx.workspaceId) || "Guest",
    preview: decrypt(previews.get(t.id), ctx.workspaceId).slice(0, 140),
  }));
}

/**
 * One page of a conversation, returned oldest first for reading. Without
 * `before` it is the newest page; with it, the page just older than that
 * message. Messages are ordered by time and then id, so two with the same
 * time are never skipped or repeated across pages.
 */
export async function messagePage(
  tx: Tx,
  ctx: Context,
  threadId: string,
  before?: { createdAt: Date; id: string },
) {
  const rows = await tx.message.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      threadId,
      status: { not: "DISMISSED" },
      ...(before
        ? {
            OR: [
              { createdAt: { lt: before.createdAt } },
              { createdAt: before.createdAt, id: { lt: before.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MESSAGE_PAGE + 1,
  });
  return {
    hasOlder: rows.length > MESSAGE_PAGE,
    messages: rows
      .slice(0, MESSAGE_PAGE)
      .reverse()
      .map(({ bodyEncrypted, ...m }) => ({
        ...m,
        body: decrypt(bodyEncrypted, ctx.workspaceId),
      })),
  };
}

/** A conversation whose property has not been removed. */
export async function threadOfActiveProperty(tx: Tx, ctx: Context, id: string) {
  const thread = await tx.thread.findFirst({
    where: { id, workspaceId: ctx.workspaceId },
  });
  ensure(thread, 404, "NOT_FOUND", "Conversation not found.");
  await activeListing(tx, ctx, thread.listingId);
  return thread;
}

export async function inboxRoutes(
  request: NextRequest,
  path: string[],
  method: string,
  ctx: Context,
): Promise<Response | null> {
  const [area, id, action] = path;
  if (area === "threads" && method === "GET" && !id) {
    const q = request.nextUrl.searchParams;
    return json(
      await tenant(ctx, async (tx) => {
        const rows = await threadSummaries(tx, ctx, {
          listing: q.get("listing"),
          platform: q.get("platform"),
          status: q.get("status"),
          reservation: q.get("reservation"),
        });
        await auditRead(
          tx,
          ctx,
          "Thread",
          null,
          "Host read conversation summaries and decrypted guest names.",
        );
        return rows;
      }),
    );
  }
  if (area === "threads" && method === "GET" && id && !action)
    return json(
      await tenant(ctx, async (tx) => {
        const t = await threadOfActiveProperty(tx, ctx, id);
        const reservation = await tx.reservation.findUniqueOrThrow({
          where: { id: t.reservationId },
        });
        const page = await messagePage(tx, ctx, t.id);
        const pastStays = reservation.guestHash
          ? await tx.reservation.count({
              where: {
                workspaceId: ctx.workspaceId,
                guestHash: reservation.guestHash,
                endDate: { lt: new Date() },
                status: "CONFIRMED",
              },
            })
          : 0;
        await auditRead(
          tx,
          ctx,
          "Thread",
          t.id,
          "Host read guest conversation, reservation context, and repeat-stay count.",
        );
        return {
          thread: t,
          reservation: reservationDTO(reservation, ctx),
          pastStays,
          ...page,
        };
      }),
    );
  if (area === "threads" && method === "GET" && id && action === "messages") {
    const before = V.id.parse(request.nextUrl.searchParams.get("before"));
    return json(
      await tenant(ctx, async (tx) => {
        await threadOfActiveProperty(tx, ctx, id);
        const anchor = await tx.message.findFirst({
          where: { id: before, threadId: id, workspaceId: ctx.workspaceId },
          select: { createdAt: true, id: true },
        });
        ensure(
          anchor,
          404,
          "NOT_FOUND",
          "That message is not in this conversation.",
        );
        const page = await messagePage(tx, ctx, id, anchor);
        await auditRead(
          tx,
          ctx,
          "Thread",
          id,
          "Host read earlier messages in a guest conversation.",
        );
        return page;
      }),
    );
  }
  if (area === "threads" && method === "POST" && action === "toggle-manual") {
    const input = z.object({ manual: z.boolean() }).parse(await body(request));
    return json(
      await tenant(ctx, async (tx) => {
        await threadOfActiveProperty(tx, ctx, id);
        const t = await tx.thread.update({
          where: { id },
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
  if (area === "threads" && method === "POST" && action === "resolve")
    return json(
      await tenant(ctx, async (tx) => {
        await threadOfActiveProperty(tx, ctx, id);
        await tx.thread.update({
          where: { id },
          data: { status: "RESOLVED" },
        });
        await audit(
          tx,
          ctx,
          "RESOLVE",
          "Thread",
          id,
          "Host marked this conversation resolved.",
        );
        return { ok: true };
      }),
    );
  if (area === "messages" && action === "dismiss" && method === "POST")
    return json(
      await tenant(ctx, async (tx) => {
        const m = await tx.message.findFirst({
          where: {
            id,
            workspaceId: ctx.workspaceId,
            status: "DRAFT",
          },
        });
        ensure(m, 409, "DRAFT_CHANGED", "Draft is unavailable.");
        await threadOfActiveProperty(tx, ctx, m.threadId);
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
  return null;
}
