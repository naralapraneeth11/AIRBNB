## Requirements

<!-- Stable identifiers from the specification, e.g. CAL 03, EXPORT 02. -->

## What changed and why

## Acceptance evidence

<!-- Test names, command output, screenshots. A check is passed only when it ran. -->

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`
- [ ] `pnpm test` and `pnpm test:integration`
- [ ] `pnpm build`

## Safety review

- [ ] Cannot release protected availability without a host decision
- [ ] No secrets or personal data in code, fixtures, logs, or screenshots
- [ ] Migrations follow MIG 01 (or the recorded pre-launch exception)
