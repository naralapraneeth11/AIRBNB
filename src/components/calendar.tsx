"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
  ShieldCheck,
  ArrowUpRight,
  Info,
  LockKeyhole,
  CircleHelp,
  TriangleAlert,
  Eye,
} from "lucide-react";
import { useWorkspace } from "./workspace";
import { api, APIError, label, localDate, dateTime, money } from "@/lib/client";
import { dayAdd, dateOnly } from "@/lib/domain";
import {
  CLASS_LABEL,
  CONFLICT_LABEL,
  EVIDENCE_LABEL,
  FLAG_LABEL,
  HOLD_LABEL,
  blockState,
  blockTitle,
  connectionStatus,
  needsClassification,
  needsDecision,
  protective,
  type Tone,
} from "@/lib/calendar-copy";
import { useNow } from "@/lib/use-now";
import type { CalendarBlock, Conflict, Connection, Listing } from "@/lib/types";
import { Button, Head, Badge, Empty, Field, ErrorBox } from "./ui";

const shift = (date: string, days: number) => dateOnly(dayAdd(date, days));
const nights = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const nightsText = (from: string, to: string) => {
  const n = nights(from, to);
  return `${n} night${n === 1 ? "" : "s"}`;
};
const TONE_DOT: Record<Tone, string> = {
  ok: "fresh",
  muted: "polling",
  attention: "delayed",
  critical: "error",
};

type Attention = {
  blocks: CalendarBlock[];
  conflicts: Conflict[];
  policyQuestions: string[];
  capped: boolean;
};
type Overlap = {
  blockId: string;
  kind: "NIGHTS" | "BUFFER";
  classification: string;
  startDate: string;
  endDate: string;
};
type BlockHistory = {
  type: string;
  createdAt: string;
  payload: { cause?: string };
}[];
type ReleasePreview = {
  blockId: string;
  revision: number;
  nights: { startDate: string; endDate: string };
  buffers: { before: number; after: number };
  channels: {
    connectionId: string;
    platform: string;
    label: string | null;
    isSource: boolean;
  }[];
  conflicts: {
    id: string;
    kind: string;
    overlapStart: string;
    overlapEnd: string;
  }[];
  turnover: { id: string; status: string; cleanerId: string | null }[];
  limits: string[];
};

/** Status dot with the honest run result as its accessible name (CAL 05). */
export function ConnectionDot({
  connection,
  now,
}: {
  connection: Connection;
  now: number;
}) {
  const status = connectionStatus(connection, now);
  const text = `${connection.label || connection.platformName}: ${status.headline}. ${status.detail}`;
  return (
    <span
      className={"status-dot " + TONE_DOT[status.tone]}
      title={text}
      role="img"
      aria-label={text}
    />
  );
}

export function CalendarView() {
  const { data, show, toast, refresh } = useWorkspace();
  const params = useSearchParams();
  const now = useNow();
  const [anchor, setAnchor] = useState(localDate()),
    [mode, setMode] = useState("Month"),
    [listing, setListing] = useState("all"),
    [blocks, setBlocks] = useState<CalendarBlock[]>([]),
    [conflicts, setConflicts] = useState<Conflict[]>([]),
    [attention, setAttention] = useState<Attention | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const drag = useRef<string | null>(null),
    grid = useRef<HTMLDivElement>(null),
    opened = useRef(false);
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
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.all([
      api<{ blocks: CalendarBlock[]; conflicts: Conflict[]; capped: boolean }>(
        `calendar?from=${from}&to=${to}`,
        { signal: controller.signal },
      ),
      api<Attention>("calendar/attention", { signal: controller.signal }),
    ])
      .then(([range, pending]) => {
        setBlocks(range.blocks);
        setConflicts(range.conflicts);
        setAttention(pending);
        setError(
          range.capped
            ? "This range holds more than 2,000 date ranges. Select a shorter range."
            : "",
        );
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [from, to, data]);
  // Deep links from notifications: ?block=… and ?conflict=… (LIFE 05).
  useEffect(() => {
    if (opened.current) return;
    const block = params.get("block"),
      conflict = params.get("conflict");
    if (block) {
      opened.current = true;
      show("Protected dates", <BlockDetail id={block} />, true);
    } else if (conflict && attention) {
      opened.current = true;
      const c = attention.conflicts.find((x) => x.id === conflict);
      if (c) show("Overlapping dates", <ConflictDetail conflict={c} />, true);
      else toast("That overlap is no longer open.");
    }
  }, [params, attention, show, toast]);

  const visible = data.listings.filter(
    (l) => listing === "all" || l.id === listing,
  );
  const relevant = blocks.filter(
    (b) => listing === "all" || b.listingId === listing,
  );
  const conflicted = new Set(
    conflicts.flatMap((c) => [c.blockAId, c.blockBId]),
  );
  const importing = data.connections.filter((c) => c.enabled && c.importing);
  const checkedRecently = importing.filter(
    (c) => c.lastSuccessAt && now - Date.parse(c.lastSuccessAt) < 3_600_000,
  ).length;
  const decisions = (attention?.blocks ?? []).filter(needsDecision);
  const openHold = (from?: string, to?: string) =>
    show(
      "Hold dates",
      <HoldForm
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
  async function checkNow() {
    try {
      const { results } = await api<{
        results: { status: string; reason?: string }[];
      }>("sync", { method: "POST", data: {} });
      const queued = results.filter((r) => r.status === "QUEUED").length;
      toast(
        queued
          ? `${queued} calendar check${queued === 1 ? "" : "s"} queued. Results appear after each check runs.`
          : (results.find((r) => r.reason)?.reason ??
              "There is no calendar to check yet."),
      );
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  }
  return (
    <>
      <Head
        title="One calendar. Every stay."
        description="Which nights are protected, and why."
      >
        <Button onClick={checkNow} disabled={!importing.length}>
          <RefreshCw size={16} />
          Check calendars now
        </Button>
        <Button
          disabled={!data.listings.length}
          onClick={() =>
            show("New direct reservation", <DirectReservationForm />)
          }
        >
          New reservation
        </Button>
        <Button
          primary
          disabled={!data.listings.length}
          onClick={() => openHold()}
        >
          <Plus size={16} />
          Hold dates
        </Button>
      </Head>
      {data.workspace.calendarMode === "SHADOW" && (
        <p className="callout shadow-banner" role="note">
          <Eye size={16} aria-hidden="true" />
          <span>
            <strong>Shadow mode.</strong> New calendar decisions are recorded
            for review. Export links, calendar alerts and turnover changes stay
            off until this workspace goes live.
          </span>
        </p>
      )}
      <section className="status-surface">
        <div>
          <ShieldCheck />
          <span>
            <strong>
              {decisions.length
                ? `${decisions.length} date range${decisions.length === 1 ? " waits" : "s wait"} for your decision.`
                : attention?.conflicts.length
                  ? "Some dates overlap. Both stays remain protected."
                  : "Protected dates, in one view."}
            </strong>
            <small>
              Nothing reopens without your review. Platforms import your export
              links on their own schedule; a check here does not confirm what a
              platform shows.
            </small>
          </span>
        </div>
        <div className="status-summary">
          <strong>
            {checkedRecently}
            <span> / {importing.length}</span>
          </strong>
          <small>calendars checked in the last hour</small>
        </div>
      </section>
      {error && <ErrorBox message={error} />}
      {attention && <AttentionPanel attention={attention} />}
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
            detail="Add a property, connect its calendars, and bring the next stay into focus."
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
            <h2>Protected dates</h2>
            <Badge>{relevant.length} date ranges</Badge>
          </div>
          {relevant.length ? (
            relevant.map((b) => (
              <button
                className="agenda-row"
                key={b.id}
                onClick={() =>
                  show("Protected dates", <BlockDetail id={b.id} />, true)
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
                  <strong>{blockTitle(b)}</strong>
                  <p>
                    {data.listings.find((l) => l.id === b.listingId)?.name} ·{" "}
                    {CLASS_LABEL[b.effectiveClass]} · {label(b.platform)}
                  </p>
                </div>
                <span>
                  {b.startDate} → {b.endDate}
                </span>
                <Badge tone={b.lifecycle === "ACTIVE" ? "" : "attention"}>
                  {blockState(b, now)}
                </Badge>
                <ArrowUpRight size={16} />
              </button>
            ))
          ) : (
            <Empty
              title="Room for what’s next."
              detail="Dates appear here after a calendar check or when you hold them."
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
            aria-label="Protected dates by property"
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
                      openHold(a < iso ? a : iso, shift(a > iso ? a : iso, 1));
                    } else drag.current = null;
                  }}
                >
                  <button
                    className="day-number"
                    aria-label={`Hold dates beginning ${date.toLocaleDateString()}`}
                    onClick={() => openHold(iso, shift(iso, 1))}
                  >
                    {date.getDate()}
                  </button>
                  {visible.map((l) => (
                    <DayCell
                      key={l.id}
                      listing={l}
                      iso={iso}
                      blocks={relevant}
                      conflicted={conflicted}
                      now={now}
                    />
                  ))}
                  <div className="day-sync" aria-label="Calendar check results">
                    {importing
                      .filter((c) => visible.some((l) => l.id === c.listingId))
                      .map((c) => (
                        <ConnectionDot key={c.id} connection={c} now={now} />
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
            <span>
              <LockKeyhole size={11} aria-hidden="true" /> Your hold
            </span>
            <span>
              <CircleHelp size={11} aria-hidden="true" /> Unknown
            </span>
            <span>
              <TriangleAlert size={11} aria-hidden="true" /> Needs your decision
            </span>
            <span className="buffer-key">▨ Buffer days</span>
          </div>
        </section>
      )}
      <div className="calendar-note">
        <Info size={15} />
        <p>
          Drag across dates to hold a range, or use the date buttons and arrow
          keys. Departure dates are exclusive: a stay from the 14th to the 17th
          protects three nights. Calendars often omit names and prices; missing
          details stay marked as unavailable.
        </p>
      </div>
      <section className="panel source-health">
        <div className="panel-heading">
          <h2>Calendar checks</h2>
          <span className="muted">What each source showed when checked</span>
        </div>
        {importing.length ? (
          importing.map((c) => {
            const status = connectionStatus(c, now);
            return (
              <Link
                className="list-row"
                key={c.id}
                href={"/properties?connection=" + c.id}
              >
                <ConnectionDot connection={c} now={now} />
                <div className="grow">
                  <strong>
                    {data.listings.find((l) => l.id === c.listingId)?.name}{" "}
                    <span className="muted">/ {c.label || c.platformName}</span>
                  </strong>
                  <small>{status.detail}</small>
                </div>
                <Badge
                  tone={
                    status.tone === "critical" || status.tone === "attention"
                      ? "attention"
                      : ""
                  }
                >
                  {status.headline}
                </Badge>
              </Link>
            );
          })
        ) : (
          <p className="panel-pad muted">
            Connect a calendar from a property’s channel settings.
          </p>
        )}
      </section>
    </>
  );
}

function DayCell({
  listing: l,
  iso,
  blocks,
  conflicted,
  now,
}: {
  listing: Listing;
  iso: string;
  blocks: CalendarBlock[];
  conflicted: Set<string>;
  now: number;
}) {
  const { show } = useWorkspace();
  const rows = blocks.filter(
    (b) => b.listingId === l.id && b.startDate <= iso && b.endDate > iso,
  );
  const buffered =
    !rows.some(protective) &&
    blocks.some(
      (b) =>
        b.listingId === l.id &&
        protective(b) &&
        ((iso >= shift(b.startDate, -b.buffer.before) && iso < b.startDate) ||
          (iso >= b.endDate && iso < shift(b.endDate, b.buffer.after))),
    );
  return (
    <div className="listing-day">
      {rows.map((b) => {
        const title = blockTitle(b);
        const name = `${l.name}: ${title}, ${CLASS_LABEL[b.effectiveClass]}, ${blockState(b, now)}, ${b.startDate} to ${b.endDate}${conflicted.has(b.id) ? ", overlaps other dates" : ""}`;
        return (
          <button
            key={b.id}
            className={
              "calendar-booking" +
              (conflicted.has(b.id) ? " conflict" : "") +
              (b.lifecycle === "AWAITING_DECISION" ? " awaiting" : "") +
              (b.lifecycle === "RELEASED" ? " released" : "") +
              (b.effectiveClass === "UNKNOWN" ? " unknown" : "")
            }
            style={{ "--listing-color": l.color } as React.CSSProperties}
            onClick={() =>
              show("Protected dates", <BlockDetail id={b.id} />, true)
            }
            title={name}
            aria-label={name}
          >
            <span className="platform-icon" aria-hidden="true">
              {b.lifecycle === "AWAITING_DECISION" ? (
                <TriangleAlert size={10} />
              ) : b.identityKind === "MANUAL" ? (
                <LockKeyhole size={10} />
              ) : b.effectiveClass === "UNKNOWN" ? (
                <CircleHelp size={10} />
              ) : (
                b.platform.slice(0, 1)
              )}
            </span>
            <span>{title}</span>
          </button>
        );
      })}
      {buffered && (
        <span
          className="calendar-buffer"
          title={`${l.name}: buffer day around protected dates`}
        >
          Buffer
        </span>
      )}
    </div>
  );
}

/** Today's questions (CLASS 02, LIFE 01, CONFLICT 01), whatever month shows. */
function AttentionPanel({ attention }: { attention: Attention }) {
  const { data, show } = useWorkspace();
  const decisions = attention.blocks.filter(needsDecision);
  const questions = data.connections.filter((c) =>
    attention.policyQuestions.includes(c.id),
  );
  const unknown = attention.blocks.filter(
    (b) =>
      needsClassification(b) &&
      !needsDecision(b) &&
      !attention.policyQuestions.includes(b.connectionId ?? ""),
  );
  const flagged = attention.blocks.filter(
    (b) =>
      b.reviewFlags.length > 0 && !needsDecision(b) && !needsClassification(b),
  );
  const count =
    decisions.length +
    questions.length +
    unknown.length +
    flagged.length +
    attention.conflicts.length;
  if (!count) return null;
  const property = (id: string) =>
    data.listings.find((l) => l.id === id)?.name ?? "A property";
  const row = (
    key: string,
    icon: ReactNode,
    title: string,
    detail: string,
    open: () => void,
  ) => (
    <button className="list-row" key={key} onClick={open}>
      {icon}
      <span className="grow">
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <ArrowUpRight size={16} />
    </button>
  );
  return (
    <section className="panel attention-panel" aria-labelledby="attention">
      <div className="panel-heading">
        <h2 id="attention">Needs your decision</h2>
        <Badge tone="attention">{count} open</Badge>
      </div>
      {decisions.map((b) =>
        row(
          b.id,
          <TriangleAlert />,
          `${property(b.listingId)}: ${b.decisionReason === "CANCELLATION" ? "a stay was cancelled at its source" : "a stay is no longer in its calendar"}`,
          `${b.startDate} → ${b.endDate} · ${nightsText(b.startDate, b.endDate)} stay protected until you decide.`,
          () => show("Protected dates", <BlockDetail id={b.id} />, true),
        ),
      )}
      {questions.map((c) =>
        row(
          c.id,
          <CircleHelp />,
          `How should ${c.label || c.platformName} blocks count for ${property(c.listingId)}?`,
          "Answer once. Until then these dates stay protected and no cleaning is scheduled for them.",
          () =>
            show(
              "How should this calendar’s blocks count?",
              <PolicyQuestion connection={c} />,
            ),
        ),
      )}
      {attention.conflicts.map((c) =>
        row(
          c.id,
          <TriangleAlert />,
          `${property(c.listingId)}: ${CONFLICT_LABEL[c.kind]}`,
          `Overlap ${c.overlapStart} → ${c.overlapEnd}. Both remain protected; nothing was cancelled.`,
          () =>
            show("Overlapping dates", <ConflictDetail conflict={c} />, true),
        ),
      )}
      {unknown
        .slice(0, 10)
        .map((b) =>
          row(
            b.id,
            <CircleHelp />,
            `${property(b.listingId)}: unknown block`,
            `${b.startDate} → ${b.endDate} · protected; classify it to schedule cleaning if it is a stay.`,
            () => show("Protected dates", <BlockDetail id={b.id} />, true),
          ),
        )}
      {flagged
        .slice(0, 10)
        .map((b) =>
          row(
            b.id,
            <Info />,
            `${property(b.listingId)}: ${b.reviewFlags.map((f) => FLAG_LABEL[f] ?? label(f)).join(", ")}`,
            `${b.startDate} → ${b.endDate} · review the evidence; dates stay protected.`,
            () => show("Protected dates", <BlockDetail id={b.id} />, true),
          ),
        )}
      {attention.capped && (
        <p className="panel-footnote">
          Showing the first 300 items. Resolve these to see more.
        </p>
      )}
    </section>
  );
}

function useBlock(id: string) {
  const [state, setState] = useState<{
    block: CalendarBlock;
    preview: ReleasePreview;
    history: BlockHistory;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<{
      block: CalendarBlock;
      preview: ReleasePreview;
      history: BlockHistory;
    }>("blocks/" + id)
      .then((r) => {
        if (active) {
          setState(r);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [id]);
  return { ...state, error };
}

const HISTORY_LABEL: Record<string, string> = {
  BLOCK_CREATED: "Protected",
  BLOCK_UPDATED: "Changed",
  BLOCK_ACTIVE: "Protected again",
  BLOCK_MISSING_OBSERVED: "Missing from a check",
  BLOCK_AWAITING_DECISION: "Waiting for your decision",
  BLOCK_RETAINED_HOLD: "Kept blocked",
  BLOCK_RELEASED: "Released",
};

function BlockDetail({ id }: { id: string }) {
  const { data, show, close } = useWorkspace();
  const now = useNow();
  const { block: b, preview, history, error } = useBlock(id);
  if (error) return <ErrorBox message={error} />;
  if (!b || !preview) return <p className="muted">Loading…</p>;
  const l = data.listings.find((x) => x.id === b.listingId);
  const c = data.connections.find((x) => x.id === b.connectionId);
  const reservation = b.reservation;
  const task = reservation
    ? data.tasks.find((t) => t.reservationId === reservation.id && !t.closedAt)
    : undefined;
  const imported = !!b.connectionId;
  const canClassify =
    imported &&
    b.lifecycle !== "RELEASED" &&
    (b.identityKind === "UID" || b.identityKind === "RECURRENCE_INSTANCE");
  const restorable =
    b.lifecycle === "RELEASED" &&
    !!b.restorableUntil &&
    Date.parse(b.restorableUntil) > now;
  return (
    <div className="booking-detail">
      <div className="badge-row">
        <Badge>{CLASS_LABEL[b.effectiveClass]}</Badge>
        <Badge tone={b.lifecycle === "ACTIVE" ? "" : "attention"}>
          {blockState(b, now)}
        </Badge>
      </div>
      <h2>{blockTitle(b)}</h2>
      <p>
        {l?.name} ·{" "}
        {c
          ? `${c.label || c.platformName} calendar`
          : HOLD_LABEL[b.holdType ?? ""] || "Created by you"}
      </p>
      <dl>
        <div>
          <dt>Arrival</dt>
          <dd>{b.startDate}</dd>
        </div>
        <div>
          <dt>Departure (not protected)</dt>
          <dd>
            {b.endDate} · {nightsText(b.startDate, b.endDate)}
          </dd>
        </div>
        <div>
          <dt>Time zone</dt>
          <dd>{l?.timezone}</dd>
        </div>
        <div>
          <dt>Buffer days</dt>
          <dd>
            {b.buffer.before} before · {b.buffer.after} after
            {b.buffer.overridden ? " (your override)" : " (property default)"}
          </dd>
        </div>
        {imported && (
          <div>
            <dt>First observed</dt>
            <dd>
              {b.firstSeenAt ? dateTime(b.firstSeenAt) : "Not recorded"} (not
              the booking time)
            </dd>
          </div>
        )}
        {imported && (
          <div>
            <dt>Last seen in its calendar</dt>
            <dd>{b.lastSeenAt ? dateTime(b.lastSeenAt) : "Not recorded"}</dd>
          </div>
        )}
        {reservation && (
          <div>
            <dt>Reservation total</dt>
            <dd>
              {reservation.price === null
                ? "Not provided by the calendar"
                : money(reservation.price, reservation.currency)}
            </dd>
          </div>
        )}
        {reservation && (
          <div>
            <dt>Cleaning</dt>
            <dd>{task ? label(task.status) : "Not scheduled"}</dd>
          </div>
        )}
      </dl>
      <p className="callout">
        <strong>Why this classification: </strong>
        {EVIDENCE_LABEL[b.evidenceRule] ?? "Recorded with its evidence."}
        {b.suggested && b.effectiveClass === "UNKNOWN"
          ? ` The platform’s label suggests ${CLASS_LABEL[b.suggested].toLowerCase()}; that is not applied until you confirm it.`
          : ""}
        {b.effectiveClass === "UNKNOWN"
          ? " Unknown dates stay protected; no cleaning is scheduled for them."
          : ""}
      </p>
      {b.pendingChange?.startDate && (
        <p className="callout">
          The calendar now shows {b.pendingChange.startDate} →{" "}
          {b.pendingChange.endDate}. Changes that would remove protection wait
          for a complete, healthy check.
        </p>
      )}
      {b.reviewFlags.length > 0 && (
        <div className="callout">
          <strong>Review: </strong>
          {b.reviewFlags.map((f) => FLAG_LABEL[f] ?? label(f)).join(", ")}.
          <div className="form-actions">
            <AcknowledgeButton block={b} />
          </div>
        </div>
      )}
      <div className="stack-actions">
        {(b.lifecycle === "AWAITING_DECISION" ||
          b.lifecycle === "MISSING_OBSERVED") && (
          <Button
            primary
            onClick={() =>
              show("Keep these dates blocked", <KeepForm block={b} />)
            }
          >
            Keep dates blocked
          </Button>
        )}
        {protective(b) && (
          <Button
            onClick={() =>
              show(
                "Review before reopening",
                <ReleaseForm block={b} preview={preview} />,
              )
            }
          >
            Reopen these dates…
          </Button>
        )}
        {restorable && (
          <Button
            primary
            onClick={() =>
              show("Restore protection", <RestoreForm block={b} />)
            }
          >
            Restore protection
          </Button>
        )}
        {canClassify && (
          <Button
            onClick={() =>
              show("Classify these dates", <ClassifyForm block={b} />)
            }
          >
            Classify…
          </Button>
        )}
        {protective(b) && (
          <Button onClick={() => show("Buffer days", <BufferForm block={b} />)}>
            Adjust buffer days…
          </Button>
        )}
        {reservation && (
          <Button
            onClick={() =>
              show(
                "Guest details",
                <ReservationEdit reservation={reservation} blockId={b.id} />,
              )
            }
          >
            Add guest details & price
          </Button>
        )}
        {reservation && (
          <Link
            className="button"
            href={"/inbox?reservation=" + reservation.id}
            onClick={close}
          >
            Open message thread
            <ArrowUpRight size={15} />
          </Link>
        )}
      </div>
      {history && history.length > 0 && (
        <section className="explain-list" aria-label="History">
          <h3>History</h3>
          {history.map((h, i) => (
            <article key={i}>
              <Badge>{HISTORY_LABEL[h.type] ?? label(h.type)}</Badge>
              <small>
                {" "}
                {dateTime(h.createdAt)} ·{" "}
                {h.payload.cause?.startsWith("observation:")
                  ? "calendar check"
                  : h.payload.cause?.startsWith("host:")
                    ? "your action"
                    : "system"}
              </small>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

/** Posts once, reports the outcome, and returns to the dates' detail. */
function ActionForm({
  path,
  build,
  label: buttonLabel,
  children,
  back,
  method = "POST",
}: {
  path: string;
  build: (f: FormData) => unknown;
  label: string;
  children: ReactNode;
  back?: string;
  method?: string;
}) {
  const { mutate, show, close, toast } = useWorkspace();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          const result = await mutate<{ id?: string } | null>(
            path,
            build(new FormData(e.currentTarget)),
            method,
          );
          toast("Saved.");
          const target = back ?? result?.id;
          if (target)
            show("Protected dates", <BlockDetail id={target} />, true);
          else close();
        } catch (err) {
          setError(
            err instanceof APIError && err.status === 409
              ? `${err.message} Close this form and open the dates again to see their current state.`
              : (err as Error).message,
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
      {error && <ErrorBox message={error} />}
      <div className="form-actions">
        <Button type="button" onClick={close}>
          Cancel
        </Button>
        <Button primary disabled={busy} type="submit">
          {busy ? "Saving…" : buttonLabel}
        </Button>
      </div>
    </form>
  );
}

function ReasonField() {
  return (
    <Field label="Reason for the history">
      <textarea name="reason" minLength={3} maxLength={1000} required />
    </Field>
  );
}

/** LIFE 03: reopening shows nights, buffers, channels and open overlaps. */
function ReleaseForm({
  block: b,
  preview,
}: {
  block: CalendarBlock;
  preview: ReleasePreview;
}) {
  const confirm =
    !!b.connectionId &&
    (b.effectiveClass === "RESERVATION" || b.effectiveClass === "UNKNOWN");
  const platform = b.platform === "OTHER" ? "its platform" : label(b.platform);
  return (
    <ActionForm
      path={`blocks/${b.id}/release`}
      back={b.id}
      label="Reopen these dates"
      build={(f) => ({
        expectedRevision: preview.revision,
        reason: f.get("reason"),
        externalResolutionConfirmed: f.get("confirmed") === "on",
      })}
    >
      <dl className="review-list">
        <div>
          <dt>Nights that reopen</dt>
          <dd>
            {preview.nights.startDate} → {preview.nights.endDate} (
            {nightsText(preview.nights.startDate, preview.nights.endDate)})
          </dd>
        </div>
        <div>
          <dt>Buffer days that reopen</dt>
          <dd>
            {preview.buffers.before} before · {preview.buffers.after} after
          </dd>
        </div>
        <div>
          <dt>Export links that change</dt>
          <dd>
            {preview.channels.length
              ? preview.channels
                  .map(
                    (c) =>
                      `${c.label || label(c.platform)}${c.isSource ? " (source of these dates)" : ""}`,
                  )
                  .join(", ")
              : "None"}
          </dd>
        </div>
        {preview.conflicts.length > 0 && (
          <div>
            <dt>Open overlaps</dt>
            <dd>
              {preview.conflicts
                .map(
                  (c) =>
                    `${CONFLICT_LABEL[c.kind] ?? label(c.kind)} ${c.overlapStart} → ${c.overlapEnd}`,
                )
                .join("; ")}
            </dd>
          </div>
        )}
        {preview.turnover.length > 0 && (
          <div>
            <dt>Cleaning</dt>
            <dd>
              {preview.turnover.length} turnover task
              {preview.turnover.length === 1 ? "" : "s"}: cancelled if not
              started, flagged for your review if under way.
            </dd>
          </div>
        )}
      </dl>
      <ul className="limits">
        {preview.limits.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
      {confirm && (
        <label className="checkbox">
          <input name="confirmed" type="checkbox" required />I checked this stay
          on {platform}; it is cancelled or no longer needs these dates.
        </label>
      )}
      <ReasonField />
    </ActionForm>
  );
}

function KeepForm({ block: b }: { block: CalendarBlock }) {
  return (
    <ActionForm
      path={`blocks/${b.id}/keep`}
      back={b.id}
      label="Keep blocked"
      build={(f) => ({ expectedRevision: b.revision, reason: f.get("reason") })}
    >
      <p className="form-intro">
        These dates stay protected as your hold, and this question is not asked
        again. You can reopen them later.
      </p>
      <ReasonField />
    </ActionForm>
  );
}

function RestoreForm({ block: b }: { block: CalendarBlock }) {
  return (
    <ActionForm
      path={`blocks/${b.id}/restore`}
      label="Restore protection"
      build={(f) => ({ expectedRevision: b.revision, reason: f.get("reason") })}
    >
      <p className="callout">
        This protects {b.startDate} → {b.endDate} again with a new hold and
        publishes it to every export link. It cannot undo a platform’s refresh
        that already reopened these dates, or cancel a booking made in the
        meantime.
      </p>
      <ReasonField />
    </ActionForm>
  );
}

function ClassifyForm({ block: b }: { block: CalendarBlock }) {
  return (
    <ActionForm
      path={`blocks/${b.id}/classify`}
      back={b.id}
      label="Save classification"
      build={(f) => ({
        expectedRevision: b.revision,
        classification:
          f.get("classification") === "EVIDENCE"
            ? null
            : f.get("classification"),
        reason: f.get("reason"),
      })}
    >
      <p className="form-intro">
        Your classification is kept separate from what the calendar shows. If
        the source changes later, the dates stay protected and you are asked to
        review.
      </p>
      <fieldset className="choices">
        <legend>These dates are</legend>
        {[
          ["RESERVATION", "A guest reservation (schedules turnover cleaning)"],
          ["OWNER_BLOCK", "An owner block or closure (no cleaning)"],
          ["UNKNOWN", "Unknown (protected, no cleaning)"],
          ["EVIDENCE", "Use the calendar’s own evidence"],
        ].map(([value, text]) => (
          <label className="checkbox" key={value}>
            <input
              type="radio"
              name="classification"
              value={value}
              required
              defaultChecked={
                (b.overrideClassification ?? "EVIDENCE") === value
              }
            />
            {text}
          </label>
        ))}
      </fieldset>
      <ReasonField />
    </ActionForm>
  );
}

function BufferForm({ block: b }: { block: CalendarBlock }) {
  const day = (name: "before" | "after") => (
    <Field label={name === "before" ? "Days before" : "Days after"}>
      <input
        name={name}
        type="number"
        min={0}
        max={14}
        defaultValue={b.buffer.overridden ? b.buffer[name] : ""}
        placeholder="Property default"
      />
    </Field>
  );
  return (
    <ActionForm
      path={`blocks/${b.id}/buffers`}
      back={b.id}
      label="Save buffer days"
      build={(f) => ({
        expectedRevision: b.revision,
        before: f.get("before") === "" ? null : Number(f.get("before")),
        after: f.get("after") === "" ? null : Number(f.get("after")),
        reason: f.get("reason"),
      })}
    >
      <p className="form-intro">
        Leave a field empty to use the property default. Buffer days are
        published to every export link as unavailable.
      </p>
      <div className="form-grid">
        {day("before")}
        {day("after")}
      </div>
      <ReasonField />
    </ActionForm>
  );
}

function AcknowledgeButton({ block: b }: { block: CalendarBlock }) {
  const { mutate, show, toast } = useWorkspace();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await mutate(`blocks/${b.id}/acknowledge`, {
            expectedRevision: b.revision,
            flags: b.reviewFlags,
          });
          toast("Marked as reviewed. The dates stay protected.");
          show("Protected dates", <BlockDetail id={b.id} />, true);
        } catch (e) {
          toast((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      I reviewed this
    </Button>
  );
}

function ReservationEdit({
  reservation: r,
  blockId,
}: {
  reservation: NonNullable<CalendarBlock["reservation"]>;
  blockId: string;
}) {
  return (
    <ActionForm
      path={"bookings/" + r.id}
      method="PATCH"
      back={blockId}
      label="Save guest details"
      build={(f) => ({
        guestName: f.get("name"),
        guestContact: f.get("contact"),
        price: f.get("price") === "" ? null : Number(f.get("price")),
        version: r.version,
      })}
    >
      <Field label="Guest name">
        <input
          name="name"
          required
          defaultValue={
            r.guestName === "Guest details unavailable" ? "" : r.guestName
          }
        />
      </Field>
      <Field
        label="Guest contact"
        hint="Stored encrypted. For direct-booking email replies, enter an email address. Saving replaces any previous contact."
      >
        <input name="contact" autoComplete="off" />
      </Field>
      <Field label={`Reservation total (${r.currency})`}>
        <input
          name="price"
          type="number"
          min="0"
          step="0.01"
          defaultValue={r.price ?? ""}
        />
      </Field>
    </ActionForm>
  );
}

type PolicySample = {
  policy: { mode: string; version: number };
  singleLabelForStaysAndClosures: boolean;
  labels: { key: string; count: number; suggested: string | null }[];
  sample: {
    startDate: string;
    endDate: string;
    labelKey: string;
    identityUncertain: boolean;
  }[];
  total: number;
  sampleDigest: string;
};

/** CLASS 02: asked once per connection, with a sample of observed events. */
export function PolicyQuestion({ connection: c }: { connection: Connection }) {
  const { mutate, close, toast } = useWorkspace();
  const [sample, setSample] = useState<PolicySample | null>(null),
    [modeChoice, setModeChoice] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api<PolicySample>(`connections/${c.id}/policy`)
      .then((s) => {
        if (active) setSample(s);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [c.id]);
  if (error && !sample) return <ErrorBox message={error} />;
  if (!sample) return <p className="muted">Loading the observed events…</p>;
  const name = c.label || c.platformName;
  const mode =
    modeChoice ??
    (sample.policy.mode === "UNSET" ? "RESERVATIONS" : sample.policy.mode);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setBusy(true);
        setError("");
        try {
          const labels =
            mode === "BY_LABEL"
              ? Object.fromEntries(
                  sample.labels.map((l) => [l.key, f.get("label:" + l.key)]),
                )
              : null;
          const result = await mutate<{ reclassified: number }>(
            `connections/${c.id}/policy`,
            {
              mode,
              labels,
              expectedVersion: sample.policy.version,
              sampleDigest: sample.sampleDigest,
            },
          );
          toast(
            `Saved for ${name}. ${result.reclassified} date range${result.reclassified === 1 ? "" : "s"} reclassified.`,
          );
          close();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="form-intro">
        {sample.singleLabelForStaysAndClosures
          ? `${name} uses one label for guest stays and your own closures, so its blocks cannot be told apart automatically.`
          : `${name} does not say reliably whether its blocks are guest stays.`}{" "}
        Your answer applies to this calendar’s blocks now and later; you can
        change it at any time. Cancellations, echoes of your own export links
        and overlaps still follow their own rules.
      </p>
      <table className="sample-table">
        <caption>
          {sample.total} protected date range{sample.total === 1 ? "" : "s"}{" "}
          observed
          {sample.total > sample.sample.length
            ? "; the first 20 are shown"
            : ""}
        </caption>
        <thead>
          <tr>
            <th scope="col">Arrival</th>
            <th scope="col">Departure</th>
            <th scope="col">Label</th>
          </tr>
        </thead>
        <tbody>
          {sample.sample.map((s, i) => (
            <tr key={i}>
              <td>{s.startDate}</td>
              <td>{s.endDate}</td>
              <td>
                {s.labelKey === "none" ? "No label" : s.labelKey}
                {s.identityUncertain ? " (identity uncertain)" : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <fieldset className="choices">
        <legend>Blocks from {name} are</legend>
        {[
          ["RESERVATIONS", "Guest reservations: schedule turnover cleaning"],
          ["OWNER_BLOCKS", "My own closures: no cleaning"],
          ["BY_LABEL", "It depends on the label"],
          ["UNSET", "I will decide for each block"],
        ].map(([value, text]) => (
          <label className="checkbox" key={value}>
            <input
              type="radio"
              name="mode"
              value={value}
              checked={mode === value}
              onChange={() => setModeChoice(value)}
            />
            {text}
          </label>
        ))}
      </fieldset>
      {mode === "BY_LABEL" &&
        sample.labels.map((l) => (
          <Field
            key={l.key}
            label={`“${l.key === "none" ? "No label" : l.key}” (${l.count})`}
            hint={
              l.suggested
                ? `Suggested: ${CLASS_LABEL[l.suggested]} (unverified; you decide)`
                : undefined
            }
          >
            <select
              name={"label:" + l.key}
              defaultValue={
                sample.policy.mode === "BY_LABEL"
                  ? undefined
                  : (l.suggested ?? "UNKNOWN")
              }
            >
              <option value="RESERVATION">Guest reservation</option>
              <option value="OWNER_BLOCK">Owner block</option>
              <option value="UNKNOWN">Unknown</option>
            </select>
          </Field>
        ))}
      {error && <ErrorBox message={error} />}
      <div className="form-actions">
        <Button type="button" onClick={close}>
          Ask me later
        </Button>
        <Button primary disabled={busy} type="submit">
          {busy ? "Saving…" : "Save answer"}
        </Button>
      </div>
    </form>
  );
}

/** CONFLICT 01: both stays stay protected; the host records the outcome. */
function ConflictDetail({ conflict: c }: { conflict: Conflict }) {
  const { data, show } = useWorkspace();
  const a = useBlock(c.blockAId),
    b = useBlock(c.blockBId);
  const side = (x: ReturnType<typeof useBlock>) => {
    const block = x.block;
    return block ? (
      <button
        className="list-row"
        onClick={() =>
          show("Protected dates", <BlockDetail id={block.id} />, true)
        }
      >
        <span className="grow">
          <strong>{blockTitle(block)}</strong>
          <small>
            {CLASS_LABEL[block.effectiveClass]} · {label(block.platform)} ·{" "}
            {block.startDate} → {block.endDate}
            {block.firstSeenAt
              ? ` · first observed ${dateTime(block.firstSeenAt)}`
              : ""}
          </small>
        </span>
        <ArrowUpRight size={16} />
      </button>
    ) : (
      <p className="muted">{x.error || "Loading…"}</p>
    );
  };
  return (
    <div className="booking-detail">
      <Badge tone={c.severity === "HIGH" ? "attention" : ""}>
        {label(c.severity)} priority
      </Badge>
      <h2>{CONFLICT_LABEL[c.kind]}</h2>
      <p>
        {data.listings.find((l) => l.id === c.listingId)?.name} · overlap{" "}
        {c.overlapStart} → {c.overlapEnd}
      </p>
      {side(a)}
      {side(b)}
      <p className="callout">
        Both date ranges remain protected. Choosing which stay to keep does not
        cancel the other on its platform; handle the guest and the platform
        first, then record what you did.
      </p>
      <ActionForm
        path={`conflicts/${c.id}/resolve`}
        label="Record resolution"
        build={(f) => ({ expectedRevision: c.revision, note: f.get("note") })}
      >
        <Field label="What you did">
          <textarea name="note" minLength={10} maxLength={1000} required />
        </Field>
      </ActionForm>
    </div>
  );
}

/** MANUAL 01: overlaps are previewed; saving anyway is an explicit choice. */
function OverlapForm({
  path,
  build,
  label: buttonLabel,
  children,
}: {
  path: string;
  build: (f: FormData) => Record<string, unknown>;
  label: string;
  children: ReactNode;
}) {
  const { mutate, close, toast } = useWorkspace();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [overlaps, setOverlaps] = useState<Overlap[] | null>(null),
    [acknowledged, setAcknowledged] = useState(false);
  return (
    <form
      onChange={(e) => {
        // Any edit after a warning needs a fresh overlap check.
        if ((e.target as { name?: string }).name === "acknowledge") return;
        setOverlaps(null);
        setAcknowledged(false);
      }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await mutate(path, {
            ...build(new FormData(e.currentTarget)),
            acknowledgeOverlaps: acknowledged,
          });
          toast("Saved. Every export link for this property includes it.");
          close();
        } catch (err) {
          if (err instanceof APIError && err.code === "DATE_CONFLICT")
            setOverlaps(
              (err.details as { overlaps?: Overlap[] } | undefined)?.overlaps ??
                [],
            );
          else setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
      {overlaps && (
        <div className="callout" role="alert">
          <strong>These dates overlap protected dates or buffer days:</strong>
          <ul>
            {overlaps.map((o) => (
              <li key={o.blockId}>
                {CLASS_LABEL[o.classification] ?? label(o.classification)}{" "}
                {o.startDate} → {o.endDate}
                {o.kind === "BUFFER" ? " (buffer days)" : ""}
              </li>
            ))}
          </ul>
          <label className="checkbox">
            <input
              type="checkbox"
              name="acknowledge"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            Save anyway. The overlap is recorded and shown until you resolve it.
          </label>
        </div>
      )}
      {error && <ErrorBox message={error} />}
      <div className="form-actions">
        <Button type="button" onClick={close}>
          Cancel
        </Button>
        <Button
          primary
          disabled={busy || (!!overlaps && !acknowledged)}
          type="submit"
        >
          {busy ? "Saving…" : buttonLabel}
        </Button>
      </div>
    </form>
  );
}

function PropertyDates({
  initial,
  listingId,
  onListing,
  arrival,
  departure,
}: {
  initial: { from?: string; to?: string };
  listingId: string;
  onListing: (id: string) => void;
  arrival: string;
  departure: string;
}) {
  const { data } = useWorkspace();
  const listing = data.listings.find((l) => l.id === listingId);
  const channels = data.connections.filter(
    (c) => c.listingId === listingId && c.enabled,
  );
  return (
    <>
      <Field
        label="Property"
        hint={
          listing
            ? `Dates are in ${listing.timezone}. Export links affected: ${channels.length ? channels.map((c) => c.label || c.platformName).join(", ") : "none yet"}.`
            : undefined
        }
      >
        <select
          name="listingId"
          value={listingId}
          onChange={(e) => onListing(e.target.value)}
        >
          {data.listings.map((l) => (
            <option value={l.id} key={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="form-grid">
        <Field label={arrival}>
          <input
            name="from"
            type="date"
            defaultValue={initial.from || localDate()}
            required
          />
        </Field>
        <Field label={departure} hint="Not included: the first free night.">
          <input
            name="to"
            type="date"
            defaultValue={initial.to || shift(localDate(), 1)}
            required
          />
        </Field>
      </div>
    </>
  );
}

export function HoldForm({
  initial = {},
}: {
  initial?: { listingId?: string; from?: string; to?: string };
}) {
  const { data } = useWorkspace();
  const key = useRef(crypto.randomUUID());
  const [listingId, setListingId] = useState(
    initial.listingId || data.listings[0]?.id || "",
  );
  return (
    <OverlapForm
      path="calendar/block"
      label="Hold dates"
      build={(f) => ({
        listingId,
        from: f.get("from"),
        to: f.get("to"),
        holdType: f.get("holdType"),
        reason: f.get("reason"),
        idempotencyKey: key.current,
      })}
    >
      <p className="form-intro">
        A hold protects these nights in every export link for the property. It
        is yours: calendar checks never remove it.
      </p>
      <PropertyDates
        initial={initial}
        listingId={listingId}
        onListing={setListingId}
        arrival="First held night"
        departure="Available again on"
      />
      <Field label="Kind of hold">
        <select name="holdType" defaultValue="OWNER">
          <option value="OWNER">Owner hold (personal use)</option>
          <option value="MAINTENANCE">Maintenance</option>
        </select>
      </Field>
      <Field label="Reason">
        <input
          name="reason"
          placeholder="Personal stay, repairs…"
          maxLength={200}
          required
        />
      </Field>
    </OverlapForm>
  );
}
/** The command palette opens the same hold review. */
export const BlockForm = HoldForm;

function DirectReservationForm() {
  const { data } = useWorkspace();
  const key = useRef(crypto.randomUUID());
  const [listingId, setListingId] = useState(data.listings[0]?.id || "");
  const listing = data.listings.find((l) => l.id === listingId);
  return (
    <OverlapForm
      path="bookings"
      label="Save reservation"
      build={(f) => ({
        listingId,
        from: f.get("from"),
        to: f.get("to"),
        guestName: f.get("guestName"),
        guestContact: f.get("guestContact") || "",
        price: f.get("price") === "" ? null : Number(f.get("price")),
        currency: listing?.currency || "USD",
        idempotencyKey: key.current,
      })}
    >
      <p className="form-intro">
        Record an agreed direct stay. It protects these nights in every export
        link and schedules turnover work. No payment is collected.
      </p>
      <PropertyDates
        initial={{}}
        listingId={listingId}
        onListing={setListingId}
        arrival="Check-in"
        departure="Checkout"
      />
      <Field label="Guest name">
        <input name="guestName" autoComplete="off" maxLength={200} required />
      </Field>
      <Field
        label="Guest email (optional)"
        hint="Encrypted at rest. Needed for email replies from the inbox."
      >
        <input
          name="guestContact"
          type="email"
          autoComplete="off"
          maxLength={320}
        />
      </Field>
      <Field
        label={`Reservation total (${listing?.currency || "USD"})`}
        hint="Leave empty when the total is not yet recorded."
      >
        <input name="price" type="number" step="0.01" min="0" />
      </Field>
    </OverlapForm>
  );
}
