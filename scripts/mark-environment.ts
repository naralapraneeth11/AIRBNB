// SEC 04: record which environment this database belongs to. The application
// refuses tenant data when its APP_ENVIRONMENT does not match the marker
// (src/server/db.ts), so a preview or staging deployment can never read or
// write production data, and production can never serve a staging database.
//
//   pnpm db:mark-environment <production|staging|development|test>
//        [--replace <current>] [--by <name>]
//
// Run with the schema-owner connection as DIRECT_URL: the runtime role can
// only read the marker. Changing an existing marker requires naming the
// current one, so a typo cannot silently re-label production.
import { PrismaClient } from "@prisma/client";

const NAMES = ["production", "staging", "development", "test"];

function option(args: string[], flag: string) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args: string[]) {
  const name = args[0];
  if (!name || !NAMES.includes(name))
    throw new Error(
      `Usage: pnpm db:mark-environment <${NAMES.join("|")}> [--replace <current>] [--by <name>]`,
    );
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error("Set DIRECT_URL to the schema-owner connection.");
  const markedBy =
    option(args, "--by") ||
    process.env.USER ||
    process.env.USERNAME ||
    "operator";
  const db = new PrismaClient({ datasourceUrl: url });
  try {
    const current = await db.deploymentEnvironment.findUnique({
      where: { id: 1 },
    });
    if (current?.name === name) {
      console.log(
        JSON.stringify({
          environment: name,
          changed: false,
          markedAt: current.markedAt,
        }),
      );
      return;
    }
    if (current && option(args, "--replace") !== current.name)
      throw new Error(
        `This database is marked "${current.name}". To change it, pass --replace ${current.name}.`,
      );
    const marked = await db.deploymentEnvironment.upsert({
      where: { id: 1 },
      create: { id: 1, name, markedBy },
      update: { name, markedBy, markedAt: new Date() },
    });
    console.log(
      JSON.stringify({
        environment: marked.name,
        changed: true,
        previous: current?.name ?? null,
        markedBy: marked.markedBy,
        markedAt: marked.markedAt,
      }),
    );
  } finally {
    await db.$disconnect();
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
