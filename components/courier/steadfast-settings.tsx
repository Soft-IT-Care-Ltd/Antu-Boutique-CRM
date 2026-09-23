"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, KeyRound, Loader2, PlugZap, RefreshCw, RotateCw, Wallet } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import type { SteadfastSettingsView } from "@/lib/courier/integration";
import type { CostRateView } from "@/lib/courier/types";
import { formatDhakaDateTime } from "@/lib/inventory/constants";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { DELIVERY_ZONE_LABELS } from "@/lib/orders/constants";

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="outline"
      title="Copy"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

const when = (iso: string | null) => (iso ? formatDhakaDateTime(iso) : "Never");

// The Courier page's Steadfast panel (STEADFAST_INTEGRATION.md §1/§3A, moved
// from Settings per CORRECTIONS Courier §2). Keys are write-only: the server
// only ever returns them masked.
export function SteadfastSettings({ canEditSettings, canManage, canSeeCost }: { canEditSettings: boolean; canManage: boolean; canSeeCost: boolean }) {
  const [view, setView] = useState<SteadfastSettingsView | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [pollingMinutes, setPollingMinutes] = useState("15");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    fetchJson<SteadfastSettingsView>("/api/courier/steadfast/settings")
      .then((data) => {
        setView(data);
        setPollingMinutes(String(data.pollingMinutes));
      })
      .catch((err) => setNotice({ tone: "error", text: err instanceof ApiError ? err.message : "Could not load Steadfast settings." }));
  }, []);

  async function run<T>(key: string, fn: () => Promise<T>, onOk: (result: T) => void) {
    setBusy(key);
    setNotice(null);
    try {
      onOk(await fn());
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof ApiError ? err.message : "Something went wrong." });
    } finally {
      setBusy(null);
    }
  }

  const save = (body: Record<string, unknown>, done: string) =>
    run("save", () => fetchJson<SteadfastSettingsView>("/api/courier/steadfast/settings", { method: "PUT", body: JSON.stringify(body) }), (data) => {
      setView(data);
      setApiKey("");
      setSecretKey("");
      setNotice({ tone: "ok", text: done });
    });

  const testConnection = () =>
    run("test", () => fetchJson<{ ok: boolean; balance?: number; error?: string }>("/api/courier/steadfast/test", { method: "POST" }), (res) => {
      if (res.ok) {
        setNotice({ tone: "ok", text: `Connected ✓ — current balance ${formatBDT(res.balance ?? 0)}` });
        setView((v) => (v ? { ...v, connectedAt: new Date().toISOString(), lastBalance: String(res.balance ?? 0), lastBalanceAt: new Date().toISOString() } : v));
      } else {
        setNotice({ tone: "error", text: `Connection failed: ${res.error}` });
      }
    });

  const refreshBalance = () =>
    run("balance", () => fetchJson<{ ok: boolean; balance?: number; error?: string }>("/api/courier/steadfast/balance"), (res) => {
      if (res.ok) setView((v) => (v ? { ...v, lastBalance: String(res.balance ?? 0), lastBalanceAt: new Date().toISOString() } : v));
      else setNotice({ tone: "error", text: `Balance: ${res.error}` });
    });

  const regenerateToken = () =>
    run("token", () => fetchJson<SteadfastSettingsView>("/api/courier/steadfast/webhook-token", { method: "POST" }), (data) => {
      setView(data);
      setNotice({ tone: "ok", text: "New webhook token generated — copy it into the Steadfast panel now. It won't be shown again." });
    });

  const syncNow = () =>
    run("sync", () => fetchJson<{ polled: number; changed: number; errors: { orderNo: string; error: string }[] }>("/api/courier/steadfast/sync", { method: "POST", body: "{}" }), (res) => {
      setView((v) => (v ? { ...v, lastSyncAt: new Date().toISOString() } : v));
      setNotice({
        tone: res.errors.length ? "error" : "ok",
        text: `Checked ${res.polled} parcel${res.polled === 1 ? "" : "s"}, ${res.changed} changed${res.errors.length ? ` · ${res.errors.length} failed (${res.errors[0].orderNo}: ${res.errors[0].error})` : ""}`,
      });
    });

  if (!view) {
    return notice ? <p className="text-sm text-destructive">{notice.text}</p> : <Skeleton className="h-96 w-full" />;
  }

  return (
    <div className="flex flex-col gap-4">
      {!view.liveApiEnabled ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <p>
            <span className="font-medium">Booking and status sync are switched off on this server.</span> Only Test Connection and the balance reach
            Steadfast. Production sets <code className="font-mono">STEADFAST_LIVE_API=enabled</code> to allow real consignments.
          </p>
        </div>
      ) : null}

      {notice ? <p className={`text-sm ${notice.tone === "ok" ? "text-emerald-600" : "text-destructive"}`}>{notice.text}</p> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="size-4" /> API credentials
            </CardTitle>
            <CardDescription>Encrypted at rest. Saved keys are never shown again — only their last characters.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={view.isEnabled ? "default" : "outline"}>{view.isEnabled ? "Enabled" : "Disabled"}</Badge>
              <Badge variant={view.connectedAt ? "secondary" : "outline"}>{view.connectedAt ? `Connected ${when(view.connectedAt)}` : "Not tested"}</Badge>
            </div>
            {canEditSettings ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="sf-api-key">API key</Label>
                  <Input id="sf-api-key" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={view.apiKeyMasked ?? "Not set"} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="sf-secret-key">Secret key</Label>
                  <Input
                    id="sf-secret-key"
                    type="password"
                    autoComplete="new-password"
                    value={secretKey}
                    onChange={(e) => setSecretKey(e.target.value)}
                    placeholder={view.secretKeyMasked ?? "Not set"}
                  />
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="sf-poll">Poll every (minutes)</Label>
                    <Input id="sf-poll" type="number" min={5} max={1440} className="w-28" value={pollingMinutes} onChange={(e) => setPollingMinutes(e.target.value)} />
                  </div>
                  <Button
                    disabled={busy !== null}
                    onClick={() =>
                      save(
                        { ...(apiKey.trim() ? { apiKey } : {}), ...(secretKey.trim() ? { secretKey } : {}), pollingMinutes: Number(pollingMinutes) || 15 },
                        "Saved.",
                      )
                    }
                  >
                    {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : null}
                    Save
                  </Button>
                </div>
                <label className="flex items-center gap-2">
                  <Switch
                    checked={view.isEnabled}
                    disabled={busy !== null || !view.configured}
                    onCheckedChange={(checked) => save({ isEnabled: checked }, checked ? "Integration enabled." : "Integration disabled.")}
                  />
                  Integration enabled {view.configured ? "" : <span className="text-xs text-muted-foreground">(save both keys first)</span>}
                </label>
              </>
            ) : (
              <div className="grid grid-cols-2 gap-1">
                <span className="text-muted-foreground">API key</span>
                <span className="font-mono">{view.apiKeyMasked ?? "Not set"}</span>
                <span className="text-muted-foreground">Secret key</span>
                <span className="font-mono">{view.secretKeyMasked ?? "Not set"}</span>
              </div>
            )}
            {canManage ? (
              <Button variant="outline" className="w-fit" disabled={busy !== null || !view.configured} onClick={testConnection}>
                {busy === "test" ? <Loader2 className="size-4 animate-spin" /> : <PlugZap />}
                Test connection
              </Button>
            ) : null}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Wallet className="size-4" /> Steadfast balance
              </CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-between gap-3">
              <div>
                <div className="text-2xl font-semibold">{view.lastBalance !== null ? formatBDT(view.lastBalance) : "—"}</div>
                <div className="text-xs text-muted-foreground">As of {when(view.lastBalanceAt)}</div>
              </div>
              {canManage ? (
                <Button size="icon-sm" variant="outline" title="Refresh balance" disabled={busy !== null || !view.configured} onClick={refreshBalance}>
                  {busy === "balance" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                </Button>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Status sync</CardTitle>
              <CardDescription>Webhook first; a {view.pollingMinutes}-minute poll catches anything missed.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Last webhook received</span>
                <span>{when(view.lastWebhookAt)}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Last sync</span>
                <span>{when(view.lastSyncAt)}</span>
              </div>
              {canManage ? (
                <Button variant="outline" className="w-fit" disabled={busy !== null || !view.isEnabled} onClick={syncNow}>
                  {busy === "sync" ? <Loader2 className="size-4 animate-spin" /> : <RotateCw />}
                  Sync now
                </Button>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Webhook</CardTitle>
          <CardDescription>In the Steadfast panel → Webhook Integration, paste this callback URL and the Bearer token.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="flex flex-col gap-1.5">
            <Label>Callback URL</Label>
            <div className="flex gap-2">
              <Input readOnly value={view.callbackUrl} className="font-mono text-xs" />
              <CopyButton value={view.callbackUrl} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Auth token (Bearer)</Label>
            {view.webhookTokenPlain ? (
              <>
                <div className="flex gap-2">
                  <Input readOnly value={view.webhookTokenPlain} className="font-mono text-xs" />
                  <CopyButton value={view.webhookTokenPlain} />
                </div>
                <p className="text-xs text-amber-600">Shown once. Copy it now — after you leave this page only the masked form is available.</p>
              </>
            ) : (
              <div className="font-mono text-xs">{view.webhookTokenMasked ?? "No token yet"}</div>
            )}
          </div>
          {canEditSettings ? (
            <Button variant="outline" className="w-fit" disabled={busy !== null} onClick={regenerateToken}>
              {busy === "token" ? <Loader2 className="size-4 animate-spin" /> : <KeyRound />}
              {view.hasWebhookToken ? "Regenerate token" : "Generate token"}
            </Button>
          ) : null}
          {view.hasWebhookToken && canEditSettings ? (
            <p className="text-xs text-muted-foreground">Regenerating stops the old token working immediately — update Steadfast right after.</p>
          ) : null}
        </CardContent>
      </Card>

      {canManage && canSeeCost ? <CostRatesCard /> : null}
    </div>
  );
}

function CostRatesCard() {
  const [rates, setRates] = useState<CostRateView[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    fetchJson<{ rates: CostRateView[] }>("/api/courier/cost-rates")
      .then((data) => setRates(data.rates))
      .catch((err) => setNotice({ tone: "error", text: err instanceof ApiError ? err.message : "Could not load rates." }));
  }, []);

  async function save() {
    if (!rates) return;
    setSaving(true);
    setNotice(null);
    try {
      await fetchJson("/api/courier/cost-rates", {
        method: "PUT",
        body: JSON.stringify({ rates: rates.map((r) => ({ zone: r.zone, baseRate: Number(r.baseRate || 0), perKgRate: Number(r.perKgRate || 0) })) }),
      });
      setNotice({ tone: "ok", text: "Rates saved." });
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof ApiError ? err.message : "Could not save rates." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Courier cost rates</CardTitle>
        <CardDescription>
          What Steadfast charges <span className="font-medium">us</span> per parcel — separate from the delivery charge on the customer&apos;s order. Base covers
          the first kg; each extra started kg adds the per-kg rate. The courier&apos;s actual charge (from the webhook) replaces this estimate in P&amp;L.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!rates ? (
          <Skeleton className="h-28 w-full" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            {rates.map((r, idx) => (
              <div key={r.zone} className="flex flex-col gap-2 rounded-lg border p-3">
                <div className="text-sm font-medium">{DELIVERY_ZONE_LABELS[r.zone]}</div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`rate-base-${r.zone}`} className="text-xs">
                      Base (≤1 kg)
                    </Label>
                    <Input
                      id={`rate-base-${r.zone}`}
                      type="number"
                      min={0}
                      step="0.01"
                      value={r.baseRate ?? ""}
                      onChange={(e) => setRates((prev) => prev!.map((x, i) => (i === idx ? { ...x, baseRate: e.target.value } : x)))}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`rate-kg-${r.zone}`} className="text-xs">
                      Per extra kg
                    </Label>
                    <Input
                      id={`rate-kg-${r.zone}`}
                      type="number"
                      min={0}
                      step="0.01"
                      value={r.perKgRate ?? ""}
                      onChange={(e) => setRates((prev) => prev!.map((x, i) => (i === idx ? { ...x, perKgRate: e.target.value } : x)))}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        {notice ? <p className={`text-sm ${notice.tone === "ok" ? "text-emerald-600" : "text-destructive"}`}>{notice.text}</p> : null}
        <Button className="w-fit" onClick={save} disabled={saving || !rates}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          Save rates
        </Button>
      </CardContent>
    </Card>
  );
}
