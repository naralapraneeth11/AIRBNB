"use client";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, ShieldCheck, CalendarDays, Workflow } from "lucide-react";
import { api } from "@/lib/client";
import { BRAND } from "@/lib/brand";
import { Button, Field, ErrorBox } from "./ui";

export type AccountFeatures = { signup: boolean; reset: boolean };

/** The two-column layout shared by sign-in, sign-up and recovery pages. */
export function AccountShell({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <main id="main" className="login">
      <section className="login-story">
        <Link className="brand" href="/">
          <span className="brand-mark">{BRAND.mark}</span>
          <span>
            {BRAND.wordmark}{" "}
            {BRAND.descriptor && <small>{BRAND.descriptor}</small>}
          </span>
        </Link>
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
          <span className="eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
          <p>{intro}</p>
          {children}
          <p className="login-note">
            <ShieldCheck size={14} />
            Encrypted data. No advertising trackers.
          </p>
        </div>
      </section>
    </main>
  );
}

export function SignIn({
  configured,
  features = { signup: false, reset: false },
}: {
  configured: boolean;
  features?: AccountFeatures;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <AccountShell
      eyebrow="WELCOME HOME"
      title="Your workspace awaits."
      intro="Sign in to see what needs you. And what’s already handled."
    >
      {!configured ? (
        <div className="setup-card">
          <h3>Finish your server setup</h3>
          <p>
            Connect PostgreSQL, configure encryption and authentication keys,
            run the migrations, and create your owner account.
          </p>
          <p>
            The deployment guide in your source package walks through each step.
            This screen never substitutes sample data for an unconfigured
            service.
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
      {configured && (
        <p className="account-links">
          {features.reset ? (
            <Link href="/forgot">Forgot your password?</Link>
          ) : (
            <span>
              Forgot your password? Your administrator can use the documented
              recovery procedure.
            </span>
          )}
          {features.signup ? (
            <Link href="/signup">New here? Create an account</Link>
          ) : (
            <span>Need access? Ask your workspace owner.</span>
          )}
        </p>
      )}
    </AccountShell>
  );
}
