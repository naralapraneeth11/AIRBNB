import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  createHmac,
  timingSafeEqual,
  scryptSync,
} from "node:crypto";
import { required } from "./config";
export const randomToken = () => randomBytes(32).toString("base64url");
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const blind = (s: string) =>
  createHmac("sha256", required("AUTH_SECRET"))
    .update(s.trim().toLowerCase())
    .digest("hex");
export function encrypt(value: string, scope: string) {
  const id = process.env.ENCRYPTION_KEY_ID || "v1",
    keys = JSON.parse(required("ENCRYPTION_KEYS"));
  const key = Buffer.from(keys[id] || "", "base64");
  if (key.length !== 32) throw new Error("Invalid encryption key");
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(scope));
  const payload = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    id,
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    payload.toString("base64url"),
  ].join(".");
}
export function decrypt(value: string | null | undefined, scope: string) {
  if (!value) return "";
  const [id, n, t, c] = value.split("."),
    key = Buffer.from(
      JSON.parse(required("ENCRYPTION_KEYS"))[id] || "",
      "base64",
    );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(n, "base64url"),
  );
  decipher.setAAD(Buffer.from(scope));
  decipher.setAuthTag(Buffer.from(t, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(c, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
export const seal = (v: unknown, scope: string) =>
  encrypt(JSON.stringify(v), scope);
export function unseal<T>(v: string, scope: string): T {
  return JSON.parse(decrypt(v, scope)) as T;
}
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex")}`;
}
export function passwordMatches(password: string, stored: string) {
  const [method, salt, key] = stored.split(":");
  if (method !== "scrypt" || !salt || !key) return false;
  return equal(
    scryptSync(password, salt, 64, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    }).toString("hex"),
    key,
  );
}
