// PRIV 02: the records `pnpm erasures:reapply` reads after a backup restore,
// either the exported ledger or the application's "property_erased" log
// lines. Ids only; anything else is refused before a single deletion runs.
import assert from "node:assert/strict";
import test from "node:test";
import { parseRecords } from "../scripts/lib/erasure-records";
import { erasesAt, ERASE_AFTER_DAYS } from "../src/server/services/erasure";

test("an exported ledger is read as deletion records", () => {
  const exported = JSON.stringify([
    {
      workspaceId: "ws1",
      subjectId: "listing-a",
      trigger: "OWNER",
      erasedAt: "2026-10-07T10:00:00.000Z",
    },
    {
      workspaceId: "ws1",
      subjectId: "listing-b",
      trigger: "RETENTION",
      erasedAt: "2026-10-08T10:00:00.000Z",
    },
  ]);
  assert.deepEqual(parseRecords(exported), [
    { workspaceId: "ws1", subjectId: "listing-a" },
    { workspaceId: "ws1", subjectId: "listing-b" },
  ]);
  assert.deepEqual(parseRecords("[]"), []);
});

test("log lines are read too, other lines are skipped, repeats count once", () => {
  const logs = [
    '{"event":"request","requestId":"r1","method":"POST","route":"listings"}',
    '2026-10-07T10:00:00Z info {"event":"property_erased","workspaceId":"ws1","listingId":"listing-a","trigger":"OWNER","erasureId":"e1"}',
    '{"event":"property_erased","workspaceId":"ws2","listingId":"listing-b","trigger":"RETENTION","erasureId":"e2"}',
    '{"event":"property_erased","workspaceId":"ws1","listingId":"listing-a","trigger":"OWNER","erasureId":"e1"}',
    "",
  ].join("\n");
  assert.deepEqual(parseRecords(logs), [
    { workspaceId: "ws1", subjectId: "listing-a" },
    { workspaceId: "ws2", subjectId: "listing-b" },
  ]);
});

test("anything that is not a deletion record is refused", () => {
  for (const bad of [
    '[{"workspaceId":"ws1"}]',
    '[{"workspaceId":"ws1","subjectId":42}]',
    '[{"workspaceId":"ws1","subjectId":"a b"}]',
    '[{"workspaceId":"ws1\'; DROP TABLE x;--","subjectId":"a"}]',
    "[null]",
    '{"event":"property_erased","workspaceId":"ws1"}',
  ])
    assert.throws(() => parseRecords(bad), /Not a deletion record/, bad);
  assert.throws(() => parseRecords("[not json"));
});

test("a removed property is deleted for good 30 days after its removal", () => {
  assert.equal(ERASE_AFTER_DAYS, 30);
  assert.equal(
    erasesAt(new Date("2026-10-07T12:00:00.000Z")).toISOString(),
    "2026-11-06T12:00:00.000Z",
  );
});
