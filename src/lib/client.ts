export class APIError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    /** Structured, non-sensitive context, e.g. an overlap preview. */
    public details?: unknown,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: { method?: string; data?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch("/api/" + path, {
    method: options.method || "GET",
    headers:
      options.data instanceof FormData
        ? undefined
        : { "Content-Type": "application/json" },
    body:
      options.data === undefined
        ? undefined
        : options.data instanceof FormData
          ? options.data
          : JSON.stringify(options.data),
    signal: options.signal,
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) {
    if (
      response.status === 401 &&
      !path.startsWith("auth") &&
      !path.startsWith("cleaner") &&
      typeof window !== "undefined"
    )
      window.location.assign("/login");
    throw new APIError(
      data.error || "The request failed.",
      response.status,
      data.code,
      data.details,
    );
  }
  return data;
}
export const label = (s: string) =>
  s
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^\w/, (x) => x.toUpperCase());
export const dateTime = (v: string, zone?: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(zone ? { timeZone: zone } : {}),
  }).format(new Date(v));
export const money = (n: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(n);
export const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** "2 minutes ago" style wording for observed times (EXPORT 02 table). */
export function ago(value: string, now = Date.now()) {
  const seconds = Math.round((now - Date.parse(value)) / 1000);
  if (seconds < 45) return "moments ago";
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
  ];
  const format = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
  const [size, unit] =
    seconds < 3600 ? units[0] : seconds < 86400 ? units[1] : units[2];
  return format.format(-Math.round(seconds / size), unit);
}
/** Relative wording for a future time, e.g. "in 12 minutes". */
export function until(value: string, now = Date.now()) {
  const seconds = Math.round((Date.parse(value) - now) / 1000);
  if (seconds <= 30) return "now";
  const format = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
  return seconds < 3600
    ? format.format(Math.round(seconds / 60), "minute")
    : seconds < 86400
      ? format.format(Math.round(seconds / 3600), "hour")
      : format.format(Math.round(seconds / 86400), "day");
}
