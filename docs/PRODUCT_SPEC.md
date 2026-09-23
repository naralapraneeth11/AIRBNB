# Airbnb Automation — Complete Product & Engineering Spec

*One command center for multi-platform short-term rental management. Master calendar as source of truth, automation for cleaning and guest messaging, AI agents layered in once the rules-based version is proven.*

---

## 1. Design Principles

The bar you asked for isn't a style choice, it's a set of constraints:

- **One source of truth, always visible.** The user should never wonder "is this synced?" — sync state is a first-class UI element, not a settings-page afterthought.
- **Restraint over density.** Show the next decision, not all the data. Insights and history are one tap away, not on-screen by default.
- **Every automated action is reversible or confirmable before it's irreversible.** Auto-sending a door code is fine; auto-cancelling a booking is not.
- **Motion communicates state, not decoration.** A calendar cell that just synced settles into place; it doesn't bounce for fun.
- **Trust is earned by showing your work.** Every AI-drafted message, every auto-scheduled cleaning, has a visible "why" (which rule fired, which listing, which booking) one click away.

---

## 2. Product Modules

### 2.1 Master Calendar
- Month/week/agenda views; each day cell shows a colored bar per listing (color = listing, not platform — platform shows as a small icon on the bar).
- Sync status lives *on the calendar itself*: a small dot per listing per day — green (synced <5 min ago), amber (>1 hr, still polling normally), red (feed error, needs attention). No separate dashboard required to notice a problem.
- Hover/tap a booking → slide-over panel: guest name, platform, dates, price, message thread link, cleaning task status — no page navigation.
- Drag to block dates (maintenance, personal use) directly on the grid; blocks sync out like any other booking.
- Buffer-day setting per listing (e.g. no same-day turnover) enforced visually — a blocked buffer shows as a hatched pattern, distinct from a real booking.

### 2.2 Unified Inbox
- One thread list across all platforms and listings, filterable by listing/platform/status (needs reply, AI-drafted, automated, resolved).
- AI-drafted replies appear as a **suggestion chip** under the guest's message — one tap to send as-is, tap to edit, or dismiss. Never auto-sent past a confidence threshold you set (see §8).
- Guest side panel: stay dates, listing, past-stay count if repeat guest, and a plain-language "intent" tag (question / negotiation / complaint / booking-adjacent) so a human scanning the inbox can triage in a glance.
- Manual-takeover toggle per thread — flips automation off for that conversation only; a small badge shows "you're replying manually" so it's unambiguous who's driving.

### 2.3 Cleaning Board
- Kanban: **Needs Scheduling → Assigned → Accepted → In Progress → Done → Verified.**
- Cleaner accepts/declines via a magic-link SMS — no app install required for the cleaner. Accept triggers door-code release automatically.
- "Verified" requires a photo upload from the cleaner before the listing shows as ready; host gets a push only if verification is overdue past checkout+buffer.
- Cleaner portal (their view only): today's jobs, address, door-code-on-accept, a single photo-upload button. Nothing else — keep their surface minimal.

### 2.4 Property Management
- Per-listing: photos, door code (encrypted, masked by default with a reveal tap), house-manual text (used by the automated FAQ responder), platform links + sync status, buffer-day setting.
- "House manual" fields are structured (wifi, checkin instructions, parking, washroom location, house rules) — this structure is what the FAQ automation reads from, not free text it has to parse.

### 2.5 Automation Control Center
- Global kill switch (pause all automation instantly — for when something's misfiring).
- Per-category toggles: cleaning automation, message automation, AI-agent replies — independently switchable.
- Confidence threshold slider for AI replies: below threshold → draft only; above → auto-send. Start conservative, loosen as trust builds.
- Rule list for canned responses (wifi, checkin time, parking, negotiation opener) — editable without touching code.

### 2.6 Insights
- Occupancy heatmap per listing, revenue per listing/period, average response time, sync uptime per platform, cleaning turnaround time.
- No vanity metrics — every number here should be one that changes a decision (raise price, drop a bad-sync platform, replace a slow cleaner).

### 2.7 Command Palette
- Cmd+K, already in your demo — extend it to accept natural-language actions: "block March 5–10 on the lake house", "show unread messages from Expedia". Parse via a small set of intents first (rules), fall back to the LLM only when a rule doesn't match.

### 2.8 Design System
- Keep your current dark-mode-first direction; add a true near-black (`#0a0a0a`) OLED option, not just dark gray.
- One accent color, used sparingly (sync-good state, primary actions only) — resist a second accent for "urgency," use a neutral warning tone instead so the palette stays calm.
- Type: one typeface, two weights (regular/medium), size scale of 4–5 steps. No decorative fonts.
- Motion: 150–200ms ease-out for state changes, nothing longer; skeleton loaders instead of spinners for anything over 300ms.
- Full keyboard navigation on the calendar grid and inbox list; every icon-only button has an accessible label.

---

## 3. Calendar Sync Architecture

No OTA gives indie developers a real-time two-way write API. Every channel manager (Hospitable, Guesty, OwnerRez, Lodgify) uses the same mechanism, and so should you:

- **Export Calendar** — each platform gives a read-only iCal feed of its bookings.
- **Import Calendar** — each platform accepts an external iCal URL and blocks those dates.

```
                 ┌────────────────────┐
                 │   Master Calendar    │  ← source of truth (your DB)
                 └─────────┬─────────────┘
        export ↓                      ↑ import
   ┌──────────┐        ┌──────────┐        ┌──────────┐
   │  Airbnb  │        │  Expedia │        │   Vrbo   │
   └──────────┘        └──────────┘        └──────────┘
        import ↑                     ↓ export
        (your master's URL          (poll their feed
         pasted into each             into your master
         platform's Import field)     calendar)
```

- Poll each platform's export feed every 60–120s from your backend. Platforms refresh *your* imported feed on their own schedule (often 1–4 hrs, no SLA) — design the UI to show that honestly (see sync dots, §2.1) rather than imply real-time.
- Master calendar is the conflict arbiter: earliest-confirmed booking wins automatically; anything else gets flagged for manual resolution, never silently auto-cancelled.
- Buffer days are your main defense against sync-lag double-bookings, not a nice-to-have.

---

## 4. Data Model

```
Listing        { id, name, address, door_code_encrypted, house_manual{}, buffer_days, platform_links[] }
SyncSource     { id, listing_id, platform, direction: import|export, ical_url, last_synced_at, status }
Booking        { id, listing_id, guest_name, guest_contact, start_date, end_date, source_platform, status, price }
CleaningTask   { id, booking_id, cleaner_id, scheduled_date, status, accepted_at, verified_photo_url }
Cleaner        { id, name, phone, listings[] }
Message        { id, booking_id, thread_id, sender, body, automated: bool, ai_confidence, sent_at }
AutomationRule { id, listing_id|global, trigger, condition, action, enabled }
AuditLog       { id, actor, action, entity, timestamp }
```

Build the API around this before touching further UI — your current front end already assumes most of this shape.

---

## 5. API Surface (representative, not exhaustive)

| Area | Endpoints |
|---|---|
| Listings | `GET/POST /listings`, `PATCH /listings/:id`, `GET /listings/:id/sync-status` |
| Calendar | `GET /calendar?range=`, `POST /calendar/block`, `GET /listings/:id/export.ics` (public, per listing) |
| Bookings | `GET /bookings`, `POST /bookings/:id/resolve-conflict` |
| Cleaning | `GET /cleaning-tasks`, `POST /cleaning-tasks/:id/assign`, `POST /cleaning-tasks/:id/verify` |
| Messaging | `GET /threads`, `POST /threads/:id/reply`, `POST /threads/:id/toggle-manual` |
| Automation | `GET/PATCH /automation-rules`, `POST /automation/kill-switch` |
| Insights | `GET /insights/occupancy`, `GET /insights/revenue`, `GET /insights/sync-health` |

---

## 6. Automation Engine

Two separate state machines — keep them decoupled so a bug in one can't take down the other:

**Cleaning workflow:** `booking confirmed → task created (checkout date) → cleaner notified → accepted → in progress → photo verified → listing marked ready`. Each transition is an event you can replay/debug, not a hidden side effect.

**Message rules engine:** simple trigger → condition → action rows (editable in §2.5), evaluated in order, first match wins. Keep this rules layer *before* the AI layer — rules handle the 80% predictable cases (wifi, checkin time, parking) cheaply and deterministically; only unmatched messages go to the AI agent.

---

## 7. AI Agent Layer

- Sits behind the rules engine, not in front of it — rules handle known FAQs, AI handles the long tail.
- Every AI reply carries a confidence score; below your set threshold it's a draft only (shows as the suggestion chip in §2.2), above it, auto-send is allowed if the per-thread automation toggle is on.
- Log the prompt + response + confidence for every AI-drafted message (into `AuditLog`) — this is both a debugging tool and how you'll tune the threshold over time.
- Hard-block categories from auto-send regardless of confidence: anything mentioning refunds, cancellations, safety issues, or legal threats — route straight to a human queue.

---

## 8. Notifications

- Cleaner: SMS (Twilio) — magic link, no app required.
- Host: push (web push or a lightweight native wrapper later) for anything needing manual attention — sync error, unmatched message, overdue cleaning verification.
- Guest: whatever channel they messaged on (Airbnb/Expedia native messaging APIs where available; fall back to email for direct bookings).

---

## 9. Security & Data Protection

- Encrypt door codes and guest PII at rest (Postgres column-level encryption or app-level AES-GCM before insert).
- No third-party analytics/trackers by default.
- `AuditLog` table covers every read/export of guest data, not just writes.
- Role-based access: host, co-host, cleaner each see only their slice (cleaner never sees guest contact info or pricing).
- Skip multi-mode deployment (self-hosted/cloud/hybrid) and a desktop app for now — that's a distraction until you have users asking for it.

---

## 10. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend/Backend | Next.js (App Router), TypeScript | You already know this from Stackr — zero ramp-up |
| Database | Postgres (Supabase or Neon) | Relational fit for this schema, built-in row-level security |
| ORM | Prisma | Fast iteration, type-safe queries |
| Background jobs | Vercel Cron or a small worker (BullMQ if you outgrow cron) | iCal polling doesn't need a heavy queue yet |
| SMS | Twilio | Cleaner magic-links, guest fallback |
| AI | Claude or GPT API, called server-side | No separate inference service needed |
| Monitoring | Sentry (errors) + a simple uptime check on each sync source | Cheap, catches sync failures before guests do |
| Hosting | Vercel | Matches Next.js, minimal ops |

Rust stays out of v1 entirely — iCal polling is I/O-bound text parsing on a handful of feeds, not compute-heavy. Reach for it only if you hit an actual measured bottleneck.

---

## 11. Non-Functional Targets

- Sync poll cycle: 60–120s; surfaced "last synced" honestly, never implying faster than the platform actually allows.
- Zero silent double-bookings: any conflict must produce a visible flag, never an auto-resolution the host doesn't see.
- Inbox reply latency (rules-based): under 1s. AI-drafted suggestion: under 5s to appear.
- Every automated action logged and explainable in one click.

---

## 12. Failure Modes to Design For

- **Platform feed goes stale/errors** → red sync dot, host notification, don't silently trust last-known state past a set staleness window.
- **Cleaner doesn't accept in time** → escalate to host with a reassign option before checkout, not after.
- **Guest asks something the rules + AI both miss** → falls to human queue, never a blank non-response.
- **Two bookings land in the same sync window** → earliest-confirmed wins, other flagged, host resolves manually.

---

## 13. Roadmap

| Phase | Goal | Core work |
|---|---|---|
| 1 | Calendar sync | Master calendar + iCal import/export per listing, sync-status UI, zero double-bookings |
| 2 | Cleaning automation | Auto-create task on checkout → notify cleaner → accept → auto-release door code → photo verify |
| 3 | Guest messaging automation | Rules engine for FAQs/negotiation + manual-takeover toggle |
| 4 | AI agent layer | Confidence-gated AI replies behind the rules engine |
| 5 | Upsells | Extra cleaning requests, stay extensions, rental-purchase flow |

---

## 14. Not Building Yet

Multiple deployment modes, Tauri/desktop app, Redis/NATS job queue, Rust rewrite. All revisit-later — none of them block Phase 1–3, and building them now just delays the part that actually prevents double-bookings and pays for itself (cleaning + messaging automation).
