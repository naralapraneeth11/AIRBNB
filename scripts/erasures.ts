// PRIV 02: permanent deletions stay permanent across a backup restore.
//
//   pnpm erasures:export [file]
//       Write every deletion recorded in the ledger as JSON (workspace and
//       property ids, trigger and time; nothing else), to the file or stdout.
//   pnpm erasures:reapply <file>
//       After restoring a backup: delete again every property in the file
//       that the restored data still holds. Each one is deleted in its own
//       transaction and recorded as REAPPLIED, so a run is safe to repeat.
//
// A backup taken after a deletion no longer contains the property, so only
// deletions made after the restored backup matter. Export them from the
// database being replaced while it is still readable; otherwise collect the
// application's "property_erased" log lines since the backup. The file may
// be the exported JSON array or those log lines, one JSON object per line.
// Runs as the application role, inside tenant scope, like the application.
import { readFile, writeFile } from "node:fs/promises";
import { db } from "../src/server/db";
import { exportErasures, reapplyErasure } from "../src/server/services/erasure";
import { parseRecords } from "./lib/erasure-records";

async function main(args: string[]) {
  const [command, file] = args;
  if (command === "export") {
    const body = JSON.stringify(await exportErasures(), null, 2) + "\n";
    if (file) await writeFile(file, body, { flag: "wx" });
    else process.stdout.write(body);
    return;
  }
  if (command !== "reapply" || !file)
    throw new Error(
      "Usage: pnpm erasures:export [file] | pnpm erasures:reapply <file>",
    );
  const operator = process.env.USER || process.env.USERNAME || "operator";
  const summary = { erased: 0, absent: 0, failed: [] as string[] };
  for (const record of parseRecords(await readFile(file, "utf8"))) {
    try {
      const outcome = await reapplyErasure(record, `operator:${operator}`);
      if (outcome === "ERASED") summary.erased++;
      else summary.absent++;
    } catch (error) {
      summary.failed.push(
        `${record.workspaceId}/${record.subjectId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  console.log(JSON.stringify(summary));
  if (summary.failed.length) process.exitCode = 1;
}

main(process.argv.slice(2))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
