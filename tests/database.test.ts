// The shipped migrations, applied in order to an embedded PostgreSQL engine,
// enforce tenant isolation (SEC 01), composite keys, calendar invariants
// (DATA 01-02, DATE 01, ID 02, CONFLICT 01, CLEAN 01/03) and history rules
// (LIFE 04) for the application role, and the calendar rebuild honours the
// MIG 01 pre-launch exception. Fixtures exist only in this in-memory database.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS = [
  "202609210001_initial",
  "202609210002_security",
  "202609270001_operations_foundation",
  "202609270002_calendar_correctness",
] as const;

const migration = (name: string) =>
  readFile(
    path.join(process.cwd(), "prisma/migrations", name, "migration.sql"),
    "utf8",
  );

async function migrated(upTo: number = MIGRATIONS.length) {
  const db = new PGlite();
  for (const name of MIGRATIONS.slice(0, upTo))
    await db.exec(await migration(name));
  return db;
}

const sqlError = (code: string) => (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === code;

const TENANT_TABLES = [
  "Listing",
  "ChannelConnection",
  "FeedObservation",
  "AvailabilityBlock",
  "Reservation",
  "ConflictCase",
  "ExportVersion",
  "ExportRetrieval",
  "RevokedExportToken",
  "CleaningTask",
] as const;

const block = (
  id: string,
  workspace: string,
  listing: string,
  connection: string,
  key: string,
  start: string,
  end: string,
) =>
  `INSERT INTO "AvailabilityBlock" (id, "workspaceId", "listingId", "connectionId", "sourceKey", "identityKind", "startDate", "endDate", classification, "classificationEvidence", lifecycle, "sourceStatus", "committedRevision", "updatedAt") VALUES ('${id}', '${workspace}', '${listing}', '${connection}', '${key}', 'UID', '${start}', '${end}', 'RESERVATION', '{}', 'ACTIVE', 'CONFIRMED', 1, now())`;

const conflict = (id: string, a: string, b: string) =>
  `INSERT INTO "ConflictCase" (id, "workspaceId", "listingId", "blockAId", "blockBId", kind, severity, "overlapStart", "overlapEnd", "firstDetectedAt", "lastDetectedAt", "updatedAt") VALUES ('${id}', 'workspace-a', 'listing-a', '${a}', '${b}', 'RESERVATION_RESERVATION', 'HIGH', '2026-10-03', '2026-10-04', now(), now(), now())`;

const FIXTURES = `
  INSERT INTO "Workspace" (id, name) VALUES ('workspace-a', 'Test A'), ('workspace-b', 'Test B');
  INSERT INTO "Listing" (id, "workspaceId", name, address, "houseManualEncrypted", "updatedAt") VALUES
    ('listing-a', 'workspace-a', 'Test A', 'Test address A', 'ciphertext-a', now()),
    ('listing-a2', 'workspace-a', 'Test A2', 'Test address A2', 'ciphertext-a2', now()),
    ('listing-b', 'workspace-b', 'Test B', 'Test address B', 'ciphertext-b', now());
  INSERT INTO "ChannelConnection" (id, "workspaceId", "listingId", platform, "importUrlEncrypted", "importUrlDigest", "exportTokenHash", "capabilitiesVersion", "updatedAt") VALUES
    ('conn-a', 'workspace-a', 'listing-a', 'AIRBNB', 'ciphertext-url-a', 'digest-a', 'export-hash-a', 'test', now()),
    ('conn-a2', 'workspace-a', 'listing-a2', 'AIRBNB', 'ciphertext-url-a2', 'digest-a2', 'export-hash-a2', 'test', now()),
    ('conn-b', 'workspace-b', 'listing-b', 'VRBO', 'ciphertext-url-b', 'digest-b', 'export-hash-b', 'test', now());
  ${block("block-a1", "workspace-a", "listing-a", "conn-a", "uid-1", "2026-10-01", "2026-10-04")};
  ${block("block-a2", "workspace-a", "listing-a", "conn-a", "uid-2", "2026-10-03", "2026-10-05")};
  ${block("block-b1", "workspace-b", "listing-b", "conn-b", "uid-1", "2026-10-01", "2026-10-04")};
  INSERT INTO "Reservation" (id, "workspaceId", "listingId", "blockId", source, platform, "sourceReservationKey", "startDate", "endDate", currency, "firstObservedAt", "updatedAt") VALUES
    ('res-a1', 'workspace-a', 'listing-a', 'block-a1', 'IMPORTED', 'AIRBNB', 'uid-1', '2026-10-01', '2026-10-04', 'USD', now(), now());
  INSERT INTO "CleaningTask" (id, "workspaceId", "listingId", "reservationId", "taskType", "departureDate", "scheduledAt", "verifyBy", "updatedAt") VALUES
    ('task-a', 'workspace-a', 'listing-a', 'res-a1', 'TURNOVER', '2026-10-04', '2026-10-04 11:00:00', '2026-10-04 15:00:00', now());
  ${conflict("conflict-a", "block-a1", "block-a2")};
  INSERT INTO "FeedObservation" (id, "workspaceId", "connectionId", trigger, mode, "startedAt", "observedAt", "durationMs", fence, outcome, complete, health, counts, "rulesVersion", result, accepted) VALUES
    ('obs-a', 'workspace-a', 'conn-a', 'SCHEDULED', 'SHADOW', now(), now(), 5, 1, 'BODY', true, 'HEALTHY', '{}', 'test', 'UPDATED', true);
  INSERT INTO "ExportVersion" (id, "workspaceId", "connectionId", version, "bodyDigest", body, "sourceRevision", "eventCount") VALUES
    ('export-a', 'workspace-a', 'conn-a', 1, repeat('a', 64), 'BEGIN:VCALENDAR', 1, 2);
  INSERT INTO "ExportRetrieval" (id, "workspaceId", "connectionId", "tokenGeneration", version, "responseClass", "bucketStart", "firstAt", "lastAt") VALUES
    ('retrieval-a', 'workspace-a', 'conn-a', 1, 1, 'BODY', date_trunc('hour', now()), now(), now());
  INSERT INTO "RevokedExportToken" ("tokenHash", "workspaceId", "connectionId", generation, "revokedAt", "expiresAt") VALUES
    ('revoked-a', 'workspace-a', 'conn-a', 1, now(), now() + interval '90 days');
  INSERT INTO "AuditLog" (id, "workspaceId", "actorId", action, entity, reason) VALUES
    ('audit-a', 'workspace-a', 'test-actor', 'TEST', 'Listing', 'Isolated test fixture');
  INSERT INTO "DomainEvent" (id, "workspaceId", type, "entityId", payload, key) VALUES
    ('event-a', 'workspace-a', 'TEST', 'listing-a', '{}', 'test-event-a');
  CREATE ROLE app_test NOSUPERUSER NOBYPASSRLS;
  GRANT USAGE ON SCHEMA public TO app_test;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_test;
  SET ROLE app_test;
`;

test("migrations enforce tenant boundaries and calendar invariants in PostgreSQL", async (t) => {
  const db = await migrated();
  const scope = (workspace: string) =>
    db.query("SELECT set_config('app.workspace_id', $1, false)", [workspace]);
  const ids = async (table: string) =>
    (
      await db.query<{ id: string }>(
        `SELECT ${table === "RevokedExportToken" ? '"tokenHash"' : "id"} AS id FROM "${table}" ORDER BY 1`,
      )
    ).rows.map((r) => r.id);
  try {
    await db.exec(FIXTURES);

    await t.test(
      "missing tenant context fails closed for reads and writes",
      async () => {
        await scope("");
        for (const table of TENANT_TABLES)
          assert.deepEqual(await ids(table), [], table);
        await assert.rejects(
          db.exec(
            block(
              "denied",
              "workspace-a",
              "listing-a",
              "conn-a",
              "denied",
              "2026-11-01",
              "2026-11-02",
            ),
          ),
          sqlError("42501"),
        );
      },
    );

    await t.test(
      "tenant context only exposes its own rows and forbids writing another tenant",
      async () => {
        await scope("workspace-a");
        assert.deepEqual(await ids("ChannelConnection"), ["conn-a", "conn-a2"]);
        assert.deepEqual(await ids("AvailabilityBlock"), [
          "block-a1",
          "block-a2",
        ]);
        for (const table of [
          "FeedObservation",
          "Reservation",
          "ConflictCase",
          "ExportVersion",
          "ExportRetrieval",
          "RevokedExportToken",
        ])
          assert.equal((await ids(table)).length, 1, table);
        assert.equal(
          (
            await db.query(
              `UPDATE "AvailabilityBlock" SET "endDate" = '2026-12-01' WHERE id = 'block-b1' RETURNING id`,
            )
          ).rows.length,
          0,
        );
        await assert.rejects(
          db.exec(
            `UPDATE "Reservation" SET "workspaceId" = 'workspace-b' WHERE id = 'res-a1'`,
          ),
          sqlError("42501"),
        );
        await scope("workspace-b");
        assert.deepEqual(await ids("AvailabilityBlock"), ["block-b1"]);
        assert.deepEqual(await ids("Reservation"), []);
      },
    );

    await t.test(
      "transaction-local tenant context does not leak into the next transaction",
      async () => {
        await scope("");
        await db.exec("BEGIN");
        await db.query(
          "SELECT set_config('app.workspace_id', 'workspace-a', true)",
        );
        assert.equal((await ids("AvailabilityBlock")).length, 2);
        await db.exec("COMMIT");
        assert.equal((await ids("AvailabilityBlock")).length, 0);
      },
    );

    await t.test(
      "composite keys reject references into another workspace or property",
      async () => {
        await scope("workspace-a");
        await assert.rejects(
          db.exec(
            `INSERT INTO "Reservation" (id, "workspaceId", "listingId", source, platform, "startDate", "endDate", currency, "firstObservedAt", "updatedAt") VALUES ('cross-tenant', 'workspace-a', 'listing-b', 'DIRECT', 'DIRECT', '2026-10-01', '2026-10-02', 'USD', now(), now())`,
          ),
          sqlError("23503"),
        );
        // A block's connection must belong to the same property.
        await assert.rejects(
          db.exec(
            block(
              "cross-property",
              "workspace-a",
              "listing-a",
              "conn-a2",
              "uid-9",
              "2026-11-01",
              "2026-11-02",
            ),
          ),
          sqlError("23503"),
        );
        await assert.rejects(
          db.exec(
            `INSERT INTO "CleaningTask" (id, "workspaceId", "listingId", "reservationId", "taskType", "departureDate", "scheduledAt", "verifyBy", "updatedAt") VALUES ('cross-task', 'workspace-a', 'listing-a2', 'res-a1', 'TURNOVER', '2026-10-05', now(), now() + interval '4 hours', now())`,
          ),
          sqlError("23503"),
        );
      },
    );

    await t.test(
      "identity, date, classification and lifecycle rules hold in the database",
      async () => {
        await scope("workspace-a");
        // DATE 01: the end date is exclusive, so a block covers a night.
        await assert.rejects(
          db.exec(
            `UPDATE "AvailabilityBlock" SET "endDate" = "startDate" WHERE id = 'block-a1'`,
          ),
          sqlError("23514"),
        );
        // ID 01 / DATA 02: identity is scoped to its connection.
        await assert.rejects(
          db.exec(
            block(
              "duplicate",
              "workspace-a",
              "listing-a",
              "conn-a",
              "uid-1",
              "2026-11-01",
              "2026-11-02",
            ),
          ),
          sqlError("23505"),
        );
        await db.exec(
          block(
            "same-uid-other-feed",
            "workspace-a",
            "listing-a2",
            "conn-a2",
            "uid-1",
            "2026-11-01",
            "2026-11-02",
          ),
        );
        // ID 02: an event without reliable identity is never classified.
        await assert.rejects(
          db.exec(
            `UPDATE "AvailabilityBlock" SET "identityKind" = 'SURROGATE' WHERE id = 'block-a2'`,
          ),
          sqlError("23514"),
        );
        // LIFE 01/03: awaiting a decision needs its reason; release needs a time.
        await assert.rejects(
          db.exec(
            `UPDATE "AvailabilityBlock" SET lifecycle = 'AWAITING_DECISION' WHERE id = 'block-a2'`,
          ),
          sqlError("23514"),
        );
        await assert.rejects(
          db.exec(
            `UPDATE "AvailabilityBlock" SET lifecycle = 'RELEASED' WHERE id = 'block-a2'`,
          ),
          sqlError("23514"),
        );
        await assert.rejects(
          db.exec(
            `UPDATE "Reservation" SET "sourceReservationKey" = NULL WHERE id = 'res-a1'`,
          ),
          sqlError("23514"),
        );
        await assert.rejects(
          db.exec(`UPDATE "Reservation" SET price = -1 WHERE id = 'res-a1'`),
          sqlError("23514"),
        );
        await assert.rejects(
          db.exec(
            `UPDATE "ExportVersion" SET "bodyDigest" = 'not-a-digest' WHERE id = 'export-a'`,
          ),
          sqlError("23514"),
        );
        await assert.rejects(
          db.exec(
            `UPDATE "ChannelConnection" SET "importUrlDigest" = NULL WHERE id = 'conn-a'`,
          ),
          sqlError("23514"),
        );
        // Export tokens are unique across every workspace.
        await assert.rejects(
          db.exec(
            `INSERT INTO "ChannelConnection" (id, "workspaceId", "listingId", platform, "exportTokenHash", "capabilitiesVersion", "updatedAt") VALUES ('reuse', 'workspace-a', 'listing-a', 'OTHER', 'export-hash-b', 'test', now())`,
          ),
          sqlError("23505"),
        );
      },
    );

    await t.test(
      "conflict cases use byte-ordered canonical pairs with one open case each",
      async () => {
        await scope("workspace-a");
        await assert.rejects(
          db.exec(conflict("reversed", "block-a2", "block-a1")),
          sqlError("23514"),
        );
        await assert.rejects(
          db.exec(conflict("second-open", "block-a1", "block-a2")),
          sqlError("23505"),
        );
        // Byte order puts "B" (0x42) before "b" (0x62) under any collation.
        await db.exec(
          block(
            "B-upper",
            "workspace-a",
            "listing-a",
            "conn-a",
            "uid-u",
            "2026-12-01",
            "2026-12-03",
          ),
        );
        await db.exec(
          block(
            "b-lower",
            "workspace-a",
            "listing-a",
            "conn-a",
            "uid-l",
            "2026-12-02",
            "2026-12-04",
          ),
        );
        await db.exec(conflict("byte-order", "B-upper", "b-lower"));
        await assert.rejects(
          db.exec(conflict("byte-order-reversed", "b-lower", "B-upper")),
          sqlError("23514"),
        );
      },
    );

    await t.test(
      "turnover work exists only for reservations and closes with a reason",
      async () => {
        await scope("workspace-a");
        await assert.rejects(
          db.exec(
            `INSERT INTO "CleaningTask" (id, "workspaceId", "listingId", "taskType", "scheduledAt", "verifyBy", "updatedAt") VALUES ('orphan-turnover', 'workspace-a', 'listing-a', 'TURNOVER', now(), now() + interval '4 hours', now())`,
          ),
          sqlError("23514"),
        );
        await db.exec(
          `INSERT INTO "CleaningTask" (id, "workspaceId", "listingId", "scheduledAt", "verifyBy", "updatedAt") VALUES ('manual-a', 'workspace-a', 'listing-a', now(), now() + interval '4 hours', now())`,
        );
        // CLEAN 01: one effective turnover per stay departure.
        await assert.rejects(
          db.exec(
            `INSERT INTO "CleaningTask" (id, "workspaceId", "listingId", "reservationId", "taskType", "departureDate", "scheduledAt", "verifyBy", "updatedAt") VALUES ('task-a-dup', 'workspace-a', 'listing-a', 'res-a1', 'TURNOVER', '2026-10-04', now(), now() + interval '4 hours', now())`,
          ),
          sqlError("23505"),
        );
        // CLEAN 03: a closed task records when and why it closed.
        await assert.rejects(
          db.exec(
            `UPDATE "CleaningTask" SET status = 'CANCELLED' WHERE id = 'task-a'`,
          ),
          sqlError("23514"),
        );
        await db.exec(
          `UPDATE "CleaningTask" SET status = 'SUPERSEDED', "closedAt" = now(), "closeReason" = 'RESERVATION_DATES_CHANGED' WHERE id = 'task-a'`,
        );
        // A closed task no longer blocks its replacement.
        await db.exec(
          `INSERT INTO "CleaningTask" (id, "workspaceId", "listingId", "reservationId", "taskType", "departureDate", "supersedesTaskId", "scheduledAt", "verifyBy", "updatedAt") VALUES ('task-a-next', 'workspace-a', 'listing-a', 'res-a1', 'TURNOVER', '2026-10-04', 'task-a', now(), now() + interval '4 hours', now())`,
        );
        await assert.rejects(
          db.exec(
            `UPDATE "CleaningTask" SET "codeReleasedAt" = now() WHERE id = 'manual-a'`,
          ),
          sqlError("23514"),
        );
        await assert.rejects(
          db.exec(
            `UPDATE "CleaningTask" SET status = 'VERIFIED', "verifiedAt" = now() WHERE id = 'manual-a'`,
          ),
          sqlError("23514"),
        );
      },
    );

    await t.test(
      "routine operations never hard-delete calendar or cleaning history",
      async () => {
        await scope("workspace-a");
        for (const [table, id] of [
          ["AvailabilityBlock", "block-a2"],
          ["Reservation", "res-a1"],
          ["ConflictCase", "conflict-a"],
          ["ExportVersion", "export-a"],
          ["CleaningTask", "manual-a"],
        ])
          await assert.rejects(
            db.exec(`DELETE FROM "${table}" WHERE id = '${id}'`),
            /never hard-deleted/,
            table,
          );
        // Bounded operational evidence is prunable (DATA 03 retention).
        for (const table of [
          "FeedObservation",
          "ExportRetrieval",
          "RevokedExportToken",
        ])
          await db.exec(`DELETE FROM "${table}"`);
      },
    );

    await t.test(
      "audit records and domain events are append-only for the application role",
      async () => {
        await scope("workspace-a");
        for (const statement of [
          `UPDATE "AuditLog" SET reason = 'Modified' WHERE id = 'audit-a'`,
          `DELETE FROM "AuditLog" WHERE id = 'audit-a'`,
          `UPDATE "DomainEvent" SET type = 'MODIFIED' WHERE id = 'event-a'`,
          `DELETE FROM "DomainEvent" WHERE id = 'event-a'`,
        ])
          await assert.rejects(
            db.exec(statement),
            /Audit history is append-only/,
          );
      },
    );

    await t.test("operations records reject impossible states", async () => {
      for (const statement of [
        `INSERT INTO "DeploymentEnvironment" (id, name, "markedBy") VALUES (2, 'staging', 'test')`,
        `INSERT INTO "DeploymentEnvironment" (name, "markedBy") VALUES ('prod', 'test')`,
        `INSERT INTO "BackupRun" (id, kind, status, "startedAt", "completedAt", "recordedBy") VALUES ('unverified', 'POSTGRES', 'SUCCEEDED', now(), now(), 'test')`,
        `INSERT INTO "SchedulerTick" (id, trigger, status, "startedAt") VALUES ('tick', 'CRON_HTTP', 'DONE', now())`,
      ])
        await assert.rejects(db.exec(statement), sqlError("23514"));
      assert.deepEqual(
        (await db.query(`SELECT id FROM "SchedulerLease"`)).rows,
        [{ id: "scheduler" }],
      );
    });
  } finally {
    await db.close();
  }
});

test("MIG 01: the calendar rebuild refuses to run over legacy calendar rows", async () => {
  const db = await migrated(3);
  try {
    await db.exec(`
      INSERT INTO "Workspace" (id, name) VALUES ('workspace-a', 'Test A');
      INSERT INTO "Listing" (id, "workspaceId", name, address, "houseManualEncrypted", "exportTokenHash", "updatedAt") VALUES
        ('listing-a', 'workspace-a', 'Test A', 'Test address A', 'ciphertext-a', 'token-a', now());
      INSERT INTO "Booking" (id, "workspaceId", "listingId", "externalUid", "startDate", "endDate", platform, "confirmedAt", "updatedAt") VALUES
        ('booking-a', 'workspace-a', 'listing-a', 'external-a', '2026-09-20', '2026-09-22', 'DIRECT', now(), now());
    `);
    await assert.rejects(
      db.exec(await migration(MIGRATIONS[3])),
      /Calendar rebuild refused: 1 calendar row\(s\) exist/,
    );
    // Nothing was applied: the legacy tables and their rows remain.
    assert.deepEqual((await db.query(`SELECT id FROM "Booking"`)).rows, [
      { id: "booking-a" },
    ]);
  } finally {
    await db.close();
  }
});

test("MIG 01: existing export links and tasks survive the pre-launch rebuild", async () => {
  const db = await migrated(3);
  try {
    await db.exec(`
      INSERT INTO "Workspace" (id, name) VALUES ('workspace-a', 'Test A');
      INSERT INTO "Listing" (id, "workspaceId", name, address, "houseManualEncrypted", "exportTokenHash", "updatedAt") VALUES
        ('listing-a', 'workspace-a', 'Test A', 'Test address A', 'ciphertext-a', 'legacy-token-hash', now());
      INSERT INTO "CleaningTask" (id, "workspaceId", "listingId", "scheduledAt", "verifyBy", "updatedAt") VALUES
        ('task-a', 'workspace-a', 'listing-a', now(), now() + interval '4 hours', now());
    `);
    await db.exec(await migration(MIGRATIONS[3]));
    assert.deepEqual(
      (
        await db.query(
          `SELECT "listingId", platform, health, "exportTokenHash", "importUrlEncrypted" FROM "ChannelConnection"`,
        )
      ).rows,
      [
        {
          listingId: "listing-a",
          platform: "OTHER",
          health: "EXPORT_ONLY",
          exportTokenHash: "legacy-token-hash",
          importUrlEncrypted: null,
        },
      ],
    );
    assert.deepEqual(
      (await db.query(`SELECT "taskType" FROM "CleaningTask"`)).rows,
      [{ taskType: "MANUAL" }],
    );
  } finally {
    await db.close();
  }
});
