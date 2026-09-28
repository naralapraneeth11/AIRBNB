// Host and operator actions on the calendar. Each takes the property lock,
// checks the revision the host reviewed, and commits through the same path as
// feed observations (commitCalendarChange), so effects cannot diverge.
import { randomUUID } from "node:crypto";
import { Prisma, type ChannelConnection } from "@prisma/client";
import {
  CAPABILITIES_VERSION,
  capabilityOf,
  labelRule,
} from "@/domain/calendar/capabilities";
import { reclassifyForPolicy } from "@/domain/calendar/compare";
import { bufferOf } from "@/domain/calendar/conflicts";
import {
  addDays,
  intersect,
  todayIn,
  type LocalDate,
} from "@/domain/calendar/dates";
import { digestOf } from "@/domain/calendar/digest";
import {
  acknowledgeFlags,
  classifyBlock,
  keepBlocked,
  manualHold,
  overrideBuffers,
  releaseBlock,
  restoreBlock,
  type TransitionResult,
} from "@/domain/calendar/lifecycle";
import { manualRefreshEligibility } from "@/domain/calendar/schedule";
import {
  effectiveClass,
  isProtective,
  type BlockState,
  type ConnectionPolicy,
  type HostClass,
  type Platform,
  type ReviewFlag,
} from "@/domain/calendar/types";
import { audit, event } from "../audit";
import {
  blind,
  decrypt,
  encrypt,
  hash,
  keyedDigest,
  randomToken,
  seal,
} from "../crypto";
import { lock, type Context, type Tx } from "../db";
import { AppError, ensure } from "../errors";
import { applyTurnover } from "../services/cleaning";
import {
  calendarMode,
  commitCalendarChange,
  loadPropertyBlocks,
  publishExports,
} from "./commit";
import { checkFeedUrl } from "./fetch";
import {
  blockState,
  connectionPolicy,
  fromLocalDate,
  toLocalDate,
} from "./mappers";
import { exportLink } from "./serve";

const TRANSITION_ERRORS = {
  STALE_REVISION: [
    409,
    "BLOCK_CHANGED",
    "These dates changed after you opened them. Review the latest details and try again.",
  ],
  INVALID_STATE: [
    409,
    "INVALID_STATE",
    "These dates are not in a state that allows this action.",
  ],
  RESTORE_WINDOW_PASSED: [
    409,
    "RESTORE_WINDOW_PASSED",
    "Released dates can be restored for 24 hours. Create a new hold instead.",
  ],
  NOT_IMPORTED: [
    400,
    "NOT_IMPORTED",
    "Only dates imported from a calendar can be classified.",
  ],
} as const;

function unwrap(result: TransitionResult): BlockState {
  if (result.ok) return result.block;
  const [status, code, message] = TRANSITION_ERRORS[result.error];
  throw new AppError(status, code, message);
}

async function lockedListing(tx: Tx, ctx: Context, listingId: string) {
  await lock(tx, "listing:" + listingId);
  const listing = await tx.listing.findFirst({
    where: { id: listingId, workspaceId: ctx.workspaceId, archivedAt: null },
  });
  ensure(listing, 404, "NOT_FOUND", "Listing not found.");
  return listing;
}

async function lockedBlock(tx: Tx, ctx: Context, blockId: string) {
  const row = await tx.availabilityBlock.findFirst({
    where: { id: blockId, workspaceId: ctx.workspaceId },
    select: { listingId: true },
  });
  ensure(row, 404, "NOT_FOUND", "These dates were not found.");
  const listing = await lockedListing(tx, ctx, row.listingId);
  const blocks = await loadPropertyBlocks(tx, ctx, listing.id);
  const block = blocks.find((b) => b.id === blockId)!;
  return { listing, blocks, block };
}

const before = (blocks: BlockState[]) => new Map(blocks.map((b) => [b.id, b]));

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------
const URL_ERRORS = {
  URL_INVALID: "Enter the calendar's full export URL.",
  HTTPS_REQUIRED:
    "Calendar links must use HTTPS. Use the HTTPS version of this link.",
  CREDENTIALS: "Calendar links cannot contain a username or password.",
  PORT: "Calendar links must use the standard HTTPS port.",
  HOST_NOT_ALLOWED:
    "This address does not belong to the selected platform. Choose the matching platform, or use Other calendar.",
} as const;

export function validatedImportUrl(raw: string, platform: Platform) {
  const cap = capabilityOf(platform);
  ensure(
    cap.importSupport !== "UNAVAILABLE",
    400,
    "PLATFORM_UNAVAILABLE",
    cap.refreshGuidance,
  );
  const check = checkFeedUrl(raw, platform);
  if (!check.ok)
    throw new AppError(400, "URL_BLOCKED", URL_ERRORS[check.code], {
      suggestion: check.suggestion ?? null,
    });
  return check.url;
}

export async function createConnection(
  tx: Tx,
  ctx: Context,
  input: {
    listingId: string;
    platform: Platform;
    url: string | null;
    label: string | null;
  },
) {
  const listing = await lockedListing(tx, ctx, input.listingId);
  const url = input.url ? validatedImportUrl(input.url, input.platform) : null;
  if (!url)
    ensure(
      capabilityOf(input.platform).exportSupport,
      400,
      "PLATFORM_UNAVAILABLE",
      capabilityOf(input.platform).refreshGuidance,
    );
  const token = randomToken();
  let connection: ChannelConnection;
  try {
    connection = await tx.channelConnection.create({
      data: {
        id: randomUUID(),
        workspaceId: ctx.workspaceId,
        listingId: listing.id,
        platform: input.platform,
        label: input.label,
        importUrlEncrypted: url ? encrypt(url.href, ctx.workspaceId) : null,
        importUrlDigest: url ? keyedDigest("feed-url", url.href) : null,
        exportTokenHash: hash(token),
        capabilitiesVersion: CAPABILITIES_VERSION,
        health: url ? "PENDING" : "EXPORT_ONLY",
        nextFetchAt: new Date(),
      },
    });
  } catch (error) {
    // Never reveal whether the feed exists in another workspace: the unique
    // index is per workspace, so this only reports this workspace's duplicate.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      throw new AppError(
        409,
        "ALREADY_CONNECTED",
        "This calendar is already connected in your workspace.",
      );
    throw error;
  }
  await publishExports(
    tx,
    ctx,
    listing,
    await loadPropertyBlocks(tx, ctx, listing.id),
    new Date(),
  );
  await audit(
    tx,
    ctx,
    "CONNECT",
    "ChannelConnection",
    connection.id,
    url
      ? "Calendar connected in both directions: its feed is imported and a destination-specific export link was issued."
      : "Export-only connection created; nothing is imported from this destination.",
    { platform: input.platform },
  );
  return {
    connection,
    exportUrl: exportLink(
      ctx.workspaceId,
      listing.id,
      token,
      url ? connection.id : undefined,
    ),
  };
}

export async function replaceConnectionUrl(
  tx: Tx,
  ctx: Context,
  connectionId: string,
  raw: string,
) {
  const c = await tx.channelConnection.findFirst({
    where: { workspaceId: ctx.workspaceId, id: connectionId },
  });
  ensure(
    c && c.importUrlEncrypted,
    404,
    "NOT_FOUND",
    "Calendar connection not found.",
  );
  await lockedListing(tx, ctx, c.listingId);
  const url = validatedImportUrl(raw, c.platform as Platform);
  try {
    await tx.channelConnection.update({
      where: { id: c.id },
      data: {
        importUrlEncrypted: encrypt(url.href, ctx.workspaceId),
        importUrlDigest: keyedDigest("feed-url", url.href),
        enabled: true,
        health: "PENDING",
        etag: null,
        lastModified: null,
        lastAcceptedFingerprint: null,
        failures: 0,
        sourceRetryAfter: null,
        nextFetchAt: new Date(),
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      throw new AppError(
        409,
        "ALREADY_CONNECTED",
        "This calendar is already connected in your workspace.",
      );
    throw error;
  }
  await audit(
    tx,
    ctx,
    "RECONNECT",
    "ChannelConnection",
    c.id,
    "Import link replaced. Existing dates stay protected until the new feed is checked.",
  );
}

export async function setConnectionEnabled(
  tx: Tx,
  ctx: Context,
  connectionId: string,
  enabled: boolean,
) {
  const c = await tx.channelConnection.findFirst({
    where: { workspaceId: ctx.workspaceId, id: connectionId },
  });
  ensure(c, 404, "NOT_FOUND", "Calendar connection not found.");
  const listing = await lockedListing(tx, ctx, c.listingId);
  await tx.channelConnection.update({
    where: { id: c.id },
    data: {
      enabled,
      health: enabled
        ? c.importUrlEncrypted
          ? "PENDING"
          : "EXPORT_ONLY"
        : "DISABLED",
      nextFetchAt: new Date(),
      leaseToken: null,
      leaseUntil: null,
    },
  });
  if (enabled)
    await publishExports(
      tx,
      ctx,
      listing,
      await loadPropertyBlocks(tx, ctx, listing.id),
      new Date(),
    );
  await audit(
    tx,
    ctx,
    enabled ? "ENABLE" : "DISABLE",
    "ChannelConnection",
    c.id,
    enabled
      ? "Connection enabled."
      : "Connection disabled: its export link stops answering. Dates it imported stay protected until you release them.",
  );
}

/** FETCH 03: manual refresh joins the scheduler's budgets and says why it waits. */
export async function requestRefresh(
  tx: Tx,
  ctx: Context,
  connectionId: string | null,
) {
  const connections = await tx.channelConnection.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      ...(connectionId ? { id: connectionId } : { enabled: true }),
    },
  });
  ensure(
    !connectionId || connections.length,
    404,
    "NOT_FOUND",
    "Calendar connection not found.",
  );
  const now = Date.now();
  const results = [];
  for (const c of connections) {
    const eligibility = manualRefreshEligibility(
      {
        enabled: c.enabled,
        importing: !!c.importUrlEncrypted,
        leaseUntil: c.leaseUntil?.toISOString() ?? null,
        lastAttemptAt: c.lastAttemptAt?.toISOString() ?? null,
        sourceRetryAfter: c.sourceRetryAfter?.toISOString() ?? null,
      },
      now,
    );
    if (eligibility.status === "QUEUED" && c.nextFetchAt.getTime() > now)
      await tx.channelConnection.update({
        where: { id: c.id },
        data: { nextFetchAt: new Date(now) },
      });
    results.push({ connectionId: c.id, ...eligibility });
  }
  return results;
}

// ---------------------------------------------------------------------------
// CLASS 02 classification policy
// ---------------------------------------------------------------------------
const SAMPLE_SIZE = 20;

export async function policySample(tx: Tx, ctx: Context, connectionId: string) {
  const c = await tx.channelConnection.findFirst({
    where: { workspaceId: ctx.workspaceId, id: connectionId },
  });
  ensure(c, 404, "NOT_FOUND", "Calendar connection not found.");
  const blocks = (await loadPropertyBlocks(tx, ctx, c.listingId)).filter(
    (b) => b.connectionId === c.id && isProtective(b),
  );
  const platform = c.platform as Platform;
  const labels = new Map<string, number>();
  for (const b of blocks)
    labels.set(
      b.sourceLabelKey ?? "none",
      (labels.get(b.sourceLabelKey ?? "none") ?? 0) + 1,
    );
  const sample = blocks.slice(0, SAMPLE_SIZE).map((b) => ({
    startDate: b.startDate,
    endDate: b.endDate,
    labelKey: b.sourceLabelKey ?? "none",
    identityUncertain:
      b.identityKind === "SURROGATE" || b.identityKind === "DUPLICATE_VARIANT",
  }));
  return {
    platform,
    policy: connectionPolicy(c),
    singleLabelForStaysAndClosures:
      capabilityOf(platform).singleLabelForStaysAndClosures,
    labels: [...labels].map(([key, count]) => ({
      key,
      count,
      suggested: labelRule(platform, key)?.suggests ?? null,
    })),
    sample,
    total: blocks.length,
    sampleDigest: digestOf(sample),
  };
}

export async function setClassificationPolicy(
  tx: Tx,
  ctx: Context,
  connectionId: string,
  input: {
    mode: ConnectionPolicy["mode"];
    labels: Record<string, HostClass> | null;
    expectedVersion: number;
    sampleDigest: string;
  },
) {
  const found = await tx.channelConnection.findFirst({
    where: { workspaceId: ctx.workspaceId, id: connectionId },
  });
  ensure(found, 404, "NOT_FOUND", "Calendar connection not found.");
  const listing = await lockedListing(tx, ctx, found.listingId);
  const c = await tx.channelConnection.findUniqueOrThrow({
    where: { id: connectionId },
  });
  ensure(
    c.policyVersion === input.expectedVersion,
    409,
    "POLICY_CHANGED",
    "This connection's policy changed. Review it again.",
  );
  const shown = await policySample(tx, ctx, connectionId);
  // The stored evidence is exactly what the host was shown (CLASS 02).
  ensure(
    shown.sampleDigest === input.sampleDigest,
    409,
    "SAMPLE_CHANGED",
    "The calendar changed while you were deciding. Review the updated events.",
  );
  ensure(
    input.mode !== "BY_LABEL" ||
      (input.labels && Object.keys(input.labels).length),
    400,
    "LABELS_REQUIRED",
    "Choose how each label should be treated.",
  );
  const policy: ConnectionPolicy = {
    mode: input.mode,
    labels: input.mode === "BY_LABEL" ? input.labels : null,
    version: c.policyVersion + 1,
  };
  const now = new Date();
  await tx.channelConnection.update({
    where: { id: c.id },
    data: {
      policyMode: policy.mode,
      policyLabels: policy.labels ?? Prisma.DbNull,
      policyVersion: policy.version,
      policyDecidedBy: input.mode === "UNSET" ? null : ctx.actorId,
      policyDecidedAt: input.mode === "UNSET" ? null : now,
      policyEvidenceEncrypted: seal(
        { sample: shown.sample, labels: shown.labels, total: shown.total },
        ctx.workspaceId,
      ),
    },
  });
  const blocks = await loadPropertyBlocks(tx, ctx, listing.id);
  const plan = reclassifyForPolicy({
    platform: c.platform as Platform,
    policy,
    blocks: blocks.filter((b) => b.connectionId === c.id),
    nextRevision: listing.calendarRevision + 1,
  });
  await commitCalendarChange(tx, ctx, {
    listing,
    mode: await calendarMode(tx, ctx),
    change: { creates: [], updates: plan.updates, decisions: plan.decisions },
    before: before(blocks),
    cause: { kind: "HOST", action: "CLASSIFICATION_POLICY" },
    now,
    auditReason: "Host set how this connection's events are classified.",
  });
  await audit(
    tx,
    ctx,
    "CLASSIFICATION_POLICY",
    "ChannelConnection",
    c.id,
    "Host answered the classification question for this connection; the evidence shown is recorded.",
    {
      mode: policy.mode,
      labels: policy.labels,
      version: policy.version,
      sampleSize: shown.sample.length,
      reclassified: plan.decisions.length,
    },
  );
  return { policy, reclassified: plan.decisions.length };
}

// ---------------------------------------------------------------------------
// MANUAL 01: holds and direct reservations
// ---------------------------------------------------------------------------
export function overlapPreview(
  blocks: BlockState[],
  range: { startDate: LocalDate; endDate: LocalDate },
  defaultBufferDays: number,
) {
  return blocks
    .filter((b) => isProtective(b))
    .flatMap((b) => {
      const buffer = bufferOf(b, defaultBufferDays);
      const nights = intersect(b, range);
      const buffered = intersect(
        {
          startDate: addDays(b.startDate, -buffer.before),
          endDate: addDays(b.endDate, buffer.after),
        },
        range,
      );
      return nights || buffered
        ? [
            {
              blockId: b.id,
              kind: nights ? "NIGHTS" : "BUFFER",
              classification: effectiveClass(b),
              startDate: b.startDate,
              endDate: b.endDate,
            },
          ]
        : [];
    });
}

function conflictError(preview: ReturnType<typeof overlapPreview>) {
  return new AppError(
    409,
    "DATE_CONFLICT",
    "These dates overlap protected dates or a buffer. Review the overlap before continuing.",
    { overlaps: preview },
  );
}

export async function createHold(
  tx: Tx,
  ctx: Context,
  input: {
    listingId: string;
    from: LocalDate;
    to: LocalDate;
    holdType: "OWNER" | "MAINTENANCE";
    reason: string;
    clientRequestId: string;
    acknowledgeOverlaps: boolean;
  },
) {
  const listing = await lockedListing(tx, ctx, input.listingId);
  const prior = await tx.availabilityBlock.findFirst({
    where: {
      workspaceId: ctx.workspaceId,
      clientRequestId: input.clientRequestId,
    },
  });
  if (prior) {
    ensure(
      prior.listingId === listing.id &&
        toLocalDate(prior.startDate) === input.from &&
        toLocalDate(prior.endDate) === input.to &&
        prior.holdType === input.holdType,
      409,
      "IDEMPOTENCY_CONFLICT",
      "This request was already used for a different hold.",
    );
    return prior;
  }
  const blocks = await loadPropertyBlocks(tx, ctx, listing.id);
  const preview = overlapPreview(
    blocks,
    { startDate: input.from, endDate: input.to },
    listing.bufferDays,
  );
  if (preview.length && !input.acknowledgeOverlaps)
    throw conflictError(preview);
  const now = new Date();
  const hold = manualHold({
    listingId: listing.id,
    startDate: input.from,
    endDate: input.to,
    holdType: input.holdType,
    now: now.toISOString(),
    nextRevision: listing.calendarRevision + 1,
    reservation: false,
  });
  const result = await commitCalendarChange(tx, ctx, {
    listing,
    mode: await calendarMode(tx, ctx),
    change: {
      creates: [hold],
      createExtras: [
        {
          reasonEncrypted: encrypt(input.reason, ctx.workspaceId),
          clientRequestId: input.clientRequestId,
          createdBy: ctx.actorId,
        },
      ],
      updates: [],
      decisions: [
        {
          type: "CREATE",
          key: "manual",
          blockId: null,
          reasons: ["BLOCK_CREATED"],
        },
      ],
    },
    before: new Map(),
    cause: { kind: "HOST", action: "CREATE_HOLD" },
    now,
    auditReason:
      "Host created a hold; every export link now includes these dates.",
  });
  return tx.availabilityBlock.findUniqueOrThrow({
    where: { id: result.created[0].id },
  });
}

export async function createDirectReservation(
  tx: Tx,
  ctx: Context,
  input: {
    listingId: string;
    from: LocalDate;
    to: LocalDate;
    guestName: string;
    guestContact: string;
    price: number | null;
    currency: string;
    clientRequestId: string;
    acknowledgeOverlaps: boolean;
  },
) {
  const listing = await lockedListing(tx, ctx, input.listingId);
  ensure(
    input.currency === listing.currency,
    400,
    "CURRENCY_MISMATCH",
    "Use the listing currency for this reservation.",
  );
  const prior = await tx.reservation.findFirst({
    where: {
      workspaceId: ctx.workspaceId,
      clientRequestId: input.clientRequestId,
    },
  });
  if (prior) {
    ensure(
      prior.listingId === listing.id &&
        toLocalDate(prior.startDate) === input.from &&
        toLocalDate(prior.endDate) === input.to &&
        decrypt(prior.guestNameEncrypted, ctx.workspaceId) ===
          input.guestName &&
        decrypt(prior.guestContactEncrypted, ctx.workspaceId) ===
          input.guestContact &&
        (prior.price === null ? null : Number(prior.price)) === input.price,
      409,
      "IDEMPOTENCY_CONFLICT",
      "This request key was already used for different reservation details.",
    );
    return prior;
  }
  const blocks = await loadPropertyBlocks(tx, ctx, listing.id);
  const preview = overlapPreview(
    blocks,
    { startDate: input.from, endDate: input.to },
    listing.bufferDays,
  );
  if (preview.length && !input.acknowledgeOverlaps)
    throw conflictError(preview);
  const now = new Date();
  const mode = await calendarMode(tx, ctx);
  const result = await commitCalendarChange(tx, ctx, {
    listing,
    mode,
    change: {
      creates: [
        manualHold({
          listingId: listing.id,
          startDate: input.from,
          endDate: input.to,
          holdType: "DIRECT_RESERVATION",
          now: now.toISOString(),
          nextRevision: listing.calendarRevision + 1,
          reservation: true,
        }),
      ],
      createExtras: [{ createdBy: ctx.actorId }],
      updates: [],
      decisions: [
        {
          type: "CREATE",
          key: "direct",
          blockId: null,
          reasons: ["BLOCK_CREATED"],
        },
      ],
    },
    before: new Map(),
    cause: { kind: "HOST", action: "CREATE_RESERVATION" },
    now,
    auditReason:
      "Host confirmed a direct reservation. Guest information is encrypted; all export links include its dates.",
  });
  const block = result.created[0];
  const reservation = await tx.reservation.create({
    data: {
      id: randomUUID(),
      workspaceId: ctx.workspaceId,
      listingId: listing.id,
      blockId: block.id,
      source: "DIRECT",
      platform: "DIRECT",
      status: "CONFIRMED",
      startDate: fromLocalDate(input.from),
      endDate: fromLocalDate(input.to),
      guestNameEncrypted: encrypt(input.guestName, ctx.workspaceId),
      guestContactEncrypted: encrypt(input.guestContact, ctx.workspaceId),
      guestHash: input.guestContact ? blind(input.guestContact) : null,
      price: input.price,
      currency: listing.currency,
      firstObservedAt: now,
      clientRequestId: input.clientRequestId,
    },
  });
  const thread = await tx.thread.create({
    data: {
      workspaceId: ctx.workspaceId,
      listingId: listing.id,
      reservationId: reservation.id,
      platform: "DIRECT",
      externalId: reservation.id,
      status: "RESOLVED",
    },
  });
  if (mode === "LIVE")
    await applyTurnover(tx, ctx, listing, reservation, block, now);
  await event(
    tx,
    ctx,
    "RESERVATION_CONFIRMED",
    reservation.id,
    "direct:" + reservation.id,
    { listingId: listing.id },
  );
  return { reservation, threadId: thread.id };
}

// ---------------------------------------------------------------------------
// LIFE 03 and MANUAL 02: decisions on protected dates
// ---------------------------------------------------------------------------
/** What a release changes, shown before the host confirms (LIFE 03). */
export async function releasePreview(tx: Tx, ctx: Context, blockId: string) {
  const b = await tx.availabilityBlock.findFirst({
    where: { workspaceId: ctx.workspaceId, id: blockId },
  });
  ensure(b, 404, "NOT_FOUND", "These dates were not found.");
  const listing = await tx.listing.findUniqueOrThrow({
    where: { id: b.listingId },
  });
  const state = blockState(b);
  const buffer = bufferOf(state, listing.bufferDays);
  const connections = await tx.channelConnection.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      listingId: listing.id,
      enabled: true,
    },
    select: { id: true, platform: true, label: true, importUrlEncrypted: true },
  });
  const conflicts = await tx.conflictCase.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      state: "OPEN",
      OR: [{ blockAId: b.id }, { blockBId: b.id }],
    },
    select: {
      id: true,
      kind: true,
      severity: true,
      overlapStart: true,
      overlapEnd: true,
    },
  });
  const reservation = await tx.reservation.findFirst({
    where: { workspaceId: ctx.workspaceId, blockId: b.id },
  });
  const tasks = reservation
    ? await tx.cleaningTask.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          reservationId: reservation.id,
          status: { notIn: ["CANCELLED", "SUPERSEDED"] },
        },
        select: { id: true, status: true, cleanerId: true },
      })
    : [];
  return {
    blockId: b.id,
    revision: b.revision,
    nights: { startDate: state.startDate, endDate: state.endDate },
    buffers: { before: buffer.before, after: buffer.after },
    channels: connections.map((c) => ({
      connectionId: c.id,
      platform: c.platform,
      label: c.label,
      isSource: c.id === b.connectionId,
    })),
    conflicts: conflicts.map((c) => ({
      ...c,
      overlapStart: toLocalDate(c.overlapStart),
      overlapEnd: toLocalDate(c.overlapEnd),
    })),
    turnover: tasks,
    limits: [
      "Releasing reopens these nights in every export link after each platform refreshes; it does not cancel or change a booking on any platform.",
      "Undo is available for 24 hours as a new hold. It cannot recall a platform refresh or undo a booking made in the meantime.",
      ...(b.connectionId
        ? [
            "The source calendar may still show these dates; if it does, they will be protected again and flagged.",
          ]
        : []),
    ],
  };
}

async function decide(
  tx: Tx,
  ctx: Context,
  blockId: string,
  action: string,
  auditReason: string,
  transition: (b: BlockState, nextRevision: number, now: Date) => BlockState,
  extras: (now: Date) => Record<string, unknown> = () => ({}),
) {
  const { listing, blocks, block } = await lockedBlock(tx, ctx, blockId);
  const now = new Date();
  const next = transition(block, listing.calendarRevision + 1, now);
  await commitCalendarChange(tx, ctx, {
    listing,
    mode: await calendarMode(tx, ctx),
    change: {
      creates: [],
      updates: [next],
      updateExtras: new Map([[next.id, extras(now)]]),
      decisions: [
        {
          type: "UPDATE",
          key: block.sourceKey ?? "manual",
          blockId: block.id,
          reasons: [],
        },
      ],
    },
    before: before(blocks),
    cause: { kind: "HOST", action },
    now,
    auditReason,
  });
  return tx.availabilityBlock.findUniqueOrThrow({ where: { id: blockId } });
}

export function releaseDates(
  tx: Tx,
  ctx: Context,
  blockId: string,
  input: {
    expectedRevision: number;
    reason: string;
    externalResolutionConfirmed: boolean;
  },
) {
  return decide(
    tx,
    ctx,
    blockId,
    "RELEASE",
    "Host released protected dates after review. Export links reopen them after each platform refreshes.",
    (b, nextRevision, now) => {
      const cls = effectiveClass(b);
      if (b.connectionId && (cls === "RESERVATION" || cls === "UNKNOWN"))
        ensure(
          input.externalResolutionConfirmed,
          400,
          "CONFIRM_REQUIRED",
          "Confirm that you checked the stay on its platform before reopening these dates.",
        );
      return unwrap(
        releaseBlock(b, {
          expectedRevision: input.expectedRevision,
          now: now.toISOString(),
          nextRevision,
        }),
      );
    },
    () => ({
      releasedBy: ctx.actorId,
      releaseReasonEncrypted: encrypt(input.reason, ctx.workspaceId),
    }),
  );
}

export function keepDatesBlocked(
  tx: Tx,
  ctx: Context,
  blockId: string,
  input: { expectedRevision: number; reason: string },
) {
  return decide(
    tx,
    ctx,
    blockId,
    "KEEP_BLOCKED",
    "Host chose to keep these dates blocked; the same question will not be asked again.",
    (b, nextRevision) =>
      unwrap(
        keepBlocked(b, {
          expectedRevision: input.expectedRevision,
          nextRevision,
        }),
      ),
  );
}

export async function restoreDates(
  tx: Tx,
  ctx: Context,
  blockId: string,
  input: { expectedRevision: number; reason: string },
) {
  const { listing, blocks, block } = await lockedBlock(tx, ctx, blockId);
  const now = new Date();
  const restored = restoreBlock(block, {
    expectedRevision: input.expectedRevision,
    now: now.toISOString(),
    nextRevision: listing.calendarRevision + 1,
  });
  if (!restored.ok) unwrap(restored);
  const result = await commitCalendarChange(tx, ctx, {
    listing,
    mode: await calendarMode(tx, ctx),
    change: {
      creates: [(restored as Extract<typeof restored, { ok: true }>).hold],
      createExtras: [
        {
          reasonEncrypted: encrypt(input.reason, ctx.workspaceId),
          createdBy: ctx.actorId,
        },
      ],
      updates: [],
      decisions: [
        {
          type: "CREATE",
          key: "restore",
          blockId: null,
          reasons: ["BLOCK_CREATED"],
        },
      ],
    },
    before: before(blocks),
    cause: { kind: "HOST", action: "RESTORE" },
    now,
    auditReason:
      "Host restored released dates with a compensating hold; platforms that already refreshed may have reopened them.",
  });
  return tx.availabilityBlock.findUniqueOrThrow({
    where: { id: result.created[0].id },
  });
}

export function classifyDates(
  tx: Tx,
  ctx: Context,
  blockId: string,
  input: {
    expectedRevision: number;
    classification: HostClass | null;
    reason: string;
  },
) {
  return decide(
    tx,
    ctx,
    blockId,
    "CLASSIFY",
    input.classification
      ? `Host classified imported dates as ${input.classification.toLowerCase().replace("_", " ")}; the imported facts are unchanged.`
      : "Host removed their classification; the connection's evidence applies again.",
    (b, nextRevision) =>
      unwrap(
        classifyBlock(b, {
          expectedRevision: input.expectedRevision,
          classification: input.classification,
          nextRevision,
        }),
      ),
    (now) => ({
      overrideBy: input.classification ? ctx.actorId : null,
      overrideAt: input.classification ? now : null,
    }),
  );
}

export function setBufferOverride(
  tx: Tx,
  ctx: Context,
  blockId: string,
  input: {
    expectedRevision: number;
    before: number | null;
    after: number | null;
    reason: string;
  },
) {
  return decide(
    tx,
    ctx,
    blockId,
    "BUFFER_OVERRIDE",
    "Host changed the buffer around these dates.",
    (b, nextRevision) =>
      unwrap(
        overrideBuffers(b, {
          expectedRevision: input.expectedRevision,
          before: input.before,
          after: input.after,
          nextRevision,
        }),
      ),
    (now) => ({ overrideBy: ctx.actorId, overrideAt: now }),
  );
}

export function acknowledgeReview(
  tx: Tx,
  ctx: Context,
  blockId: string,
  input: { expectedRevision: number; flags: ReviewFlag[] },
) {
  return decide(
    tx,
    ctx,
    blockId,
    "ACKNOWLEDGE",
    "Host reviewed and acknowledged flagged calendar evidence.",
    (b, nextRevision) =>
      unwrap(
        acknowledgeFlags(b, {
          expectedRevision: input.expectedRevision,
          flags: input.flags,
          nextRevision,
        }),
      ),
  );
}

// ---------------------------------------------------------------------------
// CONFLICT 01: the host records a resolution (the triage view is Phase 4)
// ---------------------------------------------------------------------------
export async function recordConflictResolution(
  tx: Tx,
  ctx: Context,
  caseId: string,
  input: { expectedRevision: number; note: string },
) {
  const c = await tx.conflictCase.findFirst({
    where: { workspaceId: ctx.workspaceId, id: caseId },
  });
  ensure(c, 404, "NOT_FOUND", "Conflict not found.");
  await lock(tx, "listing:" + c.listingId);
  const written = await tx.conflictCase.updateMany({
    where: { id: c.id, state: "OPEN", revision: input.expectedRevision },
    data: {
      state: "RESOLVED",
      resolution: "HOST_RECORDED",
      resolutionNoteEncrypted: encrypt(input.note, ctx.workspaceId),
      resolvedBy: ctx.actorId,
      resolvedAt: new Date(),
      revision: { increment: 1 },
    },
  });
  ensure(
    written.count === 1,
    409,
    "CONFLICT_CHANGED",
    "This overlap changed or was already resolved. Review it again.",
  );
  await event(
    tx,
    ctx,
    "CONFLICT_RESOLVED",
    c.id,
    `conflict:${c.id}:${c.revision + 1}`,
    { resolution: "HOST_RECORDED" },
  );
  await audit(
    tx,
    ctx,
    "RESOLVE",
    "ConflictCase",
    c.id,
    "Host recorded how an overlap was handled. Choosing which stay to keep does not cancel the other stay on its platform.",
    { note: input.note },
  );
}

// ---------------------------------------------------------------------------
// REL 01: switching a workspace from shadow to live effects
// ---------------------------------------------------------------------------
/** Bring turnover work in line with every current reservation after going live. */
/**
 * Bring one property's turnover work in line with its current reservations
 * (idempotent: the planner only acts on differences). Used when a workspace
 * goes live, since shadow mode records reservations without turnover work.
 */
export async function reconcileListingTurnovers(
  tx: Tx,
  ctx: Context,
  listingId: string,
  now = new Date(),
) {
  await lock(tx, "listing:" + listingId);
  const listing = await tx.listing.findFirst({
    where: { workspaceId: ctx.workspaceId, id: listingId, archivedAt: null },
  });
  if (!listing) return 0;
  const blocks = new Map(
    (await loadPropertyBlocks(tx, ctx, listing.id)).map((b) => [b.id, b]),
  );
  const rows = await tx.reservation.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      listingId: listing.id,
      endDate: {
        gte: fromLocalDate(todayIn(listing.timezone, now.getTime())),
      },
    },
  });
  let reservations = 0;
  for (const r of rows) {
    const block = r.blockId ? blocks.get(r.blockId) : undefined;
    if (!block) continue;
    await applyTurnover(tx, ctx, listing, r, block, now);
    reservations++;
  }
  return reservations;
}

export async function reconcileTurnovers(tx: Tx, ctx: Context) {
  const listings = await tx.listing.findMany({
    where: { workspaceId: ctx.workspaceId, archivedAt: null },
    select: { id: true },
  });
  let reservations = 0;
  for (const l of listings)
    reservations += await reconcileListingTurnovers(tx, ctx, l.id);
  return { reservations };
}
