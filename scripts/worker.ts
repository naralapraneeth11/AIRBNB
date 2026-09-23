import { runCron } from "../src/server/services/jobs";
import { assertDbSafety, db } from "../src/server/db";
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
async function main() {
  await assertDbSafety();
  while (!stopping) {
    const start = Date.now();
    try {
      const result = await runCron();
      console.log(JSON.stringify({ event: "worker_cycle", ...result }));
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "worker_cycle_failed",
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
