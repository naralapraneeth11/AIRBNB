import type { Metadata } from "next";
import { FETCH_POLICY } from "@/domain/calendar/schedule";
import { FETCH_LIMITS } from "@/server/calendar/fetch";

// FETCH 02: the calendar fetcher's user agent links here, so a calendar
// operator can see who is requesting their feed, how often, and how to ask it
// to slow down. Nothing on this page depends on a workspace or a session.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Calendar fetcher",
  robots: { index: false },
};

const minutes = (ms: number) => Math.round(ms / 60_000);

export default function Fetcher() {
  const contact = process.env.FETCHER_CONTACT?.trim();
  return (
    <main id="main" className="info-page">
      <h1>About this calendar fetcher</h1>
      <p>
        Requests with the user agent <code>Hostsphere-CalendarFetcher</code>{" "}
        come from this deployment. It reads iCalendar export links that a host
        connected for a property they manage, so their dates stay protected
        across the platforms they use.
      </p>
      <h2>How often it asks</h2>
      <ul>
        <li>
          About every {minutes(FETCH_POLICY.normalMs)} minutes per connected
          link, and every {minutes(FETCH_POLICY.nearTermMs)} minutes when a stay
          begins or ends within {FETCH_POLICY.nearTermDays} days, spread with
          random jitter.
        </li>
        <li>
          Conditional requests with <code>If-None-Match</code> and{" "}
          <code>If-Modified-Since</code>, so an unchanged calendar costs a
          <code> 304</code>.
        </li>
        <li>
          After a failure it backs off, up to{" "}
          {minutes(FETCH_POLICY.failureMaxMs)} minutes between attempts.
        </li>
        <li>
          At most {FETCH_LIMITS.maxRedirects} redirects,{" "}
          {FETCH_LIMITS.deadlineMs / 1000} seconds and{" "}
          {FETCH_LIMITS.maxBytes / (1024 * 1024)} MB per request, over HTTPS
          only.
        </li>
      </ul>
      <h2>Asking it to slow down</h2>
      <p>
        Answer with <code>429</code> or <code>503</code> and a{" "}
        <code>Retry-After</code> header. The fetcher waits at least that long
        and never retries sooner; a delay longer than{" "}
        {FETCH_POLICY.autoRetryWindowMs / 3_600_000} hours pauses the link until
        then and tells the host.
      </p>
      <h2>Contact</h2>
      <p>
        {contact
          ? `Questions about these requests: ${contact}.`
          : "Contact the operator of this deployment through the address in its security policy."}
      </p>
    </main>
  );
}
