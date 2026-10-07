// Export serving and token lifecycle (EXPORT 01-03). A retrieval is evidence
// that a request presented this link, not proof of which platform asked or
// that it applied the dates. Body downloads, 304 validations, HEAD requests
// and revoked-token hits are recorded as distinct classes.
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { audit, notify } from "../audit";
import { appUrl } from "../config";
import { hash, randomToken } from "../crypto";
import { lock, tenant, type Context, type Tx } from "../db";
import { todayIn } from "@/domain/calendar/dates";
import { calendarMode, loadPropertyBlocks, publishExports } from "./commit";
import { toLocalDate } from "./mappers";

/** Revoked token hashes are kept this long to recognise stale links. */
export const REVOKED_TOKEN_RETENTION_MS = 90 * 86_400_000;
type RetrievalClass =
  "BODY" | "NOT_MODIFIED" | "HEAD" | "REVOKED_TOKEN" | "UNAVAILABLE";

export function exportLink(
  workspaceId: string,
  listingId: string,
  token: string,
  connectionId?: string,
) {
  return `${appUrl()}/api/listings/${listingId}/export.ics?workspace=${encodeURIComponent(workspaceId)}&token=${encodeURIComponent(token)}${connectionId ? "&source=" + encodeURIComponent(connectionId) : ""}`;
}

const hourBucket = (d: Date) =>
  new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000);

async function recordRetrieval(
  tx: Tx,
  ctx: Context,
  input: {
    connectionId: string;
    tokenGeneration: number;
    version: number;
    responseClass: RetrievalClass;
    at: Date;
  },
) {
  const bucketStart = hourBucket(input.at);
  await tx.exportRetrieval.upsert({
    where: {
      workspaceId_connectionId_tokenGeneration_version_responseClass_bucketStart:
        {
          workspaceId: ctx.workspaceId,
          connectionId: input.connectionId,
          tokenGeneration: input.tokenGeneration,
          version: input.version,
          responseClass: input.responseClass,
          bucketStart,
        },
    },
    create: {
      id: randomUUID(),
      workspaceId: ctx.workspaceId,
      connectionId: input.connectionId,
      tokenGeneration: input.tokenGeneration,
      version: input.version,
      responseClass: input.responseClass,
      bucketStart,
      firstAt: input.at,
      lastAt: input.at,
    },
    update: { count: { increment: 1 }, lastAt: input.at },
  });
}

/** RFC 9110 If-None-Match: a list of entity tags, or "*". */
export function etagMatches(header: string | null, etag: string) {
  if (!header) return false;
  const bare = etag.replace(/^W\//, "");
  return header
    .split(",")
    .map((t) => t.trim())
    .some((t) => t === "*" || t.replace(/^W\//, "") === bare);
}

const notFound = () =>
  new Response("Calendar not found.", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

export async function serveExport(input: {
  workspaceId: string;
  listingId: string;
  token: string;
  connectionId: string | null;
  method: "GET" | "HEAD";
  ifNoneMatch: string | null;
  now?: Date;
}): Promise<Response> {
  const ctx: Context = {
    workspaceId: input.workspaceId,
    actorId: "calendar-client",
    role: "SYSTEM",
  };
  const at = input.now ?? new Date();
  const tokenHash = hash(input.token);
  return tenant(ctx, async (tx) => {
    const connection = await tx.channelConnection.findFirst({
      where: { workspaceId: ctx.workspaceId, exportTokenHash: tokenHash },
    });
    if (!connection) {
      // EXPORT 03: a rotated link still in use is recognised, answered
      // generically, and reported without exposing tenant details.
      const revoked = await tx.revokedExportToken.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          tokenHash,
          expiresAt: { gt: at },
        },
      });
      if (revoked) {
        await tx.revokedExportToken.update({
          where: { tokenHash },
          data: { hits: { increment: 1 }, lastSeenAt: at },
        });
        await recordRetrieval(tx, ctx, {
          connectionId: revoked.connectionId,
          tokenGeneration: revoked.generation,
          version: 0,
          responseClass: "REVOKED_TOKEN",
          at,
        });
        if ((await calendarMode(tx, ctx)) === "LIVE")
          await notify(
            tx,
            ctx,
            `cal:stale-link:${revoked.connectionId}:${revoked.generation}:${at.toISOString().slice(0, 10)}`,
            "An old calendar link is still being used",
            "A platform or person requested a rotated export link. Update the platform's import setting with the current link.",
            "/properties?connection=" + revoked.connectionId,
          );
      }
      return notFound();
    }
    if (
      connection.listingId !== input.listingId ||
      (input.connectionId !== null && input.connectionId !== connection.id)
    )
      return notFound();
    if (!connection.enabled) {
      // A removed property's link answers "not found", never an empty
      // calendar, so no platform is told its dates are free. The request is
      // recorded so the host can see which platform still imports the link.
      if (connection.health === "PROPERTY_REMOVED")
        await recordRetrieval(tx, ctx, {
          connectionId: connection.id,
          tokenGeneration: connection.exportTokenGeneration,
          version: 0,
          responseClass: "UNAVAILABLE",
          at,
        });
      return notFound();
    }
    if ((await calendarMode(tx, ctx)) === "SHADOW") {
      // REL 01: shadow decisions are not published to any platform.
      await recordRetrieval(tx, ctx, {
        connectionId: connection.id,
        tokenGeneration: connection.exportTokenGeneration,
        version: 0,
        responseClass: "UNAVAILABLE",
        at,
      });
      return new Response("This calendar link is not active yet.", {
        status: 503,
        headers: {
          "Retry-After": "3600",
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    const latestVersion = () =>
      tx.exportVersion.findFirst({
        where: { workspaceId: ctx.workspaceId, connectionId: connection.id },
        orderBy: { version: "desc" },
      });
    let latest = await latestVersion();
    const listing = await tx.listing.findUniqueOrThrow({
      where: { id: connection.listingId },
    });
    // Publish first when there is no servable version yet, or when the day an
    // event leaves the history window has arrived and the scheduler has not
    // republished: served content never depends on the scheduler being up.
    const aged =
      !!listing.exportRefreshOn &&
      toLocalDate(listing.exportRefreshOn) <=
        todayIn(listing.timezone, at.getTime());
    if (!latest?.body || aged) {
      await lock(tx, "listing:" + listing.id);
      const current = await tx.listing.findUniqueOrThrow({
        where: { id: listing.id },
      });
      await publishExports(
        tx,
        ctx,
        current,
        await loadPropertyBlocks(tx, ctx, listing.id),
        at,
      );
      latest = await latestVersion();
    }
    if (!latest?.body) return notFound();
    // Never serve an older version after a newer one: always the latest row.
    const etag = `"${latest.bodyDigest}"`;
    const headers = {
      ETag: etag,
      "Content-Type": "text/calendar; charset=utf-8",
      // Clients may revalidate; shared caches must not store this (SEC 03).
      "Cache-Control": "private, no-cache",
      "Content-Disposition": 'inline; filename="availability.ics"',
      "X-Calendar-Version": String(latest.version),
    };
    const responseClass: RetrievalClass = etagMatches(input.ifNoneMatch, etag)
      ? "NOT_MODIFIED"
      : input.method === "HEAD"
        ? "HEAD"
        : "BODY";
    await recordRetrieval(tx, ctx, {
      connectionId: connection.id,
      tokenGeneration: connection.exportTokenGeneration,
      version: latest.version,
      responseClass,
      at,
    });
    if (responseClass === "NOT_MODIFIED")
      return new Response(null, { status: 304, headers });
    if (responseClass === "HEAD")
      return new Response(null, {
        status: 200,
        headers: {
          ...headers,
          "Content-Length": String(Buffer.byteLength(latest.body)),
        },
      });
    return new Response(latest.body, { status: 200, headers });
  });
}

/** EXPORT 03: rotate a connection's export token through an audited flow. */
export async function rotateExportToken(
  tx: Tx,
  ctx: Context,
  connectionId: string,
) {
  const connection = await tx.channelConnection.findFirst({
    where: { workspaceId: ctx.workspaceId, id: connectionId },
  });
  if (!connection) return null;
  const token = randomToken();
  const now = new Date();
  await tx.revokedExportToken.create({
    data: {
      tokenHash: connection.exportTokenHash,
      workspaceId: ctx.workspaceId,
      connectionId: connection.id,
      generation: connection.exportTokenGeneration,
      revokedAt: now,
      expiresAt: new Date(now.getTime() + REVOKED_TOKEN_RETENTION_MS),
    },
  });
  const updated = await tx.channelConnection.update({
    where: { id: connection.id },
    data: {
      exportTokenHash: hash(token),
      exportTokenGeneration: { increment: 1 },
    },
  });
  await audit(
    tx,
    ctx,
    "ROTATE",
    "ChannelConnection",
    connection.id,
    "Export link rotated; the previous link now returns a generic not-found response.",
    {
      generation: updated.exportTokenGeneration,
    },
  );
  return {
    url: exportLink(
      ctx.workspaceId,
      connection.listingId,
      token,
      connection.importUrlEncrypted ? connection.id : undefined,
    ),
    generation: updated.exportTokenGeneration,
  };
}

/** Retrieval evidence for the connection detail view (EXPORT 02 wording). */
export async function exportEvidence(
  tx: Tx,
  ctx: Context,
  connectionId: string,
) {
  const latest = await tx.exportVersion.findFirst({
    where: { workspaceId: ctx.workspaceId, connectionId },
    orderBy: { version: "desc" },
    select: {
      version: true,
      createdAt: true,
      eventCount: true,
      sourceRevision: true,
    },
  });
  const where: Prisma.ExportRetrievalWhereInput = {
    workspaceId: ctx.workspaceId,
    connectionId,
  };
  const lastBody = await tx.exportRetrieval.findFirst({
    where: { ...where, responseClass: "BODY" },
    orderBy: { lastAt: "desc" },
    select: { version: true, lastAt: true },
  });
  const lastValidation = await tx.exportRetrieval.findFirst({
    where: { ...where, responseClass: { in: ["NOT_MODIFIED", "HEAD"] } },
    orderBy: { lastAt: "desc" },
    select: { version: true, lastAt: true, responseClass: true },
  });
  const latestRetrieved = latest
    ? await tx.exportRetrieval.findFirst({
        where: { ...where, responseClass: "BODY", version: latest.version },
        orderBy: { firstAt: "asc" },
        select: { firstAt: true },
      })
    : null;
  const staleLinkHits = await tx.revokedExportToken.aggregate({
    where: {
      workspaceId: ctx.workspaceId,
      connectionId,
      expiresAt: { gt: new Date() },
    },
    _sum: { hits: true },
  });
  return {
    latestVersion: latest,
    latestVersionFirstRetrievedAt: latestRetrieved?.firstAt ?? null,
    lastBodyRetrieval: lastBody,
    lastValidation,
    staleLinkHits: staleLinkHits._sum.hits ?? 0,
  };
}
