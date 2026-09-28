// REC 01: nightly backups through three separate paths, each recorded as the
// evidence that GET /api/health/operations?check=backups checks for freshness.
//
//   pnpm backup postgres   pg_dump as the backup role. Verified by a full
//                          restore when BACKUP_VERIFY_DATABASE_URL names an
//                          empty scratch database, else by an archive whose
//                          table of contents covers every table.
//   pnpm backup storage    every stored photo, checked against its recorded
//                          SHA-256 before it is encrypted.
//   pnpm backup keys       the escrowed encryption keys decrypt a real
//                          ciphertext of every key version in use.
//   pnpm backup record <postgres|storage|keys> <SUCCEEDED|FAILED> [result.json]
//                          record a run once its artifact is stored.
//   pnpm backup decrypt <artifact> <output>
//                          restore helper; needs the offline private key.
//
// Artifacts are encrypted to BACKUP_PUBLIC_KEY before they are written.
// Nothing here prints secrets, credentials or tenant content.
import { spawn } from "node:child_process";
import { createPublicKey, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { keyIdOf } from "../src/server/crypto";
import {
  pgEnv,
  tocTables,
  verifyEscrow,
  type KeySample,
} from "./lib/backup-checks";
import { decryptFile, encryptBytes, encryptFile, sha256 } from "./lib/envelope";

export type BackupKind = "POSTGRES" | "STORAGE" | "KEYS";
export type BackupResult = {
  kind: BackupKind;
  startedAt: string;
  completedAt: string;
  verifiedAt: string;
  artifactSha256: string | null;
  bytes: number | null;
  objectCount: number | null;
  coverage: string[];
  notes: string;
};

const KINDS: Record<string, BackupKind> = {
  postgres: "POSTGRES",
  storage: "STORAGE",
  keys: "KEYS",
};

function setting(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

function publicKey() {
  const pem =
    process.env.BACKUP_PUBLIC_KEY ??
    (process.env.BACKUP_PUBLIC_KEY_FILE
      ? readFileSync(process.env.BACKUP_PUBLIC_KEY_FILE, "utf8")
      : undefined);
  if (!pem) throw new Error("Set BACKUP_PUBLIC_KEY or BACKUP_PUBLIC_KEY_FILE.");
  const key = createPublicKey(pem);
  if (
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072
  )
    throw new Error(
      "BACKUP_PUBLIC_KEY must be an RSA public key of 3072 bits or more.",
    );
  return pem;
}

const outputDir = () =>
  process.env.BACKUP_OUTPUT_DIR ??
  path.join("backups", new Date().toISOString().slice(0, 10));
const resultPath = (kind: BackupKind, dir = outputDir()) =>
  path.join(dir, `result-${kind.toLowerCase()}.json`);
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function run(command: string, args: string[], env: Record<string, string>) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(
            new Error(
              `${path.basename(command)} exited with ${code}: ${stderr.trim()}`,
            ),
          ),
    );
  });
}

const client = (url: string) => new PrismaClient({ datasourceUrl: url });

async function publicTables(db: PrismaClient) {
  const rows = await db.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`;
  return rows.map((r) => r.table_name);
}

async function postgres(): Promise<BackupResult> {
  const startedAt = new Date();
  const source = setting("BACKUP_DATABASE_URL");
  const pgDump = process.env.PG_DUMP || "pg_dump";
  const pgRestore = process.env.PG_RESTORE || "pg_restore";
  const out = outputDir();
  await mkdir(out, { recursive: true });
  const work = await mkdtemp(path.join(tmpdir(), "hostsphere-backup-"));
  const db = client(source);
  try {
    const dump = path.join(work, "postgres.dump");
    await run(
      pgDump,
      ["--format=custom", "--no-owner", "--no-privileges", "--file", dump],
      pgEnv(source),
    );
    const archived = tocTables(await run(pgRestore, ["--list", dump], {}));
    const live = await publicTables(db);
    const missing = live.filter((t) => !archived.has(t));
    if (missing.length)
      throw new Error(
        `The archive lacks table data for: ${missing.join(", ")}.`,
      );
    let coverage = live;
    let notes = `Archive readable; its table of contents covers all ${live.length} tables. Restore not tested: set BACKUP_VERIFY_DATABASE_URL to an empty scratch database.`;
    const verifyUrl = process.env.BACKUP_VERIFY_DATABASE_URL;
    if (verifyUrl) {
      const scratch = client(verifyUrl);
      try {
        if ((await publicTables(scratch)).length)
          throw new Error("The restore check database must be empty.");
        const target = pgEnv(verifyUrl);
        await run(
          pgRestore,
          [
            "--no-owner",
            "--no-privileges",
            "--exit-on-error",
            "--single-transaction",
            `--dbname=${target.PGDATABASE}`,
            dump,
          ],
          target,
        );
        const restored = await publicTables(scratch);
        const lost = live.filter((t) => !restored.includes(t));
        if (lost.length)
          throw new Error(`The restore lacks tables: ${lost.join(", ")}.`);
        coverage = [];
        let rows = 0;
        for (const table of restored) {
          const [{ count }] = await scratch.$queryRawUnsafe<
            { count: bigint }[]
          >(`SELECT count(*) AS count FROM "${table.replaceAll('"', '""')}"`);
          rows += Number(count);
          coverage.push(`${table}:${count}`);
        }
        notes = `Restored into an empty scratch database: ${restored.length} tables, ${rows} rows.`;
      } finally {
        await scratch.$disconnect();
      }
    }
    const verifiedAt = new Date();
    const artifact = path.join(out, `postgres-${stamp()}.dump.enc`);
    const sealed = await encryptFile(dump, artifact, publicKey());
    return {
      kind: "POSTGRES",
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      verifiedAt: verifiedAt.toISOString(),
      artifactSha256: sealed.sha256,
      bytes: sealed.bytes,
      objectCount: null,
      coverage,
      notes,
    };
  } finally {
    await db.$disconnect();
    await rm(work, { recursive: true, force: true });
  }
}

async function storage(): Promise<BackupResult> {
  const startedAt = new Date();
  const db = client(setting("BACKUP_DATABASE_URL"));
  const base = setting("SUPABASE_URL").replace(/\/$/, "");
  const serviceKey = setting("SUPABASE_SERVICE_ROLE_KEY");
  const bucket = process.env.STORAGE_BUCKET || "airbnb-private";
  const key = publicKey();
  const out = outputDir();
  await mkdir(path.join(out, "objects"), { recursive: true });
  try {
    const assets = await db.$queryRaw<
      { id: string; workspaceId: string; storageKey: string; sha256: string }[]
    >`SELECT id, "workspaceId", "storageKey", sha256 FROM "Asset" ORDER BY "createdAt", id`;
    const manifest: object[] = [];
    const failures: string[] = [];
    let bytes = 0;
    for (const a of assets) {
      const url = `${base}/storage/v1/object/${encodeURIComponent(bucket)}/${a.storageKey
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        failures.push(`${a.id}: HTTP ${response.status}`);
        continue;
      }
      const body = Buffer.from(await response.arrayBuffer());
      if (sha256(body) !== a.sha256) {
        failures.push(`${a.id}: content differs from its recorded SHA-256`);
        continue;
      }
      const file = path.join(out, "objects", `${a.sha256}.enc`);
      if (!existsSync(file))
        await writeFile(file, encryptBytes(body, key), { mode: 0o600 });
      bytes += body.length;
      manifest.push({
        assetId: a.id,
        workspaceId: a.workspaceId,
        storageKey: a.storageKey,
        sha256: a.sha256,
        bytes: body.length,
      });
    }
    if (failures.length)
      throw new Error(
        `${failures.length} of ${assets.length} objects failed: ${failures.slice(0, 10).join("; ")}`,
      );
    const verifiedAt = new Date();
    const sealed = encryptBytes(Buffer.from(JSON.stringify(manifest)), key);
    await writeFile(
      path.join(out, `storage-manifest-${stamp()}.json.enc`),
      sealed,
      {
        mode: 0o600,
      },
    );
    return {
      kind: "STORAGE",
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      verifiedAt: verifiedAt.toISOString(),
      artifactSha256: sha256(sealed),
      bytes,
      objectCount: assets.length,
      coverage: [`bucket:${bucket}`, `objects:${assets.length}`],
      notes: `Every stored object matched its recorded SHA-256 before encryption.`,
    };
  } finally {
    await db.$disconnect();
  }
}

/** Encrypted columns and the scope each was sealed with (see src/server). */
const CIPHERTEXTS = [
  ["User", "emailEncrypted", "identity"],
  ["Listing", "houseManualEncrypted", "workspace"],
  ["Listing", "doorCodeEncrypted", "workspace"],
  ["Cleaner", "phoneEncrypted", "workspace"],
  ["Message", "bodyEncrypted", "workspace"],
  ["AutomationRule", "templateEncrypted", "workspace"],
  ["Integration", "secretEncrypted", "workspace"],
  ["Outbox", "payloadEncrypted", "workspace"],
  ["AuditLog", "detailEncrypted", "workspace"],
  ["ChannelConnection", "importUrlEncrypted", "workspace"],
  ["Reservation", "guestContactEncrypted", "workspace"],
] as const;

async function keys(): Promise<BackupResult> {
  const startedAt = new Date();
  const escrow = JSON.parse(setting("ESCROW_ENCRYPTION_KEYS")) as Record<
    string,
    string
  >;
  const db = client(setting("BACKUP_DATABASE_URL"));
  try {
    const present = new Set(await publicTables(db));
    const samples: KeySample[] = [];
    for (const [table, column, scope] of CIPHERTEXTS) {
      if (!present.has(table)) continue;
      const scopeColumn = scope === "identity" ? `'identity'` : `"workspaceId"`;
      const rows = await db.$queryRawUnsafe<{ value: string; scope: string }[]>(
        `SELECT DISTINCT ON (split_part("${column}", '.', 1)) "${column}" AS value, ${scopeColumn} AS scope
           FROM "${table}" WHERE "${column}" IS NOT NULL
          ORDER BY split_part("${column}", '.', 1), "createdAt" DESC`,
      );
      for (const r of rows)
        samples.push({
          keyId: keyIdOf(r.value),
          value: r.value,
          scope: r.scope,
          source: `${table}.${column}`,
        });
    }
    const check = verifyEscrow(escrow, samples);
    if (check.problems.length) throw new Error(check.problems.join(" "));
    return {
      kind: "KEYS",
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      artifactSha256: null,
      bytes: null,
      objectCount: Object.keys(escrow).length,
      coverage: check.verified,
      notes: check.verified.length
        ? `The escrow decrypts stored ciphertexts of key versions ${check.verified.join(", ")}.${check.unused.length ? ` Not yet in use: ${check.unused.join(", ")}.` : ""}`
        : "No encrypted values are stored yet; the escrow holds valid keys.",
    };
  } finally {
    await db.$disconnect();
  }
}

async function record(kindArg: string, status: string, file?: string) {
  const kind = KINDS[kindArg];
  if (!kind || !["SUCCEEDED", "FAILED"].includes(status))
    throw new Error(
      "Usage: record <postgres|storage|keys> <SUCCEEDED|FAILED> [result.json]",
    );
  const location = file ?? resultPath(kind);
  const result = existsSync(location)
    ? (JSON.parse(await readFile(location, "utf8")) as BackupResult)
    : null;
  if (status === "SUCCEEDED" && (!result || result.kind !== kind))
    throw new Error(
      `A successful ${kindArg} run needs its result file (${location}).`,
    );
  const now = new Date();
  const db = client(setting("BACKUP_DATABASE_URL"));
  try {
    const run = await db.backupRun.create({
      data: {
        id: randomUUID(),
        kind,
        status,
        startedAt: result ? new Date(result.startedAt) : now,
        completedAt: result ? new Date(result.completedAt) : now,
        verifiedAt:
          status === "SUCCEEDED" && result ? new Date(result.verifiedAt) : null,
        artifactSha256: result?.artifactSha256 ?? null,
        bytes: result?.bytes != null ? BigInt(result.bytes) : null,
        objectCount: result?.objectCount ?? null,
        coverage: result?.coverage ?? [],
        destination: process.env.BACKUP_DESTINATION ?? null,
        notes:
          status === "FAILED"
            ? (process.env.BACKUP_FAILURE_NOTE ??
              "The backup job failed; see its log.")
            : (result?.notes ?? null),
        recordedBy: process.env.BACKUP_RECORDED_BY || "backup-job",
      },
    });
    console.log(JSON.stringify({ recorded: run.id, kind, status }));
  } finally {
    await db.$disconnect();
  }
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  if (command === "record") return record(rest[0], rest[1], rest[2]);
  if (command === "decrypt") {
    if (rest.length !== 2)
      throw new Error("Usage: decrypt <artifact> <output>");
    const privateKey = await readFile(
      setting("BACKUP_PRIVATE_KEY_FILE"),
      "utf8",
    );
    await decryptFile(rest[0], rest[1], privateKey);
    return console.log(JSON.stringify({ decrypted: rest[1] }));
  }
  const kind = KINDS[command];
  if (!kind)
    throw new Error(
      "Usage: pnpm backup <postgres|storage|keys|record|decrypt> …",
    );
  const result =
    kind === "POSTGRES"
      ? await postgres()
      : kind === "STORAGE"
        ? await storage()
        : await keys();
  await mkdir(outputDir(), { recursive: true });
  await writeFile(resultPath(kind), JSON.stringify(result, null, 2) + "\n");
  console.log(
    JSON.stringify({
      kind,
      verifiedAt: result.verifiedAt,
      artifactSha256: result.artifactSha256,
      bytes: result.bytes,
      objectCount: result.objectCount,
      notes: result.notes,
    }),
  );
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
