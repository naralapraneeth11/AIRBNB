import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

// Run the actual shipped migrations against an embedded PostgreSQL engine.
// Fixtures belong only to this isolated, in-memory test database.
test("migrations enforce tenant boundaries and operational invariants in PostgreSQL", async (t) => {
  const db = new PGlite();
  const sqlError = (code: string) => (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
  const scope = (workspace: string) =>
    db.query("SELECT set_config('app.workspace_id', $1, false)", [workspace]);
  try {
    for (const migration of ["202609210001_initial", "202609210002_security"]) {
      await db.exec(
        await readFile(
          path.join(
            process.cwd(),
            "prisma/migrations",
            migration,
            "migration.sql",
          ),
          "utf8",
        ),
      );
    }
    await db.exec(`
      CREATE ROLE app_test NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO app_test;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_test;
      INSERT INTO "Workspace" (id, name) VALUES ('workspace-a', 'Test A'), ('workspace-b', 'Test B');
      INSERT INTO "Listing" (id, "workspaceId", name, address, "houseManualEncrypted", "exportTokenHash", "updatedAt") VALUES
        ('listing-a', 'workspace-a', 'Test A', 'Test address A', 'ciphertext-a', 'token-a', now()),
        ('listing-b', 'workspace-b', 'Test B', 'Test address B', 'ciphertext-b', 'token-b', now());
      INSERT INTO "Booking" (id, "workspaceId", "listingId", "externalUid", "startDate", "endDate", platform, "confirmedAt", "updatedAt") VALUES
        ('booking-a', 'workspace-a', 'listing-a', 'external-a', '2026-09-20', '2026-09-22', 'DIRECT', now(), now());
      INSERT INTO "CleaningTask" (id, "workspaceId", "listingId", "scheduledAt", "verifyBy", "updatedAt") VALUES
        ('task-a', 'workspace-a', 'listing-a', '2026-09-22 11:00:00', '2026-09-22 15:00:00', now());
      INSERT INTO "AuditLog" (id, "workspaceId", "actorId", action, entity, reason) VALUES
        ('audit-a', 'workspace-a', 'test-actor', 'TEST', 'Listing', 'Isolated test fixture');
      INSERT INTO "DomainEvent" (id, "workspaceId", type, "entityId", payload, key) VALUES
        ('event-a', 'workspace-a', 'TEST', 'listing-a', '{}', 'test-event-a');
      SET ROLE app_test;
    `);

    await t.test(
      "missing tenant context fails closed for reads and writes",
      async () => {
        await scope("");
        assert.equal(
          (await db.query('SELECT id FROM "Listing"')).rows.length,
          0,
        );
        await assert.rejects(
          db.exec(
            `INSERT INTO "AuditLog" (id, "workspaceId", "actorId", action, entity, reason) VALUES ('denied', 'workspace-a', 'test', 'TEST', 'Listing', 'Must fail')`,
          ),
          sqlError("42501"),
        );
      },
    );

    await t.test(
      "tenant context only exposes its own rows and forbids writing another tenant",
      async () => {
        await scope("workspace-a");
        assert.deepEqual(
          (await db.query('SELECT id FROM "Listing" ORDER BY id')).rows,
          [{ id: "listing-a" }],
        );
        assert.equal(
          (
            await db.query(
              `UPDATE "Listing" SET name = 'Unauthorized' WHERE id = 'listing-b' RETURNING id`,
            )
          ).rows.length,
          0,
        );
        await assert.rejects(
          db.exec(
            `UPDATE "Listing" SET "workspaceId" = 'workspace-b' WHERE id = 'listing-a'`,
          ),
          sqlError("42501"),
        );
        await scope("workspace-b");
        assert.deepEqual(
          (await db.query('SELECT id, name FROM "Listing" ORDER BY id')).rows,
          [{ id: "listing-b", name: "Test B" }],
        );
        assert.equal(
          (await db.query('SELECT id FROM "Booking"')).rows.length,
          0,
        );
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
        assert.equal(
          (await db.query('SELECT id FROM "Listing"')).rows.length,
          1,
        );
        await db.exec("COMMIT");
        assert.equal(
          (await db.query('SELECT id FROM "Listing"')).rows.length,
          0,
        );
      },
    );

    await t.test(
      "composite foreign keys reject references into another workspace",
      async () => {
        await scope("workspace-a");
        await assert.rejects(
          db.exec(
            `INSERT INTO "Booking" (id, "workspaceId", "listingId", "externalUid", "startDate", "endDate", platform, "confirmedAt", "updatedAt") VALUES ('cross-tenant', 'workspace-a', 'listing-b', 'cross-tenant', '2026-09-22', '2026-09-24', 'DIRECT', now(), now())`,
          ),
          sqlError("23503"),
        );
      },
    );

    await t.test(
      "database rejects invalid dates, duplicate external events and premature code release",
      async () => {
        await scope("workspace-a");
        await assert.rejects(
          db.exec(
            `UPDATE "Booking" SET "endDate" = "startDate" WHERE id = 'booking-a'`,
          ),
          sqlError("23514"),
        );
        await assert.rejects(
          db.exec(`UPDATE "Booking" SET price = -1 WHERE id = 'booking-a'`),
          sqlError("23514"),
        );
        await assert.rejects(
          db.exec(
            `INSERT INTO "Booking" (id, "workspaceId", "listingId", "externalUid", "startDate", "endDate", platform, "confirmedAt", "updatedAt") VALUES ('duplicate-a', 'workspace-a', 'listing-a', 'external-a', '2026-09-20', '2026-09-22', 'DIRECT', now(), now())`,
          ),
          sqlError("23505"),
        );
        await assert.rejects(
          db.exec(
            `UPDATE "CleaningTask" SET "codeReleasedAt" = now() WHERE id = 'task-a'`,
          ),
          sqlError("23514"),
        );
        await assert.rejects(
          db.exec(
            `UPDATE "CleaningTask" SET status = 'VERIFIED', "verifiedAt" = now() WHERE id = 'task-a'`,
          ),
          sqlError("23514"),
        );
        await db.exec(
          `INSERT INTO "Asset" (id, "workspaceId", "taskId", "storageKey", mime, bytes, sha256) VALUES ('photo-a', 'workspace-a', 'task-a', 'test/photo-a', 'image/jpeg', 100, 'test-digest')`,
        );
        await db.exec(
          `UPDATE "CleaningTask" SET status = 'VERIFIED', "verifiedAt" = now(), "photoId" = 'photo-a' WHERE id = 'task-a'`,
        );
        assert.deepEqual(
          (
            await db.query(
              `SELECT status FROM "CleaningTask" WHERE id = 'task-a'`,
            )
          ).rows,
          [{ status: "VERIFIED" }],
        );
      },
    );

    await t.test(
      "audit records and domain events are append-only for the application role",
      async () => {
        await scope("workspace-a");
        await assert.rejects(
          db.exec(
            `UPDATE "AuditLog" SET reason = 'Modified' WHERE id = 'audit-a'`,
          ),
          /Audit history is append-only/,
        );
        await assert.rejects(
          db.exec(`DELETE FROM "AuditLog" WHERE id = 'audit-a'`),
          /Audit history is append-only/,
        );
        await assert.rejects(
          db.exec(
            `UPDATE "DomainEvent" SET type = 'MODIFIED' WHERE id = 'event-a'`,
          ),
          /Audit history is append-only/,
        );
        await assert.rejects(
          db.exec(`DELETE FROM "DomainEvent" WHERE id = 'event-a'`),
          /Audit history is append-only/,
        );
      },
    );
  } finally {
    await db.close();
  }
});
