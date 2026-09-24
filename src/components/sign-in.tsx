"use client";
import { useState } from "react";
import { ArrowRight, ShieldCheck, CalendarDays, Workflow } from "lucide-react";
import { api } from "@/lib/client";
import { Button, Field, ErrorBox } from "./ui";
export function SignIn({ configured }: { configured: boolean }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main id="main" className="login">
      <section className="login-story">
        <a className="brand" href="/">
          <span className="brand-mark">a</span>
          <span>
            airbnb <small>AUTOMATION</small>
          </span>
        </a>
        <div>
          <span className="eyebrow">
            A LITTLE LESS WORK. A LOT MORE CLARITY.
          </span>
          <h1>
            Every stay.
            <br />
            Beautifully
            <br />
            <span>taken care of.</span>
          </h1>
          <p>
            Your properties, conversations, and people.
            <br />
            One considered place to bring it all together.
          </p>
        </div>
        <div className="login-features">
          <span>
            <CalendarDays />
            One source of truth
          </span>
          <span>
            <Workflow />
            Automation with guardrails
          </span>
          <span>
            <ShieldCheck />
            Private by design
          </span>
        </div>
      </section>
      <section className="login-form">
        <div className="login-form-inner">
          <span className="eyebrow">WELCOME HOME</span>
          <h2>Your workspace awaits.</h2>
          <p>Sign in to see what needs you. And what’s already handled.</p>
          {!configured ? (
            <div className="setup-card">
              <h3>Finish your server setup</h3>
              <p>
                Connect PostgreSQL, configure encryption and authentication
                keys, run the migrations, and create your owner account.
              </p>
              <p>
                The deployment guide in your source package walks through each
                step. This screen never substitutes sample data for an
                unconfigured service.
              </p>
            </div>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                setBusy(true);
                setError("");
                try {
                  await api("auth/login", {
                    method: "POST",
                    data: {
                      email: data.get("email"),
                      password: data.get("password"),
                    },
                  });
                  window.location.assign("/calendar");
                } catch (e) {
                  setError((e as Error).message);
                  setBusy(false);
                }
              }}
            >
              <Field label="Email address">
                <input
                  autoComplete="username"
                  type="email"
                  name="email"
                  required
                  placeholder="you@example.com"
                />
              </Field>
              <Field label="Password">
                <input
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  required
                />
              </Field>
              {error && <ErrorBox message={error} />}
              <Button primary disabled={busy} type="submit">
                {busy ? "Signing in…" : "Enter your workspace"}
                <ArrowRight size={17} />
              </Button>
            </form>
          )}
          <p className="login-note">
            <ShieldCheck size={14} />
            Encrypted data. No advertising trackers.
          </p>
          <small>
            Need access? Ask your workspace owner. Forgotten password? Your
            administrator can use the documented recovery procedure.
          </small>
        </div>
      </section>
    </main>
  );
}
