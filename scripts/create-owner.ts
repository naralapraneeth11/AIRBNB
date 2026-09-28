import { PrismaClient } from "@prisma/client";
import { passwordHash, blind } from "../src/server/crypto";
import { required } from "../src/server/config";
import { createOwnerAccount } from "../src/server/accounts/bootstrap";
const prisma = new PrismaClient({ datasourceUrl: required("DIRECT_URL") });
async function main() {
  const email = required("BOOTSTRAP_EMAIL"),
    password = required("BOOTSTRAP_PASSWORD"),
    name = required("BOOTSTRAP_NAME"),
    workspaceName = required("BOOTSTRAP_WORKSPACE");
  if (password.length < 14)
    throw new Error("Use an owner password of at least 14 characters.");
  if (await prisma.user.findUnique({ where: { emailHash: blind(email) } }))
    throw new Error("This owner already exists. Nothing was modified.");
  await prisma.$transaction((tx) =>
    createOwnerAccount(tx, {
      email,
      name,
      passwordHash: passwordHash(password),
      workspaceName,
      reason:
        "Owner bootstrap completed. Automation starts paused; FAQ rules start in draft mode.",
    }),
  );
  console.log(
    "Owner and workspace created. Remove BOOTSTRAP_* secrets and sign in.",
  );
}
main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
