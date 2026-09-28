// Shared set-up for the browser checks (QA 03): the production build served
// by `next start` against a database from the integration harness, driven in
// Chromium. Needs TEST_DATABASE_URL, a completed `pnpm build`, and Chromium
// (`pnpm exec playwright-core install chromium`, or BROWSER_EXECUTABLE).
// Skipped otherwise, unless REQUIRE_BROWSER_TESTS=1.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import { skip as noDatabase } from "../integration/harness";

export const ROOT = process.cwd();
const built = existsSync(path.join(ROOT, ".next", "BUILD_ID"));
export const skip =
  process.env.REQUIRE_BROWSER_TESTS === "1"
    ? false
    : noDatabase || (built ? false : "Run `pnpm build` first");

export async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("No free port")),
      );
    });
  });
}

export type Server = {
  base: string;
  /** Everything the server printed, most recent 50 kB. */
  log: () => string;
  stop: () => Promise<void>;
};

/** Serve the production build on `port` with `env` added. */
export async function startServer(
  port: number,
  env: Record<string, string>,
): Promise<Server> {
  let output = "";
  const server: ChildProcess = spawn(
    process.execPath,
    [
      path.join(ROOT, "node_modules/next/dist/bin/next"),
      "start",
      "-p",
      String(port),
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ...env,
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-50_000);
  };
  server.stdout?.on("data", collect);
  server.stderr?.on("data", collect);
  const base = `http://localhost:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (server.exitCode !== null)
      throw new Error(`next start exited early:\n${output}`);
    try {
      if ((await fetch(`${base}/login`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline)
      throw new Error(`The server did not answer in time:\n${output}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    base,
    log: () => output,
    stop: async () => {
      if (server.exitCode === null && server.signalCode === null) {
        const exited = new Promise((r) => server.once("exit", r));
        server.kill("SIGTERM");
        await exited;
      }
    },
  };
}

export const launchBrowser = () =>
  chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || undefined,
  });

/** Record every browser error and failed API request into `problems`. */
export function watch(page: Page, problems: string[]) {
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("response", (r) => {
    if (r.url().includes("/api/") && r.status() >= 400)
      problems.push(
        `http ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`,
      );
  });
}
