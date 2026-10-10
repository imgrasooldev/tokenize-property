"use client";

import Link from "next/link";

/**
 * Generic error page. Never shows the error message or stack (they can reveal internals); only the
 * opaque digest that operations can match in the server log.
 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="container narrow">
      <h1>Something went wrong</h1>
      <p className="lead" lang="ur" dir="rtl">
        کچھ غلط ہو گیا
      </p>
      <p className="note">
        Your money and tokens are safe: nothing is changed by a page error. Try again, or go back to the start.
      </p>
      {error.digest && (
        <p className="meta mono">
          Reference: {error.digest}
        </p>
      )}
      <p style={{ display: "flex", gap: 10, marginBlockStart: 16 }}>
        <button
          type="button"
          className="btn"
          onClick={() => {
            reset();
          }}
        >
          Try again
        </button>
        <Link href="/" className="btn secondary">
          Home
        </Link>
      </p>
    </main>
  );
}
