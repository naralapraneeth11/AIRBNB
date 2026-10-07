// Guided setup (AUTH 04 and the onboarding sequence in section 6): property,
// calendar, export link, optional cleaner, and an automation rehearsal.
// Progress is saved after every step, the host returns to the unfinished
// step, and optional steps can be skipped and resumed. "Setup complete"
// never claims that a platform has refreshed anything.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { daysBetween, todayIn } from "@/domain/calendar/dates";
import { audit } from "../audit";
import { connectionDTO } from "../calendar/dto";
import { tenant, type Context, type Tx } from "../db";
import { ensure } from "../errors";
import { body, json } from "../http";
import * as V from "../validation";

export const SETUP_STEPS = [
  "PROPERTY",
  "CALENDAR",
  "EXPORT",
  "CLEANER",
  "REHEARSAL",
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
const OPTIONAL = ["CALENDAR", "EXPORT", "CLEANER"] as const;

type Progress = {
  step: SetupStep | "DONE";
  completed: SetupStep[];
  skipped: SetupStep[];
  listingId: string | null;
  connectionId: string | null;
  exportConfirmedAt: Date | null;
  completedAt: Date | null;
};

const fresh = (): Progress => ({
  step: "PROPERTY",
  completed: [],
  skipped: [],
  listingId: null,
  connectionId: null,
  exportConfirmedAt: null,
  completedAt: null,
});

/** The first step neither completed nor skipped; the rehearsal comes last. */
export function nextStep(p: Pick<Progress, "completed" | "skipped">) {
  return (
    SETUP_STEPS.find(
      (s) => !p.completed.includes(s) && !p.skipped.includes(s),
    ) ?? "DONE"
  );
}

/** Start setup for a workspace created by sign-up (tenant scope already set). */
export async function beginSetup(tx: Tx, workspaceId: string) {
  await tx.onboardingProgress.create({ data: { workspaceId } });
}

async function load(tx: Tx, ctx: Context) {
  const row = await tx.onboardingProgress.findUnique({
    where: { workspaceId: ctx.workspaceId },
  });
  const progress: Progress = row
    ? {
        step: row.step as Progress["step"],
        completed: row.completed as SetupStep[],
        skipped: row.skipped as SetupStep[],
        listingId: row.listingId,
        connectionId: row.connectionId,
        exportConfirmedAt: row.exportConfirmedAt,
        completedAt: row.completedAt,
      }
    : fresh();
  // The property chosen during setup was removed from the app: setup picks
  // up again from choosing a property, as if none had been chosen.
  if (progress.listingId && progress.step !== "DONE") {
    const listing = await tx.listing.findFirst({
      where: { workspaceId: ctx.workspaceId, id: progress.listingId },
      select: { archivedAt: true },
    });
    if (listing?.archivedAt) {
      const reopened: SetupStep[] = ["PROPERTY", "CALENDAR", "EXPORT"];
      progress.listingId = null;
      progress.connectionId = null;
      progress.exportConfirmedAt = null;
      progress.completed = progress.completed.filter(
        (s) => !reopened.includes(s),
      );
      progress.skipped = progress.skipped.filter((s) => !reopened.includes(s));
      progress.step = nextStep(progress);
    }
  }
  return { exists: !!row, progress };
}

/** What the calendar check showed, in counts only (onboarding sequence). */
async function calendarEvidence(tx: Tx, ctx: Context, connectionId: string) {
  const c = await tx.channelConnection.findFirst({
    where: { workspaceId: ctx.workspaceId, id: connectionId },
  });
  if (!c) return null;
  const blocks = await tx.availabilityBlock.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      connectionId,
      lifecycle: { not: "RELEASED" },
    },
    select: {
      startDate: true,
      endDate: true,
      classification: true,
      overrideClassification: true,
    },
  });
  const cls = (b: (typeof blocks)[number]) =>
    b.overrideClassification ?? b.classification;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    connection: connectionDTO(c, Date.now()),
    dateRanges: blocks.length,
    reservations: blocks.filter((b) => cls(b) === "RESERVATION").length,
    unclassified: blocks.filter((b) => cls(b) === "UNKNOWN").length,
    protectedNights: blocks.reduce(
      (n, b) => n + daysBetween(iso(b.startDate), iso(b.endDate)),
      0,
    ),
  };
}

/** The first actions the workspace would take (onboarding: rehearsal). */
async function rehearsal(tx: Tx, ctx: Context, listingId: string | null) {
  const [workspace, settings, listing] = await Promise.all([
    tx.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId } }),
    tx.automationSettings.findFirst({
      where: { workspaceId: ctx.workspaceId },
    }),
    listingId
      ? tx.listing.findFirst({
          where: { workspaceId: ctx.workspaceId, id: listingId },
        })
      : null,
  ]);
  const today = todayIn(listing?.timezone ?? "UTC", Date.now());
  const upcoming = listing
    ? await tx.availabilityBlock.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          listingId: listing.id,
          lifecycle: { not: "RELEASED" },
          endDate: { gte: new Date(today) },
        },
        orderBy: { endDate: "asc" },
        take: 50,
        select: {
          endDate: true,
          classification: true,
          overrideClassification: true,
        },
      })
    : [];
  const reservations = upcoming.filter(
    (b) => (b.overrideClassification ?? b.classification) === "RESERVATION",
  );
  return {
    calendarMode: workspace.calendarMode,
    automationPaused: settings?.paused ?? true,
    turnovers: reservations
      .slice(0, 3)
      .map((b) => b.endDate.toISOString().slice(0, 10)),
    turnoverCount: reservations.length,
    unclassified: upcoming.filter(
      (b) => (b.overrideClassification ?? b.classification) === "UNKNOWN",
    ).length,
  };
}

async function state(tx: Tx, ctx: Context) {
  const { exists, progress } = await load(tx, ctx);
  return {
    exists,
    ...progress,
    calendar: progress.connectionId
      ? await calendarEvidence(tx, ctx, progress.connectionId)
      : null,
    rehearsal: await rehearsal(tx, ctx, progress.listingId),
  };
}

export async function onboardingRoutes(
  request: NextRequest,
  path: string[],
  method: string,
  ctx: Context,
): Promise<Response | null> {
  if (path[0] !== "onboarding") return null;
  if (method === "GET") return json(await tenant(ctx, (tx) => state(tx, ctx)));
  ensure(method === "POST", 405, "METHOD", "Use GET or POST.");
  const Step = z.enum(SETUP_STEPS);
  const input = z
    .discriminatedUnion("action", [
      z.object({
        action: z.literal("save"),
        listingId: V.id.optional(),
        connectionId: V.id.optional(),
      }),
      z.object({
        action: z.literal("complete"),
        step: Step,
        listingId: V.id.optional(),
        connectionId: V.id.optional(),
        exportConfirmed: z.literal(true).optional(),
      }),
      z.object({ action: z.literal("skip"), step: z.enum(OPTIONAL) }),
      z.object({ action: z.literal("goto"), step: Step }),
    ])
    .parse(await body(request));
  return json(
    await tenant(ctx, async (tx) => {
      const { progress: p } = await load(tx, ctx);
      const listingId =
        ("listingId" in input && input.listingId) || p.listingId;
      const connectionId =
        ("connectionId" in input && input.connectionId) || p.connectionId;
      if (listingId && listingId !== p.listingId)
        ensure(
          await tx.listing.findFirst({
            where: {
              workspaceId: ctx.workspaceId,
              id: listingId,
              archivedAt: null,
            },
          }),
          404,
          "NOT_FOUND",
          "That property was not found.",
        );
      if (connectionId && connectionId !== p.connectionId)
        ensure(
          await tx.channelConnection.findFirst({
            where: {
              workspaceId: ctx.workspaceId,
              id: connectionId,
              ...(listingId ? { listingId } : {}),
            },
          }),
          404,
          "NOT_FOUND",
          "That calendar connection was not found for this property.",
        );
      const next: Progress = { ...p, listingId, connectionId };
      const mark = (list: SetupStep[], s: SetupStep) =>
        list.includes(s) ? list : [...list, s];
      const unmark = (list: SetupStep[], s: SetupStep) =>
        list.filter((x) => x !== s);

      if (input.action === "complete") {
        const s = input.step;
        if (s === "PROPERTY")
          ensure(listingId, 400, "PROPERTY_REQUIRED", "Add a property first.");
        if (s === "CALENDAR" || s === "EXPORT")
          ensure(
            connectionId,
            400,
            "CALENDAR_REQUIRED",
            "Connect a calendar first, or skip this step.",
          );
        if (s === "EXPORT") {
          ensure(
            input.exportConfirmed,
            400,
            "CONFIRMATION_REQUIRED",
            "Confirm that you added the link, or skip this step for now.",
          );
          next.exportConfirmedAt = new Date();
          await audit(
            tx,
            ctx,
            "EXPORT_LINK_CONFIRMED",
            "ChannelConnection",
            connectionId!,
            "The host said they added the export link to the platform. This is their statement, not an observed retrieval.",
          );
        }
        if (s === "REHEARSAL")
          ensure(
            next.completed.includes("PROPERTY"),
            400,
            "PROPERTY_REQUIRED",
            "Add a property first.",
          );
        next.completed = mark(next.completed, s);
        next.skipped = unmark(next.skipped, s);
      } else if (input.action === "skip") {
        next.skipped = mark(next.skipped, input.step);
        next.completed = unmark(next.completed, input.step);
        // Without a calendar there is no destination link to add yet.
        if (input.step === "CALENDAR" && !next.completed.includes("EXPORT"))
          next.skipped = mark(next.skipped, "EXPORT");
      }

      if (input.action === "goto") {
        ensure(
          input.step === nextStep(next) ||
            next.completed.includes(input.step) ||
            next.skipped.includes(input.step),
          400,
          "STEP_LOCKED",
          "Finish the earlier steps first.",
        );
        next.step = input.step;
      } else if (input.action !== "save") {
        next.step = nextStep(next);
      }
      if (next.step === "DONE" && !next.completedAt) {
        next.completedAt = new Date();
        await audit(
          tx,
          ctx,
          "SETUP_COMPLETED",
          "Workspace",
          ctx.workspaceId,
          "Guided setup finished. Automation stays paused until the owner enables selected categories.",
        );
      }
      const data = {
        step: next.step,
        completed: next.completed,
        skipped: next.skipped,
        listingId: next.listingId,
        connectionId: next.connectionId,
        exportConfirmedAt: next.exportConfirmedAt,
        completedAt: next.step === "DONE" ? next.completedAt : null,
      };
      await tx.onboardingProgress.upsert({
        where: { workspaceId: ctx.workspaceId },
        create: { workspaceId: ctx.workspaceId, ...data },
        update: data,
      });
      return state(tx, ctx);
    }),
  );
}
