"use client";
import { useEffect, useRef, useState } from "react";
import {
  Check,
  Camera,
  MapPin,
  KeyRound,
  ArrowRight,
  ShieldCheck,
} from "lucide-react";
import { api, label, dateTime, APIError } from "@/lib/client";
import { Button, Badge, ErrorBox, Empty, Field } from "./ui";
type Job = {
  id: string;
  title: string;
  status: string;
  scheduledAt: string;
  verifyBy: string;
  version: number;
  photoId: string | null;
  codeAvailable: boolean;
  listing: { name: string; address: string; timezone: string };
  note: string;
};
export function CleanerPortal() {
  const [jobs, setJobs] = useState<Job[]>([]),
    [job, setJob] = useState<Job | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [code, setCode] = useState<string | null>(null),
    [token, setToken] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  async function load() {
    try {
      const day = await api<{ jobs: Job[] }>("cleaner/jobs");
      setJobs(day.jobs);
      try {
        setJob(await api<Job>("cleaner"));
      } catch (error) {
        if (!(error instanceof APIError) || error.status !== 403) throw error;
        setJob(null);
      }
      setError("");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1)),
      t = params.get("token");
    if (t) {
      setToken(t);
      history.replaceState(null, "", "/cleaner");
    } else load().catch((e) => setError(e.message));
  }, []);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function transition(status: string) {
    if (!job) return;
    await action(() =>
      api("cleaner/transition", {
        method: "POST",
        data: { status, version: job.version },
      }),
    );
    setCode(null);
  }
  useEffect(() => {
    if (code) {
      const timer = setTimeout(() => setCode(null), 30000);
      return () => clearTimeout(timer);
    }
  }, [code]);
  return (
    <main id="main" className="cleaner-portal">
      <header>
        <span className="brand-mark">a</span>
        <span>
          airbnb <small>CLEANER WORKSPACE</small>
        </span>
      </header>
      {error && <ErrorBox message={error} />}
      <span className="eyebrow">A FRESH START FOR EVERY STAY</span>
      <h1>Your next good job.</h1>
      {!token && jobs.length > 0 && (
        <nav className="cleaner-jobs" aria-label="Today's assigned jobs">
          <span className="eyebrow">TODAY’S JOBS</span>
          {jobs.map((item) => (
            <button
              key={item.id}
              disabled={busy}
              aria-current={item.id === job?.id ? "true" : undefined}
              onClick={() => {
                setCode(null);
                action(() =>
                  api("cleaner/select", {
                    method: "POST",
                    data: { taskId: item.id },
                  }),
                );
              }}
            >
              <span>
                <strong>{item.listing.name}</strong>
                <small>
                  {dateTime(item.scheduledAt, item.listing.timezone)}
                </small>
              </span>
              <Badge>{label(item.status)}</Badge>
            </button>
          ))}
        </nav>
      )}
      {token ? (
        <section className="panel panel-pad">
          <h2>A private invitation.</h2>
          <p>
            Open your assigned job to review the address and timing. The door
            code stays private until you accept.
          </p>
          <Button
            primary
            disabled={busy}
            onClick={() =>
              action(async () => {
                await api("cleaner/redeem", {
                  method: "POST",
                  data: { token },
                });
                setToken(null);
              })
            }
          >
            Open my job
            <ArrowRight size={16} />
          </Button>
        </section>
      ) : job ? (
        <section className="panel cleaner-job">
          <div className="panel-pad">
            <Badge>{label(job.status)}</Badge>
            <h2>{job.listing.name}</h2>
            <p>{job.title}</p>
            <div className="cleaner-timing">
              <strong>{dateTime(job.scheduledAt, job.listing.timezone)}</strong>
              <small>
                Verify by {dateTime(job.verifyBy, job.listing.timezone)}
              </small>
            </div>
            <div className="address">
              <MapPin size={18} />
              <span>{job.listing.address}</span>
            </div>
            {job.status === "ASSIGNED" ? (
              <div className="cleaner-actions">
                <Button
                  primary
                  disabled={busy}
                  onClick={() => transition("ACCEPTED")}
                >
                  <Check size={16} />
                  Accept job
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => transition("NEEDS_SCHEDULING")}
                >
                  Decline
                </Button>
              </div>
            ) : job.status === "ACCEPTED" ? (
              <Button
                primary
                disabled={busy}
                onClick={() => transition("IN_PROGRESS")}
              >
                Start cleaning
                <ArrowRight size={16} />
              </Button>
            ) : null}
            {job.codeAvailable && (
              <div className="access-code">
                {code ? (
                  <>
                    <span className="code">{code}</span>
                    <small>Hides automatically after 30 seconds.</small>
                  </>
                ) : (
                  <Button
                    disabled={busy}
                    onClick={async () => {
                      try {
                        const r = await api<{ code: string | null }>(
                          "cleaner/door-code",
                          { method: "POST", data: {} },
                        );
                        setCode(r.code);
                        if (!r.code)
                          setError("No door code is saved. Contact the host.");
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    <KeyRound size={16} />
                    Reveal door code
                  </Button>
                )}
              </div>
            )}
            {["IN_PROGRESS", "DONE"].includes(job.status) && (
              <>
                <input
                  ref={file}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      const form = new FormData();
                      form.set("file", f);
                      action(() =>
                        api("cleaner/photo", { method: "POST", data: form }),
                      );
                    }
                  }}
                />
                <Button disabled={busy} onClick={() => file.current?.click()}>
                  <Camera size={16} />
                  {job.photoId
                    ? "Replace verification photo"
                    : "Upload cleaning photo"}
                </Button>
                {job.photoId && (
                  <img
                    className="proof-image"
                    src={"/api/assets/" + job.photoId}
                    alt="Your uploaded cleaning photo"
                  />
                )}
                {job.status === "IN_PROGRESS" && (
                  <Button
                    primary
                    disabled={busy || !job.photoId}
                    onClick={() => transition("DONE")}
                  >
                    <Check size={16} />
                    Finish job
                  </Button>
                )}
                <small>
                  Upload a photo before finishing. Your host verifies the
                  result.
                </small>
              </>
            )}
            {job.status === "VERIFIED" && (
              <div className="verified-state">
                <ShieldCheck />
                <h3>Beautifully done.</h3>
                <p>Your host verified this job. Thank you.</p>
              </div>
            )}
          </div>
        </section>
      ) : !error && loading ? (
        <div className="skeleton card" role="status" aria-label="Loading job" />
      ) : !error ? (
        <Empty
          title={jobs.length ? "Choose your next job." : "All clear for today."}
          detail={
            jobs.length
              ? "Select an assigned job above to see its address and timing."
              : "No active jobs are assigned for today. Your host will send a private link when a new job is ready."
          }
        />
      ) : null}
      <footer>
        <ShieldCheck size={14} />A private workspace. Only your assigned jobs.
      </footer>
    </main>
  );
}
