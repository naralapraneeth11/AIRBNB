// Account emails (AUTH 01, AUTH 03): sign-up verification, password reset,
// and a notice when someone tries to sign up with an address that already
// has an account. Messages never reveal to the requester whether an account
// exists; only the address's owner learns it, by email.
import { BRAND } from "@/lib/brand";
import { appUrl } from "../config";
import { hash } from "../crypto";
import { AppError } from "../errors";
import { sendEmail } from "../integrations/providers";

export type AccountEmail = {
  to: string;
  subject: string;
  text: string;
  /** Provider idempotency key; derived from the token, never the token. */
  key: string;
};

/** How account emails are delivered here, or null when they cannot be. */
export function accountEmailTransport(
  env: Record<string, string | undefined> = process.env,
): "resend" | "log" | null {
  if (
    env.RESEND_API_KEY &&
    env.EMAIL_FROM &&
    !/REPLACE_/.test(env.RESEND_API_KEY + env.EMAIL_FROM)
  )
    return "resend";
  // Local development and tests only: print the message to the server log.
  // Never in production, staging or previews, where a log is not private.
  if (env.APP_ENVIRONMENT === "development" || env.APP_ENVIRONMENT === "test")
    return "log";
  return null;
}

/**
 * Which self-service account features this deployment offers. Password reset
 * needs email; sign-up also needs the owner's opt-in (SIGNUP_ENABLED=true),
 * so a supervised demo is not open to strangers by default.
 */
export function accountFeatures(
  env: Record<string, string | undefined> = process.env,
) {
  const email = accountEmailTransport(env) !== null;
  return { reset: email, signup: email && env.SIGNUP_ENABLED === "true" };
}

export async function deliver(message: AccountEmail) {
  const transport = accountEmailTransport();
  if (!transport)
    throw new AppError(
      503,
      "EMAIL_UNAVAILABLE",
      "Email is not set up on this deployment yet, so this can't be done here.",
    );
  if (transport === "log") {
    console.info(
      `[account-email] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`,
    );
    return;
  }
  try {
    await sendEmail(message.to, message.text, message.key, message.subject);
  } catch {
    throw new AppError(
      503,
      "EMAIL_FAILED",
      "We couldn't send the email just now. Try again in a few minutes.",
    );
  }
}

const key = (purpose: string, token: string) =>
  `${purpose}:${hash(token).slice(0, 40)}`;

export function verificationEmail(
  to: string,
  name: string,
  token: string,
): AccountEmail {
  return {
    to,
    subject: `Finish creating your ${BRAND.name} account`,
    key: key("verify", token),
    text: [
      `Hi ${name},`,
      "",
      `Confirm this address to finish creating your ${BRAND.name} account and workspace:`,
      "",
      `${appUrl()}/verify#token=${token}`,
      "",
      "The link works once and expires in 24 hours. If you didn't ask for an account, ignore this email: nothing is created unless the link is used.",
    ].join("\n"),
  };
}

export function existingAccountEmail(to: string): AccountEmail {
  return {
    to,
    subject: `You already have a ${BRAND.name} account`,
    key: `exists:${hash(to + ":" + new Date().toISOString().slice(0, 13))}`,
    text: [
      `Someone, hopefully you, tried to create a ${BRAND.name} account with this address, but it already has one.`,
      "",
      `Sign in: ${appUrl()}/login`,
      `Forgot your password? ${appUrl()}/forgot`,
      "",
      "If this wasn't you, you can ignore this email. Nothing was changed.",
    ].join("\n"),
  };
}

export function resetEmail(
  to: string,
  name: string,
  token: string,
): AccountEmail {
  return {
    to,
    subject: `Reset your ${BRAND.name} password`,
    key: key("reset", token),
    text: [
      `Hi ${name},`,
      "",
      "Use this link to choose a new password:",
      "",
      `${appUrl()}/reset#token=${token}`,
      "",
      "The link works once and expires in 30 minutes. Resetting signs you out on every device. If you didn't ask for this, ignore this email: your password stays the same.",
    ].join("\n"),
  };
}
