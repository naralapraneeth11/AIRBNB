// QA 01: turn a platform export into a committable fixture.
//
//   pnpm fixtures:anonymize <export.ics> <fixture.ics> --platform AIRBNB
//        [--shift-days N] [--salt <hex>]
//
// Use the same --salt for several exports of one calendar (for example a
// horizon pair) so their events keep matching identities. Review the output
// by eye before committing it; the report lists what was removed.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PLATFORMS, type Platform } from "../src/domain/calendar/types";
import { anonymizeCalendar } from "./lib/anonymize";

function option(args: string[], flag: string) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(args: string[]) {
  const [input, output] = args;
  const platform = option(args, "--platform") as Platform | undefined;
  const shiftDays = Number(option(args, "--shift-days") ?? 0);
  if (!input || !output || !platform || !PLATFORMS.includes(platform))
    throw new Error(
      `Usage: pnpm fixtures:anonymize <export.ics> <fixture.ics> --platform <${PLATFORMS.join("|")}> [--shift-days N] [--salt <hex>]`,
    );
  if (!Number.isInteger(shiftDays))
    throw new Error("--shift-days must be a whole number.");
  if (existsSync(output))
    throw new Error(`${output} exists; choose a new path or remove it first.`);
  const { text, report } = anonymizeCalendar(readFileSync(input, "utf8"), {
    platform,
    shiftDays,
    salt: option(args, "--salt") ?? randomBytes(32).toString("hex"),
  });
  writeFileSync(output, text, { flag: "wx" });
  console.log(JSON.stringify({ output, ...report }, null, 2));
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
