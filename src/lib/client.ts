export class APIError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
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
