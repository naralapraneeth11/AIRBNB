import { type Context, type Tx } from "../db";
import { audit } from "../audit";
import { dateOnly, dayAdd } from "@/lib/domain";
export async function insights(tx: Tx, ctx: Context, from: Date, to: Date) {
  const listings = await tx.listing.findMany({
    where: { workspaceId: ctx.workspaceId, archivedAt: null },
  });
  const bookings = await tx.booking.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      kind: "RESERVATION",
      status: "CONFIRMED",
      startDate: { lt: to },
      endDate: { gt: from },
    },
  });
  const days = Math.ceil((to.getTime() - from.getTime()) / 86400000);
  const rows = listings.map((l) => {
    const bs = bookings.filter((b) => b.listingId === l.id);
    const nights = new Set<string>();
    let revenue = 0,
      pricedStays = 0;
    for (const b of bs) {
      const start = b.startDate > from ? b.startDate : from,
        end = b.endDate < to ? b.endDate : to;
      for (let d = start; d < end; d = dayAdd(d, 1)) nights.add(dateOnly(d));
      if (b.price !== null) {
        revenue +=
          Number(b.price) *
          ((end.getTime() - start.getTime()) /
            (b.endDate.getTime() - b.startDate.getTime()));
        pricedStays++;
      }
    }
    return {
      listingId: l.id,
      name: l.name,
      color: l.color,
      currency: l.currency,
      occupancy: days ? Math.round((nights.size / days) * 100) : 0,
      revenue: Math.round(revenue * 100) / 100,
      pricedStays,
      totalStays: bs.length,
      nights: [...nights],
    };
  });
  const runs = await tx.syncRun.findMany({
    where: { workspaceId: ctx.workspaceId, createdAt: { gte: from, lt: to } },
    orderBy: { createdAt: "desc" },
    take: 20000,
  });
  const sources = await tx.syncSource.findMany({
    where: { workspaceId: ctx.workspaceId },
  });
  const platforms = [...new Set(sources.map((s) => s.platform))].map(
    (platform) => {
      const ids = sources
          .filter((s) => s.platform === platform)
          .map((s) => s.id),
        rr = runs.filter((r) => ids.includes(r.sourceId));
      return {
        platform,
        checks: rr.length,
        uptime: rr.length
          ? Math.round(
              (rr.filter((r) => r.success).length / rr.length) * 1000,
            ) / 10
          : null,
      };
    },
  );
  const messages = await tx.message.findMany({
    where: { workspaceId: ctx.workspaceId, sentAt: { gte: from, lt: to } },
    select: {
      id: true,
      replyToId: true,
      sentAt: true,
      createdAt: true,
      sender: true,
    },
  });
  const replies = messages.filter(
    (m) => m.sender !== "GUEST" && m.replyToId && m.sentAt,
  );
  const incoming = await tx.message.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      id: { in: replies.map((m) => m.replyToId!) },
    },
    select: { id: true, createdAt: true },
  });
  const delays = replies.flatMap((m) => {
    const source = incoming.find((i) => i.id === m.replyToId);
    return source
      ? [Math.max(0, m.sentAt!.getTime() - source.createdAt.getTime()) / 1000]
      : [];
  });
  const tasks = await tx.cleaningTask.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      status: "VERIFIED",
      verifiedAt: { gte: from, lt: to },
    },
    select: { scheduledAt: true, verifiedAt: true, cleanerId: true },
  });
  await audit(
    tx,
    ctx,
    "READ",
    "Insights",
    null,
    "Aggregated actual reservation, response, sync, and cleaning metrics. Prices unavailable from iCal remain unknown.",
  );
  return {
    from: dateOnly(from),
    to: dateOnly(to),
    listings: rows,
    sync: platforms,
    responseSeconds: delays.length
      ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length)
      : null,
    responseSamples: delays.length,
    cleaningHours: tasks.length
      ? Math.round(
          (tasks.reduce(
            (sum, t) =>
              sum +
              Math.max(0, t.verifiedAt!.getTime() - t.scheduledAt.getTime()) /
                3600000,
            0,
          ) /
            tasks.length) *
            10,
        ) / 10
      : null,
    cleaningSamples: tasks.length,
    syncSampleCapped: runs.length === 20000,
  };
}
