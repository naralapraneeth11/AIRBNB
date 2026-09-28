import { handle } from "@/server/router";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const GET = handle;
// EXPORT 02: HEAD is answered explicitly so it is recorded as its own class.
export const HEAD = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
