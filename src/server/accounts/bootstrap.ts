// One way to create an owner account and its workspace, shared by
// `pnpm setup:owner` and self-service sign-up (AUTH 01). It takes the caller's
// transaction and imports no database client, so the setup script can run it
// with the schema owner's connection.
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { blind, encrypt } from "../crypto";

const DRAFT_RULES = [
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
] as const;

/**
 * Create the user, a workspace they own, paused automation and draft FAQ
 * rules. The workspace starts in calendar shadow mode (the column default,
 * REL 01). `passwordHash` is already hashed.
 */
export async function createOwnerAccount(
  tx: Prisma.TransactionClient,
  input: {
    email: string;
    name: string;
    passwordHash: string;
    workspaceName: string;
    reason: string;
  },
) {
  const workspaceId = randomUUID();
  await tx.$executeRaw`SELECT set_config('app.workspace_id',${workspaceId},true)`;
  await tx.workspace.create({
    data: { id: workspaceId, name: input.workspaceName },
  });
  const user = await tx.user.create({
    data: {
      name: input.name,
      emailHash: blind(input.email),
      emailEncrypted: encrypt(input.email.trim(), "identity"),
      passwordHash: input.passwordHash,
    },
  });
  await tx.membership.create({
    data: { workspaceId, userId: user.id, role: "HOST" },
  });
  await tx.automationSettings.create({ data: { workspaceId } });
  for (const [priority, name, keywords, manualField, template] of DRAFT_RULES)
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
  await tx.auditLog.create({
    data: {
      workspaceId,
      actorId: user.id,
      action: "WORKSPACE_CREATED",
      entity: "Workspace",
      entityId: workspaceId,
      reason: input.reason,
    },
  });
  return { workspaceId, userId: user.id };
}
