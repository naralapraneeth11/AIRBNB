// Targeted browser checks (QA 03): the production build, served by
// `next start` against real PostgreSQL in its production shape (the
// integration harness), driven in Chromium at desktop and phone widths. They
// cover the calendar paths where a client/server mismatch could mislead a
// host: the policy question (CLASS 02), overlap acknowledgement (MANUAL 01,
// CONFLICT 01), the release review (LIFE 03), honest shadow-mode wording
// (REL 01) and reflow without horizontal scrolling.
//
// Needs TEST_DATABASE_URL (see tests/integration/harness.ts), a completed
// `pnpm build`, and Chromium (`pnpm exec playwright-core install chromium`,
// or BROWSER_EXECUTABLE). Skipped otherwise, unless REQUIRE_BROWSER_TESTS=1.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import {
  createTestDatabase,
  skip as noDatabase,
  type TestDatabase,
} from "../integration/harness";

const ROOT = process.cwd();
const built = existsSync(path.join(ROOT, ".next", "BUILD_ID"));
const skip =
  process.env.REQUIRE_BROWSER_TESTS === "1"
    ? false
    : noDatabase || (built ? false : "Run `pnpm build` first");

const EMAIL = "browser-host@example.test";
const PASSWORD = "browser-checks-password";
const PROPERTY = "Browser cabin";

let t: TestDatabase | undefined;
let server: ChildProcess | undefined;
let serverLog = "";
let browser: Browser | undefined;
let desktop: BrowserContext | undefined;
let page: Page;
let base = "";
let airbnbId = "";
let day: (n: number) => string = String;

/** Every failed request and browser error; only expected ones may remain. */
const problems: string[] = [];

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("No free port")),
      );
    });
  });
}

async function waitForServer(url: string, deadlineMs: number) {
  while (Date.now() < deadlineMs) {
    if (server?.exitCode !== null && server?.exitCode !== undefined)
      throw new Error(`next start exited early:\n${serverLog}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`The server did not answer in time:\n${serverLog}`);
}

function watch(p: Page) {
  p.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  p.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  p.on("response", (r) => {
    if (r.url().includes("/api/") && r.status() >= 400)
      problems.push(
        `http ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`,
      );
  });
}

const dialog = () => page.locator("dialog[open]");
const toast = () => page.locator(".toast[role=status]");

before(async () => {
  if (skip) return;
  t = await createTestDatabase();
  const port = await freePort();
  base = `http://localhost:${port}`;
  process.env.APP_URL = t.env.APP_URL = base;

  execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/create-owner.ts"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        DIRECT_URL: t.ownerUrl,
        BOOTSTRAP_EMAIL: EMAIL,
        BOOTSTRAP_PASSWORD: PASSWORD,
        BOOTSTRAP_NAME: "Browser Host",
        BOOTSTRAP_WORKSPACE: "Browser checks",
      },
      stdio: "pipe",
    },
  );

  // Seed through the application's own paths: one Airbnb connection whose
  // first check leaves the policy question pending (CLASS 02).
  const { db, tenant } = await import("../../src/server/db");
  const { createConnection } =
    await import("../../src/server/calendar/actions");
  const { runConnection } = await import("../../src/server/calendar/run");
  const { seal } = await import("../../src/server/crypto");
  const dates = await import("../../src/domain/calendar/dates");
  const today = dates.todayIn("UTC", Date.now());
  day = (n) => dates.addDays(today, n);
  const compact = (n: number) => day(n).replaceAll("-", "");
  const workspace = await db.workspace.findFirstOrThrow();
  const user = await db.user.findFirstOrThrow();
  const ctx = {
    workspaceId: workspace.id,
    actorId: user.id,
    role: "HOST" as const,
  };
  const listing = await tenant(ctx, (tx) =>
    tx.listing.create({
      data: {
        workspaceId: workspace.id,
        name: PROPERTY,
        address: "Browser test address",
        timezone: "UTC",
        houseManualEncrypted: seal({}, workspace.id),
        bufferDays: 1,
      },
    }),
  );
  const created = await tenant(ctx, (tx) =>
    createConnection(tx, ctx, {
      listingId: listing.id,
      platform: "AIRBNB",
      url: "https://www.airbnb.com/calendar/ical/1.ics?s=browser-secret",
      label: null,
    }),
  );
  airbnbId = created.connection.id;
  const event = (uid: string, from: number, to: number, summary: string) => [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20260101T000000Z",
    `DTSTART;VALUE=DATE:${compact(from)}`,
    `DTEND;VALUE=DATE:${compact(to)}`,
    `SUMMARY:${summary}`,
    "END:VEVENT",
  ];
  const feed = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//browser-checks//EN",
    ...event("stay@airbnb.com", 1, 4, "Reserved"),
    ...event("closed@airbnb.com", 8, 10, "Airbnb (Not available)"),
    ...event("later@airbnb.com", 12, 15, "Reserved"),
    "END:VCALENDAR",
  ].join("\r\n");
  await runConnection(ctx, airbnbId, {
    trigger: "MANUAL",
    fetcher: async () => ({
      kind: "BODY",
      status: 200,
      body: feed,
      etag: null,
      lastModified: null,
    }),
  });
  await db.$disconnect();

  server = spawn(
    process.execPath,
    [
      path.join(ROOT, "node_modules/next/dist/bin/next"),
      "start",
      "-p",
      String(port),
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ...t.env,
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const collect = (chunk: Buffer) => {
    serverLog = (serverLog + chunk.toString()).slice(-20_000);
  };
  server.stdout?.on("data", collect);
  server.stderr?.on("data", collect);
  await waitForServer(`${base}/login`, Date.now() + 90_000);

  browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || undefined,
  });
  desktop = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    timezoneId: "UTC",
    locale: "en-US",
  });
  page = await desktop.newPage();
  watch(page);
});

after(async () => {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((r) => server?.once("exit", r));
    server.kill("SIGTERM");
    await exited;
  }
  await t?.drop();
});

test(
  "a host signs in and sees the pending policy question and honest check result (CLASS 02, CAL 05, REL 01)",
  { skip },
  async () => {
    await page.goto(`${base}/login`);
    await page.fill("input[name=email]", EMAIL);
    await page.fill("input[name=password]", PASSWORD);
    await page.click("button[type=submit]");
    await page.waitForURL(/\/(overview|calendar)/);
    await page.goto(`${base}/calendar`);
    const attention = page.locator(".attention-panel");
    await attention
      .getByText(`How should Airbnb blocks count for ${PROPERTY}?`)
      .waitFor();
    await page.getByText(/^Shadow mode\./).waitFor();
    await page
      .locator(".source-health")
      .getByText("Some events need review")
      .waitFor();
  },
);

test(
  "the policy question pre-selects by label, saves, and reopens with the stored answer (CLASS 02)",
  { skip },
  async () => {
    await page
      .getByRole("button", { name: /How should Airbnb blocks count/ })
      .click();
    const form = dialog();
    await form.locator("select[name='label:reserved']").waitFor();
    assert.equal(
      await form.locator("input[name=mode]:checked").getAttribute("value"),
      "BY_LABEL",
      "unverified label rules pre-select only an answer by label",
    );
    assert.equal(
      await form.locator("select[name='label:reserved']").inputValue(),
      "RESERVATION",
    );
    assert.equal(
      await form.locator("select[name='label:not-available']").inputValue(),
      "OWNER_BLOCK",
    );
    await form.getByText("“Airbnb (Not available)”").first().waitFor();
    // Answer differently from the suggestion, so reopening proves the stored
    // answer is shown rather than a default.
    await form
      .locator("select[name='label:not-available']")
      .selectOption("UNKNOWN");
    await form.getByRole("button", { name: "Save answer" }).click();
    await toast()
      .getByText(/^Saved for Airbnb\./)
      .waitFor();
    await page
      .locator(".attention-panel")
      .getByText(/How should Airbnb blocks count/)
      .waitFor({ state: "detached" });

    await page.goto(`${base}/properties?connection=${airbnbId}`);
    await dialog()
      .getByRole("button", { name: /how its blocks count/ })
      .click();
    const again = dialog();
    await again.locator("select[name='label:not-available']").waitFor();
    assert.equal(
      await again.locator("input[name=mode]:checked").getAttribute("value"),
      "BY_LABEL",
    );
    assert.equal(
      await again.locator("select[name='label:not-available']").inputValue(),
      "UNKNOWN",
      "the stored answer, not the suggestion or the first option",
    );
    assert.equal(
      await again.locator("select[name='label:reserved']").inputValue(),
      "RESERVATION",
    );
    await again.getByRole("button", { name: "Cancel" }).click();
  },
);

test(
  "an overlapping hold needs acknowledgement and opens an overlap case (MANUAL 01, CONFLICT 01)",
  { skip },
  async () => {
    await page.goto(`${base}/calendar`);
    await page.getByRole("button", { name: "Hold dates", exact: true }).click();
    const form = dialog();
    await form
      .getByText(/Dates are in UTC\. Export links affected: Airbnb/)
      .waitFor();
    await form.getByText(/^Shadow mode: export links start serving/).waitFor();
    await form.locator("input[name=from]").fill(day(2));
    await form.locator("input[name=to]").fill(day(3));
    await form.locator("input[name=reason]").fill("Family visit");
    await form.getByRole("button", { name: "Hold dates" }).click();
    await form
      .getByText("These dates overlap protected dates or buffer days:")
      .waitFor();
    const submit = form.getByRole("button", { name: "Hold dates" });
    assert.equal(await submit.isDisabled(), true, "needs acknowledgement");
    await form.getByLabel(/Save anyway/).check();
    await submit.click();
    await toast()
      .getByText(
        "Saved. Export links include it once this workspace goes live.",
      )
      .waitFor();
    await page
      .locator(".attention-panel")
      .getByText(`${PROPERTY}: reservation overlaps a hold`)
      .waitFor();
  },
);

test(
  "reopening a stay shows what changes and requires confirmation (LIFE 03)",
  { skip },
  async () => {
    await page
      .getByRole("button", {
        name: new RegExp(`${PROPERTY}: Reservation, .*${day(1)} to ${day(4)}`),
      })
      .first()
      .click();
    await dialog()
      .getByRole("button", { name: /Reopen these dates/ })
      .click();
    const review = dialog();
    for (const heading of [
      "Nights that reopen",
      "Buffer days that reopen",
      "Export links that change",
      "Open overlaps",
    ])
      await review.getByText(heading, { exact: true }).waitFor();
    await review.getByText(/it does not cancel or change a booking/).waitFor();
    await review.getByLabel(/I checked this stay on Airbnb/).waitFor();
    await review.getByRole("button", { name: "Cancel" }).click();
  },
);

test(
  "at phone width the calendar reflows without horizontal scrolling",
  { skip },
  async () => {
    const phone = await browser!.newContext({
      viewport: { width: 390, height: 844 },
      timezoneId: "UTC",
      locale: "en-US",
      storageState: await desktop!.storageState(),
    });
    try {
      const small = await phone.newPage();
      watch(small);
      await small.goto(`${base}/calendar`);
      await small.locator(".attention-panel").waitFor();
      const widths = await small.evaluate(() => ({
        page: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }));
      assert.ok(
        widths.page <= widths.viewport,
        `page is ${widths.page}px wide in a ${widths.viewport}px viewport`,
      );
    } finally {
      await phone.close();
    }
  },
);

test(
  "a save whose follow-up refresh fails is reported as saved, with a stale-data notice",
  { skip },
  async () => {
    await page.goto(`${base}/calendar`);
    await page.getByRole("button", { name: "Hold dates", exact: true }).click();
    const form = dialog();
    await form.locator("input[name=from]").fill(day(20));
    await form.locator("input[name=to]").fill(day(21));
    await form.locator("input[name=reason]").fill("Deck repairs");
    // The save itself succeeds; only the workspace refresh after it fails.
    await page.route("**/api/workspace", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Simulated refresh failure." }),
      }),
    );
    await form.getByRole("button", { name: "Hold dates" }).click();
    await toast()
      .getByText(/^Saved\./)
      .waitFor();
    await page
      .locator(".stale-notice")
      .getByText(/may be out of date/)
      .waitFor();
    assert.equal(await dialog().count(), 0, "the form closed as saved");
    assert.equal(
      await page.locator(".page-content > .error-box").count(),
      0,
      "the workspace is not replaced by an error",
    );
    await page.unroute("**/api/workspace");
    await page
      .locator(".stale-notice")
      .getByRole("button", { name: "Refresh" })
      .click();
    await page.locator(".stale-notice").waitFor({ state: "detached" });
  },
);

test(
  "an unreadable error page is explained instead of shown as a parse error",
  { skip },
  async () => {
    await page.getByRole("button", { name: "Hold dates", exact: true }).click();
    const form = dialog();
    await form.locator("input[name=from]").fill(day(24));
    await form.locator("input[name=to]").fill(day(25));
    await form.locator("input[name=reason]").fill("Painting");
    await page.route("**/api/calendar/block", (route) =>
      route.fulfill({
        status: 504,
        contentType: "text/html",
        body: "<!DOCTYPE html><title>Gateway Timeout</title>",
      }),
    );
    await form.getByRole("button", { name: "Hold dates" }).click();
    await form
      .getByText(/did not answer properly \(HTTP 504\)\. If you were saving/)
      .waitFor();
    assert.equal(await form.getByText(/Unexpected token/).count(), 0);
    await page.unroute("**/api/calendar/block");
    await form.getByRole("button", { name: "Cancel" }).click();
  },
);

test("no unexpected browser errors or failed requests", { skip }, async () => {
  // Expected by design: the overlap check answers 409, and the two tests
  // above simulate a failed refresh (500) and a proxy timeout (504).
  // Chromium logs each as a failed resource.
  const expected = new Set([
    "http 409 POST /api/calendar/block",
    "http 500 GET /api/workspace",
    "http 504 POST /api/calendar/block",
  ]);
  const unexpected = problems.filter(
    (p) =>
      !expected.has(p) &&
      !/^console: Failed to load resource: .* (409 \(Conflict\)|500 \(Internal Server Error\)|504 \(Gateway Timeout\))$/.test(
        p,
      ),
  );
  assert.deepEqual(unexpected, []);
});
