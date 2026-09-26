"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PERMISSIONS, ROLE_TEMPLATES, type PermissionKey } from "@/lib/auth/permission-definitions";
import { ApiError, fetchJson } from "@/lib/orders/client";
import type { RoleView } from "@/lib/settings/staff";

const GROUPS = [...new Set(PERMISSIONS.map((p) => p.group))];

// The permissions that decide whether a role sees money it shouldn't —
// flagged so turning one on is a deliberate act (PRD §3: an SE never sees
// cost or profit; Packing sees no customer money).
const SENSITIVE = new Set<PermissionKey>(["product.cost.view", "report.pl.view", "permission.manage", "settings.manage", "audit.view", "order.view_all", "payment.view", "wallet.view"]);

// PRD §4.17 "roles and permissions" — each role's template, edited one role
// at a time. Saved to the database, which is what every request reads; the
// server refuses a change that would leave nobody able to run Settings.
export function RolesSettings({ initialRoles }: { initialRoles: RoleView[] }) {
  const router = useRouter();
  const [roles, setRoles] = useState(initialRoles);
  const [roleId, setRoleId] = useState(initialRoles[0]?.id ?? "");
  const role = roles.find((r) => r.id === roleId) ?? roles[0];
  const [draft, setDraft] = useState<Set<PermissionKey>>(() => new Set(role?.keys ?? []));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const saved = useMemo(() => new Set(role?.keys ?? []), [role]);
  const added = [...draft].filter((k) => !saved.has(k));
  const removed = [...saved].filter((k) => !draft.has(k));
  const dirty = added.length + removed.length > 0;
  const template = role ? new Set<PermissionKey>(ROLE_TEMPLATES[role.name]) : new Set<PermissionKey>();
  const matchesTemplate = template.size === draft.size && [...draft].every((k) => template.has(k));

  function pick(id: string) {
    const next = roles.find((r) => r.id === id);
    if (!next) return;
    setRoleId(id);
    setDraft(new Set(next.keys));
    setMessage(null);
  }

  function toggle(key: PermissionKey, on: boolean) {
    const next = new Set(draft);
    if (on) next.add(key);
    else next.delete(key);
    setDraft(next);
  }

  async function save() {
    if (!role) return;
    setSaving(true);
    setMessage(null);
    try {
      await fetchJson(`/api/settings/roles/${role.id}`, { method: "PUT", body: JSON.stringify({ keys: [...draft] }) });
      setRoles(roles.map((r) => (r.id === role.id ? { ...r, keys: [...draft] } : r)));
      setMessage({ ok: true, text: `Saved — ${role.activeUsers} ${role.activeUsers === 1 ? "person has" : "people have"} the new set from their next click.` });
      router.refresh();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Could not save." });
    } finally {
      setSaving(false);
    }
  }

  if (!role) return <p className="text-sm text-muted-foreground">No roles yet — run the seed.</p>;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{role.label}</CardTitle>
        <CardDescription>
          {role.activeUsers} active {role.activeUsers === 1 ? "person" : "people"} · {draft.size} of {PERMISSIONS.length} permissions
          {matchesTemplate ? " · the starting template" : " · changed from the starting template"}
        </CardDescription>
        <CardAction>
          <Select value={role.id} onValueChange={(v) => pick(v as string)}>
            <SelectTrigger className="w-44 sm:w-56" aria-label="Role">
              <SelectValue>{(v: string) => roles.find((r) => r.id === v)?.label ?? "Role"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {roles.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-5 lg:grid-cols-2">
          {GROUPS.map((group) => (
            <fieldset key={group} className="flex flex-col gap-1">
              <legend className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{group}</legend>
              {PERMISSIONS.filter((p) => p.group === group).map((p) => {
                const on = draft.has(p.key);
                const changed = on !== saved.has(p.key);
                return (
                  <label key={p.key} className={`flex items-start gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50 ${changed ? "bg-amber-500/10" : ""}`}>
                    <Checkbox className="mt-0.5" checked={on} onCheckedChange={(v) => toggle(p.key, v === true)} />
                    <span className="flex-1">
                      {p.label}
                      {SENSITIVE.has(p.key) ? (
                        <Badge variant="outline" className="ml-2 align-middle">
                          sensitive
                        </Badge>
                      ) : null}
                      <span className="block font-mono text-xs text-muted-foreground">{p.key}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          ))}
        </div>
        <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-3 border-t bg-card px-4 py-3">
          <Button size="sm" onClick={save} disabled={saving || !dirty}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            Save {role.label}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft(new Set(template))} disabled={matchesTemplate}>
            <RotateCcw />
            Starting template
          </Button>
          {dirty ? (
            <span className="text-sm text-muted-foreground">
              {added.length > 0 ? `+${added.length}` : ""}
              {added.length > 0 && removed.length > 0 ? " / " : ""}
              {removed.length > 0 ? `−${removed.length}` : ""} unsaved
            </span>
          ) : null}
          {message ? <p className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>{message.text}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}
