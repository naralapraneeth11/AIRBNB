# Operations and security

## Trust boundaries

Hosts and co-hosts authenticate with a password and a 12-hour server-backed session. Passwords use salted scrypt; only session-token hashes are stored. Cookies are HTTP-only, SameSite Strict, and Secure in production. Mutating browser requests require the configured application origin. Authentication and API request rates are limited in PostgreSQL (eight sign-in attempts per address per 15 minutes).

Owners can manage team membership, integration configuration, export-link rotation, and sensitive audit snapshots. Co-hosts operate their workspace but cannot grant access or change native integrations. Cleaners receive an expiring capability and see their assigned operational work without guest contact details or pricing. Server authorization is required regardless of hidden or disabled UI controls.

Operational tables enforce forced PostgreSQL row-level security using transaction-local workspace scope. Composite foreign keys prohibit cross-workspace and cross-property references. Global authentication and capability lookup tables exist outside tenant RLS and must remain inaccessible to browser database clients. RLS protects against an omitted workspace filter; it does not make a leaked application database credential safe, since a server credential can set its own workspace context.

Each database records the environment it belongs to, and the application refuses tenant data from any other environment (SEC 04): a preview or staging deployment cannot read or write production data, and production cannot serve a staging database.

AES-256-GCM encrypts guest identity and contact fields, message bodies, door codes, property manuals, cleaner phone numbers, calendar feed URLs, comparison snapshots, bridge credentials, push subscriptions, outbox payloads, and detailed audit snapshots. Workspace IDs are authenticated encryption context; identity records use a separate identity scope. Export-link tokens are stored only as hashes. Listing names, addresses, operational dates and statuses, and audit summaries are not encrypted columns; database, storage and provider access controls remain necessary.

Guest reads and exports at the application boundary generate audit entries. Sensitive prompt snapshots require an explicit owner request. Audit logs and domain events are append-only under database triggers and runtime grants, and calendar and cleaning history cannot be deleted by routine work. This is not an externally signed, tamper-proof ledger against a database administrator.

## How the calendar protects dates

Each connected calendar is checked about every 15 minutes, and every 5 minutes when an arrival or departure is within three days. A check is an observation, not the platform's ledger:

- A check that fails, is partial, comes back empty, or loses more than half of its future stays can add protection but never remove it. It is shown as needing review.
- A stay missing from one complete, healthy check is marked missing; if a second such check at least 15 minutes later still lacks it, the host is asked. Nothing reopens until the host decides. Stays that have already ended are not watched.
- A stay beyond the last date a calendar currently shows is never treated as cancelled.
- Blocks a platform does not describe reliably stay **Unknown** until the host answers that connection's policy question: protected, with no cleaning scheduled.
- Overlapping protected dates open one overlap case per pair; both stay protected until the host records what they did.

Each export link is specific to one destination: it leaves out that destination's own stays, keeps their buffer days, and includes everything else. A platform decides when it imports a link, often hours later; a check here never proves what a platform shows.

## What can be stopped or reversed

| Action                        | Operator control                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Queued automated work         | Global pause, category controls, manual takeover, or cancel before dispatch                                                                     |
| Calendar decisions            | Return the workspace to shadow mode (`pnpm calendar:mode <workspace-id> SHADOW --reason …`): new decisions stop affecting exports and turnovers |
| Reopened (released) dates     | Restore within 24 hours as a new hold. Restoring cannot recall a platform refresh that already reopened the dates, or a booking made meanwhile  |
| Hold                          | Reopen it from its detail view; the same 24-hour restore applies                                                                                |
| Classification or buffer days | Change them again from the block's detail view; the change is audited and the evidence kept                                                     |
| Connection policy answer      | Change it from the connection's detail view; blocks are reclassified and the change is audited                                                  |
| Response draft                | Edit, dismiss, or approve; a draft does not send itself unless the configured automation has queued it                                          |
| Cleaner assignment            | Reassign before work is in progress; previous capabilities are revoked                                                                          |
| Verified cleaning             | Reopen to Done for another host verification                                                                                                    |
| Provider-accepted message/SMS | Cannot be recalled; investigate and send a human correction if needed                                                                           |
| External reservation          | Resolve with the platform and guest, then record the confirmed outcome in this application                                                      |
| Door code already revealed    | Access can be revoked in the application, but knowledge cannot be recalled; rotate the physical lock's code separately                          |
| Removed property              | Restore it from Properties → Removed properties; its paused calendar links resume and upcoming stays get new, unassigned cleaning jobs          |

The app controls code disclosure, not physical smart-lock provisioning. It never cancels an OTA booking. Global pause is checked again before dispatch but cannot retract a network request already handed to a provider. Calendar checks and operational alerts continue while guest and cleaning automation is paused.

## Daily operational checks

Start with **Needs your decision** on the calendar: stays waiting for a reopen decision, pending policy questions, unknown or flagged blocks, and overlap cases. Then check jobs nearing checkout without cleaner acceptance, and Activity's uncertain actions. Confirm the scheduler monitors are green, not only that the website loads. Keep the structured manual accurate: deterministic rules can only answer from the facts entered there.

Each connection shows the result of its last check (no changes, availability updated, some events need review, or could not check), when it last succeeded, and when the next check is due or overdue. A connection not checked successfully for `SYNC_STALE_MINUTES` (default 240) raises a daily alert once the workspace is live. Failures back off from 5 to 60 minutes; a calendar's `Retry-After` is always honored, and a delay beyond six hours pauses the connection until reviewed. A healthy result never means another platform has imported this application's export link.

Review revenue price coverage before acting on reports. Unknown iCal prices are omitted, not counted as zero. Revenue is allocated proportionally to nights in the selected period; it is not a payment ledger, tax report, fee calculation or FX conversion. Check reliability is the share of calendar checks that produced a usable result, not how quickly a platform refreshes its copy. Cleaning turnaround measures scheduled checkout to host verification, not only hands-on cleaner time.

## Shadow review

New workspaces run in calendar shadow mode (REL 01). Decisions are recorded, export links answer "not active yet", and alerts and turnover changes are withheld. After seven representative days:

```sh
pnpm calendar:shadow-report <workspace-id> --days 7 --markdown
```

The report lists, without guest details or secrets, every connection's checks and results and every item to adjudicate: decisions awaiting the host, unknown classifications, flagged evidence, overlaps, and checks that could not complete. Compare each against the platform's own calendar and the agreed fixtures, not against the older engine. Record each wrong decision with its fix and regression test in [RELEASE_GATES.md](RELEASE_GATES.md#shadow-review), then go live with `pnpm calendar:mode <workspace-id> LIVE --reviewed <link>`.

## Incident runbooks

### Scheduler stopped

The heartbeat or progress monitor fails. Check the clock (`ops/clock`) and its `CRON_SECRET`, recent deploys, and the latest `SchedulerTick` rows: a recent tick with a growing backlog is a capacity problem, no recent tick is a clock problem. Protection stays in place while ticks stop. Restore the clock; bounded ticks then drain due checks fairly. Verify a few representative connections show a fresh check before closing the incident.

### Platform feeds failing

Determine whether failures are global or specific to one account or platform (the connection detail shows the last results and HTTP status). Respect the platform's retry instructions; never evade limits with proxies or disguised clients. The last known protection stays, and the connection shows its platform and freshness. If a platform changed its export format, capture an export with the host's permission, anonymize it (`pnpm fixtures:anonymize`), and add a fixture and test before changing the parser.

### A stay disappeared or was cancelled

The dates stay protected and the host is asked. Check the platform: if the stay is truly cancelled, reopen the dates from the block's detail view, which shows the nights, buffer days, export links and open overlaps affected and asks the host to confirm the platform. The stay's turnover is cancelled if work had not started, and flagged for the host if it had. If the stay comes back in its calendar after being reopened, its dates are protected again and flagged.

### Possible double booking

Preserve both records and their observation history. The overlap case shows the exact overlap and both sources. Handle the guest and the platforms first; this application never cancels a guest reservation to make a conflict disappear. Then record what was done in the overlap case.

### Leaked feed or cleaner token

- **Export link**: rotate it from the connection's detail view (owner only). The old generation stops answering at once and is kept for 90 days to count stale-link hits, so you can see whether a platform still uses it. Import the new link into that platform.
- **A platform's import link** (the feed URL this application reads): regenerate it in the platform's calendar settings, then use "Replace the calendar link" on the connection. The old URL is discarded; feed URLs are encrypted at rest and reduced to their origin in logs.
- **Cleaner link**: reassign the task; previous links are revoked. Revoking a link does not rotate the property's physical access code.

Every rotation and replacement is audited.

### Data or key incident

Restrict access and preserve evidence. Identify the affected workspaces and follow the applicable notification process. Restore into isolation (never over production), reconcile effects that happened after the backup before resuming the clock, and make sure previously sent messages are not replayed.

### Automation sends something unexpected

Pause automation immediately and enable manual takeover on the conversation. Inspect the action's explanation, rule, manual source, and owner-accessible AI snapshot. Cancel pending actions in Activity. Check provider receipts before marking uncertain outcomes or retrying. Amend the rule or manual, review recent related messages, and resume in draft mode first.

### Cleaner is missing or declines

Reassign from Cleaning before checkout. Prior links are revoked. If acceptance is delayed past the deadline, the host receives an actionable alert. A paused cleaning category prevents queued automated SMS; resume only after confirming the intended assignment. If an accepted cleaner cannot reveal a code while automation is paused, the host can explicitly release access for that accepted task.

### Photo or storage failure

Keep the task unverified. Check the private bucket, server credentials, quotas and provider status. Retry the actual photo upload; host verification requires stored evidence. If an upload succeeds at the object store but the database update fails, the application attempts compensating object deletion. A periodic orphan-object review is still an operator responsibility.

### Worker dies during delivery

Expired leases return safe internal work to pending. External sends are marked Unknown and require provider reconciliation. No process can atomically commit to PostgreSQL and an independent SMS or OTA provider; the application preserves uncertainty instead of declaring success or blindly duplicating a message. Record provider evidence when confirming delivery or explicitly retrying. A calendar check interrupted mid-run cannot commit after its lease expires; the next tick repeats it.

### A property was removed

Only the workspace owner can remove a property, after typing its name. Removal changes nothing on any platform. It pauses the property's calendar links (they are not fetched, and their export links answer 404 rather than an empty calendar), cancels cleaning work that has not begun, holds unsent replies as drafts, and hides the property everywhere. It waits while a cleaning started in the last 12 hours is under way. History is kept; nothing is deleted.

If it was a mistake, the owner restores it from Properties → Removed properties. Only the links the removal paused come back on (a link the host had switched off stays off), they are checked straight away, and upcoming stays get new cleaning jobs that need a cleaner; cancelled jobs stay cancelled, and their cleaners were told when cleaning automation was on. The removed list shows any platform still requesting a paused link; remove the link in that platform's calendar settings. Removal is not erasure: there is no subject-erasure workflow yet (see [Observability and retention](#observability-and-retention)).

### User loses a password

When email is configured, the user resets it themselves from "Forgot your password?" on the sign-in page. The link works once for 30 minutes, the new password must meet the policy, and every session is signed out.

Without email, or if the user no longer controls the address, verify identity outside the app. In the controlled administrative environment, set `RECOVERY_EMAIL` and `RECOVERY_PASSWORD` (at least 14 characters), with the owner `DIRECT_URL`, then run:

```sh
pnpm reset:password
```

The script updates the password, revokes all sessions for the account, and appends a recovery audit in its workspaces. Remove the recovery variables immediately afterward. There is no multi-factor authentication yet (AUTH 02).

## Backups and restore

Three nightly GitHub Actions jobs (`.github/workflows/backup.yml`) back up Postgres, storage objects and encryption keys through separate paths and credentials (REC 01). Each job records its outcome in `BackupRun`, and `GET /api/health/operations?check=backups` fails when any path lacks a verified success in 26 hours.

| Path     | What runs                                                                                                  | Verified by                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Postgres | `pg_dump` as the backup role (`prisma/grants/backup-role.sql`), which can write only its own evidence rows | A full `pg_restore` into an empty scratch database                  |
| Storage  | Every stored photo downloaded with the storage service key                                                 | Each object's SHA-256 matches the one recorded when it was uploaded |
| Keys     | The escrowed copy of `ENCRYPTION_KEYS`, kept outside the hosting provider                                  | It decrypts a real ciphertext of every key version in use           |

Artifacts are encrypted before they are written: a fresh AES-256-GCM key per artifact, wrapped with RSA-OAEP-SHA256 to the backup public key. The private key never touches CI.

**Setup.**

1. Generate the key pair on an offline machine and store the private key offline (for example, a password manager's secure note and a sealed copy):

   ```sh
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out backup-private.pem
   openssl pkey -in backup-private.pem -pubout -out backup-public.pem
   ```

2. Create the backup role (see [DEPLOYMENT.md](DEPLOYMENT.md#7-backups)) and an S3-compatible bucket with write-only credentials for the jobs.
3. In the repository, create a `backups` environment. Add the secrets `BACKUP_DATABASE_URL`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `ESCROW_ENCRYPTION_KEYS`, and the variables `BACKUP_PUBLIC_KEY` (the PEM), `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `SUPABASE_URL`, `STORAGE_BUCKET` and `PG_MAJOR` (the server's major version).
4. Set the repository variable `BACKUPS_ENABLED` to `true`, run the workflow once by hand, and confirm `check=backups` returns 200.

**Restore** (always into an isolated environment, never over production):

```sh
# BACKUP_PRIVATE_KEY_FILE names the offline private key.
pnpm backup decrypt postgres-<stamp>.dump.enc restore.dump
pg_restore --no-owner --no-privileges --dbname "$RESTORE_URL" restore.dump
```

Then apply `prisma/grants/runtime-role.sql` and mark the restored database with its own environment. For photos, decrypt `storage-manifest-<stamp>.json.enc`, then decrypt each `objects/<sha256>.enc` and upload it to its `storageKey` in the restored environment's private bucket. Configure the escrowed keys last. Reimporting calendar feeds cannot recover holds, decisions, assignments, drafts, audit history or photos; only the backup can.

**Drill.** Before relying on backups, restore the latest artifacts into an isolated environment, time it, compare row counts, open a photo, decrypt one record, and record the result in [RELEASE_GATES.md](RELEASE_GATES.md#backups-and-restore-drill). The proposed beta objectives (24-hour recovery point, 4-hour recovery time) need that drill and owner acceptance (D09).

## Keys

To rotate encryption for **new writes**, add a new 32-byte key under a new identifier in `ENCRYPTION_KEYS` and change `ENCRYPTION_KEY_ID`, then update the escrow. Keep previous keys as long as any ciphertext or backup references them; the key backup job fails if the escrow cannot decrypt a version in use. There is no bulk re-encryption tooling yet; removing an old key makes old records unreadable.

`AUTH_SECRET` is used for keyed identity lookup hashes, not only sessions. Do not replace it casually: rotating it requires a coordinated re-index of user email and guest identity hashes. Session tokens are independent random values; password changes and membership revocation invalidate sessions without replacing `AUTH_SECRET`.

Rotate bridge HMAC secrets on both sides together. Provider credential rotation and door-lock code rotation happen in the corresponding external service.

## Observability and retention

Operational history includes audit reasons, domain transitions, calendar observations and decisions, scheduler ticks, notifications, outbox status and provider IDs, and request correlation IDs. `/api/health` checks database reachability; `/api/health/operations` reports heartbeat, work progress, backup freshness and environment separately for external monitors. Optional Sentry reports errors after feed URLs, tokens and request details are scrubbed.

To debug a cleaning task using its immutable events:

```sh
pnpm events:replay <workspace-id> <cleaning-task-id>
```

This reconstructs the task's state timeline, compares the final projection to its current database state, flags discontinuities, and appends an audit record of the inspection. Exit code 2 indicates a mismatch or discontinuity; exit code 1 indicates a failure. It never mutates the task or replays SMS, message delivery or door-code release.

Bounded retention (DATA 03), enforced by the scheduler:

| Record                   | Kept                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| Calendar observations    | 30 days; each connection's newest observation and its comparison snapshots are kept regardless of age |
| Export retrievals        | 14 days                                                                                               |
| Revoked export tokens    | 90 days, to count stale-link hits                                                                     |
| Scheduler ticks          | 14 days                                                                                               |
| Sessions and rate limits | Until expiry                                                                                          |

Raw feed bodies and event descriptions are never stored. There is no broad guest-data retention policy, audit deletion, photo lifecycle deletion or subject-erasure workflow yet. Define those before storing regulated production data; append-only audit tables intentionally cannot be deleted by the runtime role.

## Capacity and validation limits

HTTP, recurrence, body-size, image and query limits bound common abuse and memory exposure. They are not a portfolio-scale capacity guarantee. A scheduler tick runs for at most 48 seconds under a 58-second lease, with per-platform budgets. The calendar view returns at most 2,000 date ranges per window and says when it is capped; "Needs your decision" lists at most 300 items. Thread lists return 200, thread messages 500, and the workspace bootstrap at most 500 nearby tasks. No load test has been run.

Rules evaluation below one second and AI suggestions below five seconds are product targets. An AI request itself times out at 4.5 seconds, but queue wait, cold starts, database latency and provider transit add latency. Establish measured objectives in your deployment rather than treating targets as achieved benchmarks.

Focus-visible states, semantic controls, modal focus behavior, keyboard navigation, responsive layouts and reduced-motion handling are implemented, and CI drives the calendar in Chromium at desktop and phone widths. A complete screen-reader, contrast, device and assistive-technology audit has not been performed. Provider-connected end-to-end, penetration and load tests require an operator-controlled staging environment.
