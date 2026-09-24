import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { required } from "../config";
import { ensure } from "../errors";
import { tenant, type Context } from "../db";
import { audit } from "../audit";
function url(key: string) {
  return `${required("SUPABASE_URL").replace(/\/$/, "")}/storage/v1/object/${encodeURIComponent(process.env.STORAGE_BUCKET || "airbnb-private")}/${key.split("/").map(encodeURIComponent).join("/")}`;
}
function headers() {
  return {
    Authorization: `Bearer ${required("SUPABASE_SERVICE_ROLE_KEY")}`,
    apikey: required("SUPABASE_SERVICE_ROLE_KEY"),
  };
}
export async function uploadPhoto(
  ctx: Context,
  file: File,
  taskId?: string,
  listingId?: string,
) {
  ensure(
    file.size > 0 && file.size <= 4 * 1024 * 1024,
    413,
    "PHOTO_SIZE",
    "Choose an image smaller than 4 MB.",
  );
  ensure(
    ["image/jpeg", "image/png", "image/webp"].includes(file.type),
    415,
    "PHOTO_TYPE",
    "Choose a JPEG, PNG, or WebP image.",
  );
  if (ctx.role === "CLEANER")
    ensure(
      taskId === ctx.taskId && !listingId,
      403,
      "PHOTO_SCOPE",
      "You can upload only for your assigned job.",
    );
  await tenant(ctx, async (tx) => {
    if (taskId) {
      const t = await tx.cleaningTask.findFirst({
        where: {
          id: taskId,
          workspaceId: ctx.workspaceId,
          ...(ctx.role === "CLEANER" ? { cleanerId: ctx.cleanerId } : {}),
        },
      });
      ensure(
        t && ["IN_PROGRESS", "DONE"].includes(t.status),
        409,
        "PHOTO_STATE",
        "Start the task before uploading verification photos.",
      );
    } else
      ensure(
        listingId &&
          (await tx.listing.findFirst({
            where: { id: listingId, workspaceId: ctx.workspaceId },
          })),
        404,
        "NOT_FOUND",
        "Listing not found.",
      );
  });
  const bytes = await sharp(Buffer.from(await file.arrayBuffer()), {
    limitInputPixels: 24_000_000,
  })
    .rotate()
    .resize({
      width: 1920,
      height: 1920,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 84 })
    .toBuffer();
  const key = `${ctx.workspaceId}/${randomUUID()}.webp`;
  const response = await fetch(url(key), {
    method: "POST",
    headers: {
      ...headers(),
      "Content-Type": "image/webp",
      "x-upsert": "false",
    },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(15000),
  });
  ensure(
    response.ok,
    502,
    "STORAGE_FAILED",
    "Photo storage is unavailable. Nothing was marked verified.",
  );
  try {
    return await tenant(ctx, async (tx) => {
      if (taskId) {
        const t = await tx.cleaningTask.findUniqueOrThrow({
          where: { id: taskId },
        });
        ensure(
          ["IN_PROGRESS", "DONE"].includes(t.status) &&
            (!ctx.cleanerId || ctx.cleanerId === t.cleanerId),
          409,
          "PHOTO_STATE",
          "Task changed while the photo was uploading.",
        );
      }
      const asset = await tx.asset.create({
        data: {
          workspaceId: ctx.workspaceId,
          taskId,
          listingId,
          storageKey: key,
          mime: "image/webp",
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      });
      if (taskId)
        await tx.cleaningTask.update({
          where: { id: taskId },
          data: { photoId: asset.id, version: { increment: 1 } },
        });
      if (listingId)
        await tx.listing.update({
          where: { id: listingId },
          data: { photoIds: { push: asset.id }, version: { increment: 1 } },
        });
      await audit(
        tx,
        ctx,
        "UPLOAD",
        "Asset",
        asset.id,
        "Image validated, metadata removed, and stored in a private bucket.",
      );
      return { id: asset.id };
    });
  } catch (error) {
    await fetch(url(key), {
      method: "DELETE",
      headers: headers(),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
    throw error;
  }
}
export async function readPhoto(ctx: Context, id: string) {
  const asset = await tenant(ctx, async (tx) => {
    const a = await tx.asset.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
    });
    ensure(a, 404, "NOT_FOUND", "Photo not found.");
    if (ctx.role === "CLEANER")
      ensure(
        a.taskId === ctx.taskId,
        403,
        "PHOTO_SCOPE",
        "Photo not available.",
      );
    await audit(
      tx,
      ctx,
      "READ",
      "Asset",
      id,
      "Private photo accessed through authenticated proxy.",
    );
    return a;
  });
  const response = await fetch(url(asset.storageKey), {
    headers: headers(),
    signal: AbortSignal.timeout(10000),
  });
  ensure(
    response.ok,
    502,
    "STORAGE_FAILED",
    "Photo is temporarily unavailable.",
  );
  return new Response(response.body, {
    headers: {
      "Content-Type": asset.mime,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
