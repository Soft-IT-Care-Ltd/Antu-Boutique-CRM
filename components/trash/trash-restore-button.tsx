"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { TrashKind } from "@/lib/trash/policy";

// Each kind is restored through its own module's route (same permission as
// deleting it), so the Trash screen adds no second way in.
const RESTORE_URL: Record<TrashKind, (id: string) => string> = {
  order: (id) => `/api/orders/${id}/restore`,
  customer: (id) => `/api/customers/${id}/restore`,
  product: (id) => `/api/catalog/products/${id}/restore`,
  lead: (id) => `/api/leads/${id}/restore`,
};

const OPEN_URL: Record<TrashKind, (id: string) => string> = {
  order: (id) => `/orders/${id}`,
  customer: (id) => `/customers/${id}`,
  product: (id) => `/catalog/products/${id}`,
  lead: (id) => `/leads/${id}`,
};

export function TrashRestoreButton({ kind, id }: { kind: TrashKind; id: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    setState("busy");
    setError(null);
    try {
      const res = await fetch(RESTORE_URL[kind](id), { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Could not restore it.");
      }
      setState("done");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not restore it.");
      setState("idle");
    }
  }

  if (state === "done") {
    return (
      <Button variant="outline" size="sm" render={<Link href={OPEN_URL[kind](id)} />} nativeButton={false}>
        Restored — open
      </Button>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="sm" onClick={restore} disabled={state === "busy"}>
        {state === "busy" ? <Loader2 className="animate-spin" /> : <RotateCcw />}
        Restore
      </Button>
      {error ? <p className="max-w-56 text-right text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
