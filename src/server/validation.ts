import { z } from "zod";
import { platforms } from "@/lib/domain";
export const id = z.string().min(1).max(100);
export const date = z.iso.date();
export const manual = z.object({
  wifi: z.string().max(4000),
  checkin: z.string().max(4000),
  parking: z.string().max(4000),
  washroom: z.string().max(4000),
  rules: z.string().max(8000),
});
export const listingInput = z.object({
  name: z.string().trim().min(1).max(100),
  address: z.string().trim().min(1).max(500),
  timezone: z.string().refine((v) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  doorCode: z.string().max(100).optional(),
  houseManual: manual,
  bufferDays: z.number().int().min(0).max(14),
  checkoutHour: z.number().int().min(0).max(23),
  cleaningBufferHours: z.number().int().min(1).max(48),
});
export const blockInput = z
  .object({
    listingId: id,
    from: date,
    to: date,
    reason: z.string().trim().min(1).max(200),
    idempotencyKey: z.uuid(),
  })
  .refine((x) => x.to > x.from, "End date must be after start date")
  .refine(
    (x) => (+new Date(x.to) - +new Date(x.from)) / 86400000 <= 730,
    "Maximum block is two years",
  );
export const incoming = z.object({
  eventId: id,
  workspaceId: id,
  platform: z.enum(platforms),
  threadId: id,
  bookingId: id,
  body: z.string().trim().min(1).max(12000),
  sentAt: z.iso.datetime(),
});
export const ruleInput = z.object({
  name: z.string().min(1).max(100),
  listingId: id.nullable(),
  keywords: z.array(z.string().min(2).max(80)).min(1).max(30),
  manualField: z
    .enum(["wifi", "checkin", "parking", "washroom", "rules"])
    .nullable(),
  template: z.string().min(1).max(5000),
  action: z.enum(["DRAFT", "SEND"]),
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(10000),
});
export const settingsInput = z.object({
  paused: z.boolean(),
  cleaning: z.boolean(),
  messaging: z.boolean(),
  ai: z.boolean(),
  confidence: z.number().min(0.5).max(1),
  version: z.number().int(),
});

export const directBookingInput = z
  .object({
    listingId: id,
    from: date,
    to: date,
    guestName: z.string().trim().min(1).max(200),
    guestContact: z.union([z.email().max(320), z.literal("")]).default(""),
    price: z.number().nonnegative().max(999999999).nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    idempotencyKey: z.uuid(),
  })
  .refine((x) => x.to > x.from, "Checkout must be after check-in")
  .refine(
    (x) => (+new Date(x.to) - +new Date(x.from)) / 86400000 <= 730,
    "Maximum stay is two years",
  );
