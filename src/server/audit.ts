import type { Context, Tx } from "./db";
import { seal } from "./crypto";
export async function audit(
  tx: Tx,
  ctx: Context,
  action: string,
  entity: string,
  entityId: string | null,
  reason: string,
  detail?: unknown,
) {
  return tx.auditLog.create({
    data: {
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action,
      entity,
      entityId,
      reason,
      requestId: ctx.requestId,
      detailEncrypted:
        detail === undefined ? undefined : seal(detail, ctx.workspaceId),
    },
  });
}
export async function event(
  tx: Tx,
  ctx: Context,
  type: string,
  entityId: string,
  key: string,
  payload: Record<string, string | number | boolean | null> = {},
) {
  await tx.domainEvent.createMany({
    data: [{ workspaceId: ctx.workspaceId, type, entityId, key, payload }],
    skipDuplicates: true,
  });
  return tx.domainEvent.findUniqueOrThrow({
    where: { workspaceId_key: { workspaceId: ctx.workspaceId, key } },
  });
}
export async function enqueue(
  tx: Tx,
  ctx: Context,
  kind: string,
  entityId: string,
  key: string,
  payload: unknown,
  category: string,
  automated = true,
) {
  return tx.outbox.upsert({
    where: { workspaceId_key: { workspaceId: ctx.workspaceId, key } },
    create: {
      workspaceId: ctx.workspaceId,
      kind,
      entityId,
      key,
      payloadEncrypted: seal(payload, ctx.workspaceId),
      category,
      automated,
    },
    update: {},
  });
}
export async function notify(
  tx: Tx,
  ctx: Context,
  key: string,
  title: string,
  body: string,
  href: string,
) {
  const n = await tx.notification.upsert({
    where: { workspaceId_key: { workspaceId: ctx.workspaceId, key } },
    create: { workspaceId: ctx.workspaceId, key, title, body, href },
    update: {},
  });
  await enqueue(
    tx,
    ctx,
    "PUSH",
    n.id,
    `push:${key}`,
    { title, body, href },
    "NOTIFICATION",
    false,
  );
  return n;
}
