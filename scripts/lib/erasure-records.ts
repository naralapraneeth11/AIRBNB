// Deletion records for re-applying after a backup restore (PRIV 02): the
// exported ledger (a JSON array) or the application's "property_erased" log
// lines, one JSON object per line. Ids only; duplicates are dropped.
const ID = /^[A-Za-z0-9_-]{1,100}$/;

export type DeletionRecord = { workspaceId: string; subjectId: string };

export function parseRecords(text: string): DeletionRecord[] {
  const trimmed = text.trim();
  const items: unknown[] = trimmed.startsWith("[")
    ? JSON.parse(trimmed)
    : trimmed
        .split("\n")
        .filter((line) => line.includes('"property_erased"'))
        .map((line) => JSON.parse(line.slice(line.indexOf("{"))));
  const records = new Map<string, DeletionRecord>();
  for (const item of items) {
    const row = (item ?? {}) as Record<string, unknown>;
    const workspaceId = row.workspaceId;
    const subjectId = row.subjectId ?? row.listingId;
    if (
      typeof workspaceId !== "string" ||
      typeof subjectId !== "string" ||
      !ID.test(workspaceId) ||
      !ID.test(subjectId)
    )
      throw new Error(`Not a deletion record: ${JSON.stringify(item)}`);
    records.set(`${workspaceId}/${subjectId}`, { workspaceId, subjectId });
  }
  return [...records.values()];
}
