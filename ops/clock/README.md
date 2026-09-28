# External scheduler clock

The application does not schedule itself. An external clock calls the
authenticated tick at `POST /api/cron` once a minute (ARCH 03). The tick claims
bounded durable work under a single scheduler lease, records what advanced and
what remains, and releases the lease (OPS 01). Because of the lease, a second
clock or the long-running `pnpm worker` can run alongside without doing work
twice; an overlapping call is recorded as `SKIPPED_OVERLAP`.

`vercel.json` declares no cron jobs: how often Vercel Cron may run depends on
the plan, and calendar protection needs a one-minute cadence. This Cloudflare
Worker is that clock. Any scheduler that can send an authenticated HTTPS
request every minute is an acceptable replacement; it needs no other logic.

## Deploy

1. Generate a distinct `CRON_SECRET` per environment and set it in the
   application's environment (Vercel project settings).
2. Edit `wrangler.toml`: set `name` and `APP_URL` for the environment. Keep one
   Worker per environment; a clock never spans production and staging.
3. From this directory:

   ```sh
   npx wrangler@latest secret put CRON_SECRET
   npx wrangler@latest deploy
   ```

4. Confirm a tick is recorded: `GET /api/health/operations?check=heartbeat`
   with `Authorization: Bearer $MONITOR_SECRET` returns `200` within two
   minutes.

## Monitor

Heartbeat and work progress are separate signals. Configure two HTTP monitors
(any uptime service that alerts on a non-200 status) against the operations
health endpoint, both sending `Authorization: Bearer $MONITOR_SECRET`:

| Monitor             | URL                                        | Fails when                                                                                                                                                                                           |
| ------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduler heartbeat | `/api/health/operations?check=heartbeat`   | no tick recorded for 5 minutes (`OPS_HEARTBEAT_MAX_MINUTES`)                                                                                                                                         |
| Work progress       | `/api/health/operations?check=progress`    | no tick completed for 15 minutes, or due calendar checks or outbox actions were more than 30 minutes overdue when the last tick finished (`OPS_PROGRESS_MAX_MINUTES`, `OPS_BACKLOG_MAX_LAG_MINUTES`) |
| Backup freshness    | `/api/health/operations?check=backups`     | any of Postgres, storage or key backups lacks a verified success in 26 hours (`OPS_BACKUP_MAX_AGE_HOURS`)                                                                                            |
| Environment         | `/api/health/operations?check=environment` | the database's environment marker does not match `APP_ENVIRONMENT`                                                                                                                                   |

The endpoint returns only timestamps and counts. It never returns tenant data.
