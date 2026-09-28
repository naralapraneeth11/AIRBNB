// Integration tests run against real PostgreSQL in its production shape
// (QA 03). TEST_DATABASE_URL names a superuser connection to a disposable
// server. Each test file gets a fresh database: the shipped migrations are
// applied with `prisma migrate deploy` by a non-superuser owner, the shipped
// runtime grants with psql, the environment marker is set to "test", and the
// application is loaded against a NOSUPERUSER NOBYPASSRLS runtime role.
// Without TEST_DATABASE_URL the tests are skipped, unless
// REQUIRE_INTEGRATION_TESTS=1 (as in CI), where that is a failure.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const ADMIN_URL = process.env.TEST_DATABASE_URL;
export const skip = ADMIN_URL
  ? false
  : process.env.REQUIRE_INTEGRATION_TESTS === "1"
    ? false
    : "TEST_DATABASE_URL is not set";

const OWNER = "hs_it_owner";
const APP = "hs_it_app";
const ROOT = process.cwd();

function url(base: string, user: string, password: string, database: string) {
  const u = new URL(base);
  u.username = user;
  u.password = password;
  u.pathname = "/" + database;
  u.search = "";
  return u.toString();
}

export type TestDatabase = {
  database: string;
  ownerUrl: string;
  appUrl: string;
  env: Record<string, string>;
  drop: () => Promise<void>;
};

/** Create, migrate, grant and mark a disposable database; set app env. */
export async function createTestDatabase(): Promise<TestDatabase> {
  if (!ADMIN_URL)
    throw new Error(
      "Set TEST_DATABASE_URL to a superuser URL of a disposable PostgreSQL server.",
    );
  const database = `hs_it_${randomBytes(5).toString("hex")}`;
  const ownerPassword = randomBytes(12).toString("hex");
  const appPassword = randomBytes(12).toString("hex");
  const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });
  try {
    for (const [role, password, extra] of [
      [OWNER, ownerPassword, "NOCREATEDB NOCREATEROLE NOBYPASSRLS"],
      [APP, appPassword, "NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"],
    ] as const) {
      await admin.$executeRawUnsafe(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} LOGIN; END IF; END $$`,
      );
      await admin.$executeRawUnsafe(
        `ALTER ROLE ${role} LOGIN NOSUPERUSER ${extra} PASSWORD '${password}'`,
      );
    }
    await admin.$executeRawUnsafe(`CREATE DATABASE ${database} OWNER ${OWNER}`);
    await admin.$executeRawUnsafe(
      `GRANT CONNECT ON DATABASE ${database} TO ${APP}`,
    );
  } finally {
    await admin.$disconnect();
  }
  const ownerUrl = url(ADMIN_URL, OWNER, ownerPassword, database);
  const appUrl = url(ADMIN_URL, APP, appPassword, database);
  // The shipped migrations, exactly as a release applies them.
  execFileSync(
    path.join(ROOT, "node_modules/.bin/prisma"),
    ["migrate", "deploy"],
    {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: ownerUrl, DIRECT_URL: ownerUrl },
      stdio: "pipe",
    },
  );
  // The shipped least-privilege grants.
  try {
    execFileSync(
      "psql",
      [
        ownerUrl,
        "-q",
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        `runtime_role=${APP}`,
        "-f",
        path.join(ROOT, "prisma/grants/runtime-role.sql"),
      ],
      { stdio: "pipe" },
    );
  } catch (error) {
    throw new Error(
      `psql is required to apply prisma/grants/runtime-role.sql: ${(error as Error).message}`,
    );
  }
  const owner = new PrismaClient({ datasourceUrl: ownerUrl });
  try {
    await owner.$executeRawUnsafe(
      `INSERT INTO "DeploymentEnvironment" ("id", "name", "markedBy") VALUES (1, 'test', 'integration-tests')`,
    );
  } finally {
    await owner.$disconnect();
  }
  const env: Record<string, string> = {
    DATABASE_URL: appUrl,
    DIRECT_URL: appUrl,
    APP_ENVIRONMENT: "test",
    APP_URL: "https://app.test",
    AUTH_SECRET: randomBytes(32).toString("hex"),
    CRON_SECRET: randomBytes(32).toString("hex"),
    MONITOR_SECRET: randomBytes(32).toString("hex"),
    ENCRYPTION_KEYS: JSON.stringify({
      v1: randomBytes(32).toString("base64"),
    }),
    ENCRYPTION_KEY_ID: "v1",
    DATABASE_POOL_SIZE: "4",
  };
  Object.assign(process.env, env);
  return {
    database,
    ownerUrl,
    appUrl,
    env,
    drop: async () => {
      const again = new PrismaClient({ datasourceUrl: ADMIN_URL });
      try {
        await again.$executeRawUnsafe(
          `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
        );
      } finally {
        await again.$disconnect();
      }
    },
  };
}
