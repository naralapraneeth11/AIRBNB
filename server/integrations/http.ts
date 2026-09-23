import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { ensure } from "../errors";
export function allowedHost(host: string, setting: string) {
  return setting
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((p) =>
      p.startsWith("*.")
        ? host.endsWith(p.slice(1)) && host !== p.slice(2)
        : host === p,
    );
}
export async function safeRequest(
  url: string,
  options: {
    allowlist: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    maxBytes?: number;
    timeoutMs?: number;
  },
) {
  const parsed = new URL(url);
  ensure(
    parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      (!parsed.port || parsed.port === "443"),
    400,
    "URL_UNSAFE",
    "Only standard HTTPS URLs without credentials are allowed.",
  );
  ensure(
    allowedHost(parsed.hostname, options.allowlist),
    400,
    "HOST_BLOCKED",
    "This provider hostname is not in the server allowlist.",
  );
  const addresses = await lookup(parsed.hostname, { all: true });
  ensure(
    addresses.length &&
      addresses.every((a) => ipaddr.parse(a.address).range() === "unicast"),
    400,
    "ADDRESS_BLOCKED",
    "Private or reserved network addresses are not allowed.",
  );
  const address = addresses[0];
  return new Promise<{
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const request = https.request(
      parsed,
      {
        method: options.method || "GET",
        headers: options.headers,
        lookup: ((
          _host: unknown,
          _opts: unknown,
          cb: (err: Error | null, addresses: unknown, family?: number) => void,
        ) => {
          if ((_opts as { all?: boolean }).all) cb(null, [address]);
          else cb(null, address.address, address.family);
        }) as never,
      },
      (response) => {
        let total = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > (options.maxBytes || 2 * 1024 * 1024)) {
            request.destroy(new Error("Provider response exceeds size limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode || 500,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    request.setTimeout(options.timeoutMs || 8000, () =>
      request.destroy(new Error("Provider timed out")),
    );
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}
