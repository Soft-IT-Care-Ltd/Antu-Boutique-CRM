import type { MetadataRoute } from "next";

// PRD §4.18 / §7 — installable as a PWA. Served at /manifest.webmanifest
// without a session (proxy.ts), since the browser fetches it without
// cookies. Opens on the dashboard; the shortcuts (Android long-press) jump
// straight to the three screens staff use on a phone. A shortcut someone's
// role can't use just lands them on the dashboard (guardPage).
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Antu Boutique CRM",
    short_name: "Antu CRM",
    description: "Orders, packing, POS and stock for Antu Boutique.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#171717",
    lang: "en",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "New order", short_name: "New order", url: "/orders/new", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Packing queue", short_name: "Packing", url: "/packing", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "POS", short_name: "POS", url: "/pos", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
