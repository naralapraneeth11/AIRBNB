// Stage 2 Fetch (FETCH 01-02): bounded, SSRF-safe retrieval of a source feed.
// Every hop is validated: HTTPS only (never a plaintext fallback), no URL
// credentials, port 443, the platform's registrable-domain rule, public
// unicast addresses only, and the address is pinned for the connection.
// One deadline covers DNS, redirects and the body; the body is bounded after
// decompression. Errors map to bounded reason codes and never carry the URL.
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { lookup } from "node:dns/promises";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import ipaddr from "ipaddr.js";
import { hostAllowedForPlatform } from "@/domain/calendar/capabilities";
import type { ReasonCode } from "@/domain/calendar/reasons";
import { parseRetryAfter } from "@/domain/calendar/schedule";
import type { Platform } from "@/domain/calendar/types";
import { allowedHost } from "../integrations/http";

export const FETCH_LIMITS = {
  deadlineMs: 10_000,
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 3,
} as const;

export type UrlCheck =
  | { ok: true; url: URL }
  | {
      ok: false;
      code:
        | "URL_INVALID"
        | "HTTPS_REQUIRED"
        | "CREDENTIALS"
        | "PORT"
        | "HOST_NOT_ALLOWED";
      /** An HTTPS form of a webcal:// or http:// address, offered, never used. */
      suggestion?: string;
    };

/** FETCH 01: validate a feed URL (or a redirect target) for a platform. */
export function checkFeedUrl(raw: string, platform: Platform): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, code: "URL_INVALID" };
  }
  if (url.protocol === "webcal:" || url.protocol === "http:") {
    const suggestion = new URL(url.href.replace(/^(webcal|http):/i, "https:"));
    return { ok: false, code: "HTTPS_REQUIRED", suggestion: suggestion.href };
  }
  if (url.protocol !== "https:") return { ok: false, code: "URL_INVALID" };
  if (url.username || url.password) return { ok: false, code: "CREDENTIALS" };
  if (url.port && url.port !== "443") return { ok: false, code: "PORT" };
  const host = url.hostname.toLowerCase();
  if (!hostAllowedForPlatform(platform, host))
    return { ok: false, code: "HOST_NOT_ALLOWED" };
  // Optional operator restriction for generic calendars; it never exempts a
  // host from the network protections below.
  const extra = process.env.ICAL_ALLOWED_HOSTS?.trim();
  if (
    (platform === "OTHER" || platform === "GOOGLE") &&
    extra &&
    !allowedHost(host, extra)
  )
    return { ok: false, code: "HOST_NOT_ALLOWED" };
  return { ok: true, url };
}

/** Only ordinary public unicast addresses may be contacted. */
export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type TransportResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  /** Present only for 200 responses, already decompressed and bounded. */
  body: Buffer | null;
};
export type Transport = (request: {
  url: URL;
  address: ResolvedAddress;
  headers: Record<string, string>;
  signal: AbortSignal;
  maxBytes: number;
}) => Promise<TransportResponse>;

export type FetchResult =
  | {
      kind: "BODY";
      status: 200;
      body: string;
      etag: string | null;
      lastModified: string | null;
    }
  | {
      kind: "NOT_MODIFIED";
      status: 304;
      etag: string | null;
      lastModified: string | null;
    }
  | {
      kind: "FAILED";
      code: ReasonCode;
      status: number | null;
      retryAfterMs: number | null;
    };

class FetchFailure extends Error {
  constructor(
    public code: ReasonCode,
    public status: number | null = null,
  ) {
    super(code);
  }
}

const defaultResolver: Resolver = async (hostname) => {
  if (ipaddr.isValid(hostname)) {
    const parsed = ipaddr.parse(hostname);
    return [{ address: hostname, family: parsed.kind() === "ipv6" ? 6 : 4 }];
  }
  const found = await lookup(hostname, { all: true, verbatim: true });
  return found.map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));
};

/** Decompress a response stream, failing as soon as it exceeds the limit. */
export function readBounded(
  source: Readable,
  encoding: string | undefined,
  maxBytes: number,
): Promise<Buffer> {
  const e = (encoding || "identity").trim().toLowerCase();
  const decoder =
    e === "gzip" || e === "x-gzip"
      ? zlib.createGunzip()
      : e === "deflate"
        ? zlib.createInflate()
        : e === "br"
          ? zlib.createBrotliDecompress()
          : e === "identity"
            ? null
            : undefined;
  if (decoder === undefined)
    return Promise.reject(new FetchFailure("FETCH_DECODE"));
  const stream: Readable = decoder ? source.pipe(decoder) : source;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        source.destroy();
        stream.destroy();
        reject(new FetchFailure("FETCH_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", (error) =>
      reject(
        error instanceof FetchFailure
          ? error
          : new FetchFailure("FETCH_DECODE"),
      ),
    );
    source.on("error", () => reject(new FetchFailure("FETCH_CONNECTION")));
  });
}

/** HTTPS to a pinned address; `tls` exists for tests that use a private CA. */
export const createHttpsTransport =
  (tls: Pick<https.RequestOptions, "ca"> = {}): Transport =>
  ({ url, address, headers, signal, maxBytes }) =>
    new Promise((resolve, reject) => {
      const request = https.request(
        url,
        {
          ...tls,
          method: "GET",
          headers,
          signal,
          lookup: ((
            _host: string,
            options: { all?: boolean },
            callback: (...args: unknown[]) => void,
          ) => {
            if (options?.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          }) as never,
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status !== 200) {
            response.resume();
            resolve({ status, headers: response.headers, body: null });
            return;
          }
          readBounded(response, response.headers["content-encoding"], maxBytes)
            .then((body) =>
              resolve({ status, headers: response.headers, body }),
            )
            .catch(reject);
        },
      );
      request.on("error", (error) =>
        reject(
          error instanceof FetchFailure
            ? error
            : signal.aborted
              ? new FetchFailure("FETCH_TIMEOUT")
              : new FetchFailure("FETCH_CONNECTION"),
        ),
      );
      request.end();
    });

export const httpsTransport = createHttpsTransport();

function withDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new FetchFailure("FETCH_TIMEOUT"));
    const onAbort = () => reject(new FetchFailure("FETCH_TIMEOUT"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

const header = (h: IncomingHttpHeaders, name: string) => {
  const v = h[name];
  return (Array.isArray(v) ? v[0] : v) ?? null;
};

export async function fetchFeed(
  rawUrl: string,
  options: {
    platform: Platform;
    etag?: string | null;
    lastModified?: string | null;
    userAgent: string;
    resolve?: Resolver;
    transport?: Transport;
    deadlineMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    now?: () => number;
  },
): Promise<FetchResult> {
  const now = options.now ?? Date.now;
  const resolve = options.resolve ?? defaultResolver;
  const transport = options.transport ?? httpsTransport;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.deadlineMs ?? FETCH_LIMITS.deadlineMs,
  );
  const headers: Record<string, string> = {
    Accept: "text/calendar, text/plain;q=0.9, */*;q=0.1",
    "Accept-Encoding": "gzip, deflate, br",
    "User-Agent": options.userAgent,
  };
  if (options.etag) headers["If-None-Match"] = options.etag;
  if (options.lastModified) headers["If-Modified-Since"] = options.lastModified;
  try {
    let target = rawUrl;
    for (let hop = 0; ; hop++) {
      const check = checkFeedUrl(target, options.platform);
      if (!check.ok)
        throw new FetchFailure(
          hop === 0 ? "FETCH_URL_INVALID" : "FETCH_REDIRECT_BLOCKED",
        );
      let addresses: ResolvedAddress[];
      try {
        addresses = await withDeadline(
          resolve(check.url.hostname),
          controller.signal,
        );
      } catch (error) {
        throw error instanceof FetchFailure
          ? error
          : new FetchFailure("FETCH_DNS");
      }
      if (!addresses.length) throw new FetchFailure("FETCH_DNS");
      if (!addresses.every((a) => isPublicAddress(a.address)))
        throw new FetchFailure("FETCH_ADDRESS_BLOCKED");
      const response = await withDeadline(
        transport({
          url: check.url,
          address: addresses[0],
          headers,
          signal: controller.signal,
          maxBytes: options.maxBytes ?? FETCH_LIMITS.maxBytes,
        }),
        controller.signal,
      );
      const { status } = response;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = header(response.headers, "location");
        if (!location) throw new FetchFailure("FETCH_HTTP_STATUS", status);
        if (hop + 1 > (options.maxRedirects ?? FETCH_LIMITS.maxRedirects))
          throw new FetchFailure("FETCH_REDIRECT_LIMIT", status);
        let next: URL;
        try {
          next = new URL(location, check.url);
        } catch {
          throw new FetchFailure("FETCH_REDIRECT_BLOCKED", status);
        }
        // A redirect must itself satisfy every rule; plaintext is never followed.
        if (next.protocol !== "https:")
          throw new FetchFailure("FETCH_REDIRECT_BLOCKED", status);
        target = next.href;
        continue;
      }
      const etag = header(response.headers, "etag");
      const lastModified = header(response.headers, "last-modified");
      if (status === 304)
        return { kind: "NOT_MODIFIED", status, etag, lastModified };
      if (status === 200 && response.body) {
        return {
          kind: "BODY",
          status,
          body: response.body.toString("utf8"),
          etag,
          lastModified,
        };
      }
      const retryAfterMs = parseRetryAfter(
        header(response.headers, "retry-after"),
        now(),
      );
      if (status === 429)
        return {
          kind: "FAILED",
          code: "FETCH_RATE_LIMITED",
          status,
          retryAfterMs,
        };
      if (status === 503)
        return {
          kind: "FAILED",
          code: "FETCH_UNAVAILABLE",
          status,
          retryAfterMs,
        };
      return {
        kind: "FAILED",
        code: "FETCH_HTTP_STATUS",
        status,
        retryAfterMs: null,
      };
    }
  } catch (error) {
    const failure =
      error instanceof FetchFailure
        ? error
        : new FetchFailure(
            controller.signal.aborted ? "FETCH_TIMEOUT" : "FETCH_INTERNAL",
          );
    return {
      kind: "FAILED",
      code: failure.code,
      status: failure.status,
      retryAfterMs: null,
    };
  } finally {
    clearTimeout(timer);
  }
}
