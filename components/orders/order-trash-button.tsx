"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ApiError, fetchJson } from "@/lib/orders/client";

// PRD §4.18 — moves a never-confirmed or cancelled order to the trash. The
// server re-checks that no money, stock or courier history hangs off it
// (lib/trash/policy.ts) and says why when something does.
export function OrderTrashButton({ orderId, orderNo }: { orderId: string; orderNo: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleTrash() {
    setBusy(true);
    setError(null);
    try {
      await fetchJson(`/api/orders/${orderId}`, { method: "DELETE" });
      router.push("/orders");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not move the order to the trash.");
      setBusy(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setError(null);
      }}
    >
      <AlertDialogTrigger render={<Button variant="outline" className="text-destructive" />}>
        <Trash2 />
        Delete
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Move {orderNo} to the trash?</AlertDialogTitle>
          <AlertDialogDescription>It can be restored from the Trash for 30 days, then it is deleted for good along with its photos.</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
          <Button variant="destructive" onClick={handleTrash} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Move to trash
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
