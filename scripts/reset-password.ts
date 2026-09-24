import { PrismaClient } from "@prisma/client";
import { required } from "../src/server/config";
import { blind, passwordHash } from "../src/server/crypto";
const db = new PrismaClient({ datasourceUrl: required("DIRECT_URL") });
async function main() {
  const email = required("RECOVERY_EMAIL"),
    password = required("RECOVERY_PASSWORD");
  if (password.length < 14)
    throw new Error("Recovery password must be at least 14 characters.");
  const user = await db.user.findUniqueOrThrow({
    where: { emailHash: blind(email) },
  });
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash: passwordHash(password) },
    });
    await tx.session.deleteMany({ where: { userId: user.id } });
    const memberships = await tx.membership.findMany({
      where: { userId: user.id },
    });
    for (const m of memberships) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id',${m.workspaceId},true)`;
      await tx.auditLog.create({
        data: {
          workspaceId: m.workspaceId,
          actorId: "administrator",
          action: "PASSWORD_RECOVERY",
          entity: "User",
          entityId: user.id,
          reason:
            "Administrator reset the password after out-of-band identity verification. All sessions were revoked.",
        },
      });
    }
  });
  console.log(
    "Password reset; all sessions revoked. Remove RECOVERY_* environment variables.",
  );
}
main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
