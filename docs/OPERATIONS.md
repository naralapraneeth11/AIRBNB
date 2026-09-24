# Operations and security

## Trust boundaries

Hosts and co-hosts authenticate with a password and a 12-hour server-backed session. Passwords use salted scrypt; only session-token hashes are stored. Cookies are HTTP-only, SameSite Strict, and Secure in production. Mutating browser requests require the configured application origin. Authentication and API request rates are limited in PostgreSQL.

Owners can manage team membership, integration configuration, export-token rotation, and sensitive audit snapshots. Co-hosts operate their workspace but cannot grant access or change native integrations. Cleaners receive an expiring capability and see their assigned operational work without guest contact details or pricing. Server authorization is required regardless of hidden or disabled UI controls.

Operational tables enforce forced PostgreSQL row-level security using transaction-local workspace scope. Composite foreign keys prohibit cross-workspace parent references. Global authentication/capability lookup tables exist outside tenant RLS and must remain inaccessible to browser database clients. RLS protects against an omitted workspace filter; it does not make a leaked application database credential safe, since a server credential can set its own workspace context.

AES-256-GCM encrypts guest identity/contact fields, message bodies, door codes, property manuals, cleaner phone numbers, feed URLs, bridge credentials, push subscriptions, outbox payloads, and detailed audit snapshots. Workspace IDs are authenticated encryption context; identity records use a separate identity scope. Listing names, addresses, operational dates/statuses, and audit summaries are not all encrypted columns. Database/storage/provider access controls remain necessary.

Guest reads and exports at the application boundary generate audit entries. Sensitive prompt snapshots require an explicit owner request. Audit logs and domain events are append-only under database triggers; runtime grants should also prohibit mutation of those tables. This is not an externally signed, tamper-proof ledger against a database administrator.

## What can be stopped or reversed

| Action                        | Operator control                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Queued automated work         | Global pause, category controls, manual takeover, or cancel before dispatch                                            |
| Manual calendar block         | Explicitly remove the block; export feeds then reflect the change                                                      |
| Response draft                | Edit, dismiss, or approve; a draft does not send itself unless the configured automation has queued it                 |
| Cleaner assignment            | Reassign before work is in progress; previous capabilities are revoked                                                 |
| Verified cleaning             | Reopen to Done for another host verification                                                                           |
| Provider-accepted message/SMS | Cannot be recalled; investigate and send a human correction if needed                                                  |
| External reservation          | Resolve with the platform/guest, then record the confirmed outcome in this application                                 |
| Door code already revealed    | Access can be revoked in the application, but knowledge cannot be recalled; rotate the physical lock's code separately |

The app controls code disclosure, not physical smart-lock provisioning. It does not silently cancel an OTA booking. Global pause is checked again before dispatch, but cannot retract a network request already handed to a provider. Calendar ingestion and operational alerts continue while guest/cleaning automation is paused.

## Daily operational checks

Review red/stale calendar indicators, unresolved conflicts, jobs nearing checkout without cleaner acceptance, and Activity's uncertain actions. Confirm the scheduler is still invoking cron, not only that the website loads. Keep the structured manual accurate: deterministic rules can only answer from the facts entered there.

Sync color represents the currently observed import freshness. Green is under five minutes; a normally polling source older than an hour becomes delayed; errors, never-synced feeds, and sources past `SYNC_STALE_MINUTES` become attention states. Source polling targets 60–120 seconds in healthy operation; failures back off up to 15 minutes. Do not interpret a green import dot as confirmation that another platform has refreshed its calendar import.

Review revenue price coverage before acting on reports. Unknown iCal prices are omitted, not counted as zero. Revenue is allocated proportionally to nights in the selected period; it is not a payment ledger, tax report, fee calculation, or FX conversion. Sync “uptime” means successful recorded import polls. Cleaning turnaround measures scheduled checkout/task time to host verification, not only hands-on cleaner time.

## Incident playbooks

### Automation sends something unexpected

Pause automation immediately and enable manual takeover on the conversation. Inspect the action's explanation, rule, manual source, and owner-accessible AI snapshot. Cancel pending actions in Activity. Check provider receipts before marking uncertain outcomes or retrying. Amend the rule/manual, review recent related messages, and resume in draft mode first.

### Calendar conflict or disappearing booking

Keep both reservations' dates protected. The earliest available confirmation is preferred internally; conflicting reservations remain visible. Verify the outcome with the actual platform and guest before choosing Keep, Dismiss, or Confirm removal. A feed disappearing or failing is not proof of cancellation. Adjust buffer days to account for platform refresh delays.

### Cleaner is missing or declines

Reassign from Cleaning before checkout. Prior links are revoked. If acceptance is delayed past the deadline, the host receives an actionable alert. A paused cleaning category prevents queued automated SMS; resume only after confirming the intended assignment. If an accepted cleaner cannot reveal a code while automation is paused, the host can explicitly release access for that accepted task.

### Photo or storage failure

Keep the task unverified. Check the private bucket, server credentials, quotas, and provider status. Retry the actual photo upload; host verification requires stored evidence. If an upload succeeds at the object store but the database update fails, the application attempts compensating object deletion. A periodic orphan-object review is still an operator responsibility.

### Worker dies during delivery

Expired leases return safe internal evaluation/push work to pending. External sends are marked Unknown and require provider reconciliation. No process can atomically commit to PostgreSQL and an independent SMS/OTA provider; the application therefore preserves uncertainty instead of declaring success or blindly duplicating a message. Record provider evidence when confirming delivery or explicitly retrying.

### User loses a password

Verify identity outside the app. In the controlled administrative environment, set `RECOVERY_EMAIL` and `RECOVERY_PASSWORD` (at least 14 characters), with the owner `DIRECT_URL`, then run:

```sh
pnpm reset:password
```

The script updates the password, revokes all sessions for the account, and appends a recovery audit in its workspaces. Remove recovery variables immediately afterward. There is no self-service email recovery or multi-factor authentication flow in this release.

## Keys, backups, and recovery

Back up PostgreSQL and private photo objects with an operator-defined retention policy. Back up the complete encryption keyring and stable authentication secret separately using a secret manager; a database backup without its encryption keys cannot restore encrypted data. Exercise restoration in an isolated environment before relying on backups.

To rotate encryption for **new writes**, add a new 32-byte key under a new identifier in `ENCRYPTION_KEYS` and change `ENCRYPTION_KEY_ID`. Retain previous keys as long as ciphertext or backups reference them. The package does not include bulk re-encryption/retirement tooling; removing old keys immediately makes old records unreadable.

`AUTH_SECRET` is used for keyed identity lookup hashes, not only sessions. Do not replace it casually: a coordinated re-index of user email and guest identity hashes is required for rotation. Session tokens have independent random values; password changes and membership revocation can invalidate sessions without replacing `AUTH_SECRET`.

Rotating a master feed token does not rotate channel-specific feed tokens. Reconnect a channel to rotate that channel's export capability. Rotate bridge HMAC secrets on both sides together. Provider credential rotation and door-lock code rotation require the corresponding external service.

## Observability and retention

Operational history includes audit reasons, domain transitions, sync runs, notifications, outbox status/attempts/provider IDs, and request correlation IDs. `/api/health` checks database reachability. Optional Sentry reports errors; cron logs report cycle duration. Configure external alerts on sustained health failures, stale feed timestamps, recurring Unknown actions, and growing pending backlog.

To debug a cleaning task using its immutable events:

```sh
pnpm events:replay <workspace-id> <cleaning-task-id>
```

This reconstructs the task's state timeline, compares the final event projection to its current database state, flags discontinuities, and appends an audit record of the inspection. Exit code 2 indicates a mismatch/discontinuity; exit code 1 indicates a failure. It does not mutate the task or replay SMS, message delivery, or door-code release. Investigate discrepancies before making an explicit, audited state correction.

Cron removes expired host sessions and aged rate-limit entries. It does **not** implement a broad guest-data retention policy, audit deletion, magic-link purging, photo lifecycle deletion, or an administrative subject-erasure workflow. Define those requirements before storing regulated production data and add a reviewed archival/retention process; append-only audit tables intentionally cannot be casually deleted by the runtime role.

## Capacity and validation limits

The HTTP, recurrence, body-size, image, and query limits bound common abuse and memory exposure. They are not a portfolio-scale capacity guarantee. The scheduler processes bounded batches; calendar views return at most 2,000 records, thread lists 200, thread messages 500, and the workspace bootstrap at most 500 nearby tasks. Insights flags its 20,000-poll sample cap. Large histories need explicit pagination/aggregation work before those caps are appropriate for the business.

Rules evaluation below one second and AI suggestions below five seconds are product targets. An AI request itself times out at 4.5 seconds, but queue wait, cold starts, database latency, provider transit, and available worker budget add end-to-end latency. Establish measured SLOs with your deployment rather than treating those targets as achieved benchmarks.

Focus-visible states, semantic controls, modal focus behavior, keyboard navigation, responsive layouts, and reduced-motion handling are implemented. A complete screen-reader, contrast, device, and assistive-technology audit has not been certified. Provider-connected end-to-end, penetration, and load tests require an operator-controlled staging environment.
