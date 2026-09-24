"use client";
import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SENTRY_DSN)
      Sentry.captureException(new Error("Application rendering failed"), {
        tags: { digest: error.digest || "unavailable" },
      });
  }, [error]);
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "#101213",
          color: "#edf0ed",
          fontFamily: "system-ui,sans-serif",
        }}
      >
        <main style={{ maxWidth: 600, margin: "12vh auto", padding: 28 }}>
          <h1>Let’s get you back on track.</h1>
          <p>This page could not load. Please try again.</p>
          <button
            onClick={reset}
            style={{
              padding: "12px 20px",
              font: "inherit",
              background: "#adcfbd",
              color: "#11221a",
              border: 0,
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            Reload workspace
          </button>
        </main>
      </body>
    </html>
  );
}
