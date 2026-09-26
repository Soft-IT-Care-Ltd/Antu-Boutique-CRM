"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, KeyRound, Loader2, Lock, Pencil, Plus, Search, ShieldCheck, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PERMISSIONS } from "@/lib/auth/permission-definitions";
import { formatDhakaDateTime, todayInDhaka } from "@/lib/inventory/constants";
import { ApiError, fetchJson } from "@/lib/orders/client";
import type { StaffListItem, TeamView } from "@/lib/settings/staff";

type RoleOption = { id: string; name: string; label: string };
type StaffPage = { items: StaffListItem[]; total: number; page: number; pageSize: number };

const PAGE_SIZE = 25;
const DHAKA_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" });

/** A readable temporary password: no 0/O/1/l look-alikes. getRandomValues works on iOS 15 and over plain http. */
function generatePassword(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint32Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

type Props = {
  teams: TeamView[];
  roles: RoleOption[];
  currentUserId: string;
  canCreate: boolean;
  canEdit: boolean;
  canDeactivate: boolean;
  canManagePermissions: boolean;
};

// PRD §4.1 / §4.17 — staff accounts and teams. The server decides who may
// change whom (lib/settings/staff.ts): nobody without permission.manage can
// touch an account with more access than their own, and nobody can leave the
// system without someone able to run it.
export function UsersSettings(props: Props) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [roleId, setRoleId] = useState("all");
  const [status, setStatus] = useState<"active" | "inactive" | "all">("active");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<StaffPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StaffListItem | "new" | null>(null);
  const [resetting, setResetting] = useState<StaffListItem | null>(null);
  const [overriding, setOverriding] = useState<StaffListItem | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ status, page: String(page), pageSize: String(PAGE_SIZE) });
    if (q.trim()) params.set("q", q.trim());
    if (roleId !== "all") params.set("roleId", roleId);
    try {
      setData(await fetchJson<StaffPage>(`/api/settings/users?${params}`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load staff.");
    }
  }, [q, roleId, status, page]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const filter = <T,>(set: (v: T) => void, v: T) => {
    set(v);
    setPage(1);
  };
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  const changed = async () => {
    await load();
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Staff</CardTitle>
          <CardDescription>People sign in with their phone or email. A new account must change its password at first sign-in.</CardDescription>
          {props.canCreate ? (
            <CardAction>
              <Button size="sm" onClick={() => setEditing("new")}>
                <Plus />
                Add person
              </Button>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative sm:w-64">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Name, phone or email..." value={q} onChange={(e) => filter(setQ, e.target.value)} className="pl-8" />
            </div>
            <div className="grid grid-cols-2 gap-2 sm:flex">
              <Select value={roleId} onValueChange={(v) => filter(setRoleId, v as string)}>
                <SelectTrigger className="w-full sm:w-48">
                  <SelectValue>{(v: string) => (v === "all" ? "All roles" : (props.roles.find((r) => r.id === v)?.label ?? "Role"))}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All roles</SelectItem>
                  {props.roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={status} onValueChange={(v) => filter(setStatus, v as typeof status)}>
                <SelectTrigger className="w-full sm:w-36">
                  <SelectValue>{(v: string) => ({ active: "Active", inactive: "Deactivated", all: "Everyone" })[v as typeof status]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Deactivated</SelectItem>
                  <SelectItem value="all">Everyone</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {!data ? (
            <div className="flex flex-col gap-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : data.items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{q || roleId !== "all" || status !== "active" ? "Nobody matches these filters." : "No staff yet."}</p>
          ) : (
            <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Person</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead className="hidden md:table-cell">Team</TableHead>
                    <TableHead className="hidden lg:table-cell">Last sign-in</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((u) => (
                    <TableRow key={u.id} className={u.isActive ? "" : "text-muted-foreground"}>
                      <TableCell className="whitespace-normal">
                        <div className="font-medium">
                          {u.name}
                          {u.id === props.currentUserId ? <span className="font-normal text-muted-foreground"> (you)</span> : null}
                        </div>
                        <div className="text-xs break-all text-muted-foreground">{[u.phone, u.email].filter(Boolean).join(" · ")}</div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {!u.isActive ? <Badge variant="outline">Deactivated</Badge> : null}
                          {u.locked ? (
                            <Badge variant="destructive">
                              <Lock />
                              Locked
                            </Badge>
                          ) : null}
                          {u.mustChangePassword && u.isActive ? <Badge variant="secondary">Password to change</Badge> : null}
                          {u.overrides.length > 0 ? <Badge variant="secondary">{u.overrides.length} override{u.overrides.length === 1 ? "" : "s"}</Badge> : null}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-normal">{u.role.label}</TableCell>
                      <TableCell className="hidden md:table-cell">
                        {u.team?.name ?? "—"}
                        {u.leadsTeam ? <span className="block text-xs text-muted-foreground">leader</span> : null}
                      </TableCell>
                      <TableCell className="hidden text-sm lg:table-cell">{u.lastLoginAt ? formatDhakaDateTime(u.lastLoginAt) : "Never"}</TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          {props.canEdit ? (
                            <>
                              <Button variant="ghost" size="icon-sm" onClick={() => setEditing(u)} aria-label={`Edit ${u.name}`}>
                                <Pencil />
                              </Button>
                              <Button variant="ghost" size="icon-sm" onClick={() => setResetting(u)} aria-label={`Reset ${u.name}'s password`}>
                                <KeyRound />
                              </Button>
                            </>
                          ) : null}
                          {props.canManagePermissions ? (
                            <Button variant="ghost" size="icon-sm" onClick={() => setOverriding(u)} aria-label={`${u.name}'s permissions`}>
                              <ShieldCheck />
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {data && data.total > PAGE_SIZE ? (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                Page {page} of {totalPages} · {data.total} people
              </span>
              <div className="flex gap-1">
                <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
                  <ChevronLeft />
                </Button>
                <Button variant="outline" size="icon-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
                  <ChevronRight />
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <TeamsCard teams={props.teams} canEdit={props.canEdit} onChanged={changed} />

      {editing ? (
        <PersonDialog
          person={editing === "new" ? null : editing}
          roles={props.roles}
          teams={props.teams.filter((t) => t.isActive)}
          isSelf={editing !== "new" && editing.id === props.currentUserId}
          canDeactivate={props.canDeactivate}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await changed();
          }}
        />
      ) : null}
      {resetting ? <ResetPasswordDialog person={resetting} onClose={() => setResetting(null)} onDone={changed} /> : null}
      {overriding ? (
        <OverridesDialog
          person={overriding}
          onClose={() => setOverriding(null)}
          onSaved={async () => {
            setOverriding(null);
            await changed();
          }}
        />
      ) : null}
    </div>
  );
}

function PersonDialog({
  person,
  roles,
  teams,
  isSelf,
  canDeactivate,
  onClose,
  onSaved,
}: {
  person: StaffListItem | null;
  roles: RoleOption[];
  teams: TeamView[];
  isSelf: boolean;
  canDeactivate: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [form, setForm] = useState({
    name: person?.name ?? "",
    phone: person?.phone ?? "",
    email: person?.email ?? "",
    roleId: person?.role.id ?? roles.find((r) => r.name === "SALES_EXECUTIVE")?.id ?? roles[0]?.id ?? "",
    teamId: person?.team?.id ?? "none",
    joinDate: person ? DHAKA_DAY.format(new Date(person.joinDate)) : todayInDhaka(),
    isActive: person?.isActive ?? true,
    password: person ? "" : generatePassword(),
  });
  const [unlock, setUnlock] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function save() {
    setSaving(true);
    setError(null);
    const details = { name: form.name, phone: form.phone, email: form.email || null, roleId: form.roleId, teamId: form.teamId === "none" ? null : form.teamId, joinDate: form.joinDate };
    try {
      if (person) {
        await fetchJson(`/api/settings/users/${person.id}`, {
          method: "PATCH",
          body: JSON.stringify({ ...details, ...(form.isActive !== person.isActive ? { isActive: form.isActive } : {}), ...(unlock ? { unlock: true } : {}) }),
        });
      } else {
        await fetchJson("/api/settings/users", { method: "POST", body: JSON.stringify({ ...details, password: form.password }) });
      }
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{person ? `Edit ${person.name}` : "Add a person"}</DialogTitle>
          <DialogDescription>{person ? "Role and team changes apply on their next click — no need to sign out." : "Tell them the temporary password; they choose their own at first sign-in."}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="p-name">Name</Label>
            <Input id="p-name" value={form.name} maxLength={80} onChange={(e) => set("name", e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="p-phone">Phone (sign-in)</Label>
            <Input id="p-phone" type="tel" inputMode="tel" value={form.phone} placeholder="01XXXXXXXXX" onChange={(e) => set("phone", e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="p-email">Email (optional)</Label>
            <Input id="p-email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Role</Label>
            <Select value={form.roleId} onValueChange={(v) => set("roleId", v as string)}>
              <SelectTrigger className="w-full">
                <SelectValue>{(v: string) => roles.find((r) => r.id === v)?.label ?? "Pick a role"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Team</Label>
            <Select value={form.teamId} onValueChange={(v) => set("teamId", v as string)}>
              <SelectTrigger className="w-full">
                <SelectValue>{(v: string) => (v === "none" ? "No team" : (teams.find((t) => t.id === v)?.name ?? "Team"))}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No team</SelectItem>
                {teams.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="p-join">Joined</Label>
            <Input id="p-join" type="date" value={form.joinDate} onChange={(e) => set("joinDate", e.target.value)} />
          </div>
          {!person ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="p-password">Temporary password</Label>
              <div className="flex gap-2">
                <Input id="p-password" value={form.password} onChange={(e) => set("password", e.target.value)} className="font-mono" />
                <Button type="button" variant="outline" size="sm" onClick={() => set("password", generatePassword())}>
                  New
                </Button>
              </div>
            </div>
          ) : null}
          {person && canDeactivate && !isSelf ? (
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <Switch checked={form.isActive} onCheckedChange={(on) => set("isActive", on)} />
              Active — a deactivated person is signed out and can&apos;t sign in. Their history stays.
            </label>
          ) : null}
          {person?.locked ? (
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <Switch checked={unlock} onCheckedChange={setUnlock} />
              Unlock now (locked after 5 wrong passwords)
            </label>
          ) : null}
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || form.name.trim().length < 2 || !form.phone.trim() || (!person && form.password.length < 8)}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            {person ? "Save" : "Add person"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ person, onClose, onDone }: { person: StaffListItem; onClose: () => void; onDone: () => void | Promise<void> }) {
  const [password, setPassword] = useState(generatePassword);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reset() {
    setSaving(true);
    setError(null);
    try {
      await fetchJson(`/api/settings/users/${person.id}/password`, { method: "POST", body: JSON.stringify({ password }) });
      setDone(true);
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reset the password.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset {person.name}&apos;s password</DialogTitle>
          <DialogDescription>They sign in with this once, then must choose their own. Any lock-out is cleared.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reset-password">Temporary password</Label>
          <div className="flex gap-2">
            <Input id="reset-password" value={password} onChange={(e) => setPassword(e.target.value)} className="font-mono" readOnly={done} />
            {!done ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setPassword(generatePassword())}>
                New
              </Button>
            ) : null}
          </div>
          {done ? <p className="text-sm text-muted-foreground">Done — give {person.name} this password now; it isn&apos;t shown again.</p> : null}
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          {done ? (
            <Button onClick={onClose}>Close</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={reset} disabled={saving || password.length < 8}>
                {saving ? <Loader2 className="animate-spin" /> : null}
                Reset password
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Effect = "ROLE" | "GRANT" | "REVOKE";

function OverridesDialog({ person, onClose, onSaved }: { person: StaffListItem; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [roleKeys, setRoleKeys] = useState<Set<string> | null>(null);
  const [effects, setEffects] = useState<Record<string, Effect>>(() => Object.fromEntries(person.overrides.map((o) => [o.key, o.effect])));
  const [reason, setReason] = useState<Record<string, string>>(() => Object.fromEntries(person.overrides.map((o) => [o.key, o.reason ?? ""])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchJson<{ roles: { id: string; keys: string[] }[] }>("/api/settings/roles")
      .then(({ roles }) => setRoleKeys(new Set(roles.find((r) => r.id === person.role.id)?.keys ?? [])))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the role."));
  }, [person.role.id]);

  const groups = [...new Set(PERMISSIONS.map((p) => p.group))];

  async function save() {
    setSaving(true);
    setError(null);
    const overrides = Object.entries(effects)
      .filter(([, e]) => e !== "ROLE")
      .map(([key, effect]) => ({ key, effect, reason: reason[key]?.trim() || null }));
    try {
      await fetchJson(`/api/settings/users/${person.id}/overrides`, { method: "PUT", body: JSON.stringify({ overrides }) });
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{person.name}&apos;s permissions</DialogTitle>
          <DialogDescription>
            Everything comes from the {person.role.label} role unless you grant or take away something for this person only. Give a reason — it goes in the audit log.
          </DialogDescription>
        </DialogHeader>
        {!roleKeys ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map((group) => (
              <fieldset key={group} className="flex flex-col gap-1">
                <legend className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{group}</legend>
                {PERMISSIONS.filter((p) => p.group === group).map((p) => {
                  const effect = effects[p.key] ?? "ROLE";
                  const fromRole = roleKeys.has(p.key);
                  const holds = effect === "GRANT" || (effect === "ROLE" && fromRole);
                  return (
                    <div key={p.key} className="flex flex-col gap-1 rounded-md px-2 py-1.5 hover:bg-muted/50 sm:flex-row sm:items-center sm:gap-3">
                      <div className="flex-1 text-sm">
                        <span className={holds ? "" : "text-muted-foreground line-through decoration-muted-foreground/50"}>{p.label}</span>
                        <span className="ml-2 font-mono text-xs text-muted-foreground">{p.key}</span>
                      </div>
                      <Select value={effect} onValueChange={(v) => setEffects({ ...effects, [p.key]: v as Effect })}>
                        <SelectTrigger size="sm" className="w-full sm:w-44">
                          <SelectValue>{(v: string) => (v === "ROLE" ? `Role: ${fromRole ? "yes" : "no"}` : v === "GRANT" ? "Granted" : "Taken away")}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ROLE">Role: {fromRole ? "yes" : "no"}</SelectItem>
                          {!fromRole ? <SelectItem value="GRANT">Grant to this person</SelectItem> : null}
                          {fromRole ? <SelectItem value="REVOKE">Take away from this person</SelectItem> : null}
                        </SelectContent>
                      </Select>
                      {effect !== "ROLE" ? (
                        <Input className="h-7 sm:w-48" placeholder="Reason" maxLength={200} value={reason[p.key] ?? ""} onChange={(e) => setReason({ ...reason, [p.key]: e.target.value })} />
                      ) : null}
                    </div>
                  );
                })}
              </fieldset>
            ))}
          </div>
        )}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !roleKeys}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TeamsCard({ teams, canEdit, onChanged }: { teams: TeamView[]; canEdit: boolean; onChanged: () => void | Promise<void> }) {
  const [editing, setEditing] = useState<TeamView | "new" | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Teams</CardTitle>
        <CardDescription>A Team Leader sees and approves their own team&apos;s leads, orders, returns and leave. Add members from each person&apos;s Edit.</CardDescription>
        {canEdit ? (
          <CardAction>
            <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
              <Plus />
              New team
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {teams.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No teams yet.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {teams.map((t) => (
              <li key={t.id} className="flex items-start gap-3 py-3">
                <Users className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    {t.name}
                    {!t.isActive ? <Badge variant="outline">Off</Badge> : null}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Leader: {t.leader?.name ?? "none"} · {t.members.length} active member{t.members.length === 1 ? "" : "s"}
                    {t.members.length > 0 ? ` — ${t.members.map((m) => m.name).join(", ")}` : ""}
                  </p>
                </div>
                {canEdit ? (
                  <Button variant="ghost" size="icon-sm" onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`}>
                    <Pencil />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {editing ? (
        <TeamDialog
          team={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await onChanged();
          }}
        />
      ) : null}
    </Card>
  );
}

function TeamDialog({ team, onClose, onSaved }: { team: TeamView | null; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [name, setName] = useState(team?.name ?? "");
  const [leaderId, setLeaderId] = useState(team?.leader?.id ?? "none");
  const [isActive, setIsActive] = useState(team?.isActive ?? true);
  const [people, setPeople] = useState<{ id: string; name: string; role: string }[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchJson<StaffPage>("/api/settings/users?status=active&pageSize=100")
      .then((d) => setPeople(d.items.map((u) => ({ id: u.id, name: u.name, role: u.role.label }))))
      .catch(() => setPeople([]));
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    const body = JSON.stringify({ name, leaderId: leaderId === "none" ? null : leaderId, ...(team ? { isActive } : {}) });
    try {
      await fetchJson(team ? `/api/settings/teams/${team.id}` : "/api/settings/teams", { method: team ? "PATCH" : "POST", body });
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{team ? `Edit ${team.name}` : "New team"}</DialogTitle>
          <DialogDescription>The leader is moved into the team if they aren&apos;t in it yet.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="t-name">Name</Label>
            <Input id="t-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Leader</Label>
            <Select value={leaderId} onValueChange={(v) => setLeaderId(v as string)} disabled={!people}>
              <SelectTrigger className="w-full">
                <SelectValue>{(v: string) => (v === "none" ? "No leader" : (people?.find((p) => p.id === v)?.name ?? team?.leader?.name ?? "Leader"))}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No leader</SelectItem>
                {(people ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} · {p.role}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {team ? (
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={isActive} onCheckedChange={setIsActive} />
              Active
            </label>
          ) : null}
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || name.trim().length < 2}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
