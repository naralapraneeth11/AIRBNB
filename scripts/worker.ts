// Long-running worker for hosts without an HTTP scheduler (ARCH 03). It runs
// the same scheduler tick as /api/cron; the shared scheduler lease means a
// worker and an external clock can both be configured without running work
// twice. Section 2: the pool size comes from WORKER_DATABASE_POOL_SIZE, so the
// process role is set before the database client is first imported.
process.env.PROCESS_ROLE = "worker";

let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});

async function main() {
  const { assertDbSafety, db } = await import("../src/server/db");
  const { runTick } = await import("../src/server/services/jobs");
  await assertDbSafety();
  while (!stopping) {
    const start = Date.now();
    try {
      const result = await runTick("WORKER");
      console.log(JSON.stringify({ event: "worker_tick", ...result }));
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "worker_tick_failed",
          type: e instanceof Error ? e.name : "Unknown",
        }),
      );
    }
    if (!stopping)
      await new Promise((r) =>
        setTimeout(r, Math.max(1000, 60000 - (Date.now() - start))),
      );
  }
  await db.$disconnect();
}

main().catch(() => {
  process.exitCode = 1;
});
