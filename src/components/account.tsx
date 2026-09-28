"use client";
// Self-service account screens (AUTH 01, AUTH 03). Links carry their token
// in the URL fragment, which browsers never send to a server; each page reads
// it once and removes it from the address bar and history.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { api } from "@/lib/client";
import { AccountShell } from "./sign-in";
import { Button, Field, ErrorBox } from "./ui";

const PASSWORD_HINT =
  "At least 14 characters. A few unrelated words work well, and pasting from a password manager is fine.";

function takeToken() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
  window.history.replaceState(null, "", window.location.pathname);
  return token;
}

function Unavailable({ what }: { what: string }) {
  return (
    <div className="setup-card">
      <h3>{what} isn’t available here</h3>
      <p>
        This deployment hasn’t turned it on. Ask your workspace owner or
        administrator for help.
      </p>
    </div>
  );
}

function Sent({ message }: { message: string }) {
  return (
    <div className="setup-card" role="status">
      <h3>Check your email</h3>
      <p>{message}</p>
      <p>
        Didn’t get it? Check your spam folder, or try again in a few minutes.
      </p>
    </div>
  );
}

export function SignUp({ available }: { available: boolean }) {
  const [sent, setSent] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <AccountShell
      eyebrow="CREATE AN ACCOUNT"
      title="Start with one property."
      intro="Create your account and workspace. We’ll email you a link to confirm the address first."
    >
      {!available ? (
        <Unavailable what="Sign-up" />
      ) : sent ? (
        <Sent message={sent} />
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setBusy(true);
            setError("");
            try {
              const result = await api<{ message: string }>("auth/register", {
                method: "POST",
                data: {
                  name: f.get("name"),
                  email: f.get("email"),
                  workspaceName: f.get("workspaceName"),
                  password: f.get("password"),
                },
              });
              setSent(result.message);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Your name">
            <input name="name" autoComplete="name" required maxLength={100} />
          </Field>
          <Field label="Email address">
            <input
              type="email"
              name="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
            />
          </Field>
          <Field label="Workspace name" hint="Usually your business name.">
            <input
              name="workspaceName"
              required
              maxLength={100}
              placeholder="Lakeside Rentals"
            />
          </Field>
          <Field label="Password" hint={PASSWORD_HINT}>
            <input
              type="password"
              name="password"
              autoComplete="new-password"
              minLength={14}
              required
            />
          </Field>
          {error && <ErrorBox message={error} />}
          <Button primary disabled={busy} type="submit">
            {busy ? "Creating…" : "Create account"}
            <ArrowRight size={17} />
          </Button>
        </form>
      )}
      <p className="account-links">
        <Link href="/login">Already have an account? Sign in</Link>
      </p>
    </AccountShell>
  );
}

export function VerifyEmail({ available }: { available: boolean }) {
  const [error, setError] = useState(""),
    started = useRef(false);
  useEffect(() => {
    if (!available || started.current) return;
    started.current = true;
    const token = takeToken();
    (async () => {
      try {
        if (!token)
          throw new Error(
            "Open this page from the link in your email; the link carries the confirmation.",
          );
        const result = await api<{ next: string }>("auth/verify", {
          method: "POST",
          data: { token },
        });
        window.location.assign(result.next);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [available]);
  return (
    <AccountShell
      eyebrow="CONFIRM YOUR EMAIL"
      title="Almost there."
      intro="We’re confirming your address and creating your workspace."
    >
      {!available ? (
        <Unavailable what="Sign-up" />
      ) : error ? (
        <ErrorBox message={error} />
      ) : (
        <p role="status">Confirming…</p>
      )}
      <p className="account-links">
        <Link href="/signup">Sign up again</Link>
        <Link href="/login">Sign in</Link>
      </p>
    </AccountShell>
  );
}

export function ForgotPassword({ available }: { available: boolean }) {
  const [sent, setSent] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <AccountShell
      eyebrow="RESET YOUR PASSWORD"
      title="Let’s get you back in."
      intro="Enter your account’s email address and we’ll send a link to choose a new password."
    >
      {!available ? (
        <Unavailable what="Password reset by email" />
      ) : sent ? (
        <Sent message={sent} />
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setBusy(true);
            setError("");
            try {
              const result = await api<{ message: string }>("auth/forgot", {
                method: "POST",
                data: { email: f.get("email") },
              });
              setSent(result.message);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Email address">
            <input
              type="email"
              name="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
            />
          </Field>
          {error && <ErrorBox message={error} />}
          <Button primary disabled={busy} type="submit">
            {busy ? "Sending…" : "Send reset link"}
            <ArrowRight size={17} />
          </Button>
        </form>
      )}
      <p className="account-links">
        <Link href="/login">Back to sign in</Link>
      </p>
    </AccountShell>
  );
}

export function ResetPassword({ available }: { available: boolean }) {
  const token = useRef<string | null>(null),
    [done, setDone] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (available && token.current === null) token.current = takeToken() ?? "";
  }, [available]);
  return (
    <AccountShell
      eyebrow="RESET YOUR PASSWORD"
      title="Choose a new password."
      intro="After this, you’ll be signed out everywhere and can sign in with the new password."
    >
      {!available ? (
        <Unavailable what="Password reset by email" />
      ) : done ? (
        <div className="setup-card" role="status">
          <h3>Password changed</h3>
          <p>Every session was signed out. Sign in with your new password.</p>
          <Link className="button primary" href="/login">
            Sign in
          </Link>
        </div>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setError("");
            if (!token.current) {
              setError(
                "Open this page from the link in your email; the link carries the reset.",
              );
              return;
            }
            if (f.get("password") !== f.get("confirm")) {
              setError("The two passwords don’t match.");
              return;
            }
            setBusy(true);
            try {
              await api("auth/reset", {
                method: "POST",
                data: { token: token.current, password: f.get("password") },
              });
              setDone(true);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="New password" hint={PASSWORD_HINT}>
            <input
              type="password"
              name="password"
              autoComplete="new-password"
              minLength={14}
              required
            />
          </Field>
          <Field label="Repeat the new password">
            <input
              type="password"
              name="confirm"
              autoComplete="new-password"
              minLength={14}
              required
            />
          </Field>
          {error && <ErrorBox message={error} />}
          <Button primary disabled={busy} type="submit">
            {busy ? "Saving…" : "Save new password"}
            <ArrowRight size={17} />
          </Button>
        </form>
      )}
      <p className="account-links">
        <Link href="/forgot">Ask for a new link</Link>
        <Link href="/login">Back to sign in</Link>
      </p>
    </AccountShell>
  );
}
