# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's private
vulnerability reporting: open this repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue, pull request, or
discussion for a security problem, and do not include real guest data, feed
URLs, export tokens, or door codes in a report.

Include what you observed, the steps or request that reproduce it, the affected
commit or deployment, and the impact you believe it has. We aim to acknowledge a
report within five business days. This is a small team, so there is no
around-the-clock response commitment.

## Scope

In scope: this repository's application code, database migrations and row-level
security, the calendar import/export endpoints, cleaner links, authentication,
and the scheduler and operational endpoints.

Out of scope: third-party platforms (Airbnb, Vrbo, Booking.com, Expedia, Google),
volumetric denial of service, and findings that require a compromised device or
leaked administrator credentials.

## Handling secrets

Feed URLs, export tokens, cleaner links, guest messages, access codes and photo
URLs are treated as secrets or personal data (SEC 03). If you believe one has
been exposed, follow the "Leaked feed or cleaner token" runbook in
`docs/OPERATIONS.md`: revoke the affected token generation, issue a replacement
through the authenticated flow, and guide the host through reconnecting.

## Maintainer setup

Private vulnerability reporting must be enabled in the repository settings
(Settings → Code security → Private vulnerability reporting). This is tracked as
a Phase 0 item in `docs/RELEASE_GATES.md`.
