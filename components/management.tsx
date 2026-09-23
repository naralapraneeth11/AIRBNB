"use client";
import { useState, useEffect, useRef } from "react";
import { useWorkspace, MutationForm } from "./workspace";
import { Head, Button, Badge, Empty, Field, Toggle, ErrorBox } from "./ui";
import { api, label, money, dateTime, localDate } from "@/lib/client";
import { dayAdd, manualFields } from "@/lib/domain";
import type {
  Listing,
  Rule,
  Settings,
  Insights,
  AuditEntry,
  Job,
} from "@/lib/types";
import {
  Plus,
  Link as LinkIcon,
  Info,
  ArrowUpRight,
  ShieldCheck,
  Camera,
  KeyRound,
  Copy,
  Power,
  MessageSquare,
  ClipboardCheck,
  SlidersHorizontal,
  Sparkles,
  Check,
  Download,
  Users,
  Bell,
  Sun,
  Moon,
  ChevronRight,
  PenLine,
  RefreshCw,
  LockKeyhole,
} from "lucide-react";
import { SyncDot } from "./calendar";
import { CleanerForm } from "./cleaning";
export function PropertiesView() {
  const { data, show } = useWorkspace();
  return (
    <>
      <Head
        title="Distinct places. One clear view."
        description="The details that make each property feel like home."
      >
        <Button primary onClick={() => show("Add a property", <ListingForm />)}>
          <Plus size={16} />
          Add property
        </Button>
      </Head>
      {data.listings.length ? (
        <div className="property-grid">
          {data.listings.map((l) => (
            <button
              className="property-card"
              key={l.id}
              onClick={() => show(l.name, <ListingDetail listing={l} />, true)}
            >
              <div className="property-image">
                {l.photoIds[0] ? (
                  <img src={"/api/assets/" + l.photoIds[0]} alt={l.name} />
                ) : (
                  <div className="property-image-empty">
                    <span style={{ borderColor: l.color }} />
                    <small>Your property, your perspective.</small>
                  </div>
                )}
                <Badge>
                  {l.ready ? "Verified & ready" : "Readiness not verified"}
                </Badge>
              </div>
              <div className="property-summary">
                <div>
                  <h2>{l.name}</h2>
                  <ArrowUpRight size={18} />
                </div>
                <p>{l.address}</p>
                <footer>
                  <span>{l.bufferDays} buffer day(s)</span>
                  <span>
                    {data.sources
                      .filter((s) => s.listingId === l.id)
                      .map((s) => (
                        <SyncDot key={s.id} source={s} />
                      ))}
                  </span>
                </footer>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <section className="panel">
          <Empty
            title="Every great stay starts with a place."
            detail="Add the address, structured house manual, calendar connections, and a buffer between stays. Your first property is a few details away."
            action={
              <Button
                primary
                onClick={() => show("Your first property", <ListingForm />)}
              >
                Add a property
                <Plus size={16} />
              </Button>
            }
          />
        </section>
      )}
      <section className="panel property-principles">
        <div>
          <ShieldCheck />
          <h3>Protected details</h3>
          <p>
            Door codes and house manuals are encrypted. Every reveal is
            recorded.
          </p>
        </div>
        <div>
          <LinkIcon />
          <h3>Honest connections</h3>
          <p>
            Know when each feed last polled, and where your attention is needed.
          </p>
        </div>
        <div>
          <MessageSquare />
          <h3>Better answers</h3>
          <p>
            Structured property knowledge gives response rules a dependable
            source.
          </p>
        </div>
      </section>
    </>
  );
}
function ListingForm({ listing: l }: { listing?: Listing }) {
  const { show } = useWorkspace();
  const empty = { wifi: "", checkin: "", parking: "", washroom: "", rules: "" };
  return (
    <MutationForm
      path={l ? "listings/" + l.id : "listings"}
      method={l ? "PATCH" : "POST"}
      label={l ? "Save property" : "Create property"}
      onSaved={(r) =>
        show(
          l ? "Property saved" : "Connect your master calendar",
          <div>
            <p>
              {l
                ? "Your settings have been saved."
                : "Copy this private availability feed to a platform’s Import Calendar setting. For loop prevention, prefer the channel-specific export produced when connecting a source."}
            </p>
            {r.exportUrl && <CopyValue value={r.exportUrl} />}
            <Button
              onClick={() => show(r.name, <ListingDetail listing={r} />, true)}
            >
              Open property
              <ArrowUpRight size={15} />
            </Button>
          </div>,
        )
      }
      build={(f) => ({
        name: f.get("name"),
        address: f.get("address"),
        timezone: f.get("timezone"),
        currency: f.get("currency"),
        color: f.get("color"),
        bufferDays: Number(f.get("bufferDays")),
        checkoutHour: Number(f.get("checkoutHour")),
        cleaningBufferHours: Number(f.get("cleaningBufferHours")),
        houseManual: Object.fromEntries(manualFields.map((k) => [k, f.get(k)])),
        ...(f.get("doorCode") ? { doorCode: f.get("doorCode") } : {}),
        ...(l ? { version: l.version } : {}),
      })}
    >
      <Field label="Property name">
        <input name="name" required maxLength={100} defaultValue={l?.name} />
      </Field>
      <Field label="Address">
        <input
          name="address"
          required
          maxLength={500}
          defaultValue={l?.address}
        />
      </Field>
      <div className="form-grid">
        <Field label="Time zone">
          <select
            name="timezone"
            defaultValue={
              l?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
            }
          >
            {[
              ...new Set([
                Intl.DateTimeFormat().resolvedOptions().timeZone,
                l?.timezone || "America/Los_Angeles",
                "America/Chicago",
                "America/New_York",
                "Europe/London",
                "Europe/Paris",
                "Asia/Kolkata",
                "Asia/Dubai",
                "Australia/Sydney",
                "Pacific/Auckland",
              ]),
            ].map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </Field>
        <Field label="Currency">
          <select name="currency" defaultValue={l?.currency || "USD"}>
            {["USD", "EUR", "GBP", "CAD", "AUD", "INR", "AED"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Calendar color">
          <input
            name="color"
            type="color"
            defaultValue={l?.color || "#a8c9b8"}
          />
        </Field>
        <Field
          label="Buffer days"
          hint="Protect nights before and after each reservation."
        >
          <input
            name="bufferDays"
            type="number"
            min="0"
            max="14"
            defaultValue={l?.bufferDays ?? 1}
            required
          />
        </Field>
        <Field label="Checkout hour (local time)">
          <input
            name="checkoutHour"
            type="number"
            min="0"
            max="23"
            defaultValue={l?.checkoutHour ?? 11}
            required
          />
        </Field>
        <Field label="Hours to verify cleaning">
          <input
            name="cleaningBufferHours"
            type="number"
            min="1"
            max="48"
            defaultValue={l?.cleaningBufferHours ?? 4}
            required
          />
        </Field>
      </div>
      <Field
        label={
          l ? "Replace door code (leave empty to keep current)" : "Door code"
        }
        hint="Encrypted at rest. Cleaners receive access only after acceptance."
      >
        <input
          name="doorCode"
          type="password"
          autoComplete="new-password"
          maxLength={100}
        />
      </Field>
      <h3 className="form-section-title">House manual</h3>
      <p className="microcopy">
        The FAQ rules read these exact fields. Add precise, guest-ready
        information.
      </p>
      {manualFields.map((k) => (
        <Field
          key={k}
          label={
            k === "wifi"
              ? "Wi-Fi network & password"
              : k === "checkin"
                ? "Check-in instructions"
                : k === "washroom"
                  ? "Washroom location"
                  : label(k)
          }
        >
          <textarea
            name={k}
            defaultValue={(l?.houseManual || empty)[k]}
            maxLength={k === "rules" ? 8000 : 4000}
            rows={3}
          />
        </Field>
      ))}
    </MutationForm>
  );
}
function ListingDetail({ listing: initial }: { listing: Listing }) {
  const { data, show, toast, mutate, explain } = useWorkspace();
  const l = data.listings.find((l) => l.id === initial.id) || initial;
  const [tab, setTab] = useState("Overview"),
    [code, setCode] = useState<string | null>(null),
    [error, setError] = useState("");
  const photo = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (code) {
      const timer = setTimeout(() => setCode(null), 30000);
      return () => clearTimeout(timer);
    }
  }, [code]);
  return (
    <div className="listing-detail">
      <div className="tabs">
        {["Overview", "Channels", "House manual", "Access"].map((t) => (
          <button
            key={t}
            className={tab === t ? "selected" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {error && <ErrorBox message={error} />}
      <div className="detail-title">
        <h2>{l.name}</h2>
        <p>{l.address}</p>
      </div>
      {tab === "Overview" ? (
        <>
          {l.photoIds[0] && (
            <img
              className="detail-photo"
              src={"/api/assets/" + l.photoIds[0]}
              alt={l.name}
            />
          )}
          <dl>
            <div>
              <dt>Time zone</dt>
              <dd>{l.timezone}</dd>
            </div>
            <div>
              <dt>Buffer</dt>
              <dd>{l.bufferDays} day(s)</dd>
            </div>
            <div>
              <dt>Checkout</dt>
              <dd>{String(l.checkoutHour).padStart(2, "0")}:00 local</dd>
            </div>
            <div>
              <dt>Cleaning verification</dt>
              <dd>Within {l.cleaningBufferHours} hours</dd>
            </div>
            <div>
              <dt>Ready for guests</dt>
              <dd>{l.ready ? "Photo verified" : "Not yet verified"}</dd>
            </div>
          </dl>
          <div className="stack-actions">
            <Button
              onClick={() => show("Edit property", <ListingForm listing={l} />)}
            >
              <PenLine size={15} />
              Edit property
            </Button>
            <Button onClick={() => photo.current?.click()}>
              <Camera size={15} />
              Upload a property photo
            </Button>
            <Button onClick={() => explain(l.id)}>
              <Info size={15} />
              History & explanation
            </Button>
          </div>
          <input
            ref={photo}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const form = new FormData();
              form.set("file", file);
              try {
                await mutate("listings/" + l.id + "/photo", form);
                toast("Property photo saved.");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          />
        </>
      ) : tab === "Channels" ? (
        <>
          <p className="callout">
            Imports poll every 60–120 seconds. Each platform decides when to
            refresh your export, often hours later. No real-time two-way update
            is implied.
          </p>
          {data.sources
            .filter((s) => s.listingId === l.id)
            .map((s) => (
              <div className="list-row" key={s.id}>
                <SyncDot source={s} />
                <div className="grow">
                  <strong>{label(s.platform)}</strong>
                  <small>
                    {s.lastSyncedAt ? dateTime(s.lastSyncedAt) : "Never synced"}
                  </small>
                </div>
                <Badge>{label(s.status)}</Badge>
              </div>
            ))}
          <Button
            primary
            onClick={() =>
              show("Connect a calendar", <SourceForm listing={l} />)
            }
          >
            <Plus size={15} />
            Add / replace channel
          </Button>
          <Button
            onClick={() =>
              show(
                "Rotate the master feed URL",
                <MutationForm
                  path={"listings/" + l.id + "/export-token"}
                  build={() => ({})}
                  label="Rotate feed URL"
                  onSaved={(r) =>
                    show("New master feed URL", <CopyValue value={r.url} />)
                  }
                >
                  <p>
                    Any platform using the old master URL will stop receiving
                    updates until you replace it. Channel-specific export URLs
                    are unaffected.
                  </p>
                  <label className="checkbox">
                    <input type="checkbox" required />
                    I’m ready to update the platforms using this feed.
                  </label>
                </MutationForm>,
              )
            }
          >
            Rotate master export link
          </Button>
        </>
      ) : tab === "House manual" ? (
        <>
          <p className="microcopy">
            These structured fields are the source of deterministic FAQ replies.
          </p>
          {manualFields.map((k) => (
            <section key={k} className="manual-section">
              <h3>{label(k)}</h3>
              <p>{l.houseManual[k] || "No information saved yet."}</p>
            </section>
          ))}
          <Button
            onClick={() =>
              show("Edit house manual", <ListingForm listing={l} />)
            }
          >
            Edit manual
            <PenLine size={15} />
          </Button>
        </>
      ) : (
        <>
          <div className="code-panel">
            <KeyRound />
            <h3>Door access</h3>
            <p>
              {l.hasDoorCode
                ? "A code is securely stored. Reveal it only when you need it."
                : "Add a door code in the property editor."}
            </p>
            {code ? (
              <span className="code">{code}</span>
            ) : (
              <Button
                disabled={!l.hasDoorCode}
                onClick={async () => {
                  try {
                    const result = await api<{ code: string | null }>(
                      "listings/" + l.id + "/door-code",
                      { method: "POST", data: {} },
                    );
                    setCode(result.code);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Reveal for 30 seconds
              </Button>
            )}
          </div>
          <p className="microcopy">
            Every code reveal is audited. This app manages authorized code
            disclosure; device-level code programming requires a future
            smart-lock integration.
          </p>
        </>
      )}
    </div>
  );
}
function SourceForm({ listing }: { listing: Listing }) {
  const { show } = useWorkspace();
  return (
    <MutationForm
      path="sources"
      label="Connect calendar"
      onSaved={(r) =>
        show(
          "Complete the connection",
          <>
            <p>
              Paste this channel-specific availability feed into the same
              platform’s Import Calendar settings. It excludes reservations that
              originated from that platform.
            </p>
            <CopyValue value={r.exportUrl} />
            <p className="microcopy">
              Treat this URL like a password. Reconnecting this channel rotates
              it.
            </p>
          </>,
        )
      }
      build={(f) => ({
        listingId: listing.id,
        platform: f.get("platform"),
        url: f.get("url"),
      })}
    >
      <Field label="Booking platform">
        <select name="platform">
          {["AIRBNB", "VRBO", "EXPEDIA", "BOOKING"].map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </Field>
      <Field label="Platform export calendar URL">
        <input
          name="url"
          type="url"
          required
          placeholder="https://…/calendar.ics"
          autoComplete="off"
        />
      </Field>
      <p className="microcopy">
        Your server’s domain allowlist protects against unsafe URLs. Ask your
        administrator to allow a legitimate provider hostname if it is rejected.
      </p>
    </MutationForm>
  );
}
function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-value">
      <textarea value={value} readOnly aria-label="Private calendar URL" />
      <Button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        <Copy size={15} />
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
export function AutomationView() {
  const { data, show, mutate, toast } = useWorkspace();
  const [threshold, setThreshold] = useState(data.settings.confidence),
    [error, setError] = useState("");
  useEffect(
    () => setThreshold(data.settings.confidence),
    [data.settings.confidence],
  );
  async function update(patch: Partial<Settings>) {
    try {
      await mutate("automation", { ...data.settings, ...patch }, "PATCH");
      toast("Automation controls saved.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <Head
        title="Quietly capable. Clearly in control."
        description="Let the predictable run itself. Keep the important decisions close."
      />
      <section
        className={"automation-hero " + (data.settings.paused ? "paused" : "")}
      >
        <div>
          <span className="eyebrow">AUTONOMOUS OPERATIONS</span>
          <h2>
            {data.settings.paused
              ? "Take a breath. Automation is paused."
              : "Your rules are working behind the scenes."}
          </h2>
          <p>
            {data.settings.paused
              ? "Calendar imports stay on. Automated messages and cleaning notifications wait."
              : "Every action has a reason. Every queued action is visible in Activity."}
          </p>
        </div>
        <Button
          primary={!data.settings.paused}
          onClick={async () => {
            try {
              await mutate("automation/kill-switch", {
                paused: !data.settings.paused,
              });
              toast(
                data.settings.paused
                  ? "Automation resumed under your current controls."
                  : "Automation paused. Already in-flight requests may finish.",
              );
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <Power size={17} />
          {data.settings.paused ? "Resume automation" : "Pause all automation"}
        </Button>
      </section>
      {error && <ErrorBox message={error} />}
      <div className="automation-grid">
        {(
          [
            {
              key: "cleaning",
              title: "Cleaning coordination",
              icon: ClipboardCheck,
              detail:
                "Create turnover tasks from checkout dates and notify assigned cleaners.",
            },
            {
              key: "messaging",
              title: "Rules-based replies",
              icon: MessageSquare,
              detail:
                "Use your editable FAQ rules and structured house manuals. First matching rule wins.",
            },
            {
              key: "ai",
              title: "AI-assisted replies",
              icon: Sparkles,
              detail:
                "Handle unmatched questions after the rules layer. Sensitive requests always come to you.",
            },
          ] as const
        ).map(({ key, title, icon: Icon, detail }) => (
          <section className="panel automation-card" key={key}>
            <div>
              <span className="feature-icon">
                <Icon />
              </span>
              <Toggle
                checked={data.settings[key]}
                onChange={(v) => update({ [key]: v })}
                label={title}
              />
            </div>
            <h2>{title}</h2>
            <p>{detail}</p>
            <Badge>{data.settings[key] ? "Enabled" : "Disabled"}</Badge>
          </section>
        ))}
      </div>
      <section className="panel threshold-panel">
        <div>
          <span className="eyebrow">AI CONFIDENCE GATE</span>
          <h2>Your standard for an automatic reply.</h2>
          <p>
            Below the threshold, AI drafts for your review. Refunds,
            cancellations, safety, legal matters, negotiations, and booking
            changes remain with a human.
          </p>
        </div>
        <div className="threshold-control">
          <output htmlFor="confidence">
            {Math.round(threshold * 100)}
            <small>%</small>
          </output>
          <input
            id="confidence"
            aria-label="Minimum confidence for automatic AI replies"
            type="range"
            min="0.5"
            max="1"
            step="0.01"
            value={threshold}
            onChange={(e) => setThreshold(+e.target.value)}
          />
          <div>
            <span>50% · More review advised</span>
            <span>100% · Most conservative</span>
          </div>
          <Button
            disabled={threshold === data.settings.confidence}
            onClick={() => update({ confidence: threshold })}
          >
            Save threshold
          </Button>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Replies with a clear reason.</h2>
            <p>Ordered rules · Lower priority numbers run first</p>
          </div>
          <Button onClick={() => show("Create a response rule", <RuleForm />)}>
            <Plus size={15} />
            Add rule
          </Button>
        </div>
        {data.rules.length ? (
          data.rules.map((r) => (
            <div className="rule-row" key={r.id}>
              <span className="rule-order">{r.priority}</span>
              <div className="grow">
                <h3>{r.name}</h3>
                <p>
                  {r.keywords.join(", ")} →{" "}
                  {r.manualField || "Host-written template"}
                </p>
              </div>
              <Badge>{r.enabled ? label(r.action) : "Disabled"}</Badge>
              <Button
                aria-label={"Edit " + r.name}
                onClick={() =>
                  show("Edit response rule", <RuleForm rule={r} />)
                }
              >
                <PenLine size={15} />
              </Button>
            </div>
          ))
        ) : (
          <Empty
            title="Start with the questions you know."
            detail="Create a Wi-Fi or parking rule linked to a structured house-manual field."
          />
        )}
      </section>
      <p className="calendar-note">
        <ShieldCheck size={15} />
        Confidence is a model estimate, not a guarantee. Start in draft mode and
        review real outcomes before allowing automatic sends.
      </p>
    </>
  );
}
function RuleForm({ rule: r }: { rule?: Rule }) {
  const { data } = useWorkspace();
  return (
    <MutationForm
      path="automation-rules"
      method={r ? "PATCH" : "POST"}
      label="Save response rule"
      build={(f) => ({
        ...(r ? { id: r.id, version: r.version } : {}),
        name: f.get("name"),
        listingId: f.get("listingId") || null,
        keywords: String(f.get("keywords"))
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        manualField: f.get("manualField") || null,
        template: f.get("template"),
        action: f.get("action"),
        enabled: f.get("enabled") === "on",
        priority: Number(f.get("priority")),
      })}
    >
      <Field label="Rule name">
        <input name="name" defaultValue={r?.name} required />
      </Field>
      <Field label="Applies to">
        <select name="listingId" defaultValue={r?.listingId || ""}>
          <option value="">All properties</option>
          {data.listings.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Match keywords"
        hint="Separate words or phrases with commas. Matching uses word boundaries."
      >
        <input
          name="keywords"
          defaultValue={r?.keywords.join(", ")}
          placeholder="wifi, wi-fi, internet"
          required
        />
      </Field>
      <div className="form-grid">
        <Field label="Answer source">
          <select name="manualField" defaultValue={r?.manualField || ""}>
            <option value="">Host-written template only</option>
            {manualFields.map((k) => (
              <option key={k} value={k}>
                {label(k)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Action">
          <select name="action" defaultValue={r?.action || "DRAFT"}>
            <option value="DRAFT">Draft for approval</option>
            <option value="SEND">Send when guardrails permit</option>
          </select>
        </Field>
      </div>
      <Field
        label="Reply template"
        hint="Use {{answer}} to insert the selected house-manual field."
      >
        <textarea
          name="template"
          defaultValue={
            r?.template || "Here are the details for your stay: {{answer}}"
          }
          required
          maxLength={5000}
        />
      </Field>
      <Field label="Priority (lower runs first)">
        <input
          type="number"
          name="priority"
          defaultValue={r?.priority ?? 100}
          min="0"
          max="10000"
          required
        />
      </Field>
      <label className="checkbox">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={r?.enabled ?? true}
        />
        Rule enabled
      </label>
    </MutationForm>
  );
}
export function InsightsView() {
  const { data, toast } = useWorkspace();
  const [from, setFrom] = useState(localDate(dayAdd(new Date(), -30))),
    [to, setTo] = useState(localDate(dayAdd(new Date(), 1))),
    [stats, setStats] = useState<Insights | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    api<Insights>(`insights?from=${from}&to=${to}`)
      .then((s) => {
        setStats(s);
        setError("");
      })
      .catch((e) => setError(e.message));
  }, [from, to]);
  const download = () => {
    if (!stats) return;
    const rows = [
      [
        "Property",
        "Currency",
        "Allocated revenue",
        "Priced stays",
        "Total stays",
        "Occupancy %",
      ],
      ...stats.listings.map((l) => [
        l.name,
        l.currency,
        l.pricedStays ? l.revenue : "Unknown",
        l.pricedStays,
        l.totalStays,
        l.occupancy,
      ]),
    ];
    const csv = rows
      .map((r) =>
        r
          .map(
            (v) =>
              '"' +
              String(v)
                .replace(/^([=+@-])/, "\t$1")
                .replaceAll('"', '""') +
              '"',
          )
          .join(","),
      )
      .join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" })),
      a = document.createElement("a");
    a.href = url;
    a.download = `portfolio-${from}-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Report exported from the displayed metrics.");
  };
  const days = Array.from(
    {
      length: Math.min(
        92,
        Math.max(0, Math.round((+new Date(to) - +new Date(from)) / 86400000)),
      ),
    },
    (_, i) => localDate(dayAdd(from, i)),
  );
  return (
    <>
      <Head
        title="The numbers behind better decisions."
        description="Measured operations. Useful signals. A clearer view of what to improve."
      >
        <Button onClick={download} disabled={!stats}>
          <Download size={16} />
          Export report
        </Button>
      </Head>
      <div className="period-filter">
        <Field label="From">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label="Until (exclusive)">
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
      </div>
      {error && <ErrorBox message={error} />}
      <div className="metric-grid">
        <section className="panel metric">
          <span>Average response time</span>
          <strong>
            {stats?.responseSeconds === null || !stats
              ? "—"
              : stats.responseSeconds < 60
                ? `${stats.responseSeconds}s`
                : `${Math.round(stats.responseSeconds / 60)}m`}
          </strong>
          <small>{stats?.responseSamples || 0} linked guest replies</small>
        </section>
        <section className="panel metric">
          <span>Cleaning turnaround</span>
          <strong>
            {stats?.cleaningHours === null || !stats
              ? "—"
              : `${stats.cleaningHours}h`}
          </strong>
          <small>{stats?.cleaningSamples || 0} verified turnovers</small>
        </section>
        <section className="panel metric">
          <span>Properties measured</span>
          <strong>{stats?.listings.length ?? "—"}</strong>
          <small>Actual records in the selected period</small>
        </section>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>Revenue & occupancy</h2>
          <Badge>
            {from} → {to}
          </Badge>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Property</th>
                <th>Revenue</th>
                <th>Price coverage</th>
                <th>Occupancy</th>
              </tr>
            </thead>
            <tbody>
              {stats?.listings.map((l) => (
                <tr key={l.listingId}>
                  <td>
                    <span
                      className="listing-color"
                      style={{ background: l.color }}
                    />
                    {l.name}
                  </td>
                  <td>
                    {l.pricedStays
                      ? money(l.revenue, l.currency)
                      : "Not available"}
                  </td>
                  <td>
                    {l.pricedStays} / {l.totalStays} stays
                  </td>
                  <td>{l.occupancy}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="panel-footnote">
          Revenue is prorated by nights inside the period. Unpriced iCal
          bookings are excluded, not treated as zero. Different currencies are
          never silently combined.
        </p>
      </section>
      <section className="panel heatmap-panel">
        <div className="panel-heading">
          <h2>Occupied nights, by property</h2>
          <span className="muted">
            First {days.length} nights of the selected period
          </span>
        </div>
        {stats?.listings.map((l) => (
          <div className="heatmap-row" key={l.listingId}>
            <strong>{l.name}</strong>
            <div>
              {days.map((day) => (
                <span
                  key={day}
                  role="img"
                  aria-label={`${day}: ${l.nights.includes(day) ? "occupied" : "available"}`}
                  title={`${day}: ${l.nights.includes(day) ? "occupied" : "available"}`}
                  style={{
                    background: l.nights.includes(day) ? l.color : undefined,
                  }}
                />
              ))}
            </div>
            <span>{l.occupancy}%</span>
          </div>
        ))}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>Sync reliability by platform</h2>
        </div>
        {stats?.sync.length ? (
          stats.sync.map((s) => (
            <div className="list-row" key={s.platform}>
              <div className="grow">
                <strong>{label(s.platform)}</strong>
                <small>{s.checks} recorded checks in this period</small>
              </div>
              <strong>
                {s.uptime === null ? "No observations" : s.uptime + "%"}
              </strong>
            </div>
          ))
        ) : (
          <p className="panel-pad muted">
            Feed checks will build this history once channels are connected.
          </p>
        )}
        <p className="panel-footnote">
          Uptime measures successful import polls, not the speed of a platform
          refreshing its imported calendar.
          {stats?.syncSampleCapped
            ? " Based on the latest 20,000 observations."
            : ""}
        </p>
      </section>
    </>
  );
}
export function SettingsView() {
  const { data, show, mutate, toast } = useWorkspace();
  const [theme, setTheme] = useState("dark"),
    [error, setError] = useState("");
  useEffect(() => setTheme(localStorage.getItem("str-theme") || "dark"), []);
  async function push() {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window))
        throw new Error("This browser does not support web push.");
      if (!data.vapidPublicKey)
        throw new Error("Web push is not configured on this server.");
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const base64 = data.vapidPublicKey.replace(/-/g, "+").replace(/_/g, "/");
      const key = Uint8Array.from(
        atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
        (c) => c.charCodeAt(0),
      );
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
      await mutate("push", subscription.toJSON());
      toast("Host alerts enabled on this browser.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <Head
        title="A workspace that works your way."
        description="Manage the people, preferences, and connections behind your operations."
      />
      {error && <ErrorBox message={error} />}
      <div className="settings-grid">
        <div>
          <section className="panel">
            <div className="panel-heading">
              <h2>Appearance</h2>
            </div>
            <div className="setting-row">
              <div>
                <h3>Your preferred light</h3>
                <p>
                  One typeface. A quieter palette. Three considered surfaces.
                </p>
              </div>
              <select
                aria-label="Color theme"
                value={theme}
                onChange={(e) => {
                  setTheme(e.target.value);
                  document.documentElement.dataset.theme = e.target.value;
                  localStorage.setItem("str-theme", e.target.value);
                }}
              >
                <option value="dark">Dark</option>
                <option value="oled">OLED black</option>
                <option value="light">Light</option>
              </select>
            </div>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>People & access</h2>
            </div>
            <button
              className="setting-row full"
              onClick={() => show("Your team", <Team />)}
            >
              <Users />
              <div className="grow">
                <h3>Hosts & co-hosts</h3>
                <p>Memberships, roles, and revocation</p>
              </div>
              <ChevronRight />
            </button>
            <button
              className="setting-row full"
              onClick={() => show("Add a cleaner", <CleanerForm />)}
            >
              <ClipboardCheck />
              <div className="grow">
                <h3>Cleaner access</h3>
                <p>Private job links, scoped to assignments</p>
              </div>
              <ChevronRight />
            </button>
            <button
              className="setting-row full"
              onClick={() =>
                show(
                  "Change your password",
                  <MutationForm
                    path="auth/password"
                    label="Change password & sign out"
                    onSaved={() => window.location.assign("/login")}
                    build={(f) => ({
                      currentPassword: f.get("current"),
                      newPassword: f.get("next"),
                    })}
                  >
                    <Field label="Current password">
                      <input
                        name="current"
                        type="password"
                        autoComplete="current-password"
                        required
                      />
                    </Field>
                    <Field label="New password (at least 14 characters)">
                      <input
                        name="next"
                        type="password"
                        autoComplete="new-password"
                        minLength={14}
                        maxLength={200}
                        required
                      />
                    </Field>
                    <p>All active sessions will be revoked.</p>
                  </MutationForm>,
                )
              }
            >
              <LockKeyhole />
              <div className="grow">
                <h3>Password & sessions</h3>
                <p>Change your password and revoke active sessions</p>
              </div>
              <ChevronRight />
            </button>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>Host notifications</h2>
            </div>
            <div className="setting-row">
              <div>
                <h3>Alerts that need you</h3>
                <p>
                  Sync errors, human-queue messages, unaccepted jobs, and
                  overdue verification.
                </p>
              </div>
              <Button onClick={push}>
                <Bell size={15} />
                Enable push
              </Button>
            </div>
            <p className="panel-footnote">
              In-app notifications remain available even if browser push is
              unavailable.
            </p>
          </section>
        </div>
        <div>
          <section className="panel">
            <div className="panel-heading">
              <h2>Service connections</h2>
              <Badge>Server configuration</Badge>
            </div>
            {Object.entries(data.providers).map(([k, v]) => (
              <div className="list-row" key={k}>
                <div className="grow">
                  <strong>
                    {{
                      sms: "Cleaner SMS",
                      email: "Direct-booking email",
                      ai: "AI provider",
                      push: "Web push",
                      photos: "Private photo storage",
                      monitoring: "Error monitoring",
                    }[k] || k}
                  </strong>
                </div>
                <Badge tone={v ? "accent" : ""}>
                  {v ? "Configured" : "Setup required"}
                </Badge>
              </div>
            ))}
            <p className="panel-footnote">
              Configured means credentials are present. Delivery receipts, feed
              checks, and Activity show actual outcomes.
            </p>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>Native guest messaging</h2>
            </div>
            <p className="panel-pad">
              Airbnb, Vrbo, Expedia, and Booking.com messaging require approved
              provider access. Connect your authorized adapter here; direct
              bookings use email.
            </p>
            {data.integrations.map((i) => (
              <div className="list-row" key={i.platform}>
                <span className="grow">{label(i.platform)}</span>
                <Badge>{i.enabled ? "Enabled" : "Disabled"}</Badge>
              </div>
            ))}
            <div className="panel-pad">
              <Button
                disabled={data.user.role !== "HOST"}
                onClick={() =>
                  show(
                    "Connect an authorized messaging bridge",
                    <IntegrationForm />,
                  )
                }
              >
                <LinkIcon size={15} />
                Configure integration
              </Button>
            </div>
          </section>
          <div className="privacy-note">
            <ShieldCheck />
            <h3>Private by design.</h3>
            <p>
              No third-party advertising analytics. Guest details and door codes
              are encrypted. Sensitive reads and exports leave an audit record.
            </p>
          </div>
          <Button
            onClick={async () => {
              await api("auth/logout", { method: "POST", data: {} });
              window.location.assign("/login");
            }}
          >
            Sign out
          </Button>
        </div>
      </div>
    </>
  );
}
function IntegrationForm() {
  return (
    <MutationForm
      path="integrations"
      label="Save authorized integration"
      build={(f) => ({
        platform: f.get("platform"),
        endpoint: f.get("endpoint"),
        secret: f.get("secret"),
        enabled: true,
      })}
    >
      <p className="callout">
        This requires an approved channel partner or your provider adapter
        implementing the signed webhook contract in the integration guide. It
        does not unlock an OTA’s private APIs.
      </p>
      <Field label="Platform">
        <select name="platform">
          {["AIRBNB", "VRBO", "EXPEDIA", "BOOKING", "DIRECT"].map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </Field>
      <Field label="Outbound messaging HTTPS endpoint">
        <input name="endpoint" type="url" required />
      </Field>
      <Field label="Shared HMAC secret (32+ characters)">
        <input
          name="secret"
          type="password"
          minLength={32}
          autoComplete="new-password"
          required
        />
      </Field>
    </MutationForm>
  );
}
function Team() {
  const { data, show, toast } = useWorkspace();
  const [members, setMembers] = useState<
      { id: string; userId: string; name: string; role: string }[]
    >([]),
    [error, setError] = useState("");
  useEffect(() => {
    api<typeof members>("team")
      .then(setMembers)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <>
      {error && <ErrorBox message={error} />}
      <div>
        {members.map((m) => (
          <div className="list-row" key={m.id}>
            <div className="grow">
              <strong>{m.name}</strong>
              <small>{label(m.role)}</small>
            </div>
            {m.role !== "HOST" && (
              <Button
                onClick={() =>
                  show(
                    "Revoke co-host access",
                    <MutationForm
                      path={"team/" + m.id}
                      method="DELETE"
                      label="Revoke access"
                      build={() => ({})}
                    >
                      <p>
                        {m.name} will immediately lose workspace access, and
                        their workspace sessions will be invalidated.
                      </p>
                      <label className="checkbox">
                        <input type="checkbox" required />
                        Revoke this membership.
                      </label>
                    </MutationForm>,
                  )
                }
              >
                Revoke
              </Button>
            )}
          </div>
        ))}
      </div>
      {data.user.role === "HOST" && (
        <Button
          onClick={() =>
            show(
              "Add a co-host",
              <MutationForm
                path="team"
                label="Create co-host"
                build={(f) => ({
                  name: f.get("name"),
                  email: f.get("email"),
                  password: f.get("password"),
                  role: "COHOST",
                })}
              >
                <Field label="Name">
                  <input name="name" required />
                </Field>
                <Field label="Email">
                  <input name="email" type="email" required />
                </Field>
                <Field label="Initial password">
                  <input
                    name="password"
                    type="password"
                    minLength={14}
                    maxLength={200}
                    required
                    autoComplete="new-password"
                  />
                </Field>
                <p className="microcopy">
                  Share the initial password through a secure channel and ask
                  the co-host to change it after signing in.
                </p>
              </MutationForm>,
            )
          }
        >
          <Plus size={15} />
          Add co-host
        </Button>
      )}
    </>
  );
}
export function ActivityView() {
  const { show, explain } = useWorkspace();
  const [entries, setEntries] = useState<AuditEntry[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [error, setError] = useState("");
  async function load(before?: string) {
    const data = await api<{ entries: AuditEntry[]; outbox: Job[] }>(
      "activity" + (before ? "?before=" + encodeURIComponent(before) : ""),
    );
    setEntries((e) => (before ? [...e, ...data.entries] : data.entries));
    setJobs(data.outbox);
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  return (
    <>
      <Head
        title="Every action has a reason."
        description="Follow the decisions, inspect the history, and stop a queued action before it leaves."
      >
        <Button onClick={() => load().catch((e) => setError(e.message))}>
          <RefreshCw size={16} />
          Refresh
        </Button>
      </Head>
      {error && <ErrorBox message={error} />}
      <section className="panel">
        <div className="panel-heading">
          <h2>Queued & uncertain actions</h2>
          <Badge>{jobs.length}</Badge>
        </div>
        {jobs.length ? (
          jobs.map((j) => (
            <div className="list-row" key={j.id}>
              <div className="grow">
                <strong>{label(j.kind)}</strong>
                <small>
                  {label(j.category)} · {j.attempts} attempt(s)
                </small>
                {j.error && <p>{j.error}</p>}
              </div>
              <Badge>{label(j.status)}</Badge>
              <Button
                disabled={j.status === "SENDING"}
                onClick={() =>
                  show(
                    "Review this action",
                    <MutationForm
                      path={"outbox/" + j.id}
                      label="Confirm action"
                      build={(f) => ({
                        action: f.get("action"),
                        reason: f.get("reason"),
                      })}
                    >
                      <p className="callout">
                        Messages and SMS cannot be recalled once accepted by a
                        provider. An uncertain outcome may already have been
                        delivered. Check the provider’s logs before retrying.
                      </p>
                      <Field label="Resolution">
                        <select name="action">
                          <option value="CANCEL">Cancel queued action</option>
                          {j.status === "UNKNOWN" && (
                            <>
                              <option value="CONFIRM_DELIVERED">
                                Provider confirms it was delivered
                              </option>
                              <option value="RETRY">
                                Provider confirms it was not sent — retry
                              </option>
                            </>
                          )}
                        </select>
                      </Field>
                      <Field label="Evidence / reason">
                        <textarea name="reason" minLength={10} required />
                      </Field>
                      <label className="checkbox">
                        <input type="checkbox" required />I reviewed this action
                        and its external outcome.
                      </label>
                    </MutationForm>,
                  )
                }
              >
                Review
              </Button>
            </div>
          ))
        ) : (
          <p className="panel-pad muted">
            No queued or uncertain actions need review.
          </p>
        )}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>Audit trail</h2>
          <Badge>Append-only</Badge>
        </div>
        {entries.length ? (
          entries.map((e) => (
            <article className="audit-row" key={e.id}>
              <span className="audit-marker" />
              <div className="grow">
                <div>
                  <Badge>{label(e.action)}</Badge>
                  <span className="muted">{e.entity}</span>
                </div>
                <h3>{e.reason}</h3>
                <small>
                  {dateTime(e.createdAt)} ·{" "}
                  {e.actorId === "worker" ? "Automation" : e.actorId}
                </small>
              </div>
              {e.entityId && (
                <Button
                  aria-label="Open full explanation"
                  onClick={() => explain(e.entityId!)}
                >
                  <Info size={16} />
                </Button>
              )}
            </article>
          ))
        ) : (
          <Empty
            title="A history you can trust."
            detail="Reads, exports, changes, and automated decisions appear here as they happen."
          />
        )}
        {entries.length >= 100 && (
          <div className="panel-pad">
            <Button
              onClick={() =>
                load(entries.at(-1)?.createdAt).catch((e) =>
                  setError(e.message),
                )
              }
            >
              Load older entries
            </Button>
          </div>
        )}
      </section>
    </>
  );
}
