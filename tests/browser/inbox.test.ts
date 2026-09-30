// Browser checks for the Inbox (QA 03) against the production build and real
// PostgreSQL: the conversation shown is always the one chosen, and a reply
// goes to it; drafts stay with their conversation; a retried send is not
// sent twice; conversations open on their newest messages and page back
// without losing the reader's place; background refresh failures never
// replace what is on screen; filters never offer stale results; on a phone
// the list and a conversation take turns with a working Back, and the
// navigation drawer holds focus while open and is skipped while closed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import type { Browser, BrowserContext, Page, Route } from "playwright-core";
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

const EMAIL = "inbox-host@example.test";
const PASSWORD = "inbox-browser-password";

let t: TestDatabase | undefined;
let server: Server | undefined;
let browser: Browser | undefined;
let desktop: BrowserContext | undefined;
let page: Page;
let base = "";
const ids = { ada: "", ben: "", cy: "", filler: "" };

const problems: string[] = [];
const watch = (p: Page) => watchPage(p, problems);
const heading = (p: Page = page) => p.locator(".conversation-heading h2");
const row = (name: string, p: Page = page) =>
  p.locator(".thread-list .thread", { hasText: name });
const threadParam = (p: Page = page) =>
  new URL(p.url()).searchParams.get("thread");

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
        BOOTSTRAP_NAME: "Inbox Host",
        BOOTSTRAP_WORKSPACE: "Inbox checks",
      },
      stdio: "pipe",
    },
  );

  const { db, tenant } = await import("../../src/server/db");
  const { encrypt, seal } = await import("../../src/server/crypto");
  const workspace = await db.workspace.findFirstOrThrow();
  const user = await db.user.findFirstOrThrow();
  const ctx = {
    workspaceId: workspace.id,
    actorId: user.id,
    role: "HOST" as const,
  };
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
  await tenant(ctx, async (tx) => {
    const listing = await tx.listing.create({
      data: {
        workspaceId: workspace.id,
        name: "Inbox cabin",
        address: "Browser test address",
        timezone: "UTC",
        houseManualEncrypted: seal({}, workspace.id),
      },
    });
    const conversation = async (
      guest: string,
      updatedAt: Date,
      messages: { body: string; sender?: string; status?: string }[],
      airbnb = false,
    ) => {
      const reservation = await tx.reservation.create({
        data: {
          workspaceId: workspace.id,
          listingId: listing.id,
          source: airbnb ? "IMPORTED" : "DIRECT",
          platform: airbnb ? "AIRBNB" : "DIRECT",
          sourceReservationKey: airbnb ? "browser-" + guest : null,
          startDate: new Date("2026-11-02"),
          endDate: new Date("2026-11-05"),
          guestNameEncrypted: encrypt(guest, workspace.id),
          currency: "USD",
          firstObservedAt: new Date(),
        },
      });
      const thread = await tx.thread.create({
        data: {
          workspaceId: workspace.id,
          listingId: listing.id,
          reservationId: reservation.id,
          externalId: "browser-" + guest,
          platform: airbnb ? "AIRBNB" : "DIRECT",
          status: airbnb ? "RESOLVED" : "NEEDS_REPLY",
          updatedAt,
        },
      });
      await tx.message.createMany({
        data: messages.map((m, i) => ({
          workspaceId: workspace.id,
          threadId: thread.id,
          bodyEncrypted: encrypt(m.body, workspace.id),
          sender: m.sender ?? "GUEST",
          status: m.status ?? "RECEIVED",
          createdAt: new Date(
            updatedAt.getTime() - (messages.length - i) * 60_000,
          ),
        })),
      });
      return thread.id;
    };
    ids.ada = await conversation(
      "Ada Guest",
      minutesAgo(1),
      Array.from({ length: 60 }, (_, i) => ({
        body: `Ada message ${i}`,
        ...(i % 2 ? { sender: "HOST", status: "SENT" } : {}),
      })),
    );
    ids.ben = await conversation("Ben Guest", minutesAgo(2), [
      { body: "Is there parking?" },
      { body: "Queued reply to Ben", sender: "HOST", status: "QUEUED" },
    ]);
    ids.cy = await conversation(
      "Cy Guest",
      minutesAgo(3),
      [{ body: "Thanks for everything" }],
      true,
    );
    for (let i = 1; i <= 12; i++)
      ids.filler = await conversation(
        `Guest ${String(i).padStart(2, "0")}`,
        minutesAgo(10 + i),
        [{ body: `Question from guest ${i}` }],
      );
  });
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
  "the Inbox opens on the latest conversation at its newest message",
  { skip },
  async () => {
    await page.goto(`${base}/login`);
    await page.fill("input[name=email]", EMAIL);
    await page.fill("input[name=password]", PASSWORD);
    await page.click("button[type=submit]");
    await page.waitForURL(/\/(overview|calendar)/);
    await page.goto(`${base}/inbox`);
    await heading().getByText("Ada Guest").waitFor();
    assert.equal(
      threadParam(),
      ids.ada,
      "the chosen conversation is in the URL",
    );
    await page
      .locator(".messages")
      .getByText("Ada message 59", { exact: true })
      .waitFor();
    const atBottom = await page
      .locator(".messages")
      .evaluate((box) => box.scrollHeight - box.scrollTop - box.clientHeight);
    assert.ok(atBottom < 2, "opens scrolled to the newest message");
    assert.equal(
      await page.getByText("Ada message 9", { exact: true }).count(),
      0,
      "only the newest page is loaded",
    );
  },
);

test(
  "earlier messages load above without moving what the host is reading",
  { skip },
  async () => {
    const box = page.locator(".messages");
    await box.evaluate((el) => (el.scrollTop = 0));
    const anchor = page.getByText("Ada message 10", { exact: true });
    const before = (await anchor.boundingBox())!;
    await page.getByRole("button", { name: "Show earlier messages" }).click();
    await page.getByText("Ada message 0", { exact: true }).waitFor();
    const after = (await anchor.boundingBox())!;
    assert.ok(
      Math.abs(after.y - before.y) < 3,
      `the message being read stayed put (${before.y} → ${after.y})`,
    );
    await page
      .getByRole("button", { name: "Show earlier messages" })
      .waitFor({ state: "detached" });
    assert.equal(await page.locator(".messages .message").count(), 60);
  },
);

test(
  "a late answer for the previous conversation never replaces the chosen one, and a reply goes to the one shown",
  { skip },
  async () => {
    // Hold the next refresh of Ada's conversation until after switching.
    let held: Route | undefined;
    let arrived!: () => void;
    const holding = new Promise<void>((resolve) => (arrived = resolve));
    const matcher = (url: URL) => url.pathname === `/api/threads/${ids.ada}`;
    await page.route(matcher, async (route) => {
      held = route;
      arrived();
    });
    await holding;
    await row("Ben Guest").click();
    await heading().getByText("Ben Guest").waitFor();
    await held!.continue().catch(() => {
      // Aborted by the app when the host switched: the answer never lands.
    });
    await page.unroute(matcher);
    await page.waitForTimeout(800);
    assert.equal(await heading().textContent(), "Ben Guest");
    assert.equal(threadParam(), ids.ben);

    await page.locator("#reply").fill("Parking is behind the house.");
    const [request] = await Promise.all([
      page.waitForRequest(
        (r) => r.method() === "POST" && r.url().includes("/reply"),
      ),
      page.getByRole("button", { name: "Send reply" }).click(),
    ]);
    assert.ok(
      request.url().endsWith(`/api/threads/${ids.ben}/reply`),
      "the reply goes to the conversation on screen",
    );
    await page.getByText("Parking is behind the house.").waitFor();
  },
);

test("a queued reply is shown as not sent yet", { skip }, async () => {
  const queued = page.locator(".message.queued", {
    hasText: "Queued reply to Ben",
  });
  await queued.getByText(/Queued, not sent yet/).waitFor();
  assert.equal(await queued.getByText(/\bSent\b/).count(), 0);
});

test(
  "drafts stay with their conversation, and sending clears only the words that were sent",
  { skip },
  async () => {
    await page.locator("#reply").fill("Draft for Ben");
    await row("Ada Guest").click();
    await heading().getByText("Ada Guest").waitFor();
    assert.equal(await page.locator("#reply").inputValue(), "");
    await page.locator("#reply").fill("Draft for Ada");
    await row("Ben Guest").click();
    await heading().getByText("Ben Guest").waitFor();
    assert.equal(await page.locator("#reply").inputValue(), "Draft for Ben");
    await row("Ada Guest").click();
    await heading().getByText("Ada Guest").waitFor();
    assert.equal(await page.locator("#reply").inputValue(), "Draft for Ada");

    // Keep typing while the reply is on its way: the new words stay.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const matcher = (url: URL) => url.pathname.endsWith("/reply");
    await page.route(matcher, async (route) => {
      await gate;
      await route.continue();
    });
    await page.getByRole("button", { name: "Send reply" }).click();
    await page.getByRole("button", { name: "Queuing…" }).waitFor();
    await page.locator("#reply").press("End");
    await page.locator("#reply").pressSequentially(" P.S.");
    release();
    await page.getByRole("button", { name: "Send reply" }).waitFor();
    await page.unroute(matcher);
    assert.equal(
      await page.locator("#reply").inputValue(),
      "Draft for Ada P.S.",
    );
    await page
      .locator(".message .bubble")
      .getByText("Draft for Ada", { exact: true })
      .waitFor();
  },
);

test(
  "a send whose answer was lost can be retried without sending twice",
  { skip },
  async () => {
    await page.locator("#reply").fill("See you at four.");
    const keys: string[] = [];
    let first = true;
    const matcher = (url: URL) => url.pathname.endsWith("/reply");
    await page.route(matcher, async (route) => {
      keys.push(route.request().postDataJSON().idempotencyKey);
      if (first) {
        first = false;
        // The server accepts it, but the answer never reaches the browser.
        await route.fetch();
        await route.fulfill({
          status: 504,
          contentType: "text/html",
          body: "<html>Gateway timeout</html>",
        });
      } else await route.continue();
    });
    await page.getByRole("button", { name: "Send reply" }).click();
    await page.getByText(/Sending the same words again is safe/).waitFor();
    await page.getByRole("button", { name: "Send reply" }).click();
    await page.getByText(/Reply queued/).waitFor();
    await page.unroute(matcher);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1], "the retry reuses the request key");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.waitForTimeout(500);
    assert.equal(
      await page
        .locator(".message .bubble")
        .getByText("See you at four.", { exact: true })
        .count(),
      1,
      "sent once",
    );
  },
);

test(
  "a failed background refresh keeps the conversation and says it may be out of date",
  { skip },
  async () => {
    const matcher = (url: URL) => url.pathname === `/api/threads/${ids.ada}`;
    await page.route(matcher, (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporarily unavailable." }),
      }),
    );
    await page.locator(".stale-notice").waitFor({ timeout: 15_000 });
    assert.equal(await heading().textContent(), "Ada Guest");
    assert.equal(
      await page.locator(".conversation-pane .error-box").count(),
      0,
      "no error replaces the conversation",
    );
    await page.unroute(matcher);
    await page.locator(".stale-notice").getByRole("button").click();
    await page.locator(".stale-notice").waitFor({ state: "detached" });
  },
);

test(
  "new filters mark the list as updating and never offer the old results",
  { skip },
  async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const matcher = (url: URL) =>
      url.pathname === "/api/threads" &&
      url.searchParams.get("platform") === "AIRBNB";
    await page.route(matcher, async (route) => {
      await gate;
      await route.continue();
    });
    await page.getByLabel("Filter inbox by platform").selectOption("AIRBNB");
    await page.locator(".thread-list.updating[aria-busy=true]").waitFor();
    await page.getByText("Updating…").waitFor();
    await row("Ben Guest").dispatchEvent("click");
    assert.equal(threadParam(), ids.ada, "stale rows cannot be opened");
    release();
    await page.locator(".thread-list.updating").waitFor({ state: "detached" });
    await page.unroute(matcher);
    assert.equal(await page.locator(".thread-list .thread").count(), 1);
    // The chosen conversation is not among the results, so the first is.
    await heading().getByText("Cy Guest").waitFor();

    await page.getByLabel("Filter inbox by status").selectOption("NEEDS_REPLY");
    await page.getByText("Nothing matches these filters.").waitFor();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await row("Ada Guest").waitFor();
    const url = new URL(page.url());
    assert.equal(url.searchParams.get("platform"), null);
    assert.equal(url.searchParams.get("status"), null);
  },
);

test(
  "on a phone the list and a conversation take turns, and Back returns to the list where it was",
  { skip },
  async () => {
    const phone = await browser!.newContext({
      viewport: { width: 390, height: 844 },
      storageState: await desktop!.storageState(),
      timezoneId: "UTC",
      locale: "en-US",
    });
    try {
      const small = await phone.newPage();
      watch(small);
      await small.goto(`${base}/inbox`);
      await row("Guest 08", small).waitFor();
      assert.equal(threadParam(small), null, "no conversation is chosen");
      assert.equal(await small.locator(".conversation-pane").count(), 0);

      await row("Guest 08", small).scrollIntoViewIfNeeded();
      const listY = await small.evaluate(() => window.scrollY);
      assert.ok(listY > 0, "the list scrolled");
      await row("Guest 08", small).click();
      await heading(small).getByText("Guest 08").waitFor();
      assert.ok(await small.locator(".thread-list").isHidden());
      await small.getByRole("button", { name: "All conversations" }).waitFor();
      assert.ok(threadParam(small));

      await small.goBack();
      await row("Guest 08", small).waitFor();
      assert.equal(threadParam(small), null);
      assert.ok(
        Math.abs((await small.evaluate(() => window.scrollY)) - listY) < 3,
        "the list is back where it was",
      );
      assert.equal(
        await small.evaluate(() => document.activeElement?.textContent ?? ""),
        await row("Guest 08", small).textContent(),
        "focus returns to the conversation's row",
      );

      await row("Guest 08", small).click();
      await small.getByRole("button", { name: "All conversations" }).click();
      await row("Guest 08", small).waitFor();
      assert.equal(threadParam(small), null);

      // Arriving straight in a conversation: Back goes to the list.
      await small.goto(`${base}/inbox?thread=${ids.ben}`);
      await heading(small).getByText("Ben Guest").waitFor();
      await small.goBack();
      await row("Ben Guest", small).waitFor();
      assert.equal(new URL(small.url()).pathname, "/inbox");
      assert.equal(threadParam(small), null);
      const widths = await small.evaluate(() => ({
        page: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }));
      assert.ok(widths.page <= widths.viewport, "no sideways scrolling");
    } finally {
      await phone.close();
    }
  },
);

test(
  "the phone navigation drawer is skipped while closed and holds focus while open",
  { skip },
  async () => {
    const phone = await browser!.newContext({
      viewport: { width: 390, height: 844 },
      storageState: await desktop!.storageState(),
      timezoneId: "UTC",
      locale: "en-US",
    });
    try {
      const small = await phone.newPage();
      watch(small);
      await small.goto(`${base}/inbox`);
      const menu = small.getByRole("button", { name: "Open navigation" });
      await menu.waitFor();
      const inDrawer = () =>
        small.evaluate(() => !!document.activeElement?.closest(".sidebar"));

      await menu.focus();
      await small.keyboard.press("Shift+Tab");
      assert.equal(await inDrawer(), false, "a closed drawer is skipped");

      // Opened from the keyboard, as a keyboard user would.
      await menu.focus();
      await small.keyboard.press("Enter");
      assert.equal(await menu.getAttribute("aria-expanded"), "true");
      await small.waitForFunction(
        () => !!document.activeElement?.closest(".sidebar"),
      );
      assert.equal(await small.locator("main#main[inert]").count(), 1);
      for (let i = 0; i < 16; i++) {
        await small.keyboard.press(i % 4 === 3 ? "Shift+Tab" : "Tab");
        assert.equal(await inDrawer(), true, "focus stays in the drawer");
      }
      await small.keyboard.press("Escape");
      await small.waitForFunction(
        () => !document.querySelector(".workspace.mobile-open"),
      );
      assert.equal(
        await small.evaluate(() =>
          document.activeElement?.getAttribute("aria-label"),
        ),
        "Open navigation",
        "focus returns to the menu button",
      );
      assert.equal(await menu.getAttribute("aria-expanded"), "false");
      assert.equal(await small.locator("main#main[inert]").count(), 0);
    } finally {
      await phone.close();
    }
  },
);

test("no unexpected browser errors or failed requests", { skip }, async () => {
  // Expected: the failures these checks cause on purpose.
  const unexpected = problems.filter(
    (p) =>
      !/^http 500 GET \/api\/threads\//.test(p) &&
      !/^http 504 POST \/api\/threads\/.*\/reply$/.test(p) &&
      !/^console: Failed to load resource: .* (500|504) /.test(p),
  );
  assert.deepEqual(unexpected, []);
});
