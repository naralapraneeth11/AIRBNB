# Integration contracts

External providers are configured by the operator. The repository does not include provider credentials, an approved OTA partner account, or a hosted bridge. Missing configuration produces a visible failure or human-review state, not a fabricated successful delivery.

## Calendar feeds

Each property connects one calendar per platform account in Properties → Channels. A connection normally works both ways: the application **imports** the platform's export link, and gives back an **export link** made for that platform to import. A connection without an import link is export-only, for example an all-channel link for a destination that only reads calendars. Two accounts on the same platform are two connections; event identity is scoped to its connection (DATA 02).

### Capabilities

The reviewed capability table in `src/domain/calendar/capabilities.ts` ships with the code and is versioned with each release (`CAPABILITIES_VERSION`). Only what it marks as supported appears as a product action.

| Platform        | Import link                                 | Export link | Notes                                                                                                   |
| --------------- | ------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| Airbnb          | `airbnb.com` and its regional domains       | Yes         | Airbnb imports external calendars about every 3 hours; checking more often here cannot change that      |
| Vrbo            | `vrbo.com`                                  | Yes         | Import horizon and account eligibility differ from Airbnb                                               |
| Booking.com     | `booking.com` (where the account offers it) | Yes         | Every closed date reads "CLOSED - Not available", so stays and closures cannot be told apart (CLASS 02) |
| Expedia         | Unavailable                                 | No          | Kept unavailable until a supported route is verified (D04)                                              |
| Google Calendar | `google.com`                                | Yes         | A manual availability source; its events start unclassified                                             |
| Other calendar  | Any public HTTPS host                       | Yes         | A manual availability source; its events start unclassified                                             |

`ICAL_ALLOWED_HOSTS` optionally restricts Google and other calendars to listed hostnames (comma-separated; `*.example.com` permits subdomains but not the bare domain). Platform links are always checked against the table's exact registrable domains.

No label rule is verified yet (see [RELEASE_GATES.md](RELEASE_GATES.md#recorded-exceptions)), so each import connection asks its host once how its blocks count (CLASS 02): all guest reservations, all owner closures, by label, or classify each block individually. Until the host answers, blocks stay Unknown: protected, with no turnover work. The answer is stored with who gave it, when, and the sample of events shown, and can be changed at any time.

### Fetching

The fetcher identifies itself as `Hostsphere-CalendarFetcher/1.0 (+<APP_URL>/fetcher)`; the `/fetcher` page explains what it is and gives `FETCHER_CONTACT` (FETCH 02). It:

- accepts only HTTPS on port 443 without URL credentials; a plaintext link is offered its HTTPS form and never fetched;
- resolves the host, refuses private, loopback, link-local and other reserved addresses, and connects to the resolved address it checked;
- follows at most three redirects, validating every hop by the same rules;
- applies one deadline across DNS, redirects and the body, and a size limit after decompression;
- sends conditional requests (`If-None-Match`, `If-Modified-Since`) and honors `Retry-After` on 429 and 503 without ever retrying earlier;
- checks each connection about every 15 minutes (5 near a stay) with jitter, backs off after failures from 5 to 60 minutes, and stays within a per-platform budget per scheduler tick. A manual "Check now" is limited to once a minute.

Use the platform's own export link. Do not route feeds through proxies or disguise the client to evade a platform's limits.

### What a check means

A check is an observation, not the platform's reservation ledger (INT 02). Feeds may omit guests, hide cancellation reasons, shorten their date range or include owner closures. The engine therefore never releases dates on its own: a failed, partial, empty or suddenly shrunken feed can add protection but not remove it; a stay absent from two complete, healthy checks at least 15 minutes apart is sent to the host; an explicit cancellation waits for the host too; and a stay beyond the calendar's current range is never read as cancelled. Each connection shows what its last check observed, the dates its source covers, when it last succeeded and when the next check is due. "Some events need review" and "Could not check; existing dates remain protected" are results, not errors to hide.

Raw feed bodies and event descriptions are not stored. Each check keeps a bounded, encrypted comparison snapshot and counts.

### Export links

Each connection's export link serves every protected date of its property except that destination's own stays; their buffer days are kept. Every event reads "Unavailable" with dates and a stable opaque UID: `<blockId>@airbnb-automation`, and `<blockId>-pre@airbnb-automation` / `-post@airbnb-automation` for buffer days. That format is frozen (D15). The UIDs are recognized when a platform echoes them back: this property's own are excluded, an unknown one stays protected for review. Nothing in an export names a guest, price, contact or code.

An export link is a bearer capability. Only its token hash is stored. Responses carry a strong `ETag` and answer `If-None-Match` with 304 and `HEAD` without a body. Each request is recorded by class (body, not modified, head, revoked token, unavailable), which is what the connection detail shows as "Retrieved through this link". That is evidence a client fetched a version, not that the platform applied it (EXPORT 02). Confirm both directions in each platform account.

Rotating an export link (owner only) revokes its token generation immediately; requests with the old token are counted for 90 days so you can see whether a platform still uses it. While a workspace is in calendar shadow mode, export links answer 503 "not active yet" with `Retry-After`, so platforms keep their current calendars.

## Authorized native-messaging bridge

Airbnb, Vrbo, Expedia, and Booking.com integrations need an authorized provider that can receive guest messages and send replies through the appropriate platform. Configure one bridge per workspace/platform in Settings → Native guest messaging. Its outbound endpoint must be on `MESSAGING_ALLOWED_HOSTS`. Use a unique random shared HMAC secret of at least 32 characters per integration.

The bridge owns OTA authentication, provider-specific API formats, thread identity, and permitted message delivery. It must keep credentials server-side, validate platform webhook signatures before normalization, enforce deduplication, and maintain a mapping between the platform reservation and the application's `bookingId`. Calendar import alone does not establish that mapping.

### Inbound: bridge → application

```http
POST /api/webhooks/messages
Content-Type: application/json
X-STR-Timestamp: <Unix seconds>
X-STR-Signature: <lowercase HMAC-SHA256 hex>
```

```json
{
  "eventId": "provider-event-unique-id",
  "workspaceId": "application-workspace-id",
  "platform": "AIRBNB",
  "threadId": "provider-thread-id",
  "bookingId": "existing-application-booking-id",
  "body": "Where can we park?",
  "sentAt": "2026-09-22T18:30:00.000Z"
}
```

`bookingId` is the application's reservation ID; the field keeps its name for bridge compatibility. Allowed platforms: `AIRBNB`, `VRBO`, `EXPEDIA`, `BOOKING`, `DIRECT`. IDs are nonempty strings up to 100 characters; message text is nonempty, up to 12,000 characters. Total raw request body must not exceed 64,000 bytes. `sentAt` is an ISO UTC timestamp. The referenced booking must belong to the workspace and match the platform; an existing thread cannot be rebound to another booking.

Compute the signature over the **exact UTF-8 bytes transmitted**, with no subsequent JSON reformatting:

```ts
import { createHmac } from "node:crypto";

const rawBody = JSON.stringify(payload);
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac("sha256", sharedSecret)
  .update(timestamp + "." + rawBody)
  .digest("hex");
```

The application rejects timestamps outside a five-minute window, invalid signatures, disabled integrations, invalid bodies, or mismatched bookings. A successfully persisted event returns HTTP **202** with `{ "id": "application-message-id" }`; this acknowledges ingestion, not an eventual reply. On a retry, reuse the same `eventId` and content, but sign with a current timestamp. Deduplication is scoped to the workspace/thread/event ID. Do not reuse one event ID for different messages.

Rules and AI evaluate asynchronously after persistence. A missing rule, missing manual fact, disabled automation, sensitive intent, provider error, or insufficient confidence leaves work for the host. A 202 response never promises an automatic guest answer.

### Outbound: application → bridge

The application sends a signed HTTPS POST to the configured endpoint:

```http
Content-Type: application/json
Idempotency-Key: <stable outbox key>
X-STR-Timestamp: <Unix seconds>
X-STR-Signature: <HMAC-SHA256 over timestamp + "." + raw body>
```

```json
{
  "threadId": "provider-thread-id",
  "body": "Parking is available in the marked space beside the entrance.",
  "idempotencyKey": "send:application-message-id"
}
```

The bridge must verify the signature with a constant-time comparison, reject expired timestamps, authorize the thread, and durably deduplicate by the idempotency key **before** performing the external send. A repeated key must return the original receipt, not create another message. Use the same timestamp/signature construction as inbound.

After the actual provider accepts the message, return a 2xx JSON response:

```json
{ "messageId": "provider-message-receipt-id" }
```

The timeout is 10 seconds. Non-2xx status, an absent string `messageId`, malformed JSON, or an interrupted request causes an uncertain delivery state. Do not return a fictional receipt just because a request entered an untracked local queue. Preserve enough provider evidence to distinguish accepted, rejected, and unknown outcomes.

The application does not automatically retry an uncertain irreversible send. A host reviews provider logs in Activity, then confirms delivery, cancels, or explicitly retries. “Sent” and “Delivered” in the application currently record **provider acceptance**, not recipient reading or a channel delivery-status webhook. The bridge should not interpret them as a read receipt.

### Direct guest email

Create a direct reservation from the calendar with the property, guest, email, dates, and optional price. An overlap with protected dates or buffer days is shown first and must be acknowledged; saving then opens an overlap case instead of rejecting either stay (MANUAL 01, CONFLICT 01). The backend encrypts guest fields, creates the conversation, and exports the reservation's protected dates. `POST /api/bookings` accepts the same host-authorized workflow with a UUID idempotency key; it is not an unauthenticated public booking engine or payment processor.

For `DIRECT` threads, outbound replies go to the reservation's encrypted email address via Resend rather than the native bridge. Configure a verified `EMAIL_FROM` and `RESEND_API_KEY`; the outbox key is passed as Resend's `Idempotency-Key`.

A direct-booking guest's inbound email still needs an adapter that verifies the email provider webhook, maps the email conversation to the application reservation, and sends the signed normalized inbound event above. Direct reservations use their application reservation ID as the external thread ID. The app is not an IMAP mailbox or an email-deliverability service. Configure a `DIRECT` integration to authorize those inbound events; its outbound endpoint is not used for direct email replies.

## Cleaner SMS

Set all three Twilio variables, including an SMS-capable E.164 `TWILIO_FROM_NUMBER`. Cleaner phone numbers must be E.164. Confirm that the account and destination comply with the provider's actual permissions and delivery requirements.

Assignment queues an SMS containing an expiring job capability in the URL fragment. The cleaner explicitly redeems it; a link-preview GET does not consume it. A token can be redeemed once and becomes a secure HTTP-only cookie. The portal also lists today's authorized assignments using each property's local date and permits switching the active task. Reassignment revokes previous job links. Acceptance and current automation settings govern code release per task.

Twilio's returned SID records provider acceptance. There is no delivery-status callback or automated SMS resend on ambiguous failures in this release. Use the SID and Twilio logs to reconcile an uncertain action. If a link was consumed on a different browser or expired, reassign the task to issue a fresh capability.

## AI

Set `OPENAI_API_KEY` server-side and select an available model supporting the structured reply format with `OPENAI_MODEL` (default `gpt-4.1-mini`). The implementation uses Chat Completions with a strict reply schema and a maximum 4.5-second request timeout. Provider access, model availability, and billing belong to the operator's account.

Only unmatched eligible messages reach the AI after ordered rules. The request contains the guest's message and structured property manual. The app records an encrypted export audit, prompt, response, model, sources, and confidence. Inform your users of this provider processing and configure account-level retention appropriately.

AI confidence is a model estimate, not calibrated proof of correctness. Sensitive categories, manual takeover, current category controls, source support, and the configured threshold gate dispatch. Keep unfamiliar or high-risk content in manual review; keyword-based hard blocks do not constitute a guarantee of understanding every language, obfuscation, or safety scenario.

The command palette uses rules first and OpenAI only for otherwise-unrecognized intent. It previews a parsed action and requires confirmation before a date mutation.

## Web push and monitoring

Generate a VAPID key pair using the installed `web-push` CLI, store the public/private values and a valid `VAPID_SUBJECT`, then enable host push in Settings from a supporting browser. No guest details or door codes are placed in push text. In-app notifications remain available when push is unsupported or declined. Expired push endpoints are removed on 404/410 responses.

Sentry is opt-in. Server events strip user/request/breadcrumb context and redact exception values; do not add guest bodies, tokens, codes, or feed URLs to telemetry. Set up an independent uptime monitor against `/api/health` and operational alerts on scheduler health and stale feeds. The health route verifies database reachability, not every provider's availability.
