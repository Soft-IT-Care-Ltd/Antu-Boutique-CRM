"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraOff, CircleAlert, CircleCheck, Loader2, ScanBarcode } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { looksLikeBanglaKeyboard } from "@/lib/barcode/scan";
import { scanFeedback } from "@/lib/browser/scan-feedback";
import { cn } from "@/lib/utils";

const CameraScanner = dynamic(() => import("@/components/scan/camera-scanner").then((m) => m.CameraScanner), { ssr: false });

export type ScanResult = { ok: boolean; message: string };

/**
 * C4 — the one scan box every stock scan screen uses (transfer send and
 * receive, purchase receiving, stock count).
 *
 *  - A handheld USB/Bluetooth scanner is a keyboard: it types the tag's SKU
 *    and Enter. The box keeps the focus so the next tag lands here too.
 *  - A person can type a SKU and press Enter the same way.
 *  - The camera button turns the phone camera into the scanner.
 *
 * Scans are handled one at a time, in order — a fast scanner can send the
 * next tag before the server has answered the last. Every result is shown
 * big (green, or a loud red refusal) and sounded (lib/browser/scan-feedback).
 */
export function ScanBox({
  onScan,
  disabled,
  placeholder = "Scan a tag, or type the SKU and press Enter",
  hint,
  autoFocus = true,
}: {
  onScan: (code: string) => Promise<ScanResult>;
  disabled?: boolean;
  placeholder?: string;
  hint?: string;
  /** False on a page where the scan box isn't the first thing (the purchase form). */
  autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [camera, setCamera] = useState(false);
  const [pending, setPending] = useState(0);
  const [last, setLast] = useState<(ScanResult & { key: number }) | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const onScanRef = useRef(onScan);
  const seq = useRef(0);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  const submit = useCallback((raw: string) => {
    const code = raw.trim();
    if (!code) return;
    setPending((n) => n + 1);
    queue.current = queue.current.then(async () => {
      let result: ScanResult;
      try {
        result = await onScanRef.current(code);
      } catch (err) {
        result = { ok: false, message: err instanceof Error ? err.message : "That scan didn't go through — try again." };
      }
      scanFeedback(result.ok);
      setLast({ ...result, key: ++seq.current });
      setPending((n) => n - 1);
    });
  }, []);

  // Back to the box after each result, unless the person moved to another field on purpose.
  useEffect(() => {
    if (disabled || camera || !last) return;
    const active = document.activeElement;
    if (!active || active === document.body || active === inputRef.current) inputRef.current?.focus();
  }, [last, disabled, camera]);

  const bangla = looksLikeBanglaKeyboard(value);

  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (disabled) return;
          submit(value);
          setValue("");
        }}
      >
        <div className="relative flex-1">
          <ScanBarcode className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            autoFocus={autoFocus}
            disabled={disabled}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            className="h-12 pl-10 font-mono text-base"
            aria-label="Scan or type a tag"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            autoCapitalize="characters"
            enterKeyHint="go"
          />
          {pending > 0 ? <Loader2 className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" /> : null}
        </div>
        <Button type="button" variant={camera ? "secondary" : "outline"} className="h-12 shrink-0 px-3" disabled={disabled} onClick={() => setCamera((c) => !c)} aria-pressed={camera}>
          {camera ? <CameraOff /> : <Camera />}
          <span className="hidden sm:inline">{camera ? "Close camera" : "Camera"}</span>
        </Button>
      </form>
      {bangla ? <p className="text-sm text-amber-700 dark:text-amber-400">The keyboard is on Bangla — switch it to English so the scanner&apos;s code reads right.</p> : null}
      {hint && !last ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {camera && !disabled ? <CameraScanner onCode={submit} /> : null}
      {last ? (
        <div
          key={last.key}
          role={last.ok ? "status" : "alert"}
          className={cn(
            "flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm font-medium animate-in fade-in-0 zoom-in-95",
            last.ok ? "bg-emerald-600/10 text-emerald-800 dark:text-emerald-300" : "border-2 border-destructive bg-destructive/15 text-base text-destructive",
          )}
        >
          {last.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0" /> : <CircleAlert className="mt-0.5 size-5 shrink-0" />}
          <span className="min-w-0">{last.message}</span>
        </div>
      ) : null}
    </div>
  );
}
