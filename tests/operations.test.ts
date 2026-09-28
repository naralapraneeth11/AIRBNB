// Phase 0 operations: the environment interlock (SEC 04), explicit pool sizes
// (section 2), the monitored health endpoint's access rules (OPS 01), and the
// backup envelope and escrow checks (REC 01). Database-backed behaviour of the
// tick and health checks is covered by the integration suite.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { environmentMismatch, poolConfig } from "../src/server/db";
import { operationsHealth } from "../src/server/routes/operations";
import {
  decryptBytes,
  decryptFile,
  encryptBytes,
  encryptFile,
} from "../scripts/lib/envelope";
import { pgEnv, tocTables, verifyEscrow } from "../scripts/lib/backup-checks";

const pair = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

test("SEC 04: each deployment serves only a database of its own environment", () => {
  assert.equal(environmentMismatch("production", "production"), null);
  assert.equal(environmentMismatch("staging", "staging"), null);
  assert.equal(environmentMismatch("preview", "staging"), null);
  assert.equal(environmentMismatch("test", "test"), null);
  for (const [app, database] of [
    ["preview", "production"],
    ["staging", "production"],
    ["development", "production"],
    ["production", "staging"],
    ["production", "development"],
    ["preview", "development"],
  ])
    assert.match(
      environmentMismatch(app, database) ?? "",
      /cannot use a database marked/,
      `${app} on ${database}`,
    );
  assert.match(
    environmentMismatch(undefined, "production") ?? "",
    /Set APP_ENVIRONMENT/,
  );
  assert.match(
    environmentMismatch("prod", "production") ?? "",
    /Set APP_ENVIRONMENT/,
  );
  assert.match(
    environmentMismatch("staging", null) ?? "",
    /no environment marker/,
  );
  // A Vercel preview can never claim to be production.
  assert.match(
    environmentMismatch("production", "production", "preview") ?? "",
    /preview deployment/,
  );
});

test("Section 2: the pool size is explicit per process type and validated", () => {
  const base = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
  assert.deepEqual(poolConfig({ ...base, VERCEL: "1" }), {
    variable: "DATABASE_POOL_SIZE",
    size: 1,
    explicit: false,
  });
  assert.equal(poolConfig(base).size, 3);
  assert.deepEqual(poolConfig({ ...base, PROCESS_ROLE: "worker" }), {
    variable: "WORKER_DATABASE_POOL_SIZE",
    size: 4,
    explicit: false,
  });
  assert.deepEqual(poolConfig({ ...base, DATABASE_POOL_SIZE: "2" }), {
    variable: "DATABASE_POOL_SIZE",
    size: 2,
    explicit: true,
  });
  for (const bad of ["0", "51", "2.5", "many"])
    assert.throws(
      () => poolConfig({ ...base, DATABASE_POOL_SIZE: bad }),
      /between 1 and 50/,
    );
});

test("OPS 01: the operations endpoint needs its own secret before touching data", async () => {
  const previous = process.env.MONITOR_SECRET;
  const request = (auth?: string, query = "") =>
    new Request(`https://app.test/api/health/operations${query}`, {
      headers: auth ? { authorization: auth } : {},
    });
  try {
    delete process.env.MONITOR_SECRET;
    assert.equal(
      (await operationsHealth(request("Bearer anything"))).status,
      503,
    );
    process.env.MONITOR_SECRET = "short";
    assert.equal((await operationsHealth(request("Bearer short"))).status, 503);
    const secret = randomBytes(32).toString("hex");
    process.env.MONITOR_SECRET = secret;
    assert.equal((await operationsHealth(request())).status, 401);
    assert.equal((await operationsHealth(request("Bearer wrong"))).status, 401);
    const invalid = await operationsHealth(
      request(`Bearer ${secret}`, "?check=everything"),
    );
    assert.equal(invalid.status, 400);
    assert.equal(invalid.headers.get("cache-control"), "no-store");
  } finally {
    if (previous === undefined) delete process.env.MONITOR_SECRET;
    else process.env.MONITOR_SECRET = previous;
  }
});

test("REC 01: backup artifacts are sealed to the offline key and reject tampering", async () => {
  const { publicKey, privateKey } = pair();
  const plain = randomBytes(300_000);
  const sealed = encryptBytes(plain, publicKey);
  assert.equal(sealed.subarray(0, 4).toString(), "HSB1");
  assert.equal(sealed.includes(plain.subarray(0, 64)), false);
  assert.deepEqual(decryptBytes(sealed, privateKey), plain);
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 100] ^= 1;
  assert.throws(() => decryptBytes(tampered, privateKey));
  assert.throws(() =>
    decryptBytes(sealed.subarray(0, sealed.length - 1), privateKey),
  );
  assert.throws(() => decryptBytes(sealed, pair().privateKey));

  const dir = await mkdtemp(path.join(tmpdir(), "envelope-test-"));
  try {
    await writeFile(path.join(dir, "plain"), plain);
    const result = await encryptFile(
      path.join(dir, "plain"),
      path.join(dir, "sealed"),
      publicKey,
    );
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
    await decryptFile(
      path.join(dir, "sealed"),
      path.join(dir, "restored"),
      privateKey,
    );
    assert.deepEqual(await readFile(path.join(dir, "restored")), plain);
    // The stream and in-memory forms are one format.
    assert.deepEqual(
      decryptBytes(await readFile(path.join(dir, "sealed")), privateKey),
      plain,
    );
    // A tampered file fails and leaves no unauthenticated plaintext behind.
    const bytes = await readFile(path.join(dir, "sealed"));
    bytes[bytes.length >> 1] ^= 1;
    await writeFile(path.join(dir, "tampered"), bytes);
    await assert.rejects(
      decryptFile(
        path.join(dir, "tampered"),
        path.join(dir, "out"),
        privateKey,
      ),
    );
    await assert.rejects(readFile(path.join(dir, "out")));
    await assert.rejects(readFile(path.join(dir, "out.partial")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("REC 01: archive coverage and key escrow checks", async () => {
  const listing = [
    ";",
    "; Archive created at 2026-09-27 03:17:00 UTC",
    "226; 1259 16390 TABLE public Listing owner",
    "3601; 0 16390 TABLE DATA public Listing owner",
    "3602; 0 16420 TABLE DATA public AvailabilityBlock owner",
    "3603; 0 16500 TABLE DATA other Elsewhere owner",
    "3650; 2606 16700 CONSTRAINT public Listing Listing_pkey owner",
  ].join("\n");
  assert.deepEqual([...tocTables(listing)].sort(), [
    "AvailabilityBlock",
    "Listing",
  ]);

  assert.deepEqual(
    pgEnv("postgresql://backup%40role:p%3Ass@db.test:6543/app?sslmode=require"),
    {
      PGHOST: "db.test",
      PGPORT: "6543",
      PGUSER: "backup@role",
      PGPASSWORD: "p:ss",
      PGDATABASE: "app",
      PGSSLMODE: "require",
    },
  );

  const previous = {
    keys: process.env.ENCRYPTION_KEYS,
    id: process.env.ENCRYPTION_KEY_ID,
  };
  const v1 = randomBytes(32).toString("base64");
  const v2 = randomBytes(32).toString("base64");
  try {
    const { encrypt } = await import("../src/server/crypto");
    process.env.ENCRYPTION_KEYS = JSON.stringify({ v1, v2 });
    process.env.ENCRYPTION_KEY_ID = "v1";
    const one = encrypt("guest phone", "workspace-a");
    process.env.ENCRYPTION_KEY_ID = "v2";
    const two = encrypt("host email", "identity");
    const samples = [
      {
        keyId: "v1",
        value: one,
        scope: "workspace-a",
        source: "Cleaner.phoneEncrypted",
      },
      {
        keyId: "v2",
        value: two,
        scope: "identity",
        source: "User.emailEncrypted",
      },
    ];
    const v3 = randomBytes(32).toString("base64");
    assert.deepEqual(verifyEscrow({ v1, v2, v3 }, samples), {
      verified: ["v1", "v2"],
      unused: ["v3"],
      problems: [],
    });
    assert.deepEqual(verifyEscrow({ v1 }, samples).problems, [
      "Key version v2 is in use but missing from the escrow.",
    ]);
    assert.deepEqual(verifyEscrow({ v1, v2: v3 }, samples).problems, [
      "Escrowed key v2 does not decrypt its ciphertexts.",
    ]);
    assert.match(
      verifyEscrow({ v1, v2, bad: "c2hvcnQ=" }, samples).problems[0],
      /not a 32-byte base64 key/,
    );
    // Key material never appears in a result.
    assert.equal(
      JSON.stringify(verifyEscrow({ v1, v2 }, samples)).includes(v1),
      false,
    );
  } finally {
    process.env.ENCRYPTION_KEYS = previous.keys;
    process.env.ENCRYPTION_KEY_ID = previous.id;
    if (previous.keys === undefined) delete process.env.ENCRYPTION_KEYS;
    if (previous.id === undefined) delete process.env.ENCRYPTION_KEY_ID;
  }
});
