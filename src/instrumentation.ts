import * as Sentry from "@sentry/nextjs";
import { scrubEvent } from "@/lib/redact";
export async function register() {
  if (process.env.SENTRY_DSN)
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      sendDefaultPii: false,
      tracesSampleRate: 0.05,
      // SEC 03: errors and sampled transactions (whose spans include outgoing
      // calendar requests) are scrubbed before they leave the server.
      beforeSend: (event) => scrubEvent(event),
      beforeSendTransaction: (event) => scrubEvent(event),
    });
}
export const onRequestError = Sentry.captureRequestError;
