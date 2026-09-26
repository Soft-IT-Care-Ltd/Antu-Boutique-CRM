"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Pencil, Phone, ShoppingBag, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CustomerForm } from "@/components/customers/customer-form";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/customers/client";
import { CUSTOMER_TAG_LABELS, type CustomerTagValue } from "@/lib/customers/constants";
import type { CustomerDetail as CustomerDetailType } from "@/lib/customers/types";

const TAG_VARIANT: Record<CustomerTagValue, "default" | "secondary" | "destructive"> = {
  VIP: "default",
  WHOLESALE: "secondary",
  PROBLEM_CUSTOMER: "destructive",
};

export function CustomerDetail({
  customer: initialCustomer,
  canEdit,
  canDelete,
}: {
  customer: CustomerDetailType;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [customer, setCustomer] = useState(initialCustomer);
  const [editing, setEditing] = useState(false);
  const [trashDialogOpen, setTrashDialogOpen] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);

  async function handleTrash() {
    setTrashError(null);
    try {
      await fetchJson(`/api/customers/${customer.id}`, { method: "DELETE" });
      router.push("/customers");
    } catch (err) {
      setTrashError(err instanceof ApiError ? err.message : "Could not move customer to trash.");
    }
  }

  if (editing) {
    return (
      <CustomerForm
        customer={customer}
        onSaved={(updated) => {
          setCustomer(updated);
          setEditing(false);
        }}
      />
    );
  }

  const address = [customer.addressDetail, customer.thana, customer.district, customer.division].filter(Boolean).join(", ");

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-xl">{customer.name}</CardTitle>
              {customer.stats.riskFlag ? (
                <Badge variant="destructive" className="gap-1">
                  <AlertTriangle className="size-3" />
                  Risk
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
              <Phone className="size-3.5" />
              {customer.phone}
              {customer.altPhone ? ` · alt ${customer.altPhone}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 gap-1.5">
            {canEdit ? (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil />
                Edit
              </Button>
            ) : null}
            {canDelete ? (
              <AlertDialog
                open={trashDialogOpen}
                onOpenChange={(open) => {
                  setTrashDialogOpen(open);
                  if (open) setTrashError(null);
                }}
              >
                <AlertDialogTrigger render={<Button variant="destructive" size="sm" />}>
                  <Trash2 />
                  Delete
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Move &quot;{customer.name}&quot; to trash?</AlertDialogTitle>
                    <AlertDialogDescription>
                      It can be restored from the Trash for 30 days. After that it is deleted — or, if they have orders, kept for the records but no longer restorable. A new order on their number brings them back.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  {trashError ? <p className="text-sm text-destructive">{trashError}</p> : null}
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleTrash}>Move to trash</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {address ? <p className="text-sm text-muted-foreground">{address}</p> : null}
          {customer.notes ? <p className="text-sm">{customer.notes}</p> : null}
          {customer.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {customer.tags.map((tag) => (
                <Badge key={tag} variant={TAG_VARIANT[tag]}>
                  {CUSTOMER_TAG_LABELS[tag]}
                </Badge>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Customer profile</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Lifetime orders" value={String(customer.stats.lifetimeOrders)} />
            <Stat label="Lifetime value" value={formatBDT(customer.stats.lifetimeValue)} />
            <Stat label="Returns/exchanges" value={String(customer.stats.returnsExchangesCount)} />
            <Stat label="Avg. order value" value={formatBDT(customer.stats.averageOrderValue)} />
            <Stat
              label="Last order"
              value={customer.stats.lastOrderDate ? new Date(customer.stats.lastOrderDate).toLocaleDateString("en-GB") : "—"}
            />
            <Stat
              label="Refused COD"
              value={String(customer.stats.refusedCodCount)}
              highlight={customer.stats.riskFlag}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Order history</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
            <ShoppingBag className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">No orders yet</p>
            <p className="text-sm text-muted-foreground">Orders placed by this customer will appear here.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-sm font-medium ${highlight ? "text-destructive" : ""}`}>{value}</p>
    </div>
  );
}
