"use client";

import { useEffect } from "react";

import { BOOT_FLAG, BOOT_PANEL_ID } from "@/lib/browser/boot-guard";

/** Tells the pre-boot guard (lib/browser/boot-guard.ts) that React is up; clears its panel if a non-fatal early error showed it. */
export function BootMarker() {
  useEffect(() => {
    (window as unknown as Record<string, boolean>)[BOOT_FLAG] = true;
    document.getElementById(BOOT_PANEL_ID)?.remove();
  }, []);
  return null;
}
