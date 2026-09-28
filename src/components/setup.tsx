"use client";
// Guided setup (AUTH 04 and the onboarding sequence). Every step is saved as
// soon as it is done; the host can leave and come back to the unfinished
// step, revisit earlier steps, and skip the optional ones. Nothing here claims
// a platform has imported a link or refreshed its calendar.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Check,
  Circle,
  CornerDownRight,
  RefreshCw,
} from "lucide-react";
import { useWorkspace } from "./workspace";
import { Head, Button, Field, ErrorBox } from "./ui";
import { CopyValue } from "./management";
import { PolicyQuestion } from "./calendar";
import { api } from "@/lib/client";
import { connectionStatus } from "@/lib/calendar-copy";
import { useNow } from "@/lib/use-now";
import { CAPABILITIES } from "@/domain/calendar/capabilities";
import { PLATFORMS } from "@/domain/calendar/types";
import type { Connection, Listing } from "@/lib/types";

type Step = "PROPERTY" | "CALENDAR" | "EXPORT" | "CLEANER" | "REHEARSAL";
export type SetupState = {
  exists: boolean;
  step: Step | "DONE";
  completed: Step[];
  skipped: Step[];
  listingId: string | null;
  connectionId: string | null;
  exportConfirmedAt: string | null;
  completedAt: string | null;
  calendar: null | {
    connection: Connection;
    dateRanges: number;
    reservations: number;
    unclassified: number;
    protectedNights: number;
  };
  rehearsal: {
    calendarMode: "SHADOW" | "LIVE";
    automationPaused: boolean;
    turnovers: string[];
    turnoverCount: number;
    unclassified: number;
  };
};
type Action =
  | { action: "save"; listingId?: string; connectionId?: string }
  | {
      action: "complete";
      step: Step;
      listingId?: string;
      connectionId?: string;
      exportConfirmed?: true;
    }
  | { action: "skip"; step: Step }
  | { action: "goto"; step: Step };
type Act = (payload: Action) => Promise<SetupState>;

const STEPS: [Step, string][] = [
  ["PROPERTY", "Property"],
  ["CALENDAR", "Calendar"],
  ["EXPORT", "Export link"],
  ["CLEANER", "Cleaner"],
  ["REHEARSAL", "First actions"],
];
const IMPORTABLE = PLATFORMS.filter(
  (p) => CAPABILITIES[p].importSupport !== "UNAVAILABLE",
);

export function SetupView() {
  const { mutate } = useWorkspace();
  const [state, setState] = useState<SetupState | null>(null),
    [error, setError] = useState("");
  // Export links are shown once, when issued; kept in memory only.
  const exportUrl = useRef<string | null>(null);
  useEffect(() => {
    api<SetupState>("onboarding")
      .then(setState)
      .catch((e) => setError(e.message));
  }, []);
  const act: Act = useCallback(
    async (payload) => {
      const next = await mutate<SetupState>("onboarding", payload);
      setState(next);
      return next;
    },
    [mutate],
  );
  const reload = useCallback(
    () =>
      api<SetupState>("onboarding")
        .then(setState)
        .catch(() => undefined),
    [],
  );
  if (!state)
    return error ? <ErrorBox message={error} /> : <p>Loading setup…</p>;
  const done = (s: Step) => state.completed.includes(s);
  const skipped = (s: Step) => state.skipped.includes(s);
  return (
    <>
      <Head
        title="Set up your workspace."
        description="About five minutes. Each step is saved as you go, so you can leave and come back."
      />
      <ol className="setup-steps" aria-label="Setup steps">
        {STEPS.map(([step, name], i) => {
          const current = state.step === step;
          const open = done(step) || skipped(step) || current;
          return (
            <li
              key={step}
              className={
                current
                  ? "current"
                  : done(step)
                    ? "done"
                    : skipped(step)
                      ? "skipped"
                      : ""
              }
            >
              <button
                type="button"
                disabled={!open || current}
                aria-current={current ? "step" : undefined}
                onClick={() => act({ action: "goto", step })}
              >
                <span className="setup-step-mark" aria-hidden="true">
                  {done(step) ? (
                    <Check size={14} />
                  ) : skipped(step) ? (
                    <CornerDownRight size={14} />
                  ) : current ? (
                    i + 1
                  ) : (
                    <Circle size={10} />
                  )}
                </span>
                <span>
                  {name}
                  <small>
                    {done(step)
                      ? "Done"
                      : skipped(step)
                        ? "Skipped"
                        : current
                          ? "Now"
                          : ""}
                  </small>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {state.step !== "DONE" && (
        <p className="setup-caption" aria-hidden="true">
          Step {STEPS.findIndex(([s]) => s === state.step) + 1} of{" "}
          {STEPS.length}: {STEPS.find(([s]) => s === state.step)?.[1]}
        </p>
      )}
      <section className="panel setup-panel">
        {state.step === "DONE" ? (
          <Finished />
        ) : state.step === "PROPERTY" ? (
          <PropertyStep state={state} act={act} />
        ) : state.step === "CALENDAR" ? (
          <CalendarStep
            state={state}
            act={act}
            reload={reload}
            onExportUrl={(u) => (exportUrl.current = u)}
          />
        ) : state.step === "EXPORT" ? (
          <ExportStep state={state} act={act} exportUrl={exportUrl} />
        ) : state.step === "CLEANER" ? (
          <CleanerStep state={state} act={act} />
        ) : (
          <RehearsalStep state={state} act={act} />
        )}
      </section>
    </>
  );
}

/** Form actions shared by the steps: busy state and a readable error. */
function useStepAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function zones(current: string) {
  const all =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  return [...new Set([current, ...all])];
}

function PropertyStep({ state, act }: { state: SetupState; act: Act }) {
  const { data, mutate } = useWorkspace();
  const { busy, error, run } = useStepAction();
  const hint = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const existing = data.listings;
  const [useExisting, setUseExisting] = useState(existing.length > 0);
  return (
    <>
      <h2>Add your first property</h2>
      <p className="form-intro">
        The time zone decides which nights a calendar date protects, so confirm
        the property’s own time zone. This device’s time zone is only a starting
        suggestion.
      </p>
      {existing.length > 0 && (
        <fieldset className="choices">
          <legend>Start from</legend>
          <label className="checkbox">
            <input
              type="radio"
              checked={useExisting}
              onChange={() => setUseExisting(true)}
            />
            A property already in this workspace
          </label>
          <label className="checkbox">
            <input
              type="radio"
              checked={!useExisting}
              onChange={() => setUseExisting(false)}
            />
            A new property
          </label>
        </fieldset>
      )}
      {useExisting && existing.length > 0 ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const listingId = String(
              new FormData(e.currentTarget).get("listingId"),
            );
            run(() => act({ action: "complete", step: "PROPERTY", listingId }));
          }}
        >
          <Field label="Property">
            <select
              name="listingId"
              defaultValue={state.listingId ?? existing[0].id}
            >
              {existing.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.timezone})
                </option>
              ))}
            </select>
          </Field>
          {error && <ErrorBox message={error} />}
          <div className="form-actions">
            <Button primary disabled={busy} type="submit">
              Continue <ArrowRight size={16} />
            </Button>
          </div>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            run(async () => {
              const listing = await mutate<Listing>("listings", {
                name: f.get("name"),
                address: f.get("address"),
                timezone: f.get("timezone"),
                currency: f.get("currency"),
                color: "#a8c9b8",
                bufferDays: 1,
                checkoutHour: Number(f.get("checkoutHour")),
                cleaningBufferHours: 4,
                houseManual: {
                  wifi: "",
                  checkin: String(f.get("checkin") ?? ""),
                  parking: "",
                  washroom: "",
                  rules: "",
                },
              });
              await act({
                action: "complete",
                step: "PROPERTY",
                listingId: listing.id,
              });
            });
          }}
        >
          <Field label="Property name">
            <input name="name" required maxLength={100} />
          </Field>
          <Field label="Address or location">
            <input name="address" required maxLength={500} />
          </Field>
          <div className="form-grid">
            <Field
              label="Time zone"
              hint={`Suggested from this device (${hint}). Choose the property’s own.`}
            >
              <select name="timezone" defaultValue={hint}>
                {zones(hint).map((z) => (
                  <option key={z}>{z}</option>
                ))}
              </select>
            </Field>
            <Field label="Currency">
              <select name="currency" defaultValue="USD">
                {["USD", "EUR", "GBP", "CAD", "AUD", "INR", "AED"].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
            <Field label="Checkout hour (local time)">
              <input
                name="checkoutHour"
                type="number"
                min="0"
                max="23"
                defaultValue={11}
                required
              />
            </Field>
          </div>
          <label className="checkbox">
            <input type="checkbox" name="zoneConfirmed" required />
            This is the property’s time zone, not just this device’s.
          </label>
          <Field
            label="Check-in instructions (optional)"
            hint="Guests and your reply rules read this. You can add Wi-Fi, parking and rules later."
          >
            <textarea name="checkin" rows={3} maxLength={4000} />
          </Field>
          {error && <ErrorBox message={error} />}
          <div className="form-actions">
            <Button primary disabled={busy} type="submit">
              {busy ? "Saving…" : "Save and continue"}
              <ArrowRight size={16} />
            </Button>
          </div>
        </form>
      )}
    </>
  );
}

function CalendarStep({
  state,
  act,
  reload,
  onExportUrl,
}: {
  state: SetupState;
  act: Act;
  reload: () => Promise<void>;
  onExportUrl: (url: string) => void;
}) {
  const { mutate, show } = useWorkspace();
  const { busy, error, run } = useStepAction();
  const [platform, setPlatform] = useState<string>("AIRBNB");
  const now = useNow();
  const checked = state.calendar?.connection.lastResult ?? null;
  // Until the first check has run, look again every few seconds.
  useEffect(() => {
    if (!state.connectionId || checked) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > 5 * 60_000) clearInterval(timer);
      else reload();
    }, 5000);
    return () => clearInterval(timer);
  }, [state.connectionId, checked, reload]);

  if (state.connectionId && state.calendar) {
    const c = state.calendar.connection;
    const status = connectionStatus(c, now);
    const ask =
      state.calendar.unclassified > 0 &&
      c.policy.mode === "UNSET" &&
      !c.policy.decidedAt;
    return (
      <>
        <h2>What {c.platformName} showed</h2>
        <p className="callout">
          <strong>{status.headline}.</strong> {status.detail}
        </p>
        {checked ? (
          <dl className="setup-counts">
            <div>
              <dt>Date ranges observed</dt>
              <dd>{state.calendar.dateRanges}</dd>
            </div>
            <div>
              <dt>Guest reservations</dt>
              <dd>{state.calendar.reservations}</dd>
            </div>
            <div>
              <dt>Not yet classified</dt>
              <dd>{state.calendar.unclassified}</dd>
            </div>
            <div>
              <dt>Nights protected</dt>
              <dd>{state.calendar.protectedNights}</dd>
            </div>
          </dl>
        ) : (
          <p className="muted" role="status">
            Waiting for the first check. It usually runs within a minute; this
            page updates by itself. You can also continue and come back.
          </p>
        )}
        {state.calendar.unclassified > 0 && (
          <p className="form-intro">
            Unclassified dates stay protected, and no cleaning is scheduled for
            them until you say what they are.
          </p>
        )}
        {error && <ErrorBox message={error} />}
        <div className="form-actions">
          {ask && (
            <Button
              onClick={() =>
                show(
                  "How should this calendar’s blocks count?",
                  <PolicyQuestion connection={c} />,
                )
              }
            >
              Answer how its blocks count
            </Button>
          )}
          <Button
            primary
            disabled={busy}
            onClick={() =>
              run(() => act({ action: "complete", step: "CALENDAR" }))
            }
          >
            Continue <ArrowRight size={16} />
          </Button>
        </div>
      </>
    );
  }

  const capability = CAPABILITIES[platform as keyof typeof CAPABILITIES];
  return (
    <>
      <h2>Connect a calendar</h2>
      <p className="form-intro">
        Paste the export (iCal) link from a platform where this property is
        listed. We check it and show what it contains before anything else
        happens. The link stays encrypted and never appears in logs.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          run(async () => {
            const created = await mutate<{
              connection: Connection;
              exportUrl: string;
            }>("connections", {
              listingId: state.listingId,
              platform,
              url: String(f.get("url") ?? "").trim(),
              label: null,
            });
            onExportUrl(created.exportUrl);
            // Ask for the first check now instead of on the next cycle.
            await api(`connections/${created.connection.id}/refresh`, {
              method: "POST",
              data: {},
            }).catch(() => undefined);
            await act({ action: "save", connectionId: created.connection.id });
          });
        }}
      >
        <Field label="Platform" hint={capability?.refreshGuidance}>
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          >
            {IMPORTABLE.map((p) => (
              <option key={p} value={p}>
                {CAPABILITIES[p].displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="The calendar’s export link"
          hint="It starts with https:// and usually ends in .ics."
        >
          <input
            name="url"
            required
            inputMode="url"
            autoComplete="off"
            placeholder="https://…/calendar.ics"
          />
        </Field>
        {error && <ErrorBox message={error} />}
        <div className="form-actions">
          <Button
            type="button"
            disabled={busy}
            onClick={() => run(() => act({ action: "skip", step: "CALENDAR" }))}
          >
            Skip for now
          </Button>
          <Button primary disabled={busy} type="submit">
            {busy ? "Connecting…" : "Connect and check"}
            <ArrowRight size={16} />
          </Button>
        </div>
      </form>
    </>
  );
}

function ExportStep({
  state,
  act,
  exportUrl,
}: {
  state: SetupState;
  act: Act;
  exportUrl: RefObject<string | null>;
}) {
  const { busy, error, run } = useStepAction();
  const [url, setUrl] = useState<string | null>(exportUrl.current);
  const [confirmed, setConfirmed] = useState(false);
  const c = state.calendar?.connection;
  if (!c)
    return (
      <>
        <h2>Add your export link</h2>
        <p className="form-intro">
          Connect a calendar first; its export link is made for that platform.
        </p>
        <div className="form-actions">
          <Button
            disabled={busy}
            onClick={() => run(() => act({ action: "skip", step: "EXPORT" }))}
          >
            Skip for now
          </Button>
        </div>
      </>
    );
  const where =
    c.platformName === "Other calendar" ? "the calendar" : c.platformName;
  return (
    <>
      <h2>Add your export link to {where}</h2>
      <p className="form-intro">
        This private link carries every protected date for the property except{" "}
        {where}’s own stays, so {where} never imports its bookings back. Treat
        it like a password.
      </p>
      {url ? (
        <CopyValue value={url} />
      ) : (
        <div className="callout">
          <p>
            For your security the link is shown only once. Create a fresh one to
            copy it now; any earlier copy stops working.
          </p>
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const rotated = await api<{ url: string }>(
                  `connections/${c.id}/export-token`,
                  { method: "POST", data: {} },
                );
                exportUrl.current = rotated.url;
                setUrl(rotated.url);
              })
            }
          >
            <RefreshCw size={15} /> Show a fresh link
          </Button>
        </div>
      )}
      <p className="form-intro">
        Open {where}’s calendar settings and find the option to import or sync a
        calendar from another website. Paste the link there and save.{" "}
        {state.rehearsal.calendarMode === "SHADOW"
          ? `While this workspace is in shadow mode the link answers “not active yet”, so ${where} keeps its current calendar until you go live.`
          : ""}
      </p>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        I added this link in {where}.
      </label>
      <p className="microcopy">
        This records what you told us. The connection shows separately when{" "}
        {where} actually fetches the link.
      </p>
      {error && <ErrorBox message={error} />}
      <div className="form-actions">
        <Button
          disabled={busy}
          onClick={() => run(() => act({ action: "skip", step: "EXPORT" }))}
        >
          Skip for now
        </Button>
        <Button
          primary
          disabled={busy || !confirmed}
          onClick={() =>
            run(() =>
              act({
                action: "complete",
                step: "EXPORT",
                exportConfirmed: true,
              }),
            )
          }
        >
          Continue <ArrowRight size={16} />
        </Button>
      </div>
    </>
  );
}

function CleanerStep({ state, act }: { state: SetupState; act: Act }) {
  const { mutate } = useWorkspace();
  const { busy, error, run } = useStepAction();
  return (
    <>
      <h2>Add a cleaner (optional)</h2>
      <p className="form-intro">
        Cleaners get a private link to the jobs you assign them, sent by text
        message when SMS is set up. Adding someone here creates their profile;
        it does not mean a message was delivered.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          run(async () => {
            await mutate("cleaners", {
              name: f.get("name"),
              phone: f.get("phone"),
              listingIds: state.listingId ? [state.listingId] : [],
            });
            await act({ action: "complete", step: "CLEANER" });
          });
        }}
      >
        <Field label="Name">
          <input name="name" required maxLength={100} />
        </Field>
        <Field
          label="Mobile number"
          hint="Include the country code, for example +15551234567."
        >
          <input
            name="phone"
            type="tel"
            pattern="\+[1-9][0-9]{7,14}"
            required
          />
        </Field>
        {error && <ErrorBox message={error} />}
        <div className="form-actions">
          <Button
            type="button"
            disabled={busy}
            onClick={() => run(() => act({ action: "skip", step: "CLEANER" }))}
          >
            Skip for now
          </Button>
          <Button primary disabled={busy} type="submit">
            {busy ? "Adding…" : "Add cleaner and continue"}
            <ArrowRight size={16} />
          </Button>
        </div>
      </form>
    </>
  );
}

function RehearsalStep({ state, act }: { state: SetupState; act: Act }) {
  const router = useRouter();
  const { toast } = useWorkspace();
  const { busy, error, run } = useStepAction();
  const r = state.rehearsal;
  return (
    <>
      <h2>What happens next</h2>
      <p className="form-intro">
        A rehearsal of the first things this workspace would do. Nothing is sent
        to guests or cleaners until you turn on selected automation.
      </p>
      <ul className="setup-rehearsal">
        <li>
          {r.automationPaused
            ? "Automation is paused. Messages and cleaning invitations wait until you enable selected categories in Automation."
            : "Automation is on for the categories you enabled."}
        </li>
        <li>
          Calendars are checked about every 15 minutes, and every 5 minutes when
          a stay is near.
        </li>
        <li>
          {r.calendarMode === "SHADOW"
            ? "Shadow mode: new calendar decisions are recorded for review. Export links answer “not active yet” and turnover work is withheld until the workspace goes live."
            : "Live: export links serve your protected dates, and turnover work is scheduled for guest reservations."}
        </li>
        <li>
          {r.turnoverCount > 0
            ? `Turnover cleaning ${r.calendarMode === "SHADOW" ? "would be" : "is"} scheduled after checkout on ${r.turnovers.join(", ")}${r.turnoverCount > r.turnovers.length ? ` and ${r.turnoverCount - r.turnovers.length} more` : ""}.`
            : "No upcoming guest reservations yet, so no turnover work would be scheduled."}
        </li>
        {r.unclassified > 0 && (
          <li>
            {r.unclassified} date range{r.unclassified === 1 ? " is" : "s are"}{" "}
            not yet classified: protected, with no cleaning until you decide.
          </li>
        )}
        <li>
          Guest messages arrive only through an approved messaging connection;
          calendar links never include conversations.
        </li>
      </ul>
      {error && <ErrorBox message={error} />}
      <div className="form-actions">
        <Button
          primary
          disabled={busy}
          onClick={() =>
            run(async () => {
              await act({ action: "complete", step: "REHEARSAL" });
              toast("Setup complete. Your calendar is ready.");
              router.push("/calendar");
            })
          }
        >
          Finish setup <ArrowRight size={16} />
        </Button>
      </div>
    </>
  );
}

function Finished() {
  return (
    <>
      <h2>Setup is complete</h2>
      <p className="form-intro">
        You can revisit any step above, or carry on from the calendar and your
        properties.
      </p>
      <div className="form-actions">
        <Link className="button" href="/properties">
          Properties
        </Link>
        <Link className="button primary" href="/calendar">
          Open the calendar <ArrowRight size={16} />
        </Link>
      </div>
    </>
  );
}
