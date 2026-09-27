// Request and response helpers shared by the API route modules (ARCH 02).
import { NextResponse } from "next/server";
import * as V from "./validation";
import { AppError, ensure } from "./errors";
import { dateOnly, dayAdd } from "@/lib/domain";

export async function bytes(request: Request, limit: number) {
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

export async function formBody(request: Request) {
  const data = await bytes(request, 4 * 1024 * 1024 + 65536);
  return new Response(new Uint8Array(data), {
    headers: { "Content-Type": request.headers.get("content-type") || "" },
  }).formData();
}

export async function body(request: Request, limit = 64000) {
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

export function range(request: Request) {
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

export function json(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
