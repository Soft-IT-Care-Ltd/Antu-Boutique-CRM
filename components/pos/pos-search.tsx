"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Layers, Loader2, ScanBarcode } from "lucide-react";

import { Input } from "@/components/ui/input";
import { looksLikeBanglaKeyboard, normalizeScannedCode } from "@/lib/barcode/scan";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import type { PosVariantHit } from "@/lib/pos/types";
import type { SetListItem } from "@/lib/sets/types";

export type PosSearchHandle = { focus: () => void };

/**
 * PRD §4.7 — one box for both ways staff find an item:
 *  - a scanner types the tag's SKU and presses Enter → exact SKU lookup
 *  - a person types a name/code/SKU → type-ahead list, ↑/↓ + Enter or tap
 * Enter always tries the exact code first, so a scan never picks a
 * look-alike from the type-ahead list.
 */
export const PosSearch = forwardRef<PosSearchHandle, { onAdd: (hit: PosVariantHit) => void; onAddSet?: (set: SetListItem) => void; showroomName: string }>(function PosSearch({ onAdd, onAddSet, showroomName }, ref) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  // The list, and the exact text it was fetched for.
  const [results, setResults] = useState<{ term: string; hits: PosVariantHit[]; sets: SetListItem[] }>({ term: "", hits: [], sets: [] });
  const [highlight, setHighlight] = useState(0);
  const [open, setOpen] = useState(false);
  // Set once the user picks a line with ↑/↓ — a scanner never does, so Enter
  // then means "that line", with no SKU lookup first.
  const [navigated, setNavigated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Only the newest request may update the list (typing outruns the network).
  const requestSeq = useRef(0);

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  // Only a list fetched for what's in the box now is offered. A scanner types
  // faster than the search answers, so an unknown scanned code must never
  // fall back to a list fetched for a prefix of it.
  const listed = results.term === query.trim() ? results.hits : [];
  // P3.3 — outfit sets matching the name; their sizes/colours are picked next.
  const listedSets = results.term === query.trim() && onAddSet ? results.sets : [];

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) return;
    const seq = ++requestSeq.current;
    const timer = setTimeout(() => {
      fetchJson<{ variants: PosVariantHit[]; sets: SetListItem[] }>(`/api/pos/search?q=${encodeURIComponent(term)}`)
        .then((data) => {
          if (seq !== requestSeq.current) return;
          setResults({ term, hits: data.variants, sets: data.sets ?? [] });
          setHighlight(0);
          setOpen(true);
        })
        .catch(() => {});
    }, 180);
    return () => clearTimeout(timer);
  }, [query]);

  // C3 (CORRECTIONS.md item 11): an item the showroom shows as 0 can still
  // be sold — it's in hand — so it's added with a warning, never refused.
  function add(hit: PosVariantHit) {
    onAdd(hit);
    requestSeq.current += 1;
    setQuery("");
    setNavigated(false);
    setResults({ term: "", hits: [], sets: [] });
    setOpen(false);
    setMessage(null);
    inputRef.current?.focus();
  }

  async function submit() {
    const raw = query;
    if (!raw.trim()) return;
    if (looksLikeBanglaKeyboard(raw)) {
      setMessage("The keyboard is typing Bangla — switch it to English and scan again.");
      setQuery("");
      return;
    }
    const chosen = navigated && open ? listed[highlight] : undefined;
    if (chosen) {
      add(chosen);
      return;
    }
    const code = normalizeScannedCode(raw);
    if (code) {
      setBusy(true);
      try {
        const { variant } = await fetchJson<{ variant: PosVariantHit | null }>(`/api/pos/lookup?code=${encodeURIComponent(code)}`);
        if (variant) {
          add(variant);
          return;
        }
      } catch (err) {
        setMessage(err instanceof ApiError ? err.message : "Lookup failed — check the connection.");
        return;
      } finally {
        setBusy(false);
      }
    }
    const picked = listed[highlight];
    if (open && picked) add(picked);
    else setMessage(`Nothing matches “${raw.trim()}”.`);
  }

  return (
    <div className="relative">
      <div className="relative">
        <ScanBarcode className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          autoFocus
          value={query}
          inputMode="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label="Scan a tag or search products"
          placeholder="Scan a tag, or type a name / SKU…   (F2)"
          className="h-12 pl-11 text-base md:text-base"
          onChange={(e) => {
            setQuery(e.target.value);
            setNavigated(false);
            setMessage(null);
          }}
          onFocus={() => listed.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            } else if (e.key === "ArrowDown" && listed.length > 0) {
              e.preventDefault();
              setOpen(true);
              setNavigated(true);
              setHighlight((h) => Math.min(listed.length - 1, h + 1));
            } else if (e.key === "ArrowUp" && listed.length > 0) {
              e.preventDefault();
              setNavigated(true);
              setHighlight((h) => Math.max(0, h - 1));
            } else if (e.key === "Escape") {
              setQuery("");
              setOpen(false);
              setMessage(null);
            }
          }}
        />
        {busy ? <Loader2 className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" /> : null}
      </div>
      {message ? <p className="pt-1.5 text-sm text-destructive">{message}</p> : null}

      {open && listed.length + listedSets.length > 0 ? (
        <div role="listbox" className="absolute z-30 mt-1 max-h-[22rem] w-full overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg">
          {listedSets.map((set) => (
            <button
              key={set.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onAddSet?.(set);
                requestSeq.current += 1;
                setQuery("");
                setResults({ term: "", hits: [], sets: [] });
                setOpen(false);
              }}
              className="flex min-h-12 w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left hover:bg-muted"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Layers className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{set.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">Outfit set · {set.components.map((c) => c.productName).join(" + ")}</span>
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-sm font-semibold tabular-nums">{formatBDT(set.price)}</span>
                <span className={`block text-xs ${set.availableSets <= 0 ? "text-destructive" : "text-muted-foreground"}`}>{set.availableSets > 0 ? `${set.availableSets} available` : "none available"}</span>
              </span>
            </button>
          ))}
          {listed.map((hit, index) => {
            const out = hit.available <= 0;
            return (
              <button
                key={hit.variantId}
                type="button"
                role="option"
                aria-selected={index === highlight}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(hit)}
                onMouseEnter={() => setHighlight(index)}
                className={`flex min-h-12 w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left ${index === highlight ? "bg-muted" : ""}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="size-3.5 shrink-0 rounded-full border" style={{ backgroundColor: hit.colorHex }} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{hit.productName}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      <b className="text-foreground">{hit.sizeName}</b> · {hit.colorName} · <span className="font-mono">{hit.sku}</span>
                    </span>
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-semibold tabular-nums">{formatBDT(hit.price)}</span>
                  <span className={`block text-xs ${out ? "text-destructive" : "text-muted-foreground"}`}>{out ? `0 at ${showroomName}` : `${hit.available} at ${showroomName}`}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
});
