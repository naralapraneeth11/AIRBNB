import Link from "next/link";
export default function NotFound() {
  return (
    <main id="main" className="fatal">
      <h1>This page isn’t here.</h1>
      <p>Return to your calendar to continue.</p>
      <Link className="button primary" href="/calendar">
        Open calendar
      </Link>
    </main>
  );
}
