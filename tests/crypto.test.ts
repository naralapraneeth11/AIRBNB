import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  decrypt,
  encrypt,
  hash,
  passwordHash,
  passwordMatches,
  randomToken,
  seal,
  unseal,
} from "../src/server/crypto";

test("encrypted guest data is scoped to one tenant and rejects ciphertext tampering", () => {
  const original = process.env.ENCRYPTION_KEYS;
  const originalId = process.env.ENCRYPTION_KEY_ID;
  try {
    process.env.ENCRYPTION_KEY_ID = "test-v1";
    process.env.ENCRYPTION_KEYS = JSON.stringify({
      "test-v1": randomBytes(32).toString("base64"),
    });
    const plaintext = "Guest private information · 门码";
    const encrypted = encrypt(plaintext, "workspace-a");
    assert.equal(decrypt(encrypted, "workspace-a"), plaintext);
    assert.notEqual(
      encrypted,
      encrypt(plaintext, "workspace-a"),
      "fresh nonces prevent repeated plaintext from revealing equality",
    );
    assert.equal(encrypted.includes(plaintext), false);
    assert.throws(() => decrypt(encrypted, "workspace-b"));
    const parts = encrypted.split(".");
    const payload = Buffer.from(parts[3], "base64url");
    payload[0] ^= 1;
    parts[3] = payload.toString("base64url");
    assert.throws(() => decrypt(parts.join("."), "workspace-a"));
    assert.deepEqual(
      unseal(
        seal({ prompt: "private guest question" }, "workspace-a"),
        "workspace-a",
      ),
      { prompt: "private guest question" },
    );
    process.env.ENCRYPTION_KEYS = JSON.stringify({
      "test-v1": randomBytes(32).toString("base64"),
    });
    assert.throws(() => decrypt(encrypted, "workspace-a"));
  } finally {
    if (original === undefined) delete process.env.ENCRYPTION_KEYS;
    else process.env.ENCRYPTION_KEYS = original;
    if (originalId === undefined) delete process.env.ENCRYPTION_KEY_ID;
    else process.env.ENCRYPTION_KEY_ID = originalId;
  }
});

test("passwords use salted hashes and capability tokens contain 256 bits", () => {
  const password = "test-only long passphrase";
  const stored = passwordHash(password);
  assert.equal(passwordMatches(password, stored), true);
  assert.equal(passwordMatches("wrong password", stored), false);
  assert.notEqual(passwordHash(password), stored);
  assert.equal(passwordMatches(password, "unsupported:hash"), false);
  const token = randomToken();
  assert.equal(Buffer.from(token, "base64url").length, 32);
  assert.notEqual(randomToken(), token);
  assert.equal(hash(token).length, 64);
});
