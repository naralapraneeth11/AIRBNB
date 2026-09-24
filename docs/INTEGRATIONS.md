# Integration contracts

External providers are configured by the operator. The repository does not include provider credentials, an approved OTA partner account, or a hosted bridge. Missing configuration produces a visible failure or human-review state, not a fabricated successful delivery.

## Calendar feeds

In Properties → Channels, connect each channel's HTTPS export-calendar URL. Add that URL's exact hostname to `ICAL_ALLOWED_HOSTS` first. Entries are comma-separated; `*.example.com` permits subdomains but not the bare `example.com`. The default list is a starting configuration, not a claim that every platform account offers calendar export at those hosts.

The HTTP client accepts HTTPS on port 443, rejects URL credentials, rejects private/reserved DNS destinations, pins the resolved address, does not follow redirects, limits response size, and times out. Use the provider's final feed URL. Do not broaden the allowlist to arbitrary user-controlled hosts to work around a rejected URL.

Connecting a source returns a channel-specific export URL. Import that URL into the **same** channel. Its availability excludes reservations originating from that channel while preserving buffers, reducing loops. The master export includes all protected dates. Generated UIDs end in `@airbnb-automation` and are ignored when echoed back by a source.

An export URL is a bearer capability. Only its hash is stored; the feed contains “Unavailable,” dates, and stable opaque event IDs—not guest names, prices, contacts, or door codes. Treat URLs as secrets. Rotating a property's master feed invalidates only its master URL. Reconnecting a channel rotates that channel's export token; update the channel import setting afterward.

The importer supports all-day stay ranges, recurrence expansion within a bounded window, exceptions, explicit cancellations, conditional requests, and retries with backoff. A missing reservation remains protected; after two observed missing polls it requires host review. Explicit source cancellation is distinguished from simple disappearance. Confirmation preference uses a feed creation/timestamp value when available, then first observation; iCal cannot prove a confirmation time the source does not provide.

Calendar import success means the app fetched the source successfully. It does not certify that the destination channel has imported the app's most recent feed. Confirm both directions in each actual channel account.

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

Allowed platforms: `AIRBNB`, `VRBO`, `EXPEDIA`, `BOOKING`, `DIRECT`. IDs are nonempty strings up to 100 characters; message text is nonempty, up to 12,000 characters. Total raw request body must not exceed 64,000 bytes. `sentAt` is an ISO UTC timestamp. The referenced booking must belong to the workspace and match the platform; an existing thread cannot be rebound to another booking.

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

Create a direct reservation from the calendar with the property, guest, email, dates, and optional price. The backend checks availability including buffers, encrypts guest fields, creates its conversation, and exports the reservation's protected dates. `POST /api/bookings` accepts the same host-authorized workflow with a UUID idempotency key; it is not an unauthenticated public booking engine or payment processor.

For `DIRECT` threads, outbound replies go to the booking's encrypted email address via Resend rather than the native bridge. Configure a verified `EMAIL_FROM` and `RESEND_API_KEY`; the outbox key is passed as Resend's `Idempotency-Key`.

A direct-booking guest's inbound email still needs an adapter that verifies the email provider webhook, maps the email conversation to the application booking, and sends the signed normalized inbound event above. Direct reservations use their application booking ID as the external thread ID. The app is not an IMAP mailbox or an email-deliverability service. Configure a `DIRECT` integration to authorize those inbound events; its outbound endpoint is not used for direct email replies.

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
