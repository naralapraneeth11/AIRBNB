// SEC 03: secrets in URLs never reach telemetry, whatever carries them.
import assert from "node:assert/strict";
import test from "node:test";
import { redactText, scrubEvent } from "../src/lib/redact";

const FEED =
  "https://www.airbnb.com/calendar/ical/12345678.ics?s=0123456789abcdef";
const EXPORT =
  "/api/listings/l1/export.ics?workspace=w1&token=SECRET-TOKEN-VALUE&source=c1";

test("feed URLs keep only their origin and queries are dropped", () => {
  assert.equal(
    redactText(`GET ${FEED}`),
    "GET https://www.airbnb.com/[redacted]",
  );
  assert.equal(
    redactText(`GET ${EXPORT}`),
    "GET /api/listings/l1/export.ics?[redacted]",
  );
  assert.equal(
    redactText("webcal://calendar.example.test/private/abc.ics"),
    "webcal://calendar.example.test/[redacted]",
  );
  assert.equal(redactText("no secrets here"), "no secrets here");
});

test("errors and transactions are scrubbed before they are sent", () => {
  const event = scrubEvent({
    message: `Could not load ${FEED}`,
    transaction: `GET ${EXPORT}`,
    user: { email: "host@example.test" },
    request: { url: `https://app.test${EXPORT}`, cookies: { session: "x" } },
    breadcrumbs: [{ message: FEED }],
    exception: { values: [{ type: "TypeError", value: `bad ${FEED}` }] },
    spans: [
      {
        description: `GET ${FEED}`,
        data: {
          "url.full": FEED,
          "http.query": "?s=abc",
          "http.method": "GET",
        },
      },
    ],
    contexts: {
      trace: { data: { "http.url": `https://app.test${EXPORT}` } },
    },
  });
  const text = JSON.stringify(event);
  for (const secret of [
    "0123456789abcdef",
    "SECRET-TOKEN-VALUE",
    "12345678.ics",
    "host@example.test",
    "session",
  ])
    assert.equal(text.includes(secret), false, secret);
  assert.equal(event.exception?.values?.[0].value, "TypeError");
  assert.equal(event.spans?.[0].data?.["http.method"], "GET");
  assert.equal(event.request, undefined);
});
