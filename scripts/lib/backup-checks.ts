// Pure checks behind the backup jobs (REC 01), kept separate so they are
// unit-tested without a database, a network or key material.
import { decryptWithKeys } from "../../src/server/crypto";

/** libpq settings from a URL, so no credential appears in a process list. */
export function pgEnv(raw: string): Record<string, string> {
  const url = new URL(raw);
  const env: Record<string, string> = {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
  };
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

/** Tables whose data an archive's table of contents (pg_restore --list) holds. */
export function tocTables(listing: string) {
  const tables = new Set<string>();
  for (const line of listing.split("\n")) {
    const m = /^\d+;\s+\d+\s+\d+\s+TABLE DATA\s+(\S+)\s+(\S+)/.exec(line);
    if (m && m[1] === "public") tables.add(m[2]);
  }
  return tables;
}

export type KeySample = {
  keyId: string;
  value: string;
  scope: string;
  source: string;
};

/**
 * Every key version found in stored ciphertexts must be in the escrow copy and
 * decrypt at least one of its real ciphertexts. Key material never appears in
 * the result, only key identifiers.
 */
export function verifyEscrow(
  escrow: Record<string, string>,
  samples: readonly KeySample[],
) {
  const problems: string[] = [];
  for (const [id, key] of Object.entries(escrow))
    if (Buffer.from(key, "base64").length !== 32)
      problems.push(`Escrowed key ${id} is not a 32-byte base64 key.`);
  const inUse = new Map<string, KeySample[]>();
  for (const s of samples)
    inUse.set(s.keyId, [...(inUse.get(s.keyId) ?? []), s]);
  const verified: string[] = [];
  for (const [id, list] of [...inUse].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!escrow[id]) {
      problems.push(`Key version ${id} is in use but missing from the escrow.`);
      continue;
    }
    const decrypts = list.some((s) => {
      try {
        decryptWithKeys(escrow, s.value, s.scope);
        return true;
      } catch {
        return false;
      }
    });
    if (decrypts) verified.push(id);
    else problems.push(`Escrowed key ${id} does not decrypt its ciphertexts.`);
  }
  const unused = Object.keys(escrow)
    .filter((id) => !inUse.has(id))
    .sort();
  return { verified, unused, problems };
}
