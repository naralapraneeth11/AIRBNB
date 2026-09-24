import * as Sentry from "@sentry/nextjs";
export async function register() {
  if (process.env.SENTRY_DSN)
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      sendDefaultPii: false,
      tracesSampleRate: 0.05,
      beforeSend(event) {
        delete event.user;
        delete event.request;
        delete event.breadcrumbs;
        if (event.exception)
          for (const v of event.exception.values || [])
            v.value = v.type || "Application error";
        return event;
      },
    });
}
export const onRequestError = Sentry.captureRequestError;
