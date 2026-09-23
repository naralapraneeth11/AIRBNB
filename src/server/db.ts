import { PrismaClient, Prisma } from "@prisma/client";
import type { Role } from "@/lib/domain";
const globalDb = globalThis as unknown as { prisma?: PrismaClient };
export const db = globalDb.prisma || new PrismaClient({ log: ["error"] });
if (process.env.NODE_ENV !== "production") globalDb.prisma = db;
export type Tx = Prisma.TransactionClient;
export type Context = {
  workspaceId: string;
  actorId: string;
  role: Role;
  requestId?: string;
  cleanerId?: string;
  taskId?: string;
  cleanerSessionId?: string;
};
let safetyCheck: Promise<void> | undefined;
export async function tenant<T>(ctx: Context, fn: (tx: Tx) => Promise<T>) {
  await (safetyCheck ??= assertDbSafety().catch((error) => {
    safetyCheck = undefined;
    throw error;
  }));
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
      return fn(tx);
    },
    { maxWait: 10000, timeout: 20000 },
  );
}
export async function lock(tx: Tx, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`;
}
export async function assertDbSafety() {
  const rows = await db.$queryRaw<
    { rolsuper: boolean; rolbypassrls: boolean }[]
  >`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
  if (rows.length !== 1 || rows[0].rolsuper || rows[0].rolbypassrls)
    throw new Error(
      "DATABASE_URL must use a non-superuser, NOBYPASSRLS application role",
    );
}
