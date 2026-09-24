export default function NotFound() {
  return (
    <main id="main" className="fatal">
      <h1>This page isn’t here.</h1>
      <p>Return to your calendar to continue.</p>
      <a className="button primary" href="/calendar">
        Open calendar
      </a>
    </main>
  );
}
