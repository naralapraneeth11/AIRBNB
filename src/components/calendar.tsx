"use client";
import { useState, useEffect, useRef } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
  ShieldCheck,
  ArrowUpRight,
  Clock,
  Info,
  CalendarDays,
  LockKeyhole,
} from "lucide-react";
import Link from "next/link";
import { useWorkspace, MutationForm } from "./workspace";
import { api, label, localDate, dateTime, money } from "@/lib/client";
import { freshness, dayAdd, dateOnly } from "@/lib/domain";
import type { Booking, Source, Listing } from "@/lib/types";
import { Button, Head, Badge, Empty, Field, ErrorBox } from "./ui";
export function SyncDot({ source }: { source: Source }) {
  const { data } = useWorkspace();
  const status = freshness(
    source.status,
    source.lastSyncedAt,
    Date.now(),
    data.staleMinutes,
  );
  const detail = `${source.platform}: ${status === "fresh" ? "recently polled" : status === "polling" ? "polling normally" : status === "delayed" ? "poll delayed" : "needs attention"}${source.lastSyncedAt ? "; last success " + dateTime(source.lastSyncedAt) : "; never successfully polled"}. ${source.error || ""}`;
  return (
    <span
      className={"status-dot " + status}
      title={detail}
      role="img"
      aria-label={detail}
    />
  );
}
export function CalendarView() {
  const { data, show, toast, refresh } = useWorkspace();
  const [anchor, setAnchor] = useState(localDate()),
    [mode, setMode] = useState("Month"),
    [listing, setListing] = useState("all"),
    [bookings, setBookings] = useState<Booking[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const drag = useRef<string | null>(null),
    grid = useRef<HTMLDivElement>(null);
  const d = new Date(anchor + "T12:00:00"),
    monthStart = new Date(d.getFullYear(), d.getMonth(), 1);
  const start =
    mode === "Month"
      ? new Date(
          monthStart.getFullYear(),
          monthStart.getMonth(),
          1 - ((monthStart.getDay() + 6) % 7),
        )
      : new Date(
          d.getFullYear(),
          d.getMonth(),
          d.getDate() - ((d.getDay() + 6) % 7),
        );
  const days = Array.from(
    { length: mode === "Month" ? 42 : 7 },
    (_, i) =>
      new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
  );
  const from = localDate(days[0]),
    to = localDate(new Date(days.at(-1)!.getTime() + 86400000));
  const key =
    data.sources.map((s) => s.lastSyncedAt).join() + data.tasks.length;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api<{ bookings: Booking[]; capped: boolean }>(
      `calendar?from=${from}&to=${to}`,
      { signal: controller.signal },
    )
      .then((r) => {
        setBookings(r.bookings);
        setError(
          r.capped
            ? "This range contains more than 2,000 reservations. Select a shorter range."
            : "",
        );
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [from, to, key, data]);
  const visible = data.listings.filter(
    (l) => listing === "all" || l.id === listing,
  );
  const relevant = bookings.filter(
    (b) => listing === "all" || b.listingId === listing,
  );
  const conflicts = relevant.filter(
    (b) => b.status === "CONFLICT" || b.status === "PENDING_REMOVAL",
  );
  const openBlock = (from?: string, to?: string) =>
    show(
      "Make room on the calendar",
      <BlockForm
        initial={{
          listingId: listing === "all" ? data.listings[0]?.id : listing,
          from,
          to,
        }}
      />,
    );
  function navigate(n: number) {
    setAnchor(
      localDate(
        new Date(
          d.getFullYear(),
          d.getMonth() + (mode === "Month" ? n : 0),
          mode === "Month" ? 1 : d.getDate() + n * 7,
        ),
      ),
    );
  }
  return (
    <>
      <Head
        title="One calendar. Every stay."
        description="The source of truth for your properties. Every change, in view."
      >
        <Button
          onClick={async () => {
            try {
              await api("sync", { method: "POST", data: {} });
              toast(
                "Sync requested. Feed status updates after the poll completes.",
              );
              await refresh();
            } catch (e) {
              toast((e as Error).message);
            }
          }}
        >
          <RefreshCw size={16} />
          Sync now
        </Button>
        <Button
          disabled={!data.listings.length}
          onClick={() => show("New direct reservation", <DirectBookingForm />)}
        >
          New reservation
        </Button>
        <Button
          primary
          disabled={!data.listings.length}
          onClick={() => openBlock()}
        >
          <Plus size={16} />
          Block dates
        </Button>
      </Head>
      <section className="status-surface">
        <div>
          <ShieldCheck />
          <span>
            <strong>
              {data.settings.paused
                ? "A clear view. Automation on your terms."
                : conflicts.length
                  ? "A few dates need your attention."
                  : "Your operations, connected."}
            </strong>
            <small>
              {data.settings.paused
                ? "Automation is paused. Calendar polling remains active to protect availability."
                : "Imported dates are protected. Booking platforms refresh your export feed on their own schedule."}
            </small>
          </span>
        </div>
        <div className="status-summary">
          <strong>
            {data.sources.filter((s) => s.status === "SYNCED").length}
            <span> / {data.sources.length}</span>
          </strong>
          <small>feeds with a successful poll</small>
        </div>
      </section>
      {error && <ErrorBox message={error} />}
      <div className="calendar-toolbar">
        <div className="period-control">
          <Button aria-label="Previous period" onClick={() => navigate(-1)}>
            <ChevronLeft size={16} />
          </Button>
          <h2>
            {d.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
          </h2>
          <Button aria-label="Next period" onClick={() => navigate(1)}>
            <ChevronRight size={16} />
          </Button>
          <Button onClick={() => setAnchor(localDate())}>Today</Button>
        </div>
        <div className="actions">
          <select
            aria-label="Filter calendar by property"
            value={listing}
            onChange={(e) => setListing(e.target.value)}
          >
            <option value="all">All properties</option>
            {data.listings.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <div className="segmented">
            {["Month", "Week", "Agenda"].map((m) => (
              <button
                key={m}
                aria-pressed={mode === m}
                className={mode === m ? "selected" : ""}
                onClick={() => setMode(m)}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      </div>
      {!data.listings.length ? (
        <section className="panel">
          <Empty
            title="Your first property starts here."
            detail="Add a listing, connect its calendar feeds, and bring the next stay into focus."
            action={
              <Link className="button primary" href="/properties">
                Add a property
                <ArrowUpRight size={16} />
              </Link>
            }
          />
        </section>
      ) : mode === "Agenda" ? (
        <section className="panel">
          <div className="panel-heading">
            <h2>Upcoming reservations</h2>
            <Badge>{relevant.length} stays & blocks</Badge>
          </div>
          {relevant.length ? (
            relevant.map((b) => (
              <button
                className="agenda-row"
                key={b.id}
                onClick={() =>
                  show(
                    b.kind === "BLOCK" ? "Calendar block" : "Reservation",
                    <BookingDetail booking={b} />,
                    true,
                  )
                }
              >
                <span
                  className="listing-line"
                  style={{
                    background: data.listings.find((l) => l.id === b.listingId)
                      ?.color,
                  }}
                />
                <div>
                  <strong>{b.kind === "BLOCK" ? b.reason : b.guestName}</strong>
                  <p>
                    {data.listings.find((l) => l.id === b.listingId)?.name} ·{" "}
                    {label(b.platform)}
                  </p>
                </div>
                <span>
                  {b.startDate} → {b.endDate}
                </span>
                <Badge>{label(b.status)}</Badge>
                <ArrowUpRight size={16} />
              </button>
            ))
          ) : (
            <Empty
              title="Room for what’s next."
              detail="Reservations will appear here after a successful calendar import."
            />
          )}
        </section>
      ) : (
        <section
          className={"panel calendar-panel " + (loading ? "refreshing" : "")}
          aria-busy={loading}
        >
          <div className="calendar-weekdays">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((v) => (
              <span key={v}>{v}</span>
            ))}
          </div>
          <div
            className={"calendar-grid " + (mode === "Week" ? "week" : "")}
            ref={grid}
            role="grid"
            aria-label="Master calendar"
            onKeyDown={(e) => {
              const buttons = Array.from(
                grid.current?.querySelectorAll<HTMLButtonElement>(
                  ".day-number",
                ) || [],
              );
              const index = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const delta = (
                {
                  ArrowRight: 1,
                  ArrowLeft: -1,
                  ArrowDown: 7,
                  ArrowUp: -7,
                } as Record<string, number>
              )[e.key];
              if (delta && index >= 0) {
                e.preventDefault();
                buttons[
                  Math.max(0, Math.min(buttons.length - 1, index + delta))
                ]?.focus();
              }
            }}
          >
            {days.map((date) => {
              const iso = localDate(date),
                inMonth = date.getMonth() === d.getMonth();
              return (
                <div
                  className={
                    "calendar-cell " +
                    (!inMonth && mode === "Month" ? "outside " : "") +
                    (iso === localDate() ? "today" : "")
                  }
                  key={iso}
                  role="gridcell"
                  onPointerDown={(e) => {
                    if ((e.target as HTMLElement).closest(".calendar-booking"))
                      return;
                    drag.current = iso;
                  }}
                  onPointerUp={() => {
                    if (drag.current && drag.current !== iso) {
                      const a = drag.current;
                      drag.current = null;
                      openBlock(
                        a < iso ? a : iso,
                        dateOnly(dayAdd(a > iso ? a : iso, 1)),
                      );
                    } else drag.current = null;
                  }}
                >
                  <button
                    className="day-number"
                    aria-label={`Block dates beginning ${date.toLocaleDateString()}`}
                    onClick={() => openBlock(iso, dateOnly(dayAdd(iso, 1)))}
                  >
                    {date.getDate()}
                  </button>
                  {visible.map((l) => {
                    const rows = relevant.filter(
                      (b) =>
                        b.listingId === l.id &&
                        b.startDate <= iso &&
                        b.endDate > iso,
                    );
                    const buffered =
                      !rows.length &&
                      relevant.some(
                        (b) =>
                          b.listingId === l.id &&
                          ((iso >=
                            dateOnly(dayAdd(b.startDate, -l.bufferDays)) &&
                            iso < b.startDate) ||
                            (iso >= b.endDate &&
                              iso < dateOnly(dayAdd(b.endDate, l.bufferDays)))),
                      );
                    return (
                      <div className="listing-day" key={l.id}>
                        {rows.map((b) => (
                          <button
                            key={b.id}
                            className={
                              "calendar-booking " +
                              (["CONFLICT", "PENDING_REMOVAL"].includes(
                                b.status,
                              )
                                ? "conflict"
                                : "")
                            }
                            style={
                              {
                                "--listing-color": l.color,
                              } as React.CSSProperties
                            }
                            onClick={() =>
                              show(
                                "Reservation details",
                                <BookingDetail booking={b} />,
                                true,
                              )
                            }
                            title={`${l.name} · ${b.guestName} · ${label(b.platform)} · ${label(b.status)}`}
                          >
                            <span className="platform-icon">
                              {b.kind === "BLOCK" ? (
                                <LockKeyhole size={10} />
                              ) : (
                                b.platform.slice(0, 1)
                              )}
                            </span>
                            <span>
                              {b.kind === "BLOCK" ? b.reason : b.guestName}
                            </span>
                            {b.status === "CONFLICT" && <Info size={11} />}
                          </button>
                        ))}
                        {buffered && (
                          <span
                            className="calendar-buffer"
                            title={`${l.name} · ${l.bufferDays} protected buffer day(s)`}
                          >
                            Buffer
                          </span>
                        )}
                      </div>
                    );
                  })}
                  <div className="day-sync" aria-label="Calendar source health">
                    {data.sources
                      .filter(
                        (s) =>
                          s.enabled &&
                          visible.some((l) => l.id === s.listingId),
                      )
                      .map((s) => (
                        <SyncDot key={s.id} source={s} />
                      ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="calendar-legend">
            {visible.map((l) => (
              <span key={l.id}>
                <i style={{ background: l.color }} />
                {l.name}
              </span>
            ))}
            <span className="buffer-key">▨ Buffer days</span>
          </div>
        </section>
      )}
      <div className="calendar-note">
        <Info size={15} />
        <p>
          Drag across dates to block a range, or use the date buttons and arrow
          keys. Imported calendars often omit names and prices; missing details
          stay marked as unavailable.
        </p>
      </div>
      {conflicts.length > 0 && (
        <section className="panel attention-panel">
          <div className="panel-heading">
            <h2>Resolve before opening these dates</h2>
            <Badge>{conflicts.length} to review</Badge>
          </div>
          {conflicts.map((b) => (
            <button
              className="list-row"
              key={b.id}
              onClick={() =>
                show("Review reservation", <BookingDetail booking={b} />, true)
              }
            >
              <Info />
              <span className="grow">
                <strong>
                  {data.listings.find((l) => l.id === b.listingId)?.name}
                </strong>
                <small>
                  {b.startDate} → {b.endDate} · {label(b.status)}
                </small>
              </span>
              <ArrowUpRight size={16} />
            </button>
          ))}
        </section>
      )}
      <section className="panel source-health">
        <div className="panel-heading">
          <h2>Sync, without the guesswork.</h2>
          <span className="muted">Your last successful imports</span>
        </div>
        {data.sources.length ? (
          data.sources.map((s) => (
            <div className="list-row" key={s.id}>
              <SyncDot source={s} />
              <div className="grow">
                <strong>
                  {data.listings.find((l) => l.id === s.listingId)?.name}{" "}
                  <span className="muted">/ {label(s.platform)}</span>
                </strong>
                <small>
                  {s.lastSyncedAt
                    ? "Last successful poll " + dateTime(s.lastSyncedAt)
                    : "Waiting for the first successful poll"}
                </small>
                {s.error && <p>{s.error}</p>}
              </div>
              <Badge>{label(s.status)}</Badge>
            </div>
          ))
        ) : (
          <p className="panel-pad muted">
            Connect an iCal feed from a property’s channel settings.
          </p>
        )}
      </section>
    </>
  );
}
export function BlockForm({
  initial = {},
}: {
  initial?: { listingId?: string; from?: string; to?: string };
}) {
  const { data } = useWorkspace();
  const id = useRef(crypto.randomUUID());
  return (
    <MutationForm
      path="calendar/block"
      label="Confirm block"
      build={(f) => ({
        listingId: f.get("listingId"),
        from: f.get("from"),
        to: f.get("to"),
        reason: f.get("reason"),
        idempotencyKey: id.current,
      })}
    >
      <p className="form-intro">
        This blocks availability in your export feeds. Existing reservations and
        buffer days are protected.
      </p>
      <Field label="Property">
        <select name="listingId" defaultValue={initial.listingId}>
          {data.listings.map((l) => (
            <option value={l.id} key={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="form-grid">
        <Field label="First blocked night">
          <input
            name="from"
            type="date"
            defaultValue={initial.from || localDate()}
            required
          />
        </Field>
        <Field label="Available again on">
          <input
            name="to"
            type="date"
            defaultValue={initial.to || dateOnly(dayAdd(new Date(), 1))}
            required
          />
        </Field>
      </div>
      <Field label="Reason">
        <input
          name="reason"
          placeholder="Maintenance, personal stay…"
          maxLength={200}
          required
        />
      </Field>
    </MutationForm>
  );
}
function BookingDetail({ booking: b }: { booking: Booking }) {
  const { data, explain, show, close } = useWorkspace();
  const l = data.listings.find((l) => l.id === b.listingId);
  const task = data.tasks.find((t) => t.bookingId === b.id);
  return (
    <div className="booking-detail">
      <Badge>{label(b.status)}</Badge>
      <h2>{b.kind === "BLOCK" ? b.reason : b.guestName}</h2>
      <p>
        {l?.name} · {label(b.platform)}
      </p>
      <dl>
        <div>
          <dt>Check-in</dt>
          <dd>{b.startDate}</dd>
        </div>
        <div>
          <dt>Checkout</dt>
          <dd>{b.endDate}</dd>
        </div>
        <div>
          <dt>Reservation total</dt>
          <dd>
            {b.price === null
              ? "Not provided by feed"
              : money(b.price, b.currency)}
          </dd>
        </div>
        <div>
          <dt>Cleaning</dt>
          <dd>{task ? label(task.status) : "Not scheduled"}</dd>
        </div>
        <div>
          <dt>Protected buffer</dt>
          <dd>{l?.bufferDays} day(s)</dd>
        </div>
      </dl>
      <div className="stack-actions">
        <Link
          className="button"
          href={"/inbox?booking=" + b.id}
          onClick={close}
        >
          Open message thread
          <ArrowUpRight size={15} />
        </Link>
        <Button onClick={() => explain(b.id)}>
          Why / history
          <Info size={15} />
        </Button>
        <Button
          onClick={() =>
            show("Add booking details", <BookingEdit booking={b} />)
          }
        >
          Edit guest details & price
        </Button>
        {(b.status === "CONFLICT" ||
          b.status === "PENDING_REMOVAL" ||
          b.kind === "BLOCK") && (
          <Button
            onClick={() =>
              show(
                "Review before changing availability",
                <ResolveBooking booking={b} />,
              )
            }
          >
            {b.kind === "BLOCK"
              ? "Remove this block"
              : "Resolve this reservation"}
          </Button>
        )}
      </div>
      {b.status === "CONFLICT" && (
        <p className="callout">
          The earliest confirmed reservation is preferred. No guest reservation
          has been automatically cancelled. Resolve the outcome with the
          platform before releasing these dates.
        </p>
      )}
    </div>
  );
}
function BookingEdit({ booking: b }: { booking: Booking }) {
  return (
    <MutationForm
      path={"bookings/" + b.id}
      method="PATCH"
      build={(f) => ({
        guestName: f.get("name"),
        guestContact: f.get("contact"),
        price: f.get("price") === "" ? null : Number(f.get("price")),
        version: b.version,
      })}
    >
      <Field label="Guest name">
        <input
          name="name"
          required
          defaultValue={
            b.guestName === "Guest details unavailable" ? "" : b.guestName
          }
        />
      </Field>
      <Field
        label="Guest contact"
        hint="Stored encrypted. For direct-booking email replies, enter an email address. Saving replaces any previous contact."
      >
        <input name="contact" required autoComplete="off" />
      </Field>
      <Field label={`Total reservation price (${b.currency})`}>
        <input
          name="price"
          type="number"
          min="0"
          step="0.01"
          defaultValue={b.price ?? ""}
        />
      </Field>
    </MutationForm>
  );
}
function ResolveBooking({ booking: b }: { booking: Booking }) {
  return (
    <MutationForm
      path={`bookings/${b.id}/resolve-conflict`}
      label="Confirm resolution"
      build={(f) => ({
        action: b.kind === "BLOCK" ? "REMOVE_BLOCK" : f.get("action"),
        reason: f.get("reason"),
        version: b.version,
        externalResolutionConfirmed: f.get("confirmed") === "on",
      })}
    >
      <p className="callout">
        Changing internal availability does not cancel or modify the external
        booking. Released dates may be imported by booking platforms later.
      </p>
      {b.kind !== "BLOCK" && (
        <>
          <Field label="Resolution">
            <select name="action">
              <option value="KEEP">Keep this booking as preferred</option>
              <option value="DISMISS">
                Externally resolved — release these dates
              </option>
              <option value="CONFIRM_REMOVAL">
                Confirm the booking was removed externally
              </option>
            </select>
          </Field>
          <label className="checkbox">
            <input name="confirmed" type="checkbox" required />I confirmed the
            outcome with the platform and guest.
          </label>
        </>
      )}
      <Field label="Reason for the audit trail">
        <textarea name="reason" minLength={10} maxLength={1000} required />
      </Field>
    </MutationForm>
  );
}

function DirectBookingForm() {
  const { data } = useWorkspace();
  const id = useRef(crypto.randomUUID());
  const [listingId, setListingId] = useState(data.listings[0]?.id || "");
  const listing = data.listings.find((l) => l.id === listingId);
  return (
    <MutationForm
      path="bookings"
      label="Confirm reservation"
      build={(f) => ({
        listingId,
        from: f.get("from"),
        to: f.get("to"),
        guestName: f.get("guestName"),
        guestContact: f.get("guestContact"),
        price: f.get("price") === "" ? null : Number(f.get("price")),
        currency: listing?.currency || "USD",
        idempotencyKey: id.current,
      })}
    >
      <p className="form-intro">
        Record an agreed direct stay. Availability is checked against every
        reservation and buffer before confirmation. A private email conversation
        is created for your guest.
      </p>
      <Field label="Property">
        <select
          name="listingId"
          value={listingId}
          onChange={(e) => setListingId(e.target.value)}
        >
          {data.listings.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="form-grid">
        <Field label="Check-in">
          <input name="from" type="date" required defaultValue={localDate()} />
        </Field>
        <Field label="Checkout">
          <input name="to" type="date" required />
        </Field>
      </div>
      <Field label="Guest name">
        <input name="guestName" autoComplete="off" maxLength={200} required />
      </Field>
      <Field
        label="Guest email"
        hint="Encrypted at rest. Replies use your configured email provider."
      >
        <input
          name="guestContact"
          type="email"
          autoComplete="off"
          required
          maxLength={320}
        />
      </Field>
      <Field
        label={`Reservation total (${listing?.currency || "USD"})`}
        hint="Leave empty when the total is not yet recorded. No payment is collected."
      >
        <input name="price" type="number" step="0.01" min="0" />
      </Field>
    </MutationForm>
  );
}
