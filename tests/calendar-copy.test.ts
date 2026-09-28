// Host-facing calendar wording and the capability table it draws on
// (CAL 05, CLASS 01, CLASS 02): pure functions, so they are tested directly.
import assert from "node:assert/strict";
import test from "node:test";
import { CAPABILITIES, labelKeyOf } from "../src/domain/calendar/capabilities";
import {
  connectionStatus,
  policyLabelName,
  suggestedPolicyMode,
} from "../src/lib/calendar-copy";
import { brandFrom } from "../src/lib/brand";
import type { Connection } from "../src/lib/types";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const minutes = (n: number) => new Date(NOW + n * 60_000).toISOString();

const connection = (patch: Partial<Connection> = {}): Connection => ({
  id: "c1",
  listingId: "l1",
  platform: "AIRBNB",
  platformName: "Airbnb",
  label: null,
  importing: true,
  enabled: true,
  health: "HEALTHY",
  lastResult: "NO_CHANGES",
  lastSuccessAt: minutes(-3),
  lastAttemptAt: minutes(-3),
  nextFetchAt: minutes(12),
  sourceRetryAfter: null,
  checking: false,
  failures: 0,
  coverageEnd: null,
  policy: { mode: "BY_LABEL", labels: null, version: 1, decidedAt: null },
  refreshGuidance: "",
  exportTokenGeneration: 1,
  ...patch,
});

test("the next check reads as scheduled, due now, or overdue (CAL 05)", () => {
  assert.match(
    connectionStatus(connection(), NOW).detail,
    /Next check in 12 minutes\.$/,
  );
  for (const due of [0, -5])
    assert.match(
      connectionStatus(connection({ nextFetchAt: minutes(due) }), NOW).detail,
      /The next check is due now\.$/,
    );
  assert.match(
    connectionStatus(connection({ nextFetchAt: minutes(-25) }), NOW).detail,
    /The next check is overdue; it was due 25 minutes ago\.$/,
  );
  const paused = connectionStatus(
    connection({
      health: "PAUSED_BY_SOURCE",
      sourceRetryAfter: minutes(90),
      nextFetchAt: minutes(-25),
    }),
    NOW,
  );
  assert.match(paused.detail, /asked us to wait/);
  assert.doesNotMatch(paused.detail, /overdue/);
});

test("a run result never claims more than was observed (CAL 05, EXPORT 02)", () => {
  const failed = connectionStatus(
    connection({ lastResult: "COULD_NOT_CHECK" }),
    NOW,
  );
  assert.equal(failed.tone, "critical");
  assert.match(failed.headline, /existing dates remain protected/);
  for (const result of [
    "NO_CHANGES",
    "UPDATED",
    "NEEDS_REVIEW",
    "COULD_NOT_CHECK",
  ] as const) {
    const status = connectionStatus(connection({ lastResult: result }), NOW);
    assert.doesNotMatch(
      `${status.headline} ${status.detail}`,
      /\bsync(ed)?\b/i,
      "nothing says a calendar is synced",
    );
  }
});

test("label rules only ever pre-select an answer by label (CLASS 01, CLASS 02)", () => {
  const airbnb = CAPABILITIES.AIRBNB.labelRules.map((r) => ({
    suggested: r.suggests,
  }));
  assert.equal(suggestedPolicyMode(airbnb), "BY_LABEL");
  // Booking.com's one label says nothing: the host must choose.
  const booking = CAPABILITIES.BOOKING.labelRules.map((r) => ({
    suggested: r.suggests,
  }));
  assert.equal(suggestedPolicyMode(booking), null);
  assert.equal(
    suggestedPolicyMode([{ suggested: null }, { suggested: "UNKNOWN" }]),
    null,
  );
  assert.equal(suggestedPolicyMode([]), null);
});

test("policy labels read as the platform shows them", () => {
  assert.equal(policyLabelName("none", null), "No label");
  assert.equal(policyLabelName("other", null), "Any other label");
  assert.equal(
    policyLabelName("not-available", "Airbnb (Not available)"),
    "“Airbnb (Not available)”",
  );
  assert.equal(policyLabelName("closed", null), "“closed”");
});

test("the capability table is well formed (section 5)", () => {
  for (const capability of Object.values(CAPABILITIES)) {
    if (capability.hostDomains !== "ANY_PUBLIC")
      assert.equal(
        new Set(capability.hostDomains).size,
        capability.hostDomains.length,
        `${capability.platform}: duplicate host domain`,
      );
    const keys = capability.labelRules.map((r) => r.key);
    assert.equal(new Set(keys).size, keys.length, "label keys are unique");
    for (const rule of capability.labelRules) {
      assert.ok(!["none", "other"].includes(rule.key), "reserved label key");
      assert.ok(rule.text.trim(), `${rule.key}: host-facing text`);
      // The canonical text classifies as its own rule.
      assert.equal(
        labelKeyOf(capability.platform, rule.text.replace(/ …$/, "")),
        rule.key,
      );
    }
  }
});

test("the product name is one setting; identifiers stay stable (REL 03)", () => {
  const current = brandFrom(undefined);
  assert.deepEqual(
    [current.name, current.mark, current.wordmark, current.descriptor],
    ["Airbnb Automation", "a", "airbnb", "AUTOMATION"],
  );
  assert.equal(current.token, "AirbnbAutomation");
  const renamed = brandFrom("  Hostsphere ");
  assert.deepEqual(
    [renamed.name, renamed.mark, renamed.wordmark, renamed.descriptor],
    ["Hostsphere", "h", "hostsphere", ""],
  );
  assert.equal(brandFrom("Stay & Co.").token, "StayCo");
  assert.equal(brandFrom("!!!").token, "Calendar");
  assert.equal(brandFrom("").name, "Airbnb Automation");
});
