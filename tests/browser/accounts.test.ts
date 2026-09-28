// Browser checks for self-service accounts and guided setup (AUTH 01, AUTH 03,
// AUTH 04): sign up, confirm the email link, go through setup, then reset
// the password, which signs out the earlier session. The test environment
// prints account emails to the server log, where the links are read.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { createTestDatabase, type TestDatabase } from "../integration/harness";
import {
  freePort,
  launchBrowser,
  skip,
  startServer,
  watch,
  type Server,
} from "./harness";

const EMAIL = "signup-host@example.test";
const words = () =>
  `${randomBytes(5).toString("hex")} harbor willow ${randomBytes(5).toString("hex")}`;
const FIRST_PASSWORD = words();
const NEW_PASSWORD = words();

let t: TestDatabase | undefined;
let server: Server | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page;
let base = "";
const problems: string[] = [];

/** The newest link of one kind that the server "emailed". */
function emailedLink(kind: "verify" | "reset") {
  const links = [
    ...server!
      .log()
      .matchAll(new RegExp(`(http://\\S+/${kind}#token=[A-Za-z0-9_-]+)`, "g")),
  ];
  assert.ok(links.length, `no ${kind} email in the server log`);
  return links.at(-1)![1];
}

before(async () => {
  if (skip) return;
  t = await createTestDatabase();
  const port = await freePort();
  base = `http://localhost:${port}`;
  process.env.APP_URL = t.env.APP_URL = base;
  server = await startServer(port, { ...t.env, SIGNUP_ENABLED: "true" });
  browser = await launchBrowser();
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    timezoneId: "UTC",
    locale: "en-US",
  });
  page = await context.newPage();
  watch(page, problems);
});

after(async () => {
  await browser?.close();
  await server?.stop();
  await t?.drop();
});

test(
  "a visitor signs up and nothing exists until the emailed link is used (AUTH 01)",
  { skip },
  async () => {
    await page.goto(`${base}/login`);
    await page.getByRole("link", { name: /Create an account/ }).click();
    await page.waitForURL(/\/signup$/);
    await page.getByLabel("Your name").fill("Signup Host");
    await page.getByLabel("Email address").fill(EMAIL);
    await page.getByLabel("Workspace name").fill("Signup Rentals");
    await page.getByLabel("Password").fill(FIRST_PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByRole("heading", { name: "Check your email" }).waitFor();
    await page.getByText(/If this address can be used/).waitFor();
  },
);

test(
  "the emailed link creates the account, signs in and opens guided setup",
  { skip },
  async () => {
    await page.goto(emailedLink("verify"));
    await page.waitForURL(/\/setup$/);
    assert.equal(
      new URL(page.url()).hash,
      "",
      "the token left the address bar",
    );
    await page
      .getByRole("heading", { name: "Set up your workspace." })
      .waitFor();
    await page
      .getByRole("heading", { name: "Add your first property" })
      .waitFor();
  },
);

test(
  "setup saves each step, allows skipping optional ones, and finishes (AUTH 04)",
  { skip },
  async () => {
    await page.getByLabel("Property name").fill("Harbor cottage");
    await page.getByLabel("Address or location").fill("12 Harbor Lane");
    await page.getByLabel(/This is the property’s time zone/).check();
    await page.getByRole("button", { name: "Save and continue" }).click();
    await page.getByRole("heading", { name: "Connect a calendar" }).waitFor();

    // Progress survives a reload.
    await page.reload();
    await page.getByRole("heading", { name: "Connect a calendar" }).waitFor();

    await page.getByRole("button", { name: "Skip for now" }).click();
    await page
      .getByRole("heading", { name: "Add a cleaner (optional)" })
      .waitFor();
    await page.getByRole("button", { name: "Skip for now" }).click();
    await page.getByRole("heading", { name: "What happens next" }).waitFor();
    await page.getByText(/Automation is paused/).waitFor();
    await page.getByText(/^Shadow mode: new calendar decisions/).waitFor();
    await page.getByRole("button", { name: "Finish setup" }).click();
    await page.waitForURL(/\/calendar$/);
    await page
      .locator(".calendar-legend")
      .getByText("Harbor cottage")
      .waitFor();
    assert.equal(
      await page.getByText("Finish setting up.").count(),
      0,
      "no reminder once setup is done",
    );
  },
);

test(
  "a reset link sets a new password and signs out the earlier session (AUTH 03)",
  { skip },
  async () => {
    const other = await browser!.newPage();
    watch(other, problems);
    await other.goto(`${base}/login`);
    await other.getByRole("link", { name: "Forgot your password?" }).click();
    await other.waitForURL(/\/forgot$/);
    await other.getByLabel("Email address").fill(EMAIL);
    await other.getByRole("button", { name: "Send reset link" }).click();
    await other.getByText(/If an account uses this address/).waitFor();

    await other.goto(emailedLink("reset"));
    await other.locator("input[name=password]").fill(NEW_PASSWORD);
    await other.locator("input[name=confirm]").fill(NEW_PASSWORD);
    await other.getByRole("button", { name: "Save new password" }).click();
    await other.getByRole("heading", { name: "Password changed" }).waitFor();
    await other.close();

    // The session from sign-up no longer works.
    await page.goto(`${base}/calendar`);
    await page.waitForURL(/\/login/);

    await page.getByLabel("Email address").fill(EMAIL);
    await page.getByLabel("Password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Enter your workspace" }).click();
    await page.waitForURL(/\/calendar$/);
  },
);

test("account pages reflow at phone width", { skip }, async () => {
  const phone = await browser!.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    const small = await phone.newPage();
    for (const path of ["/login", "/signup", "/forgot"]) {
      await small.goto(`${base}${path}`);
      const widths = await small.evaluate(() => ({
        page: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }));
      assert.ok(widths.page <= widths.viewport, `${path} scrolls sideways`);
    }
  } finally {
    await phone.close();
  }
});

test("no unexpected browser errors or failed requests", { skip }, async () => {
  // Expected: after the reset, the old session's first request is refused
  // (401) and the app returns to sign-in, as it should.
  const unexpected = problems.filter(
    (p) =>
      !/^http 401 GET \/api\//.test(p) &&
      !/^console: Failed to load resource: .* 401 \(Unauthorized\)$/.test(p),
  );
  assert.deepEqual(unexpected, []);
});
