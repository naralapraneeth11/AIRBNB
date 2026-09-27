// Section 5 capability records: a reviewed table shipped with the code and
// versioned with each release. Only verified capabilities become product
// actions. Database-versioned capability records are Later (SCOPE 04).
import type { HostClass, Platform } from "./types";

export const CAPABILITIES_VERSION = "2026-09-27.1";
/** Version of the calendar decision rules recorded with every run (CAL 01). */
export const RULES_VERSION = "calendar-rules/2026-09-27.1";

export type LabelRule = {
  /** Stable, non-personal key stored instead of the raw summary (DATA 03). */
  key: string;
  matches: (summary: string) => boolean;
  suggests: HostClass;
  /**
   * Anonymized fixtures that verified this rule across account types and
   * languages (CLASS 01). Empty means unverified: the rule only pre-selects an
   * answer in the host's policy question and never classifies on its own.
   */
  verifiedBy: readonly string[];
};

export type Capability = {
  platform: Platform;
  displayName: string;
  importSupport: "SUPPORTED" | "CONDITIONAL" | "MANUAL_SOURCE" | "UNAVAILABLE";
  exportSupport: boolean;
  /** Registrable domains accepted for import URLs, or any public host. */
  hostDomains: readonly string[] | "ANY_PUBLIC";
  /** Documented source horizon; null when unknown. */
  horizonDays: number | null;
  horizonVerified: boolean;
  refreshGuidance: string;
  labelRules: readonly LabelRule[];
  /** CLASS 02: one label covers both guest stays and owner closures. */
  singleLabelForStaysAndClosures: boolean;
  /** Maximum fetches claimed per scheduler tick across all workspaces. */
  budgetPerTick: number;
};

const exact = (text: string) => (s: string) =>
  s.trim().toLowerCase() === text.toLowerCase();

export const CAPABILITIES: Record<Platform, Capability> = {
  AIRBNB: {
    platform: "AIRBNB",
    displayName: "Airbnb",
    importSupport: "SUPPORTED",
    exportSupport: true,
    hostDomains: [
      "airbnb.com",
      "airbnb.ca",
      "airbnb.co.uk",
      "airbnb.com.au",
      "airbnb.co.nz",
      "airbnb.ie",
      "airbnb.de",
      "airbnb.fr",
      "airbnb.es",
      "airbnb.it",
      "airbnb.nl",
      "airbnb.co.in",
      "airbnb.com.br",
      "airbnb.mx",
      "airbnb.jp",
    ],
    horizonDays: null,
    horizonVerified: false,
    refreshGuidance:
      "Airbnb imports external calendars about every 3 hours. Checking more often here cannot make Airbnb refresh sooner.",
    labelRules: [
      {
        key: "reserved",
        matches: exact("Reserved"),
        suggests: "RESERVATION",
        verifiedBy: [],
      },
      {
        key: "not-available",
        matches: exact("Airbnb (Not available)"),
        suggests: "OWNER_BLOCK",
        verifiedBy: [],
      },
    ],
    singleLabelForStaysAndClosures: false,
    budgetPerTick: 60,
  },
  VRBO: {
    platform: "VRBO",
    displayName: "Vrbo",
    importSupport: "SUPPORTED",
    exportSupport: true,
    hostDomains: ["vrbo.com"],
    horizonDays: null,
    horizonVerified: false,
    refreshGuidance:
      "Vrbo decides when it imports this calendar; its import horizon and account eligibility differ from Airbnb.",
    labelRules: [
      {
        key: "reserved",
        matches: (s) => /^reserved\b/i.test(s.trim()),
        suggests: "RESERVATION",
        verifiedBy: [],
      },
      {
        key: "blocked",
        matches: (s) => /^blocked\b/i.test(s.trim()),
        suggests: "OWNER_BLOCK",
        verifiedBy: [],
      },
    ],
    singleLabelForStaysAndClosures: false,
    budgetPerTick: 60,
  },
  BOOKING: {
    platform: "BOOKING",
    displayName: "Booking.com",
    importSupport: "CONDITIONAL",
    exportSupport: true,
    hostDomains: ["booking.com"],
    horizonDays: null,
    horizonVerified: false,
    refreshGuidance:
      "Booking.com shows every closed date with one label; choose how this connection's blocks should be treated.",
    labelRules: [
      {
        key: "closed",
        matches: exact("CLOSED - Not available"),
        suggests: "UNKNOWN",
        verifiedBy: [],
      },
    ],
    singleLabelForStaysAndClosures: true,
    budgetPerTick: 60,
  },
  EXPEDIA: {
    platform: "EXPEDIA",
    displayName: "Expedia",
    importSupport: "UNAVAILABLE",
    exportSupport: false,
    hostDomains: [],
    horizonDays: null,
    horizonVerified: false,
    refreshGuidance:
      "Expedia is unavailable until a supported calendar route is verified.",
    labelRules: [],
    singleLabelForStaysAndClosures: false,
    budgetPerTick: 0,
  },
  GOOGLE: {
    platform: "GOOGLE",
    displayName: "Google Calendar",
    importSupport: "MANUAL_SOURCE",
    exportSupport: true,
    hostDomains: ["google.com"],
    horizonDays: null,
    horizonVerified: false,
    refreshGuidance:
      "Google Calendar is a manual availability source; its events start unclassified.",
    labelRules: [],
    singleLabelForStaysAndClosures: true,
    budgetPerTick: 40,
  },
  OTHER: {
    platform: "OTHER",
    displayName: "Other calendar",
    importSupport: "MANUAL_SOURCE",
    exportSupport: true,
    hostDomains: "ANY_PUBLIC",
    horizonDays: null,
    horizonVerified: false,
    refreshGuidance:
      "Other HTTPS calendars are manual availability sources; their events start unclassified.",
    labelRules: [],
    singleLabelForStaysAndClosures: true,
    budgetPerTick: 30,
  },
};

export const capabilityOf = (platform: Platform) => CAPABILITIES[platform];

/** Map a raw summary to a stable, non-personal label key; never stored raw. */
export function labelKeyOf(platform: Platform, summary: string | null): string {
  if (!summary) return "none";
  for (const rule of CAPABILITIES[platform].labelRules)
    if (rule.matches(summary)) return rule.key;
  return "other";
}

export function labelRule(platform: Platform, key: string) {
  return CAPABILITIES[platform].labelRules.find((r) => r.key === key) ?? null;
}

/** Exact registrable-domain rule for supported platforms (FETCH 01). */
export function hostAllowedForPlatform(platform: Platform, host: string) {
  const domains = CAPABILITIES[platform].hostDomains;
  if (domains === "ANY_PUBLIC") return true;
  const h = host.toLowerCase().replace(/\.$/, "");
  return domains.some((d) => h === d || h.endsWith("." + d));
}
