# Calendar fixtures

QA 01 and CLASS 01 require anonymized **real** exports for each advertised
platform, plus synthetic edge cases. Every file here is listed below with its
provenance; `tests/fixtures.test.ts` fails if a file is added without a row
here, or a row names a missing file.

## Provenance

**No real platform export is in this directory yet.** The platform files are
synthetic: they reproduce each platform's documented export shape (property
order, date forms, label text, UID style) with invented identifiers and no
personal data. They exercise the parser and the classification policy flow,
but they do **not** verify any platform's label semantics. Accordingly, every
label rule in `src/domain/calendar/capabilities.ts` has an empty `verifiedBy`
list and only _suggests_ an answer in the host's policy question.

Before the Phase 1 gate, replace each platform file with an export collected
**with the host's permission** and anonymized by:

```sh
pnpm fixtures:anonymize <export.ics> tests/fixtures/platforms/<platform>.ics --platform <PLATFORM>
```

Review the output by eye before committing it, update the row below to
"anonymized real export" with the collection date and account type, and only
then add the fixture name to the matching label rule's `verifiedBy`.

## Files

| File | Source | Exercises |
| --- | --- | --- |
| `platforms/airbnb.ics` | Synthetic, Airbnb host-calendar shape | "Reserved" and "Airbnb (Not available)" labels, descriptions that are never stored, the policy question |
| `platforms/vrbo.ics` | Synthetic, Vrbo shape | "Reserved - …" and "Blocked" labels |
| `platforms/booking.ics` | Synthetic, Booking.com shape | One "CLOSED - Not available" label for stays and closures (CLASS 02) |
| `platforms/google.ics` | Synthetic, Google Calendar shape | Zoned times with a VTIMEZONE, all-day events, weekly recurrence with EXDATE |
| `synthetic/dst.ics` | Synthetic | Fall-back ambiguity and spring-forward gaps in America/Los_Angeles; a 22:00 arrival that keeps its night (DATE 01) |
| `synthetic/leap-day.ics` | Synthetic | Stays across and starting on 29 February; the one-day default |
| `synthetic/duplicate-uid.ics` | Synthetic | Identical duplicates merged; disagreeing duplicates protected for review (ID 01) |
| `synthetic/recurrence.ics` | Synthetic | EXDATE, a moved override keeping its identity, a cancelled instance (ID 01, DATE 02) |
| `synthetic/malformed.ics` | Synthetic | Unreadable dates and a reversed range beside a valid stay (CAL 02) |
| `synthetic/truncated.ics` | Synthetic | A body cut off mid-event (CAL 02) |
| `synthetic/horizon/long.ics` | Synthetic | First of a horizon pair: a stay far in the future |
| `synthetic/horizon/short.ics` | Synthetic | Second of the pair: the far stay is beyond the new horizon, not cancelled (DATE 02) |
| `synthetic/cancellation/confirmed.ics` | Synthetic | A confirmed stay at SEQUENCE 1 |
| `synthetic/cancellation/stale.ics` | Synthetic | An older cancellation (SEQUENCE 0) that must be ignored (LIFE 01) |
| `synthetic/cancellation/cancelled.ics` | Synthetic | A newer cancellation (SEQUENCE 2) that waits for the host (LIFE 01) |
| `synthetic/output-loop.ics` | Synthetic | This app's export UIDs coming back through an import, known and foreign (CLASS 01, EXPORT 01) |
| `synthetic/empty.ics` | Synthetic | A valid but empty calendar (section 10 anomaly) |
| `synthetic/not-calendar.html` | Synthetic | An HTML error page served instead of a calendar |
