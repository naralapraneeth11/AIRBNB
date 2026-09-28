import * as Sentry from "@sentry/nextjs";
import { scrubEvent } from "@/lib/redact";
if (process.env.NEXT_PUBLIC_SENTRY_DSN)
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    // SEC 03: the browser's copy of an export link must never reach telemetry.
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
  });
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
