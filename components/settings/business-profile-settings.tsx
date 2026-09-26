"use client";

import { useRef, useState } from "react";
import { ImageUp, Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, fetchJson } from "@/lib/orders/client";
import type { BusinessProfile, BusinessProfileInput } from "@/lib/settings/business-profile-shape";

const fieldsOf = (p: BusinessProfile): BusinessProfileInput => ({ name: p.name, tagline: p.tagline, address: p.address, phone: p.phone, email: p.email, invoiceFooter: p.invoiceFooter });

// PRD §4.17 business profile: name, logo, address, phone, invoice footer.
// Printed on documents generated from now on; invoices already made keep
// what they printed.
export function BusinessProfileSettings({ initial }: { initial: BusinessProfile }) {
  const [form, setForm] = useState<BusinessProfileInput>(fieldsOf(initial));
  const [saved, setSaved] = useState<BusinessProfileInput>(fieldsOf(initial));
  const [logoPath, setLogoPath] = useState(initial.logoPath);
  const [busy, setBusy] = useState<"save" | "logo" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirty = (Object.keys(form) as (keyof BusinessProfileInput)[]).some((k) => form[k] !== saved[k]);
  const set = (key: keyof BusinessProfileInput) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  async function save() {
    setBusy("save");
    setMessage(null);
    try {
      const { profile } = await fetchJson<{ profile: BusinessProfile }>("/api/settings/business-profile", { method: "PUT", body: JSON.stringify(form) });
      const next = fieldsOf(profile);
      setSaved(next);
      setForm(next);
      setMessage({ ok: true, text: "Saved — new invoices, packing slips and receipts use it." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Could not save." });
    } finally {
      setBusy(null);
    }
  }

  async function uploadLogo(file: File) {
    setBusy("logo");
    setMessage(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetchJson<{ logoPath: string }>("/api/settings/business-profile/logo", { method: "POST", body });
      setLogoPath(res.logoPath);
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Could not upload the logo." });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removeLogo() {
    setBusy("logo");
    setMessage(null);
    try {
      await fetchJson("/api/settings/business-profile/logo", { method: "DELETE" });
      setLogoPath(null);
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Could not remove the logo." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Business profile</CardTitle>
        <CardDescription>Bangla is fine in every field — the PDFs embed a Bangla font.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label>Logo</Label>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex h-16 w-40 items-center justify-center overflow-hidden rounded-md border bg-white">
              {logoPath ? (
                // eslint-disable-next-line @next/next/no-img-element -- served by the auth-checked uploads route, not next/image
                <img src={`/uploads/${logoPath}`} alt="Business logo" className="max-h-14 max-w-36 object-contain" />
              ) : (
                <span className="text-xs text-muted-foreground">No logo</span>
              )}
            </div>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && uploadLogo(e.target.files[0])} />
            <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={busy !== null}>
              {busy === "logo" ? <Loader2 className="animate-spin" /> : <ImageUp />}
              {logoPath ? "Replace" : "Upload"}
            </Button>
            {logoPath ? (
              <Button size="sm" variant="ghost" onClick={removeLogo} disabled={busy !== null}>
                <Trash2 />
                Remove
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">PNG with a transparent background prints best. It is printed in black and white on the 80 mm receipt.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bp-name">Business name</Label>
            <Input id="bp-name" value={form.name} maxLength={80} onChange={set("name")} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bp-tagline">Tagline</Label>
            <Input id="bp-tagline" value={form.tagline} maxLength={120} onChange={set("tagline")} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bp-phone">Phone</Label>
            <Input id="bp-phone" type="tel" value={form.phone} maxLength={60} onChange={set("phone")} placeholder="01XXXXXXXXX" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bp-email">Email</Label>
            <Input id="bp-email" type="email" value={form.email} maxLength={120} onChange={set("email")} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bp-address">Address</Label>
          <Textarea id="bp-address" rows={2} value={form.address} maxLength={300} onChange={set("address")} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bp-footer">Invoice footer</Label>
          <Textarea id="bp-footer" rows={2} value={form.invoiceFooter} maxLength={300} onChange={set("invoiceFooter")} />
          <p className="text-xs text-muted-foreground">The thank-you line at the foot of the invoice and the showroom receipt.</p>
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={save} disabled={busy !== null || !dirty || form.name.trim().length < 2}>
            {busy === "save" ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
          {message ? <p className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>{message.text}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}
