# Correct folder structure (from ZIP)

Upload files from your unzipped `airbnb-automation` folder into these paths.

## src/components/  (upload these 8 files)
- calendar.tsx
- cleaner-portal.tsx
- cleaning.tsx
- inbox.tsx
- management.tsx
- sign-in.tsx
- ui.tsx          (already done)
- workspace.tsx

## src/lib/  (upload these 3)
- client.ts      (already done)
- domain.ts
- types.ts

## src/server/  (upload these)
- audit.ts
- auth.ts
- config.ts      (already done)
- crypto.ts
- db.ts          (already done)
- errors.ts
- observability.ts
- router.ts
- validation.ts
- integrations/http.ts
- integrations/providers.ts
- services/calendar.ts
- services/cleaning.ts
- services/commands.ts
- services/insights.ts
- services/jobs.ts
- services/messaging.ts
- services/storage.ts

## src/app/
- globals.css    (MUST upload - large CSS file)
- (routes already created)

## Also upload if missing
- .env.example (from ZIP root)
- .github/workflows/ci.yml
