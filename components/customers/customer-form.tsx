"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, fetchJson } from "@/lib/customers/client";
import { BD_DIVISIONS, CUSTOMER_TAG_LABELS, CUSTOMER_TAG_VALUES, type CustomerTagValue } from "@/lib/customers/constants";
import { isValidBdPhone } from "@/lib/customers/phone";
import type { CustomerDetail, CustomerListItem } from "@/lib/customers/types";

type CustomerFormValues = {
  name: string;
  phone: string;
  altPhone: string;
  division: string | null;
  district: string;
  thana: string;
  addressDetail: string;
  notes: string;
  tags: CustomerTagValue[];
};

function toFormValues(customer?: CustomerDetail): CustomerFormValues {
  if (!customer) {
    return { name: "", phone: "", altPhone: "", division: null, district: "", thana: "", addressDetail: "", notes: "", tags: [] };
  }
  return {
    name: customer.name,
    phone: customer.phone,
    altPhone: customer.altPhone ?? "",
    division: customer.division,
    district: customer.district ?? "",
    thana: customer.thana ?? "",
    addressDetail: customer.addressDetail ?? "",
    notes: customer.notes ?? "",
    tags: customer.tags,
  };
}

export function CustomerForm({
  customer,
  onSaved,
}: {
  customer?: CustomerDetail;
  onSaved?: (customer: CustomerDetail) => void;
}) {
  const router = useRouter();
  const isEdit = Boolean(customer);
  const [values, setValues] = useState<CustomerFormValues>(toFormValues(customer));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<CustomerListItem | null>(null);
  const [checkingPhone, setCheckingPhone] = useState(false);

  function toggleTag(tag: CustomerTagValue) {
    setValues((prev) => ({
      ...prev,
      tags: prev.tags.includes(tag) ? prev.tags.filter((t) => t !== tag) : [...prev.tags, tag],
    }));
  }

  async function checkDuplicatePhone() {
    if (isEdit || duplicate) return;
    const phone = values.phone.trim();
    if (!isValidBdPhone(phone)) return;

    setCheckingPhone(true);
    try {
      const { items } = await fetchJson<{ items: CustomerListItem[] }>(
        `/api/customers?q=${encodeURIComponent(phone)}&pageSize=5`,
      );
      const digits = phone.replace(/[\s-]/g, "");
      const match = items.find((c) => c.phone.endsWith(digits.slice(-10)));
      setDuplicate(match ?? null);
    } catch {
      // Non-blocking — the create submit still validates uniqueness server-side.
    } finally {
      setCheckingPhone(false);
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    const payload = {
      name: values.name,
      phone: values.phone,
      altPhone: values.altPhone || null,
      division: values.division,
      district: values.district || null,
      thana: values.thana || null,
      addressDetail: values.addressDetail || null,
      notes: values.notes || null,
      tags: values.tags,
    };

    try {
      if (isEdit && customer) {
        const { customer: updated } = await fetchJson<{ customer: CustomerDetail }>(`/api/customers/${customer.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        onSaved?.(updated);
      } else {
        const { customer: created } = await fetchJson<{ customer: CustomerListItem }>("/api/customers", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        router.push(`/customers/${created.id}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save customer.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{isEdit ? "Edit customer" : "New customer"}</CardTitle>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="customer-name">Name</Label>
              <Input id="customer-name" value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="customer-phone">Phone</Label>
              <Input
                id="customer-phone"
                value={values.phone}
                onChange={(e) => {
                  setValues({ ...values, phone: e.target.value });
                  setDuplicate(null);
                }}
                onBlur={checkDuplicatePhone}
                placeholder="017XXXXXXXX"
                inputMode="tel"
                required
              />
              {checkingPhone ? <p className="text-xs text-muted-foreground">Checking...</p> : null}
              {duplicate ? (
                <p className="text-xs text-amber-600">
                  Already a customer:{" "}
                  <Link href={`/customers/${duplicate.id}`} className="underline">
                    {duplicate.name}
                  </Link>
                </p>
              ) : null}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="customer-alt-phone">
                Alternate contact number <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="customer-alt-phone"
                value={values.altPhone}
                onChange={(e) => setValues({ ...values, altPhone: e.target.value })}
                placeholder="017XXXXXXXX"
                inputMode="tel"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Division</Label>
              <Select
                value={values.division ?? "none"}
                onValueChange={(v) => setValues({ ...values, division: v === "none" ? null : (v as string) })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select division" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not set</SelectItem>
                  {BD_DIVISIONS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="customer-district">District</Label>
              <Input id="customer-district" value={values.district} onChange={(e) => setValues({ ...values, district: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="customer-thana">Thana / Upazila</Label>
              <Input id="customer-thana" value={values.thana} onChange={(e) => setValues({ ...values, thana: e.target.value })} />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="customer-address">Address detail</Label>
            <Textarea
              id="customer-address"
              value={values.addressDetail}
              onChange={(e) => setValues({ ...values, addressDetail: e.target.value })}
              rows={2}
              placeholder="House, road, area..."
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="customer-notes">Notes</Label>
            <Textarea
              id="customer-notes"
              value={values.notes}
              onChange={(e) => setValues({ ...values, notes: e.target.value })}
              rows={2}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Tags</Label>
            <div className="flex flex-wrap gap-1.5">
              {CUSTOMER_TAG_VALUES.map((tag) => {
                const selected = values.tags.includes(tag);
                return (
                  <Badge
                    key={tag}
                    variant={selected ? "default" : "outline"}
                    className="cursor-pointer select-none"
                    onClick={() => toggleTag(tag)}
                  >
                    {CUSTOMER_TAG_LABELS[tag]}
                  </Badge>
                );
              })}
            </div>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button type="submit" disabled={saving || !values.name.trim() || !values.phone.trim()}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {isEdit ? "Save changes" : "Create customer"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
