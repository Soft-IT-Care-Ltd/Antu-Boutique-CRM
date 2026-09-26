"use client";

import { useEffect } from "react";

// P5.1 — registers public/sw.js (offline page + installability) once the page
// has loaded, in production only: a service worker in `next dev` fights with
// hot reload. Failing to register just means no offline page.
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch((error) => console.warn("Service worker registration failed:", error));
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
