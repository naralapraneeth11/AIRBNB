// Calendar API routes (Phase 1). Split from the main router (ARCH 02); the
// main router authenticates the host and delegates here.
import type { AvailabilityBlock } from "@prisma/client";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { HOST_CLASSES, PLATFORMS } from "@/domain/calendar/types";
import { audit } from "../audit";
import { ownerOnly } from "../auth";
import {
  acknowledgeReview,
  classifyDates,
  createConnection,
  createDirectReservation,
  createHold,
  keepDatesBlocked,
  policySample,
  recordConflictResolution,
  releaseDates,
  releasePreview,
  replaceConnectionUrl,
  requestRefresh,
  restoreDates,
  setBufferOverride,
  setClassificationPolicy,
  setConnectionEnabled,
} from "../calendar/actions";
import {
  blockDTO,
  conflictDTO,
  connectionDTO,
  reservationDTO,
} from "../calendar/dto";
import { toLocalDate } from "../calendar/mappers";
import { exportEvidence, rotateExportToken } from "../calendar/serve";
import { blind, encrypt } from "../crypto";
import { lock, tenant, type Context, type Tx } from "../db";
import { AppError, ensure } from "../errors";
import { body, json, range } from "../http";
import * as V from "../validation";

const REVIEW_FLAGS = [
  "IDENTITY_UNCERTAIN",
  "DUPLICATE_UID",
  "INVALID_SOURCE_EVENT",
  "AMBIGUOUS_TIME",
  "OVERRIDE_SOURCE_CHANGED",
  "CONTRADICTORY_HISTORY",
  "UPDATE_DEFERRED",
  "FOREIGN_ECHO_UID",
  "STALE_CANCELLATION_IGNORED",
  "BEYOND_COVERAGE",
] as const;
const revision = z.number().int().nonnegative();
const reason = z.string().trim().min(3).max(1000);

async function blocksInRange(tx: Tx, ctx: Context, from: Date, to: Date) {
  const rows = await tx.availabilityBlock.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      startDate: { lt: to },
      endDate: { gt: from },
      // Released dates stay visible for their 24-hour restore window.
      OR: [
        { lifecycle: { not: "RELEASED" } },
        { releasedAt: { gte: new Date(Date.now() - 24 * 3_600_000) } },
      ],
    },
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
    take: 2000,
  });
  return { rows, blocks: await decorate(tx, ctx, rows) };
}

/** Block DTOs with their platform, property buffer default and reservation. */
async function decorate(tx: Tx, ctx: Context, rows: AvailabilityBlock[]) {
  const [listings, connections, reservations] = await Promise.all([
    tx.listing.findMany({
      where: { workspaceId: ctx.workspaceId },
      select: { id: true, bufferDays: true },
    }),
    tx.channelConnection.findMany({
      where: { workspaceId: ctx.workspaceId },
      select: { id: true, platform: true },
    }),
    tx.reservation.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        blockId: { in: rows.map((r) => r.id) },
      },
    }),
  ]);
  const buffers = new Map(listings.map((l) => [l.id, l.bufferDays]));
  const platforms = new Map(connections.map((c) => [c.id, c.platform]));
  const byBlock = new Map(reservations.map((r) => [r.blockId, r]));
  return rows.map((r) =>
    blockDTO(r, ctx, {
      platform: r.connectionId
        ? (platforms.get(r.connectionId) ?? "OTHER")
        : r.holdType === "DIRECT_RESERVATION"
          ? "DIRECT"
          : "MANUAL",
      defaultBufferDays: buffers.get(r.listingId) ?? 0,
      reservation: byBlock.get(r.id) ?? null,
    }),
  );
}

const isUnknown = (r: AvailabilityBlock) =>
  (r.overrideClassification ?? r.classification) === "UNKNOWN";

/**
 * Everything waiting on the host, whatever month is on screen: decisions
 * before reopening (LIFE 01), unknown blocks and pending connection policy
 * questions (CLASS 02), flagged evidence, and open overlaps (CONFLICT 01).
 */
export async function attention(tx: Tx, ctx: Context) {
  const recent = new Date(Date.now() - 2 * 86_400_000);
  const rows = await tx.availabilityBlock.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      lifecycle: { not: "RELEASED" },
      OR: [
        { lifecycle: "AWAITING_DECISION" },
        {
          endDate: { gte: recent },
          OR: [
            { classification: "UNKNOWN", overrideClassification: null },
            { overrideClassification: "UNKNOWN" },
            { reviewFlags: { isEmpty: false } },
          ],
        },
      ],
    },
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
    take: 300,
  });
  const conflicts = await tx.conflictCase.findMany({
    where: { workspaceId: ctx.workspaceId, state: "OPEN" },
    orderBy: [{ overlapStart: "asc" }, { id: "asc" }],
    take: 100,
  });
  const unset = await tx.channelConnection.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      enabled: true,
      importUrlEncrypted: { not: null },
      policyMode: "UNSET",
      policyDecidedAt: null,
    },
    select: { id: true },
  });
  return {
    blocks: await decorate(tx, ctx, rows),
    conflicts: conflicts.map(conflictDTO),
    policyQuestions: unset
      .filter((c) => rows.some((r) => r.connectionId === c.id && isUnknown(r)))
      .map((c) => c.id),
    capped: rows.length === 300,
  };
}

async function oneBlock(tx: Tx, ctx: Context, id: string) {
  const row = await tx.availabilityBlock.findFirst({
    where: { workspaceId: ctx.workspaceId, id },
  });
  ensure(row, 404, "NOT_FOUND", "These dates were not found.");
  const listing = await tx.listing.findUniqueOrThrow({
    where: { id: row.listingId },
  });
  const connection = row.connectionId
    ? await tx.channelConnection.findUnique({ where: { id: row.connectionId } })
    : null;
  const reservation = await tx.reservation.findFirst({
    where: { workspaceId: ctx.workspaceId, blockId: row.id },
  });
  return blockDTO(row, ctx, {
    platform:
      connection?.platform ??
      (row.holdType === "DIRECT_RESERVATION" ? "DIRECT" : "MANUAL"),
    defaultBufferDays: listing.bufferDays,
    reservation,
  });
}

export async function calendarRoutes(
  request: NextRequest,
  path: string[],
  method: string,
  ctx: Context,
): Promise<Response | null> {
  const [area, id, action] = path;

  if (area === "calendar" && method === "GET" && !id) {
    const r = range(request);
    return json(
      await tenant(ctx, async (tx) => {
        const { rows, blocks } = await blocksInRange(tx, ctx, r.from, r.to);
        const conflicts = await tx.conflictCase.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            state: "OPEN",
            overlapStart: { lt: r.to },
            overlapEnd: { gt: r.from },
          },
          orderBy: { overlapStart: "asc" },
          take: 500,
        });
        await audit(
          tx,
          ctx,
          "READ",
          "AvailabilityBlock",
          null,
          "Host read calendar availability and decrypted guest names.",
          {
            from: toLocalDate(r.from),
            to: toLocalDate(r.to),
            count: rows.length,
          },
        );
        return {
          blocks,
          conflicts: conflicts.map(conflictDTO),
          capped: rows.length === 2000,
        };
      }),
    );
  }

  if (area === "calendar" && id === "attention" && method === "GET")
    return json(
      await tenant(ctx, async (tx) => {
        const result = await attention(tx, ctx);
        await audit(
          tx,
          ctx,
          "READ",
          "AvailabilityBlock",
          null,
          "Host read calendar items waiting for a decision.",
          { count: result.blocks.length },
        );
        return result;
      }),
    );

  if (area === "calendar" && id === "block" && method === "POST") {
    const input = V.blockInput.parse(await body(request));
    return json(
      await tenant(ctx, async (tx) => {
        const row = await createHold(tx, ctx, {
          listingId: input.listingId,
          from: input.from,
          to: input.to,
          holdType: input.holdType,
          reason: input.reason,
          clientRequestId: input.idempotencyKey,
          acknowledgeOverlaps: input.acknowledgeOverlaps,
        });
        return oneBlock(tx, ctx, row.id);
      }),
      201,
    );
  }

  if (area === "blocks" && id) {
    if (method === "GET" && !action)
      return json(
        await tenant(ctx, async (tx) => {
          const block = await oneBlock(tx, ctx, id);
          const history = await tx.domainEvent.findMany({
            where: { workspaceId: ctx.workspaceId, entityId: id },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 30,
            select: { type: true, createdAt: true, payload: true },
          });
          return { block, preview: await releasePreview(tx, ctx, id), history };
        }),
      );
    if (method === "POST") {
      const data = await body(request);
      const run = (fn: (tx: Tx) => Promise<unknown>) =>
        tenant(ctx, async (tx) => {
          await fn(tx);
          return oneBlock(tx, ctx, id);
        });
      if (action === "release") {
        const input = z
          .object({
            expectedRevision: revision,
            reason,
            externalResolutionConfirmed: z.boolean().default(false),
          })
          .parse(data);
        return json(await run((tx) => releaseDates(tx, ctx, id, input)));
      }
      if (action === "keep") {
        const input = z
          .object({ expectedRevision: revision, reason })
          .parse(data);
        return json(await run((tx) => keepDatesBlocked(tx, ctx, id, input)));
      }
      if (action === "restore") {
        const input = z
          .object({ expectedRevision: revision, reason })
          .parse(data);
        return json(
          await tenant(ctx, async (tx) => {
            const hold = await restoreDates(tx, ctx, id, input);
            return oneBlock(tx, ctx, hold.id);
          }),
          201,
        );
      }
      if (action === "classify") {
        const input = z
          .object({
            expectedRevision: revision,
            classification: z.enum(HOST_CLASSES).nullable(),
            reason,
          })
          .parse(data);
        return json(await run((tx) => classifyDates(tx, ctx, id, input)));
      }
      if (action === "buffers") {
        const days = z.number().int().min(0).max(14).nullable();
        const input = z
          .object({
            expectedRevision: revision,
            before: days,
            after: days,
            reason,
          })
          .parse(data);
        return json(await run((tx) => setBufferOverride(tx, ctx, id, input)));
      }
      if (action === "acknowledge") {
        const input = z
          .object({
            expectedRevision: revision,
            flags: z.array(z.enum(REVIEW_FLAGS)).min(1),
          })
          .parse(data);
        return json(await run((tx) => acknowledgeReview(tx, ctx, id, input)));
      }
    }
  }

  if (area === "bookings") {
    if (method === "POST" && !id) {
      const input = V.directBookingInput.parse(await body(request));
      return json(
        await tenant(ctx, async (tx) => {
          const result = await createDirectReservation(tx, ctx, {
            listingId: input.listingId,
            from: input.from,
            to: input.to,
            guestName: input.guestName,
            guestContact: input.guestContact,
            price: input.price,
            currency: input.currency,
            clientRequestId: input.idempotencyKey,
            acknowledgeOverlaps: input.acknowledgeOverlaps,
          });
          if ("reservation" in result)
            return {
              ...reservationDTO(result.reservation, ctx),
              threadId: result.threadId,
            };
          const thread = await tx.thread.findFirst({
            where: {
              workspaceId: ctx.workspaceId,
              reservationId: result.id,
              platform: "DIRECT",
            },
          });
          await audit(
            tx,
            ctx,
            "READ",
            "Reservation",
            result.id,
            "An idempotent reservation request returned the existing reservation.",
          );
          return {
            ...reservationDTO(result, ctx),
            threadId: thread?.id ?? null,
          };
        }),
        201,
      );
    }
    if (method === "GET" && !id) {
      const r = range(request);
      return json(
        await tenant(ctx, async (tx) => {
          const rows = await tx.reservation.findMany({
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
            "Reservation",
            null,
            "Host read guest reservation details.",
          );
          return rows.map((row) => reservationDTO(row, ctx));
        }),
      );
    }
    if (method === "PATCH" && id) {
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
          await lock(tx, "reservation:" + id);
          const r = await tx.reservation.findFirst({
            where: { id, workspaceId: ctx.workspaceId },
          });
          ensure(
            r && r.version === input.version,
            409,
            "VERSION_CONFLICT",
            "Reservation changed. Refresh and try again.",
          );
          const updated = await tx.reservation.update({
            where: { id: r.id },
            data: {
              guestNameEncrypted: encrypt(input.guestName, ctx.workspaceId),
              guestContactEncrypted: encrypt(
                input.guestContact,
                ctx.workspaceId,
              ),
              guestHash: input.guestContact ? blind(input.guestContact) : null,
              price: input.price,
              version: { increment: 1 },
            },
          });
          await audit(
            tx,
            ctx,
            "ENRICH",
            "Reservation",
            r.id,
            "Host added guest details and price; calendar feeds usually do not provide these fields.",
          );
          return reservationDTO(updated, ctx);
        }),
      );
    }
  }

  if (area === "connections") {
    if (method === "POST" && !id) {
      ownerOnly(ctx);
      const input = z
        .object({
          listingId: V.id,
          platform: z.enum(PLATFORMS),
          url: z.string().trim().max(2000).nullable(),
          label: z.string().trim().max(80).nullable().default(null),
        })
        .parse(await body(request));
      return json(
        await tenant(ctx, async (tx) => {
          const { connection, exportUrl } = await createConnection(
            tx,
            ctx,
            input,
          );
          return { connection: connectionDTO(connection), exportUrl };
        }),
        201,
      );
    }
    if (method === "GET" && id && !action)
      return json(
        await tenant(ctx, async (tx) => {
          const c = await tx.channelConnection.findFirst({
            where: { workspaceId: ctx.workspaceId, id },
          });
          ensure(c, 404, "NOT_FOUND", "Calendar connection not found.");
          const observations = await tx.feedObservation.findMany({
            where: { workspaceId: ctx.workspaceId, connectionId: id },
            orderBy: { observedAt: "desc" },
            take: 20,
            select: {
              id: true,
              observedAt: true,
              trigger: true,
              mode: true,
              outcome: true,
              httpStatus: true,
              health: true,
              result: true,
              reasonCodes: true,
              counts: true,
              durationMs: true,
              recomputed: true,
            },
          });
          return {
            connection: connectionDTO(c),
            observations,
            exports: await exportEvidence(tx, ctx, id),
          };
        }),
      );
    if (method === "PATCH" && id && !action) {
      ownerOnly(ctx);
      const input = z
        .object({
          url: z.string().trim().max(2000).optional(),
          enabled: z.boolean().optional(),
          label: z.string().trim().max(80).nullable().optional(),
        })
        .parse(await body(request));
      return json(
        await tenant(ctx, async (tx) => {
          if (input.url !== undefined)
            await replaceConnectionUrl(tx, ctx, id, input.url);
          if (input.enabled !== undefined)
            await setConnectionEnabled(tx, ctx, id, input.enabled);
          if (input.label !== undefined)
            await tx.channelConnection.updateMany({
              where: { workspaceId: ctx.workspaceId, id },
              data: { label: input.label },
            });
          const c = await tx.channelConnection.findFirst({
            where: { workspaceId: ctx.workspaceId, id },
          });
          ensure(c, 404, "NOT_FOUND", "Calendar connection not found.");
          return connectionDTO(c);
        }),
      );
    }
    if (method === "POST" && id && action === "refresh")
      return json(
        await tenant(ctx, async (tx) => (await requestRefresh(tx, ctx, id))[0]),
        202,
      );
    if (method === "POST" && id && action === "export-token") {
      ownerOnly(ctx);
      return json(
        await tenant(ctx, async (tx) => {
          const rotated = await rotateExportToken(tx, ctx, id);
          ensure(rotated, 404, "NOT_FOUND", "Calendar connection not found.");
          return rotated;
        }),
      );
    }
    if (id && action === "policy") {
      if (method === "GET")
        return json(await tenant(ctx, (tx) => policySample(tx, ctx, id)));
      if (method === "POST") {
        const input = z
          .object({
            mode: z.enum(["UNSET", "RESERVATIONS", "OWNER_BLOCKS", "BY_LABEL"]),
            labels: z
              .record(z.string().max(40), z.enum(HOST_CLASSES))
              .nullable()
              .default(null),
            expectedVersion: revision,
            sampleDigest: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .parse(await body(request));
        return json(
          await tenant(ctx, (tx) =>
            setClassificationPolicy(tx, ctx, id, input),
          ),
        );
      }
    }
  }

  if (area === "sync" && method === "POST")
    return json(
      { results: await tenant(ctx, (tx) => requestRefresh(tx, ctx, null)) },
      202,
    );

  if (area === "conflicts") {
    if (method === "GET" && !id)
      return json(
        await tenant(ctx, async (tx) =>
          (
            await tx.conflictCase.findMany({
              where: { workspaceId: ctx.workspaceId, state: "OPEN" },
              orderBy: [{ severity: "asc" }, { overlapStart: "asc" }],
              take: 500,
            })
          ).map(conflictDTO),
        ),
      );
    if (method === "POST" && id && action === "resolve") {
      const input = z
        .object({
          expectedRevision: revision,
          note: z.string().trim().min(10).max(1000),
        })
        .parse(await body(request));
      await tenant(ctx, (tx) => recordConflictResolution(tx, ctx, id, input));
      return json({ ok: true });
    }
  }

  if (
    area === "listings" &&
    id &&
    action === "export-token" &&
    method === "POST"
  ) {
    // Compatibility: the master link is the listing's export-only connection.
    ownerOnly(ctx);
    return json(
      await tenant(ctx, async (tx) => {
        const master = await tx.channelConnection.findFirst({
          where: {
            workspaceId: ctx.workspaceId,
            listingId: id,
            importUrlEncrypted: null,
          },
          orderBy: { createdAt: "asc" },
        });
        if (!master)
          throw new AppError(
            404,
            "NOT_FOUND",
            "This property has no all-channel export link.",
          );
        return rotateExportToken(tx, ctx, master.id);
      }),
    );
  }
  return null;
}
