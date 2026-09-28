import { PrismaClient, Prisma } from "@prisma/client";
import type { Role } from "@/lib/domain";

// Section 2: the pool size is set explicitly per process instead of Prisma's
// CPU-derived default (which reported 21 connections during local setup).
export const POOL_DEFAULTS = { serverless: 1, web: 3, worker: 4 } as const;

export function poolConfig(env: NodeJS.ProcessEnv = process.env) {
  const worker = env.PROCESS_ROLE === "worker";
  const variable = worker ? "WORKER_DATABASE_POOL_SIZE" : "DATABASE_POOL_SIZE";
  const fallback = worker
    ? POOL_DEFAULTS.worker
    : env.VERCEL
      ? POOL_DEFAULTS.serverless
      : POOL_DEFAULTS.web;
  const configured = env[variable];
  const size =
    configured === undefined || configured === ""
      ? fallback
      : Number(configured);
  if (!Number.isInteger(size) || size < 1 || size > 50)
    throw new Error(`${variable} must be an integer between 1 and 50`);
  return {
    variable,
    size,
    explicit: configured !== undefined && configured !== "",
  };
}

export function datasourceUrl(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.DATABASE_URL;
  if (!raw) return undefined;
  const url = new URL(raw);
  const pool = poolConfig(env);
  if (pool.explicit || !url.searchParams.has("connection_limit"))
    url.searchParams.set("connection_limit", String(pool.size));
  if (!url.searchParams.has("pool_timeout"))
    url.searchParams.set("pool_timeout", "10");
  return url.toString();
}

const globalDb = globalThis as unknown as { prisma?: PrismaClient };
export const db =
  globalDb.prisma ||
  new PrismaClient({ log: ["error"], datasourceUrl: datasourceUrl() });
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

// SEC 04: a database records which environment it belongs to, and an
// application instance serves only a compatible database. A preview or
// staging deployment can never read or write production data.
export const APP_ENVIRONMENTS = [
  "production",
  "staging",
  "preview",
  "development",
  "test",
] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];
export const DATABASE_ENVIRONMENTS = {
  production: ["production"],
  staging: ["staging", "preview"],
  development: ["development"],
  test: ["test"],
} as const satisfies Record<string, readonly AppEnvironment[]>;

export function environmentMismatch(
  appEnvironment: string | undefined,
  databaseEnvironment: string | null,
  vercelEnvironment?: string,
): string | null {
  if (
    !appEnvironment ||
    !APP_ENVIRONMENTS.includes(appEnvironment as AppEnvironment)
  )
    return "Set APP_ENVIRONMENT to production, staging, preview, development or test.";
  if (vercelEnvironment === "preview" && appEnvironment === "production")
    return "A preview deployment cannot run with APP_ENVIRONMENT=production.";
  if (!databaseEnvironment)
    return "This database has no environment marker. Run `pnpm db:mark-environment <name>` with the owner connection.";
  const allowed: readonly string[] =
    DATABASE_ENVIRONMENTS[
      databaseEnvironment as keyof typeof DATABASE_ENVIRONMENTS
    ] ?? [];
  return allowed.includes(appEnvironment)
    ? null
    : `APP_ENVIRONMENT=${appEnvironment} cannot use a database marked "${databaseEnvironment}".`;
}

export async function assertDbSafety() {
  const rows = await db.$queryRaw<
    { rolsuper: boolean; rolbypassrls: boolean }[]
  >`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
  if (rows.length !== 1 || rows[0].rolsuper || rows[0].rolbypassrls)
    throw new Error(
      "DATABASE_URL must use a non-superuser, NOBYPASSRLS application role",
    );
  const marker = await db.$queryRaw<{ name: string }[]>`
    SELECT "name" FROM "DeploymentEnvironment" WHERE "id" = 1`;
  const problem = environmentMismatch(
    process.env.APP_ENVIRONMENT,
    marker[0]?.name ?? null,
    process.env.VERCEL_ENV,
  );
  if (problem) throw new Error(problem);
}

let safetyCheck: Promise<void> | undefined;
/** Cached per process; retried after a failure. Run before any data access. */
export function ensureDatabaseSafety() {
  return (safetyCheck ??= assertDbSafety().catch((error) => {
    safetyCheck = undefined;
    throw error;
  }));
}

export async function tenant<T>(ctx: Context, fn: (tx: Tx) => Promise<T>) {
  await ensureDatabaseSafety();
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
