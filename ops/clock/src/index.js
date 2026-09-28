// External scheduler clock (ARCH 03). A Cloudflare Worker cron trigger calls
// the application's authenticated scheduler tick once a minute. The clock
// holds no booking policy and no data: it only calls the endpoint. The tick
// records its own durable progress, which the operations health endpoint
// (GET /api/health/operations) reports as separate heartbeat and progress
// signals (OPS 01). A 200 here means the endpoint answered, nothing more.

const clock = {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(tick(env));
  },
  // The Worker exposes no public surface.
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
};

export default clock;

async function tick(env) {
  if (!env.APP_URL || !env.CRON_SECRET)
    throw new Error("Configure APP_URL and the CRON_SECRET secret.");
  const url = new URL("/api/cron", env.APP_URL);
  if (url.protocol !== "https:" && url.hostname !== "localhost")
    throw new Error("APP_URL must use HTTPS.");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CRON_SECRET}`,
      "User-Agent": "Hostsphere-Clock/1.0",
    },
    // A tick is bounded to under a minute by the application.
    signal: AbortSignal.timeout(70_000),
  });
  // Surface failures in the Worker's logs and error metrics. The body is not
  // logged: it contains only counts, but the clock has no need for it.
  if (!response.ok)
    throw new Error(`Scheduler tick answered HTTP ${response.status}.`);
}
