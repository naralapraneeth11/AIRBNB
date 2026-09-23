import { PrismaClient } from "@prisma/client";
import { passwordHash, blind, encrypt } from "../src/server/crypto";
import { required } from "../src/server/config";
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
  const workspaceId = crypto.randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id',${workspaceId},true)`;
    await tx.workspace.create({
      data: { id: workspaceId, name: workspaceName },
    });
    const user = await tx.user.create({
      data: {
        name,
        emailHash: blind(email),
        emailEncrypted: encrypt(email, "identity"),
        passwordHash: passwordHash(password),
      },
    });
    await tx.membership.create({
      data: { workspaceId, userId: user.id, role: "HOST" },
    });
    await tx.automationSettings.create({ data: { workspaceId } });
    for (const [priority, name, keywords, manualField, template] of [
      [
        10,
        "Wi-Fi information",
        ["wifi", "wi-fi", "internet"],
        "wifi",
        "Here are the Wi-Fi details for your stay: {{answer}}",
      ],
      [
        20,
        "Check-in instructions",
        ["check in", "check-in time"],
        "checkin",
        "Here is how to check in: {{answer}}",
      ],
      [
        30,
        "Parking information",
        ["parking", "park my car"],
        "parking",
        "Here are the parking details: {{answer}}",
      ],
      [
        40,
        "Negotiation acknowledgment",
        ["discount", "lower price"],
        null,
        "Thank you for asking. Your host will review your request and get back to you.",
      ],
    ] as const) {
      await tx.automationRule.create({
        data: {
          workspaceId,
          name,
          keywords: [...keywords],
          manualField,
          templateEncrypted: encrypt(template, workspaceId),
          priority,
          action: "DRAFT",
        },
      });
    }
    await tx.auditLog.create({
      data: {
        workspaceId,
        actorId: user.id,
        action: "WORKSPACE_CREATED",
        entity: "Workspace",
        entityId: workspaceId,
        reason:
          "Owner bootstrap completed. Automation starts paused; FAQ rules start in draft mode.",
      },
    });
  });
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
