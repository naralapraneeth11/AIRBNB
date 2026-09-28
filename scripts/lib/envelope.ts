// REC 01: backup artifacts are encrypted before they leave the machine that
// made them. A fresh AES-256-GCM data key encrypts each artifact, and the data
// key is wrapped with the operator's RSA public key (RSA-OAEP, SHA-256). The
// private key stays offline with the key escrow, so the backup destination
// alone can never read a backup, and a tampered artifact fails to decrypt.
//
// Format: "HSB1" | u16 wrapped-key length | wrapped key | 12-byte IV |
//         ciphertext | 16-byte GCM tag. The header is authenticated.
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rename, rm, stat } from "node:fs/promises";

const MAGIC = Buffer.from("HSB1");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const oaep = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" };

function header(publicKeyPem: string) {
  const key = randomBytes(32);
  const iv = randomBytes(IV_BYTES);
  const wrapped = publicEncrypt({ key: publicKeyPem, ...oaep }, key);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(wrapped.length);
  const head = Buffer.concat([MAGIC, length, wrapped, iv]);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(head);
  return { head, cipher };
}

function parseHeader(head: Buffer, privateKeyPem: string) {
  if (head.length < 6 || !head.subarray(0, 4).equals(MAGIC))
    throw new Error("Not a Hostsphere backup artifact.");
  const wrappedLength = head.readUInt16BE(4);
  const end = 6 + wrappedLength + IV_BYTES;
  if (head.length < end)
    throw new Error("Backup artifact header is truncated.");
  const wrapped = head.subarray(6, 6 + wrappedLength);
  const iv = head.subarray(6 + wrappedLength, end);
  const key = privateDecrypt({ key: privateKeyPem, ...oaep }, wrapped);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(head.subarray(0, end));
  return { decipher, headerLength: end };
}

export function encryptBytes(plain: Buffer, publicKeyPem: string) {
  const { head, cipher } = header(publicKeyPem);
  return Buffer.concat([
    head,
    cipher.update(plain),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

export function decryptBytes(sealed: Buffer, privateKeyPem: string) {
  const { decipher, headerLength } = parseHeader(sealed, privateKeyPem);
  if (sealed.length < headerLength + TAG_BYTES)
    throw new Error("Backup artifact is truncated.");
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(sealed.subarray(headerLength, sealed.length - TAG_BYTES)),
    decipher.final(),
  ]);
}

/** Stream-encrypt a file; returns the artifact's SHA-256 and size. */
export async function encryptFile(
  input: string,
  output: string,
  publicKeyPem: string,
) {
  const { head, cipher } = header(publicKeyPem);
  const digest = createHash("sha256");
  const file = await open(output, "wx", 0o600);
  const write = async (b: Buffer) => {
    if (!b.length) return;
    digest.update(b);
    await file.write(b);
  };
  try {
    await write(head);
    for await (const chunk of createReadStream(input))
      await write(cipher.update(chunk as Buffer));
    await write(cipher.final());
    await write(cipher.getAuthTag());
  } finally {
    await file.close();
  }
  return { sha256: digest.digest("hex"), bytes: (await stat(output)).size };
}

/**
 * Stream-decrypt a file. Output goes to a partial file that becomes the
 * named output only after the GCM tag verifies, so a tampered or truncated
 * artifact never leaves unauthenticated plaintext behind.
 */
export async function decryptFile(
  input: string,
  output: string,
  privateKeyPem: string,
) {
  const partial = `${output}.partial`;
  try {
    await decryptInto(input, partial, privateKeyPem);
    await rename(partial, output);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

async function decryptInto(
  input: string,
  output: string,
  privateKeyPem: string,
) {
  const size = (await stat(input)).size;
  const source = await open(input, "r");
  const target = await open(output, "wx", 0o600);
  try {
    const probe = Buffer.alloc(Math.min(size, 6 + 1024 + IV_BYTES));
    await source.read(probe, 0, probe.length, 0);
    const { decipher, headerLength } = parseHeader(probe, privateKeyPem);
    if (size < headerLength + TAG_BYTES)
      throw new Error("Backup artifact is truncated.");
    const tag = Buffer.alloc(TAG_BYTES);
    await source.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
    decipher.setAuthTag(tag);
    const chunk = Buffer.alloc(1 << 20);
    for (let at = headerLength; at < size - TAG_BYTES;) {
      const length = Math.min(chunk.length, size - TAG_BYTES - at);
      const { bytesRead } = await source.read(chunk, 0, length, at);
      if (!bytesRead) throw new Error("Backup artifact is truncated.");
      await target.write(decipher.update(chunk.subarray(0, bytesRead)));
      at += bytesRead;
    }
    await target.write(decipher.final());
  } finally {
    await source.close();
    await target.close();
  }
}

export const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
