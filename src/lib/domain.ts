export const cleaningStates = [
  "NEEDS_SCHEDULING",
  "ASSIGNED",
  "ACCEPTED",
  "IN_PROGRESS",
  "DONE",
  "VERIFIED",
] as const;
export type CleaningState = (typeof cleaningStates)[number];
export type Role = "HOST" | "COHOST" | "CLEANER" | "SYSTEM";
export const manualFields = [
  "wifi",
  "checkin",
  "parking",
  "washroom",
  "rules",
] as const;
export type HouseManual = Record<(typeof manualFields)[number], string>;
export const platforms = [
  "AIRBNB",
  "VRBO",
  "EXPEDIA",
  "BOOKING",
  "DIRECT",
] as const;
export function canTransition(
  from: string,
  to: string,
  role: Role,
  hasPhoto = false,
) {
  if (to === "VERIFIED")
    return ["HOST", "COHOST"].includes(role) && from === "DONE" && hasPhoto;
  if (role === "CLEANER")
    return (
      (from === "ASSIGNED" && ["ACCEPTED", "NEEDS_SCHEDULING"].includes(to)) ||
      (from === "ACCEPTED" && to === "IN_PROGRESS") ||
      (from === "IN_PROGRESS" && to === "DONE")
    );
  return (
    ["HOST", "COHOST", "SYSTEM"].includes(role) &&
    ((from === "NEEDS_SCHEDULING" && to === "ASSIGNED") ||
      (["ASSIGNED", "ACCEPTED"].includes(from) && to === "NEEDS_SCHEDULING") ||
      (from === "VERIFIED" && to === "DONE"))
  );
}
export function isSensitive(text: string) {
  return (
    /\b(refund\w*|cancel\w*|unsafe|safety|danger\w*|emergenc\w*|fire|smoke|gas leak|injur\w*|hurt|police|lawyer\w*|legal|lawsuit|sue|suing|court|discriminat\w*|harass\w*|threat\w*|assault\w*|break.in|stolen|ambulance|hospital|bleeding|suicid\w*|weapon\w*)\b/i.test(
      text,
    ) ||
    /reembolso|cancelaci[oó]n|peligro|incendio|abogado|remboursement|annulation|urgence|avocat|退款|取消|危险|报警/i.test(
      text,
    )
  );
}
export function intentOf(text: string) {
  if (isSensitive(text)) return "COMPLAINT";
  if (/discount|price|cheaper|negotia/i.test(text)) return "NEGOTIATION";
  if (/change.*date|extend|early.*check|late.*check|extra.*guest/i.test(text))
    return "BOOKING_ADJACENT";
  return "QUESTION";
}
export function dateOnly(v: string | Date) {
  const s = typeof v === "string" ? v : v.toISOString();
  return s.slice(0, 10);
}
export function dayAdd(date: string | Date, days: number) {
  const d = new Date(dateOnly(date) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
export function overlaps(
  a: { startDate: Date; endDate: Date },
  b: { startDate: Date; endDate: Date },
  buffer = 0,
) {
  return (
    a.startDate < dayAdd(b.endDate, buffer) &&
    b.startDate < dayAdd(a.endDate, buffer)
  );
}
export function freshness(
  status: string,
  last: string | Date | null,
  now = Date.now(),
  staleMinutes = 240,
) {
  if (
    status === "ERROR" ||
    !last ||
    now - new Date(last).getTime() > staleMinutes * 60000
  )
    return "error";
  const age = now - new Date(last).getTime();
  return age < 300000 ? "fresh" : age > 3600000 ? "delayed" : "polling";
}
export function checkoutInstant(date: Date, hour: number, zone: string) {
  let instant = new Date(
    `${dateOnly(date)}T${String(hour).padStart(2, "0")}:00:00Z`,
  );
  const target = instant.getTime();
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    const shown = Date.UTC(
      +p.year,
      +p.month - 1,
      +p.day,
      +p.hour,
      +p.minute,
      +p.second,
    );
    instant = new Date(instant.getTime() + target - shown);
  }
  return instant;
}
export type Command =
  | { intent: "BLOCK"; listingId: string; from: string; to: string }
  | { intent: "INBOX"; platform?: string; status?: string }
  | { intent: "NAVIGATE"; page: string }
  | { intent: "UNKNOWN" };
function validCommandDate(value: string) {
  const parsed = new Date(value + "T00:00:00Z");
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(parsed.getTime()) &&
    dateOnly(parsed) === value
  );
}
function blockCommand(listingId: string, from: string, to: string): Command {
  return validCommandDate(from) && validCommandDate(to) && to > from
    ? { intent: "BLOCK", listingId, from, to }
    : { intent: "UNKNOWN" };
}
export function parseCommand(
  text: string,
  listings: { id: string; name: string }[],
  now = new Date(),
): Command {
  const t = text.trim().toLowerCase();
  if (/message|inbox/.test(t))
    return {
      intent: "INBOX",
      platform: platforms.find((p) => t.includes(p.toLowerCase())),
      status: /unread|needs reply/.test(t) ? "NEEDS_REPLY" : undefined,
    };
  const listing = listings.find((l) => t.includes(l.name.toLowerCase()));
  const iso = t.match(
    /(\d{4}-\d{2}-\d{2})\s*(?:to|through|–|—)\s*(\d{4}-\d{2}-\d{2})/,
  );
  if (/^block\b/.test(t) && listing && iso)
    return blockCommand(listing.id, iso[1], iso[2]);
  const date = t.match(
    /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})\s*[-–—]\s*(\d{1,2})(?:,?\s+(\d{4}))?/,
  );
  if (/^block\b/.test(t) && listing && date) {
    const month = [
      "january",
      "february",
      "march",
      "april",
      "may",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december",
    ].indexOf(date[1]);
    let y = +(date[4] || now.getUTCFullYear());
    if (!date[4] && new Date(Date.UTC(y, month, +date[2])) < dayAdd(now, 0))
      y++;
    const prefix = `${y}-${String(month + 1).padStart(2, "0")}-`,
      from = prefix + date[2].padStart(2, "0"),
      through = prefix + date[3].padStart(2, "0");
    if (!validCommandDate(from) || !validCommandDate(through) || through < from)
      return { intent: "UNKNOWN" };
    return blockCommand(listing.id, from, dateOnly(dayAdd(through, 1)));
  }
  const page = [
    "calendar",
    "inbox",
    "cleaning",
    "properties",
    "automation",
    "insights",
    "settings",
    "activity",
  ].find((p) => t === p || t === `open ${p}`);
  return page ? { intent: "NAVIGATE", page } : { intent: "UNKNOWN" };
}
