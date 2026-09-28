import { type Context, type Tx } from "../db";
import { audit } from "../audit";
import { dateOnly, dayAdd } from "@/lib/domain";
export async function insights(tx: Tx, ctx: Context, from: Date, to: Date) {
  const listings = await tx.listing.findMany({
    where: { workspaceId: ctx.workspaceId, archivedAt: null },
  });
  // Only reservations count as stays; owner blocks and unknown events do not.
  const bookings = await tx.reservation.findMany({
    where: {
      workspaceId: ctx.workspaceId,
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
  // Every scheduled or manual check records an observation (CAL 05); a check
  // succeeded when it produced a usable, accepted result.
  const connections = await tx.channelConnection.findMany({
    where: { workspaceId: ctx.workspaceId },
    select: { id: true, platform: true },
  });
  const observed = await tx.feedObservation.groupBy({
    by: ["connectionId", "accepted"],
    where: { workspaceId: ctx.workspaceId, observedAt: { gte: from, lt: to } },
    _count: { _all: true },
  });
  const platforms = [...new Set(connections.map((c) => c.platform))].map(
    (platform) => {
      const ids = new Set(
        connections.filter((c) => c.platform === platform).map((c) => c.id),
      );
      const rows = observed.filter((o) => ids.has(o.connectionId));
      const checks = rows.reduce((n, o) => n + o._count._all, 0);
      const accepted = rows
        .filter((o) => o.accepted)
        .reduce((n, o) => n + o._count._all, 0);
      return {
        platform,
        checks,
        uptime: checks ? Math.round((accepted / checks) * 1000) / 10 : null,
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
    "Aggregated actual reservation, response, calendar check, and cleaning metrics. Prices unavailable from iCal remain unknown.",
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
  };
}
