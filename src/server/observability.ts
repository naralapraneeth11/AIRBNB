import * as Sentry from "@sentry/nextjs";
export function reportError(error: unknown, requestId: string) {
  console.error(
    JSON.stringify({
      level: "error",
      event: "request_failed",
      requestId,
      errorType: error instanceof Error ? error.name : "Unknown",
    }),
  );
  Sentry.captureException(error, { tags: { requestId } });
}
