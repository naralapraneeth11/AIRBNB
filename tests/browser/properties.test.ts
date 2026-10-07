// Browser checks for removing a property from the app and restoring it
// (QA 03), against the production build and real PostgreSQL: the dialog says
// what will stop and what will not, the button stays disabled until the
// property's name is typed, the property then leaves every screen, its
// export link stops answering without serving an empty calendar, and
// restoring brings it back.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { createTestDatabase, type TestDatabase } from "../integration/harness";
import {
  ROOT,
  freePort,
  launchBrowser,
  skip,
  startServer,
  watch as watchPage,
  type Server,
} from "./harness";

const EMAIL = "remove-host@example.test";
const PASSWORD = "remove-browser-password";
const GONE = "Harbor cottage";
const KEPT = "Hill house";

let t: TestDatabase | undefined;
let server: Server | undefined;
let browser: Browser | undefined;
let desktop: BrowserContext | undefined;
let page: Page;
let base = "";
let exportUrl = "";

const problems: string[] = [];
const watch = (p: Page) => watchPage(p, problems);
const dialog = () => page.locator("dialog[open]");
const card = (name: string) =>
  page.locator(".property-card", { hasText: name });

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
        BOOTSTRAP_NAME: "Remove Host",
        BOOTSTRAP_WORKSPACE: "Removal checks",
      },
      stdio: "pipe",
    },
  );
  const { db, tenant } = await import("../../src/server/db");
  const { createConnection } =
    await import("../../src/server/calendar/actions");
  const { runConnection } = await import("../../src/server/calendar/run");
  const { seal } = await import("../../src/server/crypto");
  const dates = await import("../../src/domain/calendar/dates");
  const day = (n: number) =>
    dates.addDays(dates.todayIn("UTC", Date.now()), n).replaceAll("-", "");
  const workspace = await db.workspace.findFirstOrThrow();
  const user = await db.user.findFirstOrThrow();
  const ctx = {
    workspaceId: workspace.id,
    actorId: user.id,
    role: "HOST" as const,
  };
  for (const name of [GONE, KEPT]) {
    const listing = await tenant(ctx, (tx) =>
      tx.listing.create({
        data: {
          workspaceId: workspace.id,
          name,
          address: `${name} address`,
          timezone: "UTC",
          houseManualEncrypted: seal({}, workspace.id),
        },
      }),
    );
    const link = await tenant(ctx, (tx) =>
      createConnection(tx, ctx, {
        listingId: listing.id,
        platform: "AIRBNB",
        url: `https://www.airbnb.com/calendar/ical/${name.length}.ics?s=x`,
        label: null,
      }),
    );
    if (name === GONE) exportUrl = link.exportUrl;
    await runConnection(ctx, link.connection.id, {
      trigger: "MANUAL",
      fetcher: async () => ({
        kind: "BODY",
        status: 200,
        body: [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "PRODID:-//removal-checks//EN",
          "BEGIN:VEVENT",
          `UID:${name.length}@airbnb.com`,
          "DTSTAMP:20260101T000000Z",
          `DTSTART;VALUE=DATE:${day(3)}`,
          `DTEND;VALUE=DATE:${day(6)}`,
          "SUMMARY:Reserved",
          "END:VEVENT",
          "END:VCALENDAR",
        ].join("\r\n"),
        etag: null,
        lastModified: null,
      }),
    });
  }
  await db.$disconnect();

  server = await startServer(port, t.env);
  browser = await launchBrowser();
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
  await server?.stop();
  await t?.drop();
});

test(
  "the remove dialog says what stops and what does not, and waits for the name",
  { skip },
  async () => {
    await page.goto(`${base}/login`);
    await page.fill("input[name=email]", EMAIL);
    await page.fill("input[name=password]", PASSWORD);
    await page.click("button[type=submit]");
    await page.waitForURL(/\/(overview|calendar)/);
    await page.goto(`${base}/properties`);
    await card(GONE).click();
    await dialog().getByRole("button", { name: "Remove property…" }).click();
    const form = dialog();
    await form.getByRole("heading", { name: `Remove ${GONE}?` }).waitFor();
    await form.getByText(/Nothing is changed or deleted on Airbnb/).waitFor();
    await form.getByText("We stop checking its calendar.").waitFor();
    await form.getByText(/never sends an empty calendar/).waitFor();
    await form.getByText(/history is kept/).waitFor();

    const remove = form.getByRole("button", { name: "Remove property" });
    assert.equal(await remove.isDisabled(), true, "disabled until confirmed");
    const typed = form.getByLabel(`Type “${GONE}” to confirm`);
    await typed.fill("Harbor");
    assert.equal(await remove.isDisabled(), true, "a partial name is not it");
    await typed.fill("harbor   COTTAGE");
    assert.equal(await remove.isDisabled(), false, "case does not matter");

    // Cancel returns to the property, nothing removed.
    await form.getByRole("button", { name: "Cancel" }).click();
    await dialog().getByRole("button", { name: "Remove property…" }).waitFor();
    await dialog().getByRole("button", { name: "Close" }).click();
    await card(GONE).waitFor();
  },
);

test(
  "removing takes it out of every screen and its link stops answering",
  { skip },
  async () => {
    await card(GONE).click();
    await dialog().getByRole("button", { name: "Remove property…" }).click();
    await dialog().getByLabel(`Type “${GONE}” to confirm`).fill(GONE);
    await dialog().getByRole("button", { name: "Remove property" }).click();
    await page.getByText(`${GONE} was removed.`).waitFor();
    await card(GONE).waitFor({ state: "detached" });
    await card(KEPT).waitFor();

    const removed = page.locator(".removed-properties");
    await removed.getByText("Removed properties").click();
    await removed.getByText(GONE, { exact: true }).waitFor();

    await page.goto(`${base}/calendar`);
    await page.locator(".calendar-legend").getByText(KEPT).waitFor();
    assert.equal(
      await page.locator(".calendar-legend").getByText(GONE).count(),
      0,
    );
    // The export link answers "not found", never an empty calendar.
    const response = await page.request.get(exportUrl);
    assert.equal(response.status(), 404);
    assert.equal(await response.text(), "Calendar not found.");
  },
);

test(
  "the removed list shows a platform still asking for the link, and restore brings it back",
  { skip },
  async () => {
    await page.goto(`${base}/properties`);
    const removed = page.locator(".removed-properties");
    await removed.getByText("Removed properties").click();
    await removed
      .getByText(/Still asked for its calendar link: Airbnb/)
      .waitFor();
    await removed.getByRole("button", { name: "Restore" }).click();
    await dialog()
      .getByRole("heading", { name: `Restore ${GONE}?` })
      .waitFor();
    await dialog().getByRole("button", { name: "Restore" }).click();
    await page.getByText(`${GONE} is back.`).waitFor();
    await card(GONE).waitFor();
    await removed.waitFor({ state: "detached" });
    const response = await page.request.get(exportUrl);
    assert.notEqual(response.status(), 404, "the link answers again");
  },
);

test("the remove dialog reflows at phone width", { skip }, async () => {
  const phone = await browser!.newContext({
    viewport: { width: 390, height: 844 },
    storageState: await desktop!.storageState(),
    timezoneId: "UTC",
    locale: "en-US",
  });
  try {
    const small = await phone.newPage();
    watch(small);
    await small.goto(`${base}/properties`);
    await small.locator(".property-card", { hasText: GONE }).click();
    await small
      .locator("dialog[open]")
      .getByRole("button", { name: "Remove property…" })
      .click();
    await small
      .locator("dialog[open]")
      .getByLabel(`Type “${GONE}” to confirm`)
      .waitFor();
    const widths = await small.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    assert.ok(widths.page <= widths.viewport, "no sideways scrolling");
  } finally {
    await phone.close();
  }
});

test("no unexpected browser errors or failed requests", { skip }, async () => {
  assert.deepEqual(problems, []);
});
