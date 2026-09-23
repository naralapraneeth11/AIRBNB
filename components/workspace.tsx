"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  Inbox,
  House,
  SlidersHorizontal,
  ChartNoAxesCombined,
  ClipboardCheck,
  Activity,
  Settings,
  Search,
  Bell,
  Menu,
  ArrowRight,
  Command,
  ShieldCheck,
  ChevronsLeft,
  Plus,
  Power,
  Check,
  X,
  LayoutDashboard,
} from "lucide-react";
import { api, label, dateTime } from "@/lib/client";
import type { WorkspaceData, AuditEntry } from "@/lib/types";
import type { Command as Intent } from "@/lib/domain";
import { Modal, Button, Head, Badge, ErrorBox, Skeleton, Empty } from "./ui";
import { CalendarView, BlockForm } from "./calendar";
import { InboxView } from "./inbox";
import { CleaningView } from "./cleaning";
import {
  PropertiesView,
  AutomationView,
  InsightsView,
  SettingsView,
  ActivityView,
} from "./management";
type WorkspaceContext = {
  data: WorkspaceData;
  refresh: () => Promise<void>;
  show: (title: string, content: ReactNode, sheet?: boolean) => void;
  close: () => void;
  toast: (message: string) => void;
  mutate: <T = unknown>(
    path: string,
    data: unknown,
    method?: string,
  ) => Promise<T>;
  explain: (id: string) => void;
};
const Context = createContext<WorkspaceContext | null>(null);
export function useWorkspace() {
  const ctx = useContext(Context);
  if (!ctx) throw new Error("Workspace context missing");
  return ctx;
}
const navigation = [
  ["calendar", "Calendar", CalendarDays],
  ["inbox", "Inbox", Inbox],
  ["cleaning", "Cleaning", ClipboardCheck],
  ["properties", "Properties", House],
  ["automation", "Automation", SlidersHorizontal],
  ["insights", "Insights", ChartNoAxesCombined],
] as const;
export function Workspace({ section }: { section: string }) {
  const router = useRouter();
  const [data, setData] = useState<WorkspaceData | null>(null),
    [error, setError] = useState(""),
    [dialog, setDialog] = useState<{
      title: string;
      content: ReactNode;
      sheet?: boolean;
    } | null>(null),
    [notice, setNotice] = useState(""),
    [mobile, setMobile] = useState(false),
    [collapsed, setCollapsed] = useState(false);
  const refresh = useCallback(async () => {
    const next = await api<WorkspaceData>("workspace");
    setData(next);
    setError("");
  }, []);
  useEffect(() => {
    let active = true;
    refresh().catch((e) => {
      if (active) setError(e.message);
    });
    const interval = setInterval(() => {
      if (!document.hidden) refresh().catch((e) => setError(e.message));
    }, 60000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [refresh]);
  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(""), 4500);
      return () => clearTimeout(t);
    }
  }, [notice]);
  const show = useCallback(
    (title: string, content: ReactNode, sheet = false) =>
      setDialog({ title, content, sheet }),
    [],
  );
  const close = () => setDialog(null);
  const mutate = async <T,>(
    path: string,
    payload: unknown,
    method = "POST",
  ) => {
    const result = await api<T>(path, { method, data: payload });
    await refresh();
    return result;
  };
  const explain = async (id: string) => {
    try {
      const rows = await api<AuditEntry[]>("explain/" + id);
      show(
        "Why this happened",
        <div className="explain-list">
          {rows.length ? (
            rows.map((r) => (
              <article key={r.id}>
                <Badge>{label(r.action)}</Badge>
                <h3>{r.reason}</h3>
                <small>
                  {dateTime(r.createdAt)} ·{" "}
                  {r.actorId === "worker"
                    ? "Automation"
                    : r.actorId === data?.user.name
                      ? "You"
                      : r.actorId}
                </small>
              </article>
            ))
          ) : (
            <p>No action history has been recorded for this item yet.</p>
          )}
        </div>,
        true,
      );
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  const palette = useCallback(
    () => show("Where would you like to go?", <Palette />),
    [show],
  );
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        palette();
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [palette]);
  const context = data
    ? { data, refresh, show, close, toast: setNotice, mutate, explain }
    : null;
  return (
    <div
      className={
        "workspace " +
        (collapsed ? "collapsed " : "") +
        (mobile ? "mobile-open" : "")
      }
    >
      <aside className="sidebar">
        <Link
          href="/calendar"
          className="brand"
          aria-label="Airbnb Automation home"
        >
          <span className="brand-mark">a</span>
          <span className="brand-label">
            airbnb<small>AUTOMATION</small>
          </span>
        </Link>
        <div className="workspace-name">
          <span className="workspace-symbol">
            <House size={17} />
          </span>
          <div>
            <strong>{data?.workspace.name || "Your workspace"}</strong>
            <small>
              {data
                ? `${data.listings.length} properties`
                : "Private operations"}
            </small>
          </div>
        </div>
        <p className="nav-caption">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {navigation.map(([id, name, Icon]) => (
            <Link
              onClick={() => setMobile(false)}
              key={id}
              href={"/" + id}
              className={section === id ? "active" : ""}
              aria-current={section === id ? "page" : undefined}
              aria-label={name}
            >
              <Icon />
              <span>{name}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-lower">
          <Link
            href="/activity"
            className={section === "activity" ? "active" : ""}
            aria-label="Activity"
          >
            <Activity />
            <span>Activity & audit</span>
          </Link>
          <Link
            href="/settings"
            className={section === "settings" ? "active" : ""}
            aria-label="Settings"
          >
            <Settings />
            <span>Settings</span>
          </Link>
          <button
            className="collapse-button"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          >
            <ChevronsLeft />
            <span>Collapse navigation</span>
          </button>
          <div className="automation-state">
            <span
              className={
                "status-dot " + (data?.settings.paused ? "paused" : "fresh")
              }
            />
            <div>
              <strong>
                {data?.settings.paused
                  ? "Automation paused"
                  : "Automation enabled"}
              </strong>
              <small>Always under your control.</small>
            </div>
          </div>
          <div className="profile">
            <span className="avatar">
              {data?.user.name
                .split(" ")
                .map((x) => x[0])
                .slice(0, 2)
                .join("") || "—"}
            </span>
            <div>
              <strong>{data?.user.name || "Your account"}</strong>
              <small>{data ? label(data.user.role) : "Secure workspace"}</small>
            </div>
          </div>
        </div>
      </aside>
      <button
        className="scrim"
        aria-label="Close navigation"
        onClick={() => setMobile(false)}
      />
      <main id="main" className="main">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="Open navigation"
            onClick={() => setMobile(true)}
          >
            <Menu />
          </button>
          <div className="breadcrumb">
            Workspace <span>/</span>
            <strong>{label(section)}</strong>
          </div>
          <button className="search-button" onClick={palette}>
            <Search size={17} />
            <span>Find something or take action</span>
            <kbd>⌘ K</kbd>
          </button>
          <button
            className="icon-button"
            aria-label="Open notifications"
            onClick={() =>
              show(
                "Notifications",
                <div className="notifications">
                  {data?.notifications.length ? (
                    data.notifications.map((n) => (
                      <Link key={n.id} href={n.href} onClick={close}>
                        <strong>{n.title}</strong>
                        <p>{n.body}</p>
                        <small>{dateTime(n.createdAt)}</small>
                      </Link>
                    ))
                  ) : (
                    <Empty
                      title="A quieter inbox."
                      detail="Alerts appear here when something needs your attention."
                    />
                  )}
                  <Button
                    onClick={async () => {
                      await mutate("notifications", {});
                      close();
                    }}
                  >
                    Mark all read
                  </Button>
                </div>,
                true,
              )
            }
          >
            <Bell />
            {data?.notifications.some((n) => !n.readAt) && (
              <span className="notification-dot" />
            )}
          </button>
        </header>
        <div className="page-content">
          {error ? (
            <ErrorBox
              message={error}
              retry={() => refresh().catch((e) => setError(e.message))}
            />
          ) : !data ? (
            <Skeleton />
          ) : (
            context && (
              <Context.Provider value={context}>
                {section === "calendar" || section === "overview" ? (
                  <CalendarView />
                ) : section === "inbox" ? (
                  <InboxView />
                ) : section === "cleaning" ? (
                  <CleaningView />
                ) : section === "properties" ? (
                  <PropertiesView />
                ) : section === "automation" ? (
                  <AutomationView />
                ) : section === "insights" ? (
                  <InsightsView />
                ) : section === "settings" ? (
                  <SettingsView />
                ) : (
                  <ActivityView />
                )}
                <footer className="workspace-footer">
                  <span>
                    <ShieldCheck size={14} />
                    Private. Accountable. Yours.
                  </span>
                  <span>
                    Calendar polls every 60–120 seconds · Platform refresh times
                    vary.
                  </span>
                </footer>
              </Context.Provider>
            )
          )}
        </div>
      </main>
      {dialog &&
        (context ? (
          <Context.Provider value={context}>
            <Modal title={dialog.title} onClose={close} sheet={dialog.sheet}>
              {dialog.content}
            </Modal>
          </Context.Provider>
        ) : (
          <Modal title={dialog.title} onClose={close}>
            <p>Your workspace is still loading. Try again in a moment.</p>
          </Modal>
        ))}
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
        </div>
      )}
    </div>
  );
}
function Palette() {
  const { data, show, close } = useWorkspace(),
    router = useRouter();
  const [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const matches = navigation.filter(([, name]) =>
    name.toLowerCase().includes(query.toLowerCase()),
  );
  async function execute() {
    setBusy(true);
    setError("");
    try {
      const result = await api<Intent>("command", {
        method: "POST",
        data: { text: query },
      });
      if (result.intent === "BLOCK")
        show(
          "Review calendar block",
          <BlockForm
            initial={{
              listingId: result.listingId,
              from: result.from,
              to: result.to,
            }}
          />,
        );
      else if (result.intent === "INBOX") {
        router.push(
          "/inbox?" +
            new URLSearchParams({
              ...(result.platform ? { platform: result.platform } : {}),
              ...(result.status ? { status: result.status } : {}),
            }),
        );
        close();
      } else if (result.intent === "NAVIGATE") {
        router.push("/" + result.page);
        close();
      } else
        setError(
          "Try “block March 5–10 on [property]” or “show unread messages from Expedia”.",
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="palette">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          execute();
        }}
      >
        <input
          aria-label="Command"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search pages, or tell us what you need…"
        />
        <Button primary disabled={busy || !query}>
          {busy ? "Understanding…" : "Continue"}
          <ArrowRight size={16} />
        </Button>
      </form>
      {error && <ErrorBox message={error} />}
      <div className="palette-results">
        {matches.map(([id, name, Icon]) => (
          <button
            key={id}
            onClick={() => {
              router.push("/" + id);
              close();
            }}
          >
            <Icon size={18} />
            <span>{name}</span>
            <ArrowRight size={15} />
          </button>
        ))}
      </div>
      <p className="microcopy">
        Calendar changes always open a review step before anything is saved.
      </p>
    </div>
  );
}
export function MutationForm({
  children,
  path,
  method = "POST",
  build,
  onSaved,
  label: buttonLabel = "Save changes",
}: {
  children: ReactNode;
  path: string;
  method?: string;
  build: (data: FormData) => unknown;
  onSaved?: (result: any) => void;
  label?: string;
}) {
  const { mutate, close, toast } = useWorkspace();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        setBusy(true);
        setError("");
        try {
          const result = await mutate(path, build(new FormData(form)), method);
          toast("Changes saved.");
          if (onSaved) onSaved(result);
          else close();
        } catch (e) {
          setError((e as Error).message);
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
