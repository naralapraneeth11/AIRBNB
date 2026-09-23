import { required, appUrl, providerStatus } from "../src/server/config";
import { encrypt, decrypt } from "../src/server/crypto";
import { assertDbSafety, db } from "../src/server/db";
async function main() {
  for (const key of [
    "DATABASE_URL",
    "DIRECT_URL",
    "APP_URL",
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
  if (process.env.NODE_ENV === "production" && !appUrl().startsWith("https:"))
    throw new Error("Production requires an HTTPS APP_URL.");
  if (
    decrypt(encrypt("roundtrip", "configuration"), "configuration") !==
    "roundtrip"
  )
    throw new Error("Encryption roundtrip failed.");
  await assertDbSafety();
  const tables = await db.$queryRaw<
    { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
  >`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('Listing','Booking','Message','AuditLog','CleaningTask')`;
  if (
    tables.length !== 5 ||
    tables.some((t) => !t.relrowsecurity || !t.relforcerowsecurity)
  )
    throw new Error(
      "Apply both database migrations; forced row-level security is required.",
    );
  console.log(
    JSON.stringify(
      {
        database: "ready",
        encryption: "ready",
        rowLevelSecurity: "ready",
        providers: providerStatus(),
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
