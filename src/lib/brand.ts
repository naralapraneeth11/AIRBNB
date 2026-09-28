// The product's visible name, in one place (REL 03). The final name waits on
// decision D11 (a trademark and domain search), so it is a setting: set
// NEXT_PUBLIC_BRAND_NAME and redeploy; the value is built into the pages.
//
// Compatibility identifiers never follow it: export event UIDs
// (`@airbnb-automation`, frozen by D15), the export PRODID, the default
// storage bucket and database role names stay as they are, so nothing a
// platform or a deployment already uses changes.

/** Derive every visible form of the name from one setting. */
export function brandFrom(setting: string | undefined) {
  const name = setting?.trim().slice(0, 40) || "Airbnb Automation";
  const [first, ...rest] = name.split(/\s+/);
  return {
    name,
    /** The logo: a one-letter mark, the first word, then a small descriptor. */
    mark: first.charAt(0).toLowerCase(),
    wordmark: first.toLowerCase(),
    descriptor: rest.join(" ").toUpperCase(),
    /** An identifier-safe form, e.g. for the calendar fetcher's user agent. */
    token: name.replace(/[^A-Za-z0-9]/g, "") || "Calendar",
  } as const;
}

// Next.js inlines NEXT_PUBLIC_* variables at build time, so this literal
// reference is what makes the setting reach the browser.
export const BRAND = brandFrom(process.env.NEXT_PUBLIC_BRAND_NAME);
