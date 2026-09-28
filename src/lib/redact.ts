// SEC 03: feed URLs, export tokens, cleaner links, guest messages, access
// codes and photo URLs never leave through telemetry. Every error and
// transaction the monitoring SDK would send passes through `scrubEvent`, on
// the server and in browsers. Absolute URLs keep only their origin and every
// query string is dropped, because secrets travel in both: a platform's feed
// path is itself a credential, and export links carry their token in the query.

const ABSOLUTE_URL = /\b(?:https?|webcal):\/\/[^\s"'<>]+/gi;
const QUERY = /\?[^\s"'<>#]*/g;

export function redactText(value: string): string {
  return value
    .replace(ABSOLUTE_URL, (url) => {
      try {
        // `origin` is "null" for webcal:, so build it from its parts.
        const u = new URL(url);
        return `${u.protocol}//${u.host}/[redacted]`;
      } catch {
        return "[redacted-url]";
      }
    })
    .replace(QUERY, "?[redacted]");
}

type Data = Record<string, unknown>;
function scrubData(data: Data | undefined) {
  if (!data) return;
  for (const [key, value] of Object.entries(data))
    if (typeof value === "string") data[key] = redactText(value);
}

/** The event fields this module reads or rewrites (a structural subset). */
export type TelemetryEvent = {
  message?: string;
  transaction?: string;
  user?: unknown;
  request?: unknown;
  breadcrumbs?: unknown;
  exception?: { values?: { type?: string; value?: string }[] };
  spans?: { description?: string; data?: Data }[];
  contexts?: { trace?: { data?: Data; description?: string } } & Data;
};

export function scrubEvent<T extends TelemetryEvent>(event: T): T {
  // Request details carry cookies, query strings and bodies; users are PII.
  delete event.user;
  delete event.request;
  delete event.breadcrumbs;
  // Error text can quote inputs; keep the type, which is enough to triage.
  for (const v of event.exception?.values ?? [])
    v.value = v.type || "Application error";
  if (event.message) event.message = redactText(event.message);
  if (event.transaction) event.transaction = redactText(event.transaction);
  for (const span of event.spans ?? []) {
    if (span.description) span.description = redactText(span.description);
    scrubData(span.data);
  }
  const trace = event.contexts?.trace;
  if (trace) {
    scrubData(trace.data);
    if (trace.description) trace.description = redactText(trace.description);
  }
  return event;
}
