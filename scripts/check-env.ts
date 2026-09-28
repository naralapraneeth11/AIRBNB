import { required, appUrl, providerStatus } from "../src/server/config";
import { encrypt, decrypt } from "../src/server/crypto";
import { assertDbSafety, db, poolConfig } from "../src/server/db";

// Tenant tables that must keep FORCE row-level security (SEC 01).
const TENANT_TABLES = [
  "Listing",
  "Message",
  "AuditLog",
  "CleaningTask",
  "ChannelConnection",
  "FeedObservation",
  "AvailabilityBlock",
  "Reservation",
  "ConflictCase",
  "ExportVersion",
  "ExportRetrieval",
  "RevokedExportToken",
];

async function main() {
  for (const key of [
    "DATABASE_URL",
    "DIRECT_URL",
    "APP_URL",
    "APP_ENVIRONMENT",
    "AUTH_SECRET",
    "CRON_SECRET",
    "ENCRYPTION_KEYS",
  ])
    required(key);
  if (
    required("AUTH_SECRET").length < 32 ||
    required("CRON_SECRET").length < 32
  )
    throw new Error(
      "Authentication and cron secrets require at least 32 random characters.",
    );
  if (
    process.env.APP_ENVIRONMENT === "production" &&
    !appUrl().startsWith("https:")
  )
    throw new Error("Production requires an HTTPS APP_URL.");
  const monitor = process.env.MONITOR_SECRET;
  if (monitor && monitor.length < 32)
    throw new Error("MONITOR_SECRET requires at least 32 random characters.");
  if (
    decrypt(encrypt("roundtrip", "configuration"), "configuration") !==
    "roundtrip"
  )
    throw new Error("Encryption roundtrip failed.");
  // Section 2: throws on an invalid explicit pool size.
  const pool = poolConfig();
  // Role attributes and the SEC 04 environment interlock.
  await assertDbSafety();
  const tables = await db.$queryRaw<
    { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
  >`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = ANY(${TENANT_TABLES})`;
  const unprotected = TENANT_TABLES.filter(
    (t) =>
      !tables.some(
        (r) => r.relname === t && r.relrowsecurity && r.relforcerowsecurity,
      ),
  );
  if (unprotected.length)
    throw new Error(
      `Apply every migration; forced row-level security is missing on: ${unprotected.join(", ")}.`,
    );
  const warnings = [
    ...(monitor
      ? []
      : [
          "MONITOR_SECRET is not set, so the operations health endpoint cannot be monitored (OPS 01).",
        ]),
    ...(pool.explicit
      ? []
      : [
          `${pool.variable} is not set; this process type uses the default of ${pool.size}.`,
        ]),
  ];
  console.log(
    JSON.stringify(
      {
        environment: process.env.APP_ENVIRONMENT,
        database: "ready",
        encryption: "ready",
        rowLevelSecurity: "ready",
        pool: { [pool.variable]: pool.size, explicit: pool.explicit },
        providers: providerStatus(),
        warnings,
      },
      null,
      2,
    ),
  );
}
main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
