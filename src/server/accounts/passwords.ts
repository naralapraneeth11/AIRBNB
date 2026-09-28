// AUTH 01 password policy: at least fourteen characters, any characters,
// paste and password managers welcome, no arbitrary composition rules, and a
// privacy-preserving screen against passwords known from breaches.
import { createHash } from "node:crypto";

export const PASSWORD_LIMITS = { min: 14, max: 200 } as const;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * How often a password appears in known breaches, via the Pwned Passwords
 * range API. Only the first five hex characters of its SHA-1 leave this
 * server (k-anonymity), and padded responses hide which prefix was asked.
 * Returns null when the service cannot answer: the check then fails open,
 * because an outage elsewhere must not block sign-up or recovery; the
 * length rule still applies.
 */
export async function breachCount(
  password: string,
  fetchImpl: Fetch = fetch,
): Promise<number | null> {
  const digest = createHash("sha1")
    .update(password)
    .digest("hex")
    .toUpperCase();
  const prefix = digest.slice(0, 5),
    suffix = digest.slice(5);
  try {
    const response = await fetchImpl(
      `https://api.pwnedpasswords.com/range/${prefix}`,
      {
        headers: { "Add-Padding": "true" },
        signal: AbortSignal.timeout(2500),
      },
    );
    if (!response.ok) return null;
    for (const line of (await response.text()).split("\n")) {
      const [candidate, count] = line.trim().split(":");
      if (candidate === suffix) return Number(count) || 0;
    }
    return 0;
  } catch {
    return null;
  }
}

/** Why a new password is not acceptable, or null when it is. */
export async function passwordProblem(
  password: string,
  context: { email?: string } = {},
  fetchImpl?: Fetch,
): Promise<string | null> {
  if (password.length < PASSWORD_LIMITS.min)
    return `Use at least ${PASSWORD_LIMITS.min} characters. A few unrelated words work well.`;
  if (password.length > PASSWORD_LIMITS.max)
    return `Use at most ${PASSWORD_LIMITS.max} characters.`;
  if (/^(.)\1*$/su.test(password))
    return "Choose a password that is not one character repeated.";
  const local = context.email?.split("@")[0]?.trim().toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local))
    return "Choose a password that does not contain your email address.";
  if (((await breachCount(password, fetchImpl)) ?? 0) > 0)
    return "This password appears in known data breaches. Choose a different one.";
  return null;
}
