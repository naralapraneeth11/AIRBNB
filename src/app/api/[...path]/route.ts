import { handleApi } from "@/server/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleApi(request);
}

export async function POST(request: Request) {
  return handleApi(request);
}

export async function PUT(request: Request) {
  return handleApi(request);
}

export async function PATCH(request: Request) {
  return handleApi(request);
}

export async function DELETE(request: Request) {
  return handleApi(request);
}
