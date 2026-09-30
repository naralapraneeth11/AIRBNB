"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSearchParams } from "next/navigation";
import {
  Send,
  Info,
  Check,
  X,
  PenLine,
  MessageSquare,
  ChevronLeft,
} from "lucide-react";
import { useWorkspace } from "./workspace";
import { api, APIError, label, dateTime } from "@/lib/client";
import { SUPERSEDED, useLatestRequest, usePolling } from "@/lib/requests";
import { useMediaQuery } from "@/lib/use-media-query";
import type { Conversation, Message, MessagePage, Thread } from "@/lib/types";
import { Head, Button, Badge, Empty, Toggle, ErrorBox } from "./ui";

/** An open conversation refreshes often; the list of conversations less so. */
const CONVERSATION_REFRESH_MS = 5_000;
const LIST_REFRESH_MS = 20_000;
/** Phones show the list or one conversation, never both side by side. */
const ONE_PANE = "(max-width: 760px)";
const FILTERS = ["listing", "platform", "status"] as const;
type Filter = (typeof FILTERS)[number];
const PLATFORMS = ["AIRBNB", "EXPEDIA", "VRBO", "BOOKING", "DIRECT"];
const STATUSES = ["NEEDS_REPLY", "AI_DRAFTED", "AUTOMATED", "RESOLVED"];
const STATUS_TEXT: Record<string, string> = {
  RECEIVED: "Received",
  QUEUED: "Queued, not sent yet",
  SENT: "Sent",
  DELIVERY_UNCERTAIN: "Delivery uncertain",
};

type Open = Conversation & { threadId: string };
type Problem = { threadId: string; message: string };
/** A reply on its way, kept so that retrying the same words reuses its key. */
type Submission = { key: string; body: string };

const without = <T,>(record: Record<string, T>, key: string) => {
  const next = { ...record };
  delete next[key];
  return next;
};

/**
 * A conversation's newest page joined to the older pages already loaded for
 * it. When so much arrived that the two no longer overlap, the newest page
 * starts over on its own.
 */
function withNewest(prev: Open | null, threadId: string, next: Conversation) {
  const fresh: Open = { ...next, threadId };
  if (prev?.threadId !== threadId || !next.messages.length) return fresh;
  const overlap = prev.messages.findIndex((m) => m.id === next.messages[0].id);
  if (overlap === -1) return fresh;
  return {
    ...fresh,
    messages: [...prev.messages.slice(0, overlap), ...next.messages],
    hasOlder: prev.hasOlder,
  };
}

/**
 * Change the address without leaving the page. The URL holds the open
 * conversation and the filters, so a reload, a shared link and Back all
 * show the same thing. A replaced entry keeps its mark of having been
 * opened from the list unless told otherwise.
 */
function go(
  patch: Record<string, string | null>,
  how: "push" | "replace",
  state?: { inboxThread: boolean },
) {
  const next = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(patch))
    if (value) next.set(key, value);
    else next.delete(key);
  const search = next.toString();
  const url = window.location.pathname + (search ? "?" + search : "");
  const mark = state ?? {
    inboxThread:
      how === "replace" && window.history.state?.inboxThread === true,
  };
  if (how === "push") window.history.pushState(mark, "", url);
  else window.history.replaceState(mark, "", url);
}

export function InboxView() {
  const { data, toast, explain } = useWorkspace();
  const params = useSearchParams();
  const onePane = useMediaQuery(ONE_PANE);
  const selected = params.get("thread") || "";
  const filters = Object.fromEntries(
    FILTERS.map((key) => [key, params.get(key) || ""]),
  ) as Record<Filter, string>;
  const query = new URLSearchParams(
    Object.entries(filters).filter(([, value]) => value),
  ).toString();
  const reservation = params.get("reservation");

  // The list shown and the filters it was loaded for: while they differ,
  // new results are on their way and the old ones cannot be used.
  const [listed, setListed] = useState<{
      query: string;
      rows: Thread[];
    } | null>(null),
    [listError, setListError] = useState(""),
    [open, setOpen] = useState<Open | null>(null),
    [openError, setOpenError] = useState<Problem | null>(null),
    [problem, setProblem] = useState<Problem | null>(null),
    [stale, setStale] = useState({ list: false, conversation: false }),
    [refreshing, setRefreshing] = useState(false),
    [drafts, setDrafts] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState<Record<string, true>>({}),
    [loadingOlder, setLoadingOlder] = useState(false);

  const selectedRef = useRef(selected),
    onePaneRef = useRef(onePane),
    shownRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    selectedRef.current = selected;
    onePaneRef.current = onePane;
    shownRef.current = open?.threadId === selected ? selected : null;
  });
  const submissions = useRef(new Map<string, Submission>()),
    rowRefs = useRef(new Map<string, HTMLButtonElement>()),
    paneRef = useRef<HTMLElement>(null),
    messagesRef = useRef<HTMLDivElement>(null),
    listScroll = useRef<number | null>(null),
    previousSelection = useRef(selected);
  const { run: runList } = useLatestRequest(),
    { run: runConversation, cancel: cancelConversation } = useLatestRequest(),
    { run: runOlder, cancel: cancelOlder } = useLatestRequest();

  // A request that fails before anything is on screen shows why, whichever
  // request it was; once something is shown, a failure only marks it stale.
  const loadList = useCallback(async () => {
    let rows;
    try {
      rows = await runList((signal) =>
        api<Thread[]>("threads" + (query ? "?" + query : ""), { signal }),
      );
    } catch (e) {
      setListError((e as Error).message);
      throw e;
    }
    if (rows === SUPERSEDED) return;
    setListed({ query, rows });
    setListError("");
  }, [query, runList]);

  const loadConversation = useCallback(
    async (threadId: string) => {
      const first = shownRef.current !== threadId;
      if (first) setOpenError((e) => (e?.threadId === threadId ? null : e));
      let next;
      try {
        next = await runConversation((signal) =>
          api<Conversation>("threads/" + threadId, { signal }),
        );
      } catch (e) {
        if (first && threadId === selectedRef.current)
          setOpenError({ threadId, message: (e as Error).message });
        throw e;
      }
      // Only the conversation still chosen may land: an answer for one the
      // host has moved away from is never shown, so never replied to.
      if (next === SUPERSEDED || threadId !== selectedRef.current) return;
      setOpen((prev) => withNewest(prev, threadId, next));
      setOpenError((e) => (e?.threadId === threadId ? null : e));
    },
    [runConversation],
  );

  const refreshAll = useCallback(async () => {
    const threadId = selectedRef.current;
    const [list, conversation] = await Promise.allSettled([
      loadList(),
      threadId ? loadConversation(threadId) : Promise.resolve(),
    ]);
    setStale({
      list: list.status === "rejected",
      conversation: conversation.status === "rejected",
    });
  }, [loadList, loadConversation]);

  // The list, on arrival and whenever the filters change.
  useEffect(() => {
    loadList().catch(() => {});
  }, [loadList]);

  // Once results for new filters land, by whichever request: keep the
  // chosen conversation while it is among them, else choose the first (side
  // by side) or none (phones). A link straight to a conversation is kept
  // even when the list does not show it.
  const reconciled = useRef<string | null>(null);
  useEffect(() => {
    if (!listed || reconciled.current === listed.query) return;
    const first = reconciled.current === null;
    reconciled.current = listed.query;
    // A stay opened from the calendar is chosen once it is found.
    if (new URLSearchParams(window.location.search).has("reservation")) return;
    const chosen = selectedRef.current;
    if (chosen && (first || listed.rows.some((t) => t.id === chosen))) return;
    if (!onePaneRef.current && listed.rows[0])
      go({ thread: listed.rows[0].id }, "replace");
    else if (chosen) go({ thread: null }, "replace");
  }, [listed]);

  // The chosen conversation. Whatever was loading for the one before stops.
  useEffect(() => {
    cancelOlder();
    if (selected) loadConversation(selected).catch(() => {});
    else cancelConversation();
  }, [selected, loadConversation, cancelOlder, cancelConversation]);

  // Arriving on a phone straight in a conversation, as from a notification:
  // put the list beneath it, so Back returns to the list, not out of the app.
  useEffect(() => {
    if (
      !onePaneRef.current ||
      !selectedRef.current ||
      window.history.state?.inboxThread
    )
      return;
    const here = window.location.pathname + window.location.search;
    go({ thread: null }, "replace", { inboxThread: false });
    window.history.pushState({ inboxThread: true }, "", here);
  }, []);

  // Opening a stay's conversation from the calendar (?reservation=…).
  useEffect(() => {
    if (!reservation) return;
    let current = true;
    api<Thread[]>("threads?reservation=" + encodeURIComponent(reservation))
      .then((found) => {
        if (!current) return;
        go({ reservation: null, thread: found[0]?.id ?? null }, "replace");
        if (!found[0]) toast("There are no messages for that stay yet.");
      })
      .catch(() => {
        if (current) go({ reservation: null }, "replace");
      });
    return () => {
      current = false;
    };
  }, [reservation, toast]);

  // Background refreshes keep what is on screen; a failure only says the
  // view may be out of date. Each waits for the one before it.
  usePolling(async () => {
    try {
      await loadList();
      setStale((s) => (s.list ? { ...s, list: false } : s));
    } catch (e) {
      setStale((s) => ({ ...s, list: true }));
      throw e;
    }
  }, LIST_REFRESH_MS);
  usePolling(async () => {
    const threadId = selectedRef.current;
    if (!threadId) return;
    try {
      await loadConversation(threadId);
      setStale((s) => (s.conversation ? { ...s, conversation: false } : s));
    } catch (e) {
      setStale((s) => ({ ...s, conversation: true }));
      throw e;
    }
  }, CONVERSATION_REFRESH_MS);

  const shown = open?.threadId === selected ? open : null;
  const threads = listed?.rows ?? null;
  const updating = !!listed && listed.query !== query;

  // A conversation opens on its newest message and follows new ones while
  // the host is at the bottom; earlier messages load without moving what
  // the host is reading.
  const keepFromBottom = useRef<number | null>(null),
    atBottom = useRef(true),
    scrolledThread = useRef(""),
    firstSeen = useRef<string | undefined>(undefined);
  const shownThread = shown?.threadId,
    firstId = shown?.messages[0]?.id,
    lastId = shown?.messages.at(-1)?.id;
  useLayoutEffect(() => {
    const box = messagesRef.current;
    if (!box || !shownThread) return;
    if (scrolledThread.current !== shownThread) {
      scrolledThread.current = shownThread;
      keepFromBottom.current = null;
      atBottom.current = true;
    }
    if (keepFromBottom.current !== null && firstId !== firstSeen.current)
      box.scrollTop = box.scrollHeight - keepFromBottom.current;
    else if (atBottom.current) box.scrollTop = box.scrollHeight;
    keepFromBottom.current = null;
    firstSeen.current = firstId;
  }, [shownThread, firstId, lastId]);

  // Phones: a conversation starts at the top of the page, and returning to
  // the list puts it back where it was.
  useLayoutEffect(() => {
    if (!onePane) return;
    if (selected) window.scrollTo(0, 0);
    else if (listScroll.current !== null) {
      window.scrollTo(0, listScroll.current);
      listScroll.current = null;
    }
  }, [onePane, selected]);
  // Phones: focus follows the view, into the conversation on opening and
  // back to its row on returning. Nothing moves on arrival.
  useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = selected;
    if (!onePane || selected === previous) return;
    if (selected) paneRef.current?.focus({ preventScroll: true });
    else if (previous)
      rowRefs.current.get(previous)?.focus({ preventScroll: true });
  }, [onePane, selected]);

  function openThread(id: string, how: "push" | "replace") {
    if (id === selected) return;
    if (onePane) listScroll.current = window.scrollY;
    go({ thread: id }, how, how === "push" ? { inboxThread: true } : undefined);
  }
  function showList() {
    if (window.history.state?.inboxThread) window.history.back();
    else go({ thread: null }, "replace", { inboxThread: false });
  }
  const filter = (key: Filter, value: string) =>
    go({ [key]: value || null }, "replace");

  async function refreshNow() {
    setRefreshing(true);
    try {
      await refreshAll();
    } finally {
      setRefreshing(false);
    }
  }

  /**
   * One action on a conversation: its control is disabled while it runs,
   * success shows only once the server has confirmed it, and a conflict
   * reloads the conversation so the host acts on its latest state.
   */
  async function act<T>(
    key: string,
    threadId: string,
    work: () => Promise<T>,
    done?: (result: T) => void,
  ) {
    setBusy((b) => ({ ...b, [key]: true }));
    setProblem(null);
    try {
      const result = await work();
      done?.(result);
      void refreshAll();
    } catch (e) {
      const conflict = e instanceof APIError && e.status === 409;
      if (conflict) void refreshAll();
      setProblem({
        threadId,
        message:
          (e as Error).message +
          (conflict ? " The conversation now shows its latest state." : ""),
      });
    } finally {
      setBusy((b) => without(b, key));
    }
  }

  function send(threadId: string, body: string, draftId?: string) {
    const key = draftId ? "draft:" + draftId : "reply:" + threadId;
    // Retrying the same words reuses the request key, so a reply that went
    // through before its answer was lost is not sent a second time.
    const earlier = submissions.current.get(key);
    const submission =
      earlier?.body === body ? earlier : { key: crypto.randomUUID(), body };
    submissions.current.set(key, submission);
    return act(
      key,
      threadId,
      async () => {
        try {
          return await api(`threads/${threadId}/reply`, {
            method: "POST",
            data: { body, idempotencyKey: submission.key, draftId },
          });
        } catch (e) {
          // No answer, or one that could not be read: the reply may or may
          // not have been queued, and repeating it is safe.
          if (e instanceof APIError && e.code !== "UNREADABLE_RESPONSE")
            throw e;
          throw new Error(
            "The server did not confirm this reply, so it may or may not have been queued. Sending the same words again is safe: they will not be sent twice.",
          );
        }
      },
      () => {
        if (submissions.current.get(key) === submission)
          submissions.current.delete(key);
        // Clear the reply only if it is still exactly what was sent.
        setDrafts((d) =>
          draftId
            ? without(d, "suggestion:" + draftId)
            : d[threadId] === body
              ? without(d, threadId)
              : d,
        );
        toast(
          "Reply queued. It shows as sent once the messaging service accepts it.",
        );
      },
    );
  }

  const setManual = (threadId: string, manual: boolean) =>
    act(
      "manual:" + threadId,
      threadId,
      () =>
        api<{ manual: boolean }>(`threads/${threadId}/toggle-manual`, {
          method: "POST",
          data: { manual },
        }),
      (result) =>
        setOpen((prev) =>
          prev?.threadId === threadId
            ? { ...prev, thread: { ...prev.thread, manual: result.manual } }
            : prev,
        ),
    );

  const resolve = (threadId: string) =>
    act(
      "resolve:" + threadId,
      threadId,
      () => api(`threads/${threadId}/resolve`, { method: "POST", data: {} }),
      () =>
        setOpen((prev) =>
          prev?.threadId === threadId
            ? { ...prev, thread: { ...prev.thread, status: "RESOLVED" } }
            : prev,
        ),
    );

  const dismiss = (threadId: string, messageId: string) =>
    act(
      "draft:" + messageId,
      threadId,
      () => api(`messages/${messageId}/dismiss`, { method: "POST", data: {} }),
      () => {
        setOpen((prev) =>
          prev?.threadId === threadId
            ? {
                ...prev,
                messages: prev.messages.filter((m) => m.id !== messageId),
              }
            : prev,
        );
        setDrafts((d) => without(d, "suggestion:" + messageId));
      },
    );

  async function loadOlder(current: Open) {
    const threadId = current.threadId,
      before = current.messages[0]?.id;
    if (!before) return;
    setLoadingOlder(true);
    setProblem(null);
    try {
      const page = await runOlder((signal) =>
        api<MessagePage>(
          `threads/${threadId}/messages?before=${encodeURIComponent(before)}`,
          { signal },
        ),
      );
      if (page === SUPERSEDED) return;
      const box = messagesRef.current;
      if (box) keepFromBottom.current = box.scrollHeight - box.scrollTop;
      setOpen((prev) =>
        prev?.threadId === threadId && prev.messages[0]?.id === before
          ? {
              ...prev,
              messages: [...page.messages, ...prev.messages],
              hasOlder: page.hasOlder,
            }
          : prev,
      );
    } catch (e) {
      setProblem({ threadId, message: (e as Error).message });
    } finally {
      setLoadingOlder(false);
    }
  }

  const listing = data.listings.find((l) => l.id === shown?.thread.listingId);
  const draft = shown ? (drafts[shown.threadId] ?? "") : "";
  const shownProblem =
    shown && problem?.threadId === shown.threadId ? problem.message : "";

  return (
    <div className={"inbox" + (selected ? " has-selection" : "")}>
      <Head
        title="Every conversation, considered."
        description="A personal touch. Clear context. You’re always in control."
      />
      {!data.integrations.some((i) => i.enabled) && (
        <p className="callout shadow-banner" role="note">
          <Info size={16} aria-hidden="true" />
          <span>
            <strong>Guest messages need a messaging connection.</strong>{" "}
            Calendar links share dates only; they never carry guest
            conversations. Airbnb, Vrbo, Booking.com and Expedia messages arrive
            here only through an approved messaging service, set up in Settings
            → Native guest messaging. Direct-booking guests can be answered by
            email once email is configured.
          </span>
        </p>
      )}
      <div className="inbox-filters">
        <select
          aria-label="Filter inbox by property"
          value={filters.listing}
          onChange={(e) => filter("listing", e.target.value)}
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
          onChange={(e) => filter("platform", e.target.value)}
        >
          <option value="">All platforms</option>
          {PLATFORMS.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <select
          aria-label="Filter inbox by status"
          value={filters.status}
          onChange={(e) => filter("status", e.target.value)}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option value={s} key={s}>
              {label(s)}
            </option>
          ))}
        </select>
        <span className="inbox-status" role="status">
          {updating ? "Updating…" : refreshing ? "Refreshing…" : ""}
        </span>
        <Button onClick={refreshNow} disabled={refreshing}>
          Refresh
        </Button>
      </div>
      {((stale.list && threads) || (stale.conversation && shown)) && (
        <div className="stale-notice" role="status">
          <span>
            Couldn’t refresh just now, so some of what you see may be out of
            date. Nothing you sent was lost.
          </span>
          <Button onClick={refreshNow} disabled={refreshing}>
            Refresh
          </Button>
        </div>
      )}
      <section className="panel inbox-layout">
        <aside
          className={"thread-list" + (updating ? " updating" : "")}
          aria-label="Guest conversations"
          aria-busy={threads === null || updating}
        >
          {threads === null ? (
            listError ? (
              <ErrorBox
                message={listError}
                retry={() => {
                  setListError("");
                  loadList().catch(() => {});
                }}
              />
            ) : (
              <ThreadsLoading />
            )
          ) : threads.length ? (
            threads.map((t, i) => (
              <button
                key={t.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(t.id, el);
                  return () => {
                    rowRefs.current.delete(t.id);
                  };
                }}
                className={"thread " + (selected === t.id ? "selected" : "")}
                aria-current={selected === t.id ? "true" : undefined}
                onClick={() => {
                  if (!updating) openThread(t.id, "push");
                }}
                onKeyDown={(e) => {
                  if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
                  e.preventDefault();
                  const n = Math.max(
                    0,
                    Math.min(
                      threads.length - 1,
                      i + (e.key === "ArrowDown" ? 1 : -1),
                    ),
                  );
                  rowRefs.current.get(threads[n].id)?.focus();
                  if (!onePane && !updating)
                    openThread(threads[n].id, "replace");
                }}
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
          ) : query ? (
            <Empty
              title="Nothing matches these filters."
              detail="Try another property, platform or status."
              action={
                <Button
                  onClick={() =>
                    go(
                      { listing: null, platform: null, status: null },
                      "replace",
                    )
                  }
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <Empty
              title="A little quiet."
              detail="Conversations arrive through an approved messaging connection or direct-booking email. Calendar links never include messages."
            />
          )}
        </aside>
        {selected ? (
          <section
            ref={paneRef}
            className="conversation-pane"
            tabIndex={-1}
            aria-label={
              shown
                ? `Conversation with ${shown.reservation.guestName}`
                : "Conversation"
            }
            aria-busy={!shown}
          >
            <button
              type="button"
              className="conversation-back"
              onClick={showList}
            >
              <ChevronLeft size={17} aria-hidden="true" />
              All conversations
            </button>
            {shown ? (
              <>
                <div className="conversation">
                  <header className="conversation-heading">
                    <div>
                      <h2>{shown.reservation.guestName}</h2>
                      <p>
                        {listing?.name} · {label(shown.thread.platform)}
                      </p>
                    </div>
                    <div className="actions">
                      <span className="manual-label">
                        {shown.thread.manual
                          ? "You’re replying manually"
                          : "Automation available"}
                      </span>
                      <Toggle
                        checked={shown.thread.manual}
                        disabled={!!busy["manual:" + shown.threadId]}
                        label="Manual takeover for this conversation"
                        onChange={(manual) => setManual(shown.threadId, manual)}
                      />
                    </div>
                  </header>
                  <div
                    className="messages"
                    ref={messagesRef}
                    onScroll={(e) => {
                      const box = e.currentTarget;
                      atBottom.current =
                        box.scrollHeight - box.scrollTop - box.clientHeight <
                        48;
                    }}
                  >
                    {shown.hasOlder && (
                      <div className="older-messages">
                        <Button
                          onClick={() => loadOlder(shown)}
                          disabled={loadingOlder}
                        >
                          {loadingOlder
                            ? "Loading earlier messages…"
                            : "Show earlier messages"}
                        </Button>
                      </div>
                    )}
                    {shown.messages.length ? (
                      shown.messages.map((m) => (
                        <MessageItem key={m.id} message={m} explain={explain}>
                          {m.status === "DRAFT" && (
                            <Suggestion
                              message={m}
                              value={drafts["suggestion:" + m.id] ?? m.body}
                              onChange={(value) =>
                                setDrafts((d) => ({
                                  ...d,
                                  ["suggestion:" + m.id]: value,
                                }))
                              }
                              busy={!!busy["draft:" + m.id]}
                              onSend={(body) =>
                                send(shown.threadId, body, m.id)
                              }
                              onDismiss={() => dismiss(shown.threadId, m.id)}
                            />
                          )}
                        </MessageItem>
                      ))
                    ) : (
                      <p className="messages-empty">
                        No messages in this conversation yet.
                      </p>
                    )}
                  </div>
                  {shownProblem && <ErrorBox message={shownProblem} />}
                  <form
                    className="composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      send(shown.threadId, draft);
                    }}
                  >
                    <label htmlFor="reply">Your reply</label>
                    <textarea
                      id="reply"
                      value={draft}
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [shown.threadId]: e.target.value,
                        }))
                      }
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
                        disabled={
                          !!busy["reply:" + shown.threadId] || !draft.trim()
                        }
                      >
                        <Send size={15} />
                        {busy["reply:" + shown.threadId]
                          ? "Queuing…"
                          : "Send reply"}
                      </Button>
                    </div>
                  </form>
                </div>
                <aside className="guest-context">
                  <span className="eyebrow">THE STAY</span>
                  <h3>{shown.reservation.guestName}</h3>
                  <Badge>{label(shown.thread.intent)}</Badge>
                  <dl>
                    <div>
                      <dt>Property</dt>
                      <dd>{listing?.name}</dd>
                    </div>
                    <div>
                      <dt>Check-in</dt>
                      <dd>{shown.reservation.startDate}</dd>
                    </div>
                    <div>
                      <dt>Checkout</dt>
                      <dd>{shown.reservation.endDate}</dd>
                    </div>
                    <div>
                      <dt>Previous stays</dt>
                      <dd>{shown.pastStays}</dd>
                    </div>
                    <div>
                      <dt>Reservation status</dt>
                      <dd>{label(shown.reservation.status)}</dd>
                    </div>
                  </dl>
                  <div className="context-manual">
                    <span className="eyebrow">HOUSE KNOWLEDGE</span>
                    <h3>Check-in instructions</h3>
                    <p>
                      {listing?.houseManual.checkin ||
                        "No instructions saved yet."}
                    </p>
                  </div>
                  <Button
                    onClick={() => resolve(shown.threadId)}
                    disabled={
                      !!busy["resolve:" + shown.threadId] ||
                      shown.thread.status === "RESOLVED"
                    }
                  >
                    <Check size={15} />
                    {busy["resolve:" + shown.threadId]
                      ? "Marking resolved…"
                      : shown.thread.status === "RESOLVED"
                        ? "Resolved"
                        : "Mark resolved"}
                  </Button>
                </aside>
              </>
            ) : openError?.threadId === selected ? (
              <div className="conversation-status">
                <ErrorBox
                  message={openError.message}
                  retry={() => {
                    setOpenError(null);
                    loadConversation(selected).catch(() => {});
                  }}
                />
              </div>
            ) : (
              <ConversationLoading />
            )}
          </section>
        ) : threads === null && !listError ? (
          // Side by side, the first conversation opens once the list lands.
          <div className="conversation-placeholder">
            <ConversationLoading />
          </div>
        ) : (
          <div className="conversation-empty">
            <MessageSquare />
            <h2>A conversation starts with context.</h2>
            <p>
              {threads?.length
                ? "Select a guest to see their stay and messages."
                : "Conversations appear here as guests write to you."}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function ThreadsLoading() {
  return (
    <div
      className="threads-loading"
      role="status"
      aria-label="Loading conversations"
    >
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="skeleton thread-skeleton" />
      ))}
    </div>
  );
}

function ConversationLoading() {
  return (
    <div
      className="conversation-loading"
      role="status"
      aria-label="Loading conversation"
    >
      <div className="skeleton heading-skeleton" />
      <div className="skeleton bubble-skeleton" />
      <div className="skeleton bubble-skeleton host" />
      <div className="skeleton bubble-skeleton" />
    </div>
  );
}

/** A message; a suggestion awaiting approval renders as its children. */
function MessageItem({
  message: m,
  explain,
  children,
}: {
  message: Message;
  explain: (id: string) => void;
  children?: ReactNode;
}) {
  return (
    <div
      className={
        "message " +
        (m.sender === "GUEST" ? "guest" : "host") +
        (m.status === "QUEUED"
          ? " queued"
          : m.status === "DELIVERY_UNCERTAIN"
            ? " uncertain"
            : "")
      }
    >
      {children || (
        <>
          <div className="bubble">{m.body}</div>
          <small>
            {m.sender === "GUEST"
              ? "Guest"
              : m.automated
                ? "Automation"
                : "Host"}{" "}
            · {dateTime(m.createdAt)} ·{" "}
            {STATUS_TEXT[m.status] ?? label(m.status)}
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
  );
}

function Suggestion({
  message,
  value,
  onChange,
  onSend,
  onDismiss,
  busy,
}: {
  message: Message;
  value: string;
  onChange: (value: string) => void;
  onSend: (body: string) => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  const { explain } = useWorkspace();
  const [editing, setEditing] = useState(false);
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
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <p>{value}</p>
      )}
      <div className="suggestion-actions">
        <Button
          primary
          disabled={busy || !value.trim()}
          onClick={() => onSend(value)}
        >
          <Check size={14} />
          {busy ? "Working…" : "Approve & send"}
        </Button>
        <Button
          aria-label="Edit draft"
          aria-pressed={editing}
          onClick={() => setEditing(!editing)}
        >
          <PenLine size={14} />
        </Button>
        <Button aria-label="Dismiss draft" disabled={busy} onClick={onDismiss}>
          <X size={14} />
        </Button>
      </div>
    </div>
  );
}
