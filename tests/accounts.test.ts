// AUTH 01 / AUTH 03 building blocks: the password policy, the breach screen,
// which account features a deployment offers, and what account emails say.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  accountEmailTransport,
  accountFeatures,
  existingAccountEmail,
  resetEmail,
  verificationEmail,
} from "../src/server/accounts/email";
import { breachCount, passwordProblem } from "../src/server/accounts/passwords";

// Read when the emails are built, not at import.
process.env.APP_URL = "https://app.test";

const STRONG = "copper lantern orbit maple";
const suffixOf = (password: string) =>
  createHash("sha1").update(password).digest("hex").toUpperCase().slice(5);
const rangeResponse = (lines: string[]) => async () =>
  new Response(lines.join("\r\n"), { status: 200 });

test("the password policy is length-based, without composition rules (AUTH 01)", async () => {
  const offline = async () => {
    throw new Error("offline");
  };
  assert.match(
    (await passwordProblem("short", {}, offline)) ?? "",
    /at least 14/,
  );
  assert.match(
    (await passwordProblem("x".repeat(201), {}, offline)) ?? "",
    /at most 200/,
  );
  assert.match(
    (await passwordProblem("a".repeat(20), {}, offline)) ?? "",
    /repeated/,
  );
  assert.match(
    (await passwordProblem(
      "maria.lopez rooftop garden",
      { email: "maria.lopez@example.com" },
      offline,
    )) ?? "",
    /email address/,
  );
  // No uppercase, digit or symbol is required.
  assert.equal(await passwordProblem(STRONG, {}, offline), null);
});

test("breached passwords are refused; only a hash prefix leaves the server", async () => {
  const asked: string[] = [];
  const breached = async (url: string) => {
    asked.push(url);
    return new Response(`${suffixOf(STRONG)}:42\r\nFFFFF:0`, { status: 200 });
  };
  assert.equal(await breachCount(STRONG, breached), 42);
  assert.match((await passwordProblem(STRONG, {}, breached)) ?? "", /breach/);
  const prefix = createHash("sha1")
    .update(STRONG)
    .digest("hex")
    .toUpperCase()
    .slice(0, 5);
  assert.deepEqual(asked, [
    `https://api.pwnedpasswords.com/range/${prefix}`,
    `https://api.pwnedpasswords.com/range/${prefix}`,
  ]);
  // Padding rows carry a zero count and never count as breached.
  assert.equal(
    await breachCount(STRONG, rangeResponse([`${suffixOf(STRONG)}:0`])),
    0,
  );
});

test("the breach screen fails open when the service cannot answer", async () => {
  assert.equal(
    await breachCount(STRONG, async () => new Response("", { status: 503 })),
    null,
  );
  assert.equal(
    await breachCount(STRONG, async () => {
      throw new Error("network down");
    }),
    null,
  );
  assert.equal(
    await passwordProblem(STRONG, {}, async () => {
      throw new Error("network down");
    }),
    null,
  );
});

test("email and sign-up are available only where configured and chosen", () => {
  const resend = { RESEND_API_KEY: "re_live", EMAIL_FROM: "a@b.example" };
  assert.equal(
    accountEmailTransport({ ...resend, APP_ENVIRONMENT: "production" }),
    "resend",
  );
  // Without a provider, only development and tests print to the log.
  assert.equal(accountEmailTransport({ APP_ENVIRONMENT: "test" }), "log");
  assert.equal(
    accountEmailTransport({ APP_ENVIRONMENT: "development" }),
    "log",
  );
  for (const env of ["production", "staging", "preview"])
    assert.equal(accountEmailTransport({ APP_ENVIRONMENT: env }), null);
  assert.equal(
    accountEmailTransport({
      RESEND_API_KEY: "REPLACE_ME",
      EMAIL_FROM: "a@b.example",
      APP_ENVIRONMENT: "production",
    }),
    null,
  );
  // Reset follows email; sign-up also needs the owner's opt-in.
  assert.deepEqual(
    accountFeatures({ ...resend, APP_ENVIRONMENT: "production" }),
    { reset: true, signup: false },
  );
  assert.deepEqual(
    accountFeatures({
      ...resend,
      APP_ENVIRONMENT: "production",
      SIGNUP_ENABLED: "true",
    }),
    { reset: true, signup: true },
  );
  assert.deepEqual(
    accountFeatures({ APP_ENVIRONMENT: "production", SIGNUP_ENABLED: "true" }),
    { reset: false, signup: false },
  );
});

test("account emails carry the token in the fragment and never in the provider key", () => {
  const token = "T".repeat(43);
  const verify = verificationEmail("host@example.com", "Sam", token);
  assert.match(verify.text, /https:\/\/app\.test\/verify#token=T{43}\n/);
  assert.match(verify.text, /expires in 24 hours/);
  assert.equal(verify.key.includes(token), false);
  const reset = resetEmail("host@example.com", "Sam", token);
  assert.match(reset.text, /https:\/\/app\.test\/reset#token=T{43}\n/);
  assert.match(reset.text, /expires in 30 minutes/);
  assert.match(reset.text, /signs you out on every device/);
  assert.equal(reset.key.includes(token), false);
  const exists = existingAccountEmail("host@example.com");
  assert.match(exists.text, /already has one/);
  assert.doesNotMatch(exists.text, /token=/);
});
