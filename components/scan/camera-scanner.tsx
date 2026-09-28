"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

/**
 * C4 — the phone camera as a fallback scanner. Reads the Code 128 on a
 * price tag (lib/barcode/code128.ts) and hands the text to `onCode`,
 * exactly like a handheld scanner typing it. The decoder (@zxing, pure JS —
 * iOS Safari has no BarcodeDetector) loads only when the camera is opened.
 * The same tag held in front of the lens is read once, not every frame.
 */
export function CameraScanner({ onCode }: { onCode: (code: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onCodeRef = useRef(onCode);
  const [state, setState] = useState<"starting" | "live" | "error">("starting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onCodeRef.current = onCode;
  }, [onCode]);

  useEffect(() => {
    let stopped = false;
    let controls: { stop: () => void } | null = null;
    let last = { code: "", at: 0 };

    (async () => {
      const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
      if (!md || typeof md.getUserMedia !== "function") {
        setState("error");
        setError(
          typeof window !== "undefined" && !window.isSecureContext
            ? "The camera only works over a secure (https) link. Use the scanner, or type the SKU."
            : "This browser can't use the camera. Use the scanner, or type the SKU.",
        );
        return;
      }
      try {
        const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import("@zxing/browser"), import("@zxing/library")]);
        if (stopped || !videoRef.current) return;
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128]);
        const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 120 });
        controls = await reader.decodeFromConstraints({ video: { facingMode: { ideal: "environment" } }, audio: false }, videoRef.current, (result) => {
          if (!result) return;
          const code = result.getText();
          const now = Date.now();
          // The same tag stays in view for a while — wait till it's moved away (or 2 s).
          if (code === last.code && now - last.at < 2000) {
            last.at = now;
            return;
          }
          if (now - last.at < 700) return;
          last = { code, at: now };
          onCodeRef.current(code);
        });
        if (stopped) controls.stop();
        else setState("live");
      } catch (err) {
        if (stopped) return;
        setState("error");
        const name = (err as { name?: string })?.name;
        setError(
          name === "NotAllowedError"
            ? "Camera permission was refused. Allow the camera for this site in the browser settings, or use the scanner."
            : name === "NotFoundError"
              ? "No camera found on this device."
              : "Couldn't start the camera. Use the scanner, or type the SKU.",
        );
      }
    })();

    return () => {
      stopped = true;
      controls?.stop();
    };
  }, []);

  return (
    <div className="relative overflow-hidden rounded-xl border bg-black">
      {/* playsInline + muted: iOS Safari won't play a camera feed inline otherwise. */}
      <video ref={videoRef} className="aspect-[4/3] w-full object-cover" playsInline muted autoPlay />
      {state === "live" ? <div className="pointer-events-none absolute inset-x-8 top-1/2 h-0.5 -translate-y-1/2 bg-red-500/80 shadow-[0_0_8px_rgba(239,68,68,0.9)]" /> : null}
      {state === "starting" ? (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/80">
          <Loader2 className="size-4 animate-spin" /> Starting the camera…
        </div>
      ) : null}
      {state === "error" ? <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-white">{error}</div> : null}
      {state === "live" ? <p className="absolute inset-x-0 bottom-0 bg-black/50 px-3 py-1.5 text-center text-xs text-white">Hold the tag&apos;s barcode across the red line</p> : null}
    </div>
  );
}
