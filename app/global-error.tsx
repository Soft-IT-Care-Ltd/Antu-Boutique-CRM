"use client";

import { useEffect } from "react";

// Errors in the root layout itself. This replaces the whole document, so it
// carries its own <html>/<body> and inline styles — it must render even if
// the app's CSS is what failed. (P3.0, Gift Valy CORRECTIONS Round 2 §2.8.)
export default function GlobalError({ error }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "-apple-system, system-ui, sans-serif" }}>
        <title>Something went wrong — Antu Boutique CRM</title>
        <div role="alert" style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, boxSizing: "border-box" }}>
          <div style={{ maxWidth: 360, textAlign: "center" }}>
            <p style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>Something went wrong</p>
            <p style={{ margin: "0 0 16px", color: "#555" }}>The app hit an error. Reload to try again — nothing you saved is lost.</p>
            {error.digest ? <p style={{ margin: "0 0 16px", color: "#777", fontSize: 12, fontFamily: "monospace" }}>Ref: {error.digest}</p> : null}
            <button type="button" onClick={() => window.location.reload()} style={{ font: "inherit", fontWeight: 600, padding: "10px 20px", borderRadius: 8, border: 0, background: "#111", color: "#fff" }}>
              Reload
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
