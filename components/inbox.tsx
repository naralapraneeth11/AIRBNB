"use client";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Send,
  Info,
  Check,
  X,
  PenLine,
  MessageSquare,
  ShieldCheck,
} from "lucide-react";
import { useWorkspace } from "./workspace";
import { api, label, dateTime } from "@/lib/client";
import type { Thread, Conversation, Message } from "@/lib/types";
import { Head, Button, Badge, Empty, Toggle, ErrorBox, Field } from "./ui";
export function InboxView() {
  const { data, show, close, toast, explain, refresh } = useWorkspace(),
    params = useSearchParams();
  const [threads, setThreads] = useState<Thread[]>([]),
    [selected, setSelected] = useState(params.get("thread") || ""),
    [conversation, setConversation] = useState<Conversation | null>(null),
    [filters, setFilters] = useState({
      listing: "",
      platform: params.get("platform") || "",
      status: params.get("status") || "",
    }),
    [error, setError] = useState(""),
    [reply, setReply] = useState(""),
    [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  async function load() {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
    );
    const rows = await api<Thread[]>("threads?" + qs);
    setThreads(rows);
    const requested = params.get("booking");
    if (requested) {
      const t = rows.find((t) => t.bookingId === requested);
      if (t) setSelected(t.id);
    } else if (!selected && rows[0]) setSelected(rows[0].id);
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [filters]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    setConversation(null);
    setReply("");
    api<Conversation>("threads/" + selected)
      .then((c) => {
        if (active) {
          setConversation(c);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [selected]);
  async function updateConversation() {
    if (selected)
      setConversation(await api<Conversation>("threads/" + selected));
    await load();
  }
  useEffect(() => {
    const i = setInterval(() => {
      if (!document.hidden)
        updateConversation().catch((e) => setError(e.message));
    }, 2500);
    return () => clearInterval(i);
  }, [selected, filters]);
  async function send(body: string, draftId?: string) {
    setBusy(true);
    setError("");
    try {
      await api(`threads/${selected}/reply`, {
        method: "POST",
        data: { body, idempotencyKey: key.current, draftId },
      });
      key.current = crypto.randomUUID();
      setReply("");
      await updateConversation();
      toast("Reply queued. Delivery status appears in this conversation.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const c = conversation,
    l = data.listings.find((l) => l.id === c?.thread.listingId);
  return (
    <>
      <Head
        title="Every conversation, considered."
        description="A personal touch. Clear context. You’re always in control."
      />
      <div className="inbox-filters">
        <select
          aria-label="Filter inbox by property"
          value={filters.listing}
          onChange={(e) => setFilters({ ...filters, listing: e.target.value })}
        >
          <option value="">All properties</option>
          {data.listings.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter inbox by platform"
          value={filters.platform}
          onChange={(e) => setFilters({ ...filters, platform: e.target.value })}
        >
          <option value="">All platforms</option>
          {["AIRBNB", "EXPEDIA", "VRBO", "BOOKING", "DIRECT"].map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <select
          aria-label="Filter inbox by status"
          value={filters.status}
          onChange={(e) => setFilters({ ...filters, status: e.target.value })}
        >
          <option value="">All statuses</option>
          {["NEEDS_REPLY", "AI_DRAFTED", "AUTOMATED", "RESOLVED"].map((s) => (
            <option value={s} key={s}>
              {label(s)}
            </option>
          ))}
        </select>
        <Button
          onClick={() => updateConversation().catch((e) => setError(e.message))}
        >
          Refresh
        </Button>
      </div>
      {error && <ErrorBox message={error} />}
      <section className="panel inbox-layout">
        <aside className="thread-list" aria-label="Guest conversations">
          {threads.length ? (
            threads.map((t, i) => (
              <button
                key={t.id}
                className={"thread " + (selected === t.id ? "selected" : "")}
                onClick={() => setSelected(t.id)}
                onKeyDown={(e) => {
                  if (["ArrowDown", "ArrowUp"].includes(e.key)) {
                    e.preventDefault();
                    const n = Math.max(
                      0,
                      Math.min(
                        threads.length - 1,
                        i + (e.key === "ArrowDown" ? 1 : -1),
                      ),
                    );
                    setSelected(threads[n].id);
                    (
                      e.currentTarget.parentElement?.children[n] as HTMLElement
                    )?.focus();
                  }
                }}
                aria-current={selected === t.id ? "true" : undefined}
              >
                <span className="avatar">
                  {t.guestName.slice(0, 2).toUpperCase()}
                </span>
                <span>
                  <strong>{t.guestName}</strong>
                  <small>
                    {data.listings.find((l) => l.id === t.listingId)?.name}
                  </small>
                  <p>{t.preview}</p>
                  <Badge>{label(t.status)}</Badge>
                </span>
              </button>
            ))
          ) : (
            <Empty
              title="A little quiet."
              detail="Conversations arrive through your configured messaging integrations."
            />
          )}
        </aside>
        {c ? (
          <>
            <div className="conversation">
              <header className="conversation-heading">
                <div>
                  <h2>{c.booking.guestName}</h2>
                  <p>
                    {l?.name} · {label(c.thread.platform)}
                  </p>
                </div>
                <div className="actions">
                  <span className="manual-label">
                    {c.thread.manual
                      ? "You’re replying manually"
                      : "Automation available"}
                  </span>
                  <Toggle
                    checked={c.thread.manual}
                    label="Manual takeover for this conversation"
                    onChange={async (manual) => {
                      try {
                        await api(`threads/${selected}/toggle-manual`, {
                          method: "POST",
                          data: { manual },
                        });
                        await updateConversation();
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  />
                </div>
              </header>
              <div className="messages">
                {c.messages
                  .filter((m) => m.status !== "DISMISSED")
                  .map((m) => (
                    <div
                      key={m.id}
                      className={
                        "message " + (m.sender === "GUEST" ? "guest" : "host")
                      }
                    >
                      {m.status === "DRAFT" ? (
                        <Suggestion
                          message={m}
                          send={send}
                          busy={busy}
                          onDismiss={async () => {
                            await api(`messages/${m.id}/dismiss`, {
                              method: "POST",
                              data: {},
                            });
                            await updateConversation();
                          }}
                        />
                      ) : (
                        <>
                          <div className="bubble">{m.body}</div>
                          <small>
                            {m.sender === "GUEST"
                              ? "Guest"
                              : m.automated
                                ? "Automation"
                                : "Host"}{" "}
                            · {dateTime(m.createdAt)} · {label(m.status)}
                            {m.status !== "RECEIVED" && (
                              <button
                                aria-label="Explain this message"
                                onClick={() => explain(m.id)}
                              >
                                <Info size={13} />
                              </button>
                            )}
                          </small>
                        </>
                      )}
                    </div>
                  ))}
              </div>
              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  send(reply);
                }}
              >
                <label htmlFor="reply">Your reply</label>
                <textarea
                  id="reply"
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  required
                  maxLength={12000}
                  placeholder="A thoughtful reply, in your own words…"
                />
                <div>
                  <small>
                    Sending is irreversible once the provider accepts the
                    message.
                  </small>
                  <Button
                    primary
                    type="submit"
                    disabled={busy || !reply.trim()}
                  >
                    <Send size={15} />
                    {busy ? "Queuing…" : "Send reply"}
                  </Button>
                </div>
              </form>
            </div>
            <aside className="guest-context">
              <span className="eyebrow">THE STAY</span>
              <h3>{c.booking.guestName}</h3>
              <Badge>{label(c.thread.intent)}</Badge>
              <dl>
                <div>
                  <dt>Property</dt>
                  <dd>{l?.name}</dd>
                </div>
                <div>
                  <dt>Check-in</dt>
                  <dd>{c.booking.startDate}</dd>
                </div>
                <div>
                  <dt>Checkout</dt>
                  <dd>{c.booking.endDate}</dd>
                </div>
                <div>
                  <dt>Previous stays</dt>
                  <dd>{c.pastStays}</dd>
                </div>
                <div>
                  <dt>Booking status</dt>
                  <dd>{label(c.booking.status)}</dd>
                </div>
              </dl>
              <div className="context-manual">
                <span className="eyebrow">HOUSE KNOWLEDGE</span>
                <h3>Check-in instructions</h3>
                <p>{l?.houseManual.checkin || "No instructions saved yet."}</p>
              </div>
              <Button
                onClick={async () => {
                  try {
                    await api(`threads/${selected}/resolve`, {
                      method: "POST",
                      data: {},
                    });
                    await updateConversation();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                <Check size={15} />
                Mark resolved
              </Button>
            </aside>
          </>
        ) : (
          <div className="conversation-empty">
            <MessageSquare />
            <h2>A conversation starts with context.</h2>
            <p>Select a guest to see their stay and messages.</p>
          </div>
        )}
      </section>
    </>
  );
}
function Suggestion({
  message,
  send,
  onDismiss,
  busy,
}: {
  message: Message;
  send: (body: string, id: string) => void;
  onDismiss: () => Promise<void>;
  busy: boolean;
}) {
  const { explain } = useWorkspace();
  const [editing, setEditing] = useState(false),
    [body, setBody] = useState(message.body),
    [error, setError] = useState("");
  return (
    <div className="suggestion">
      <div>
        <Badge tone="accent">
          {message.aiConfidence === null
            ? "Rule suggestion"
            : `AI suggestion · ${Math.round(message.aiConfidence * 100)}%`}
        </Badge>
        <button
          className="icon-button"
          aria-label="Why this reply was suggested"
          onClick={() => explain(message.id)}
        >
          <Info size={16} />
        </button>
      </div>
      {editing ? (
        <textarea
          aria-label="Edit suggested reply"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      ) : (
        <p>{body}</p>
      )}
      <div className="suggestion-actions">
        <Button
          primary
          disabled={busy || !body.trim()}
          onClick={() => send(body, message.id)}
        >
          <Check size={14} />
          Approve & send
        </Button>
        <Button aria-label="Edit draft" onClick={() => setEditing(!editing)}>
          <PenLine size={14} />
        </Button>
        <Button
          aria-label="Dismiss draft"
          onClick={async () => {
            try {
              await onDismiss();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <X size={14} />
        </Button>
      </div>
      {error && <ErrorBox message={error} />}
    </div>
  );
}
