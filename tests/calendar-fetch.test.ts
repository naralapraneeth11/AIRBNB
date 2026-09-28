// FETCH 01-02: URL rules, SSRF protections, redirects, deadline, size bounds
// and conditional requests. Network policy is tested with an injected resolver
// and transport; the real TLS transport is exercised against a local server.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import zlib from "node:zlib";
import {
  checkFeedUrl,
  createHttpsTransport,
  fetchFeed,
  isPublicAddress,
  readBounded,
  type Resolver,
  type Transport,
} from "../src/server/calendar/fetch";

const PUBLIC: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];
const calendar = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
const ok =
  (body = calendar, headers = {}): Transport =>
  async () => ({
    status: 200,
    headers,
    body: Buffer.from(body),
  });

test("FETCH 01: only HTTPS on 443 without credentials; plaintext is offered an HTTPS form, never used", () => {
  const webcal = checkFeedUrl(
    "webcal://www.airbnb.com/calendar/ical/1.ics?s=abc",
    "AIRBNB",
  );
  assert.deepEqual(webcal, {
    ok: false,
    code: "HTTPS_REQUIRED",
    suggestion: "https://www.airbnb.com/calendar/ical/1.ics?s=abc",
  });
  assert.equal(
    checkFeedUrl("http://www.vrbo.com/icalendar/x.ics", "VRBO").ok,
    false,
  );
  assert.equal(
    checkFeedUrl("https://user:pw@www.airbnb.com/x.ics", "AIRBNB").ok,
    false,
  );
  assert.equal(
    checkFeedUrl("https://www.airbnb.com:8443/x.ics", "AIRBNB").ok,
    false,
  );
  assert.equal(checkFeedUrl("ftp://www.airbnb.com/x.ics", "AIRBNB").ok, false);
  assert.equal(checkFeedUrl("not a url", "AIRBNB").ok, false);
});

test("FETCH 01: exact registrable-domain rules per platform; other hosts get the same protections", () => {
  assert.equal(
    checkFeedUrl("https://www.airbnb.com/calendar/ical/1.ics", "AIRBNB").ok,
    true,
  );
  assert.equal(
    checkFeedUrl("https://www.airbnb.co.uk/calendar/ical/1.ics", "AIRBNB").ok,
    true,
  );
  assert.equal(
    checkFeedUrl("https://airbnb.com.evil.example/x.ics", "AIRBNB").ok,
    false,
  );
  assert.equal(
    checkFeedUrl("https://evilairbnb.com/x.ics", "AIRBNB").ok,
    false,
  );
  assert.equal(
    checkFeedUrl("https://www.vrbo.com/x.ics", "AIRBNB").ok,
    false,
    "platform label must match the host",
  );
  assert.equal(
    checkFeedUrl("https://admin.booking.com/hotel/ical.html?t=1", "BOOKING").ok,
    true,
  );
  assert.equal(
    checkFeedUrl(
      "https://calendar.google.com/calendar/ical/x/basic.ics",
      "GOOGLE",
    ).ok,
    true,
  );
  assert.equal(
    checkFeedUrl("https://ical.example.org/feed.ics", "OTHER").ok,
    true,
  );
  assert.equal(
    checkFeedUrl("https://www.expedia.com/x.ics", "EXPEDIA").ok,
    false,
    "Expedia is unavailable",
  );
  const saved = process.env.ICAL_ALLOWED_HOSTS;
  try {
    process.env.ICAL_ALLOWED_HOSTS = "ical.example.org";
    assert.equal(
      checkFeedUrl("https://ical.example.org/feed.ics", "OTHER").ok,
      true,
    );
    assert.equal(
      checkFeedUrl("https://elsewhere.example.net/feed.ics", "OTHER").ok,
      false,
    );
    assert.equal(
      checkFeedUrl("https://www.airbnb.com/x.ics", "AIRBNB").ok,
      true,
    );
  } finally {
    if (saved === undefined) delete process.env.ICAL_ALLOWED_HOSTS;
    else process.env.ICAL_ALLOWED_HOSTS = saved;
  }
});

test("FETCH 01: private, loopback, link-local, mapped and carrier-grade addresses are blocked", () => {
  for (const blocked of [
    "10.1.2.3",
    "127.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "172.16.0.1",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::ffff:127.0.0.1",
    "fd00::1",
    "fe80::1",
    "224.0.0.1",
    "not-an-ip",
  ])
    assert.equal(isPublicAddress(blocked), false, blocked);
  for (const allowed of ["93.184.216.34", "2606:4700:4700::1111"])
    assert.equal(isPublicAddress(allowed), true, allowed);
});

test("FETCH 01: a host resolving to any private address is never contacted", async () => {
  let called = false;
  const result = await fetchFeed("https://ical.example.org/feed.ics", {
    platform: "OTHER",
    userAgent: "test",
    resolve: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ],
    transport: async () => {
      called = true;
      return { status: 200, headers: {}, body: Buffer.from(calendar) };
    },
  });
  assert.equal(
    result.kind === "FAILED" && result.code,
    "FETCH_ADDRESS_BLOCKED",
  );
  assert.equal(called, false);
});

test("FETCH 01: redirects are validated hop by hop and limited to three", async () => {
  const redirects = (targets: string[]): Transport => {
    let i = 0;
    return async () =>
      i < targets.length
        ? { status: 302, headers: { location: targets[i++] }, body: null }
        : { status: 200, headers: {}, body: Buffer.from(calendar) };
  };
  const follow = await fetchFeed("https://www.airbnb.com/a.ics", {
    platform: "AIRBNB",
    userAgent: "test",
    resolve: PUBLIC,
    transport: redirects([
      "/b.ics",
      "https://www.airbnb.co.uk/c.ics",
      "https://www.airbnb.com/d.ics",
    ]),
  });
  assert.equal(follow.kind, "BODY");
  const tooMany = await fetchFeed("https://www.airbnb.com/a.ics", {
    platform: "AIRBNB",
    userAgent: "test",
    resolve: PUBLIC,
    transport: redirects(["/1", "/2", "/3", "/4"]),
  });
  assert.equal(
    tooMany.kind === "FAILED" && tooMany.code,
    "FETCH_REDIRECT_LIMIT",
  );
  const downgrade = await fetchFeed("https://www.airbnb.com/a.ics", {
    platform: "AIRBNB",
    userAgent: "test",
    resolve: PUBLIC,
    transport: redirects(["http://www.airbnb.com/a.ics"]),
  });
  assert.equal(
    downgrade.kind === "FAILED" && downgrade.code,
    "FETCH_REDIRECT_BLOCKED",
  );
  const offPlatform = await fetchFeed("https://www.airbnb.com/a.ics", {
    platform: "AIRBNB",
    userAgent: "test",
    resolve: PUBLIC,
    transport: redirects(["https://attacker.example/steal"]),
  });
  assert.equal(
    offPlatform.kind === "FAILED" && offPlatform.code,
    "FETCH_REDIRECT_BLOCKED",
  );
  const toPrivate = await fetchFeed("https://ical.example.org/a.ics", {
    platform: "OTHER",
    userAgent: "test",
    resolve: async (host) => [
      {
        address: host === "internal.example" ? "10.0.0.9" : "93.184.216.34",
        family: 4,
      },
    ],
    transport: redirects(["https://internal.example/metadata"]),
  });
  assert.equal(
    toPrivate.kind === "FAILED" && toPrivate.code,
    "FETCH_ADDRESS_BLOCKED",
  );
});

test("FETCH 02: conditional requests, 304, and Retry-After on 429 and 503", async () => {
  let seen: Record<string, string> = {};
  const notModified = await fetchFeed("https://www.airbnb.com/a.ics", {
    platform: "AIRBNB",
    userAgent: "Hostsphere-CalendarFetcher/1.0 (+https://app.example/fetcher)",
    etag: '"v1"',
    lastModified: "Sun, 27 Sep 2026 10:00:00 GMT",
    resolve: PUBLIC,
    transport: async ({ headers }) => {
      seen = headers;
      return { status: 304, headers: { etag: '"v1"' }, body: null };
    },
  });
  assert.equal(notModified.kind, "NOT_MODIFIED");
  assert.equal(seen["If-None-Match"], '"v1"');
  assert.equal(seen["If-Modified-Since"], "Sun, 27 Sep 2026 10:00:00 GMT");
  assert.match(
    seen["User-Agent"],
    /^Hostsphere-CalendarFetcher\/1\.0 \(\+https:/,
  );
  const now = Date.parse("2026-09-27T10:00:00Z");
  for (const [status, code] of [
    [429, "FETCH_RATE_LIMITED"],
    [503, "FETCH_UNAVAILABLE"],
  ] as const) {
    const limited = await fetchFeed("https://www.airbnb.com/a.ics", {
      platform: "AIRBNB",
      userAgent: "test",
      resolve: PUBLIC,
      now: () => now,
      transport: async () => ({
        status,
        headers: { "retry-after": "3600" },
        body: null,
      }),
    });
    assert.deepEqual(limited, {
      kind: "FAILED",
      code,
      status,
      retryAfterMs: now + 3_600_000,
    });
  }
});

test("FETCH 01: one deadline covers DNS, redirects and the body", async () => {
  const slowDns = await fetchFeed("https://www.airbnb.com/a.ics", {
    platform: "AIRBNB",
    userAgent: "test",
    deadlineMs: 40,
    resolve: () =>
      new Promise((r) =>
        setTimeout(() => r([{ address: "93.184.216.34", family: 4 }]), 500),
      ),
    transport: ok(),
  });
  assert.equal(slowDns.kind === "FAILED" && slowDns.code, "FETCH_TIMEOUT");
  const slowBody = await fetchFeed("https://www.airbnb.com/a.ics", {
    platform: "AIRBNB",
    userAgent: "test",
    deadlineMs: 40,
    resolve: PUBLIC,
    transport: () => new Promise(() => {}),
  });
  assert.equal(slowBody.kind === "FAILED" && slowBody.code, "FETCH_TIMEOUT");
});

test("FETCH 01: the size bound applies after decompression", async () => {
  const small = zlib.gzipSync(Buffer.from(calendar));
  assert.equal(
    (await readBounded(Readable.from([small]), "gzip", 1024)).toString(),
    calendar,
  );
  const bomb = zlib.gzipSync(Buffer.alloc(3 * 1024 * 1024, 65));
  assert.ok(bomb.length < 64 * 1024, "compressed input is small");
  await assert.rejects(
    readBounded(Readable.from([bomb]), "gzip", 2 * 1024 * 1024),
    /FETCH_TOO_LARGE/,
  );
  await assert.rejects(
    readBounded(Readable.from([Buffer.from("x")]), "compress", 1024),
    /FETCH_DECODE/,
  );
  await assert.rejects(
    readBounded(Readable.from([Buffer.alloc(4096)]), undefined, 1024),
    /FETCH_TOO_LARGE/,
  );
});

test("FETCH 01: the TLS transport pins the resolved address and decodes bounded bodies", async (t) => {
  let dir: string;
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    dir = mkdtempSync(path.join(tmpdir(), "fetch-tls-"));
  } catch {
    if (process.env.CI)
      throw new Error("openssl is required for the TLS transport test in CI");
    t.skip("openssl is not installed locally");
    return;
  }
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=feed.test",
        "-addext",
        "subjectAltName=DNS:feed.test",
        "-keyout",
        path.join(dir, "key.pem"),
        "-out",
        path.join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    const cert = readFileSync(path.join(dir, "cert.pem"));
    const server = https.createServer(
      { key: readFileSync(path.join(dir, "key.pem")), cert },
      (req, res) => {
        if (req.url === "/big") {
          res.writeHead(200, { "content-encoding": "gzip" });
          res.end(zlib.gzipSync(Buffer.alloc(3 * 1024 * 1024, 65)));
        } else if (req.url === "/missing") {
          res.writeHead(404);
          res.end("nope");
        } else {
          res.writeHead(200, {
            "content-encoding": "gzip",
            etag: '"abc"',
            "content-type": "text/calendar",
          });
          res.end(zlib.gzipSync(Buffer.from(calendar)));
        }
      },
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const transport = createHttpsTransport({ ca: cert });
    const request = (p: string) =>
      transport({
        url: new URL(`https://feed.test:${port}${p}`),
        address: { address: "127.0.0.1", family: 4 },
        headers: { "Accept-Encoding": "gzip" },
        signal: new AbortController().signal,
        maxBytes: 2 * 1024 * 1024,
      });
    try {
      const good = await request("/feed.ics");
      assert.equal(good.status, 200);
      assert.equal(good.body?.toString(), calendar);
      assert.equal(good.headers.etag, '"abc"');
      await assert.rejects(request("/big"), /FETCH_TOO_LARGE/);
      const missing = await request("/missing");
      assert.deepEqual([missing.status, missing.body], [404, null]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
