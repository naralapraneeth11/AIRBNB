"use client";
export default function ErrorPage({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <main id="main" className="fatal">
      <h1>Let’s get you back on track.</h1>
      <p>The page could not load. Your saved workspace is still there.</p>
      <button className="button primary" onClick={reset}>
        Try again
      </button>
      <a href="/login">Sign in again</a>
    </main>
  );
}
