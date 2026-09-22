"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, fetchJson } from "@/lib/orders/client";
import type { OrderDetail, OrderEditRequestView } from "@/lib/orders/types";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// PRD §4.6: past the edit window, an SE's change to items/price/discount/
// delivery charge is queued instead of applied. This banner is the only
// place that pending request is visible — to the requester (informational)
// and to a Team Leader/Admin (who can approve or reject it right here).
export function OrderEditRequestBanner({
  pendingRequest,
  canReview,
  onResolved,
}: {
  pendingRequest: OrderEditRequestView;
  canReview: boolean;
  onResolved: (order: OrderDetail) => void;
}) {
  const [reviewNote, setReviewNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function review(action: "approve" | "reject") {
    setBusy(action);
    setError(null);
    try {
      const result = await fetchJson<{ order?: OrderDetail }>(`/api/order-edit-requests/${pendingRequest.id}`, {
        method: "PATCH",
        body: JSON.stringify({ action, reviewNote: reviewNote.trim() || undefined }),
      });
      if (result.order) onResolved(result.order);
      else window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not review this request.");
    } finally {
      setBusy(null);
    }
  }

  const changes = pendingRequest.proposedChanges as {
    items?: { variantId: string; qty: number; unitPrice: number; lineDiscount: number }[];
    deliveryCharge?: number;
  };

  return (
    <Card className="border-amber-500/50 bg-amber-500/5">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>Edit pending approval</CardTitle>
          <Badge variant="outline" className="border-amber-600 text-amber-700">
            Awaiting Team Leader / Admin
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          {pendingRequest.requestedBy?.name ?? "Someone"} requested this change on {formatDateTime(pendingRequest.createdAt)} — the order&apos;s
          edit window had already passed, so it needs approval before it applies.
        </p>
        <ul className="list-inside list-disc text-muted-foreground">
          {changes.items ? <li>Items: proposes {changes.items.length} line(s)</li> : null}
          {changes.deliveryCharge !== undefined ? <li>Delivery charge change</li> : null}
        </ul>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Full proposed change</summary>
          <pre className="mt-2 overflow-x-auto rounded bg-muted p-2">{JSON.stringify(pendingRequest.proposedChanges, null, 2)}</pre>
        </details>

        {canReview ? (
          <div className="flex flex-col gap-2 border-t pt-3">
            <Textarea placeholder="Review note (optional)" value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} rows={2} />
            {error ? <p className="text-destructive">{error}</p> : null}
            <div className="flex gap-2">
              <Button onClick={() => review("approve")} disabled={busy !== null}>
                {busy === "approve" ? <Loader2 className="animate-spin" /> : null}
                Approve &amp; apply
              </Button>
              <Button variant="outline" onClick={() => review("reject")} disabled={busy !== null}>
                {busy === "reject" ? <Loader2 className="animate-spin" /> : null}
                Reject
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
