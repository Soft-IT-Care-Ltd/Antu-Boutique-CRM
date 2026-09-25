import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { auditFilterOptions, auditFilterSchema, listAuditLogs, type AuditFilters } from "@/lib/audit/queries";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { formatDhakaDateTime } from "@/lib/inventory/constants";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// P4.4 (PRD §3.1) — the audit-log viewer: every sensitive change with who,
// what, which record, before/after and IP. ADMIN only (audit.view, gated
// through the nav map by guardPage). Filter by person, record type (and
// id), action and Dhaka dates; newest first, 50 a page.

const SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

const labelOf = (entity: string) => entity.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

function pageHref(f: AuditFilters, page: number): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, page: String(page) })) if (v && !(k === "page" && v === "1")) q.set(k, String(v));
  const s = q.toString();
  return s ? `/audit-log?${s}` : "/audit-log";
}

export default async function AuditLogPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await guardPage("/audit-log");
  const raw = Object.fromEntries(Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v));
  const parsed = auditFilterSchema.safeParse(raw);
  const filters: AuditFilters = parsed.success ? parsed.data : { page: 1 };
  const [list, options] = await Promise.all([listAuditLogs(prisma, filters, await can(user, "product.cost.view")), auditFilterOptions(prisma)]);
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const filtered = Object.keys(raw).some((k) => k !== "page");

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="text-sm text-muted-foreground">Every sensitive change — orders, prices, payments, stock, permissions, images, approvals — with who made it, before and after.</p>
      </div>

      <form method="get" className="grid grid-cols-2 gap-2 rounded-xl border bg-card p-3 sm:grid-cols-3 sm:p-4 lg:grid-cols-7 lg:items-end">
        <Field label="Person" htmlFor="a-actor">
          <select id="a-actor" name="actor" defaultValue={filters.actor ?? ""} className={SELECT_CLASS}>
            <option value="">Everyone</option>
            {options.actors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Record type" htmlFor="a-entity">
          <select id="a-entity" name="entity" defaultValue={filters.entity ?? ""} className={SELECT_CLASS}>
            <option value="">All</option>
            {options.entities.map((e) => (
              <option key={e} value={e}>
                {labelOf(e)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Record id" htmlFor="a-entity-id">
          <Input id="a-entity-id" name="entityId" defaultValue={filters.entityId ?? ""} placeholder="Any" />
        </Field>
        <Field label="Action contains" htmlFor="a-action">
          <Input id="a-action" name="action" defaultValue={filters.action ?? ""} placeholder="e.g. payment" />
        </Field>
        <Field label="From" htmlFor="a-from">
          <Input id="a-from" type="date" name="from" defaultValue={filters.from ?? ""} />
        </Field>
        <Field label="To" htmlFor="a-to">
          <Input id="a-to" type="date" name="to" defaultValue={filters.to ?? ""} />
        </Field>
        <div className="col-span-2 flex gap-2 sm:col-span-1">
          <Button type="submit" className="flex-1">
            Show
          </Button>
          <Button variant="ghost" render={<Link href="/audit-log" />} nativeButton={false}>
            Reset
          </Button>
        </div>
        {!parsed.success ? <p className="col-span-full text-sm text-destructive">{parsed.error.issues[0]?.message ?? "Some filters were not understood"} — showing everything.</p> : null}
      </form>

      <p className="text-sm text-muted-foreground">
        {list.total.toLocaleString("en-IN")} {list.total === 1 ? "entry" : "entries"}
        {filtered ? " match" : ""}
      </p>

      {list.items.length === 0 ? (
        <Card>
          <CardContent>
            <p className="py-8 text-center text-sm text-muted-foreground">{filtered ? "Nothing matches these filters." : "Nothing has been logged yet."}</p>
          </CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.items.map((e) => (
            <li key={e.id} className="rounded-xl border bg-card p-3 text-sm">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium">{e.actor?.name ?? "System"}</span>
                <Badge variant="outline" className="font-mono">
                  {e.action}
                </Badge>
                <span className="text-muted-foreground">
                  {labelOf(e.entityType)}{" "}
                  {e.entityHref ? (
                    <Link href={e.entityHref} className="font-mono text-xs hover:underline">
                      {e.entityId}
                    </Link>
                  ) : (
                    <span className="font-mono text-xs">{e.entityId}</span>
                  )}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {formatDhakaDateTime(e.createdAt)}
                  {e.ipAddress ? ` · ${e.ipAddress}` : ""}
                </span>
              </div>
              {e.changed.length ? <p className="mt-1 text-xs text-muted-foreground">Changed: {e.changed.slice(0, 12).join(", ")}{e.changed.length > 12 ? ` +${e.changed.length - 12} more` : ""}</p> : null}
              {e.before !== null || e.after !== null ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">Before / after</summary>
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    <JsonBlock label="Before" value={e.before} />
                    <JsonBlock label="After" value={e.after} />
                  </div>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {pages > 1 ? (
        <div className="flex items-center justify-between gap-2">
          <Button variant="outline" size="sm" disabled={list.page <= 1} render={list.page > 1 ? <Link href={pageHref(filters, list.page - 1)} /> : undefined} nativeButton={list.page <= 1}>
            <ChevronLeft /> Newer
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {list.page} of {pages}
          </span>
          <Button variant="outline" size="sm" disabled={list.page >= pages} render={list.page < pages ? <Link href={pageHref(filters, list.page + 1)} /> : undefined} nativeButton={list.page >= pages}>
            Older <ChevronRight />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      <pre className="max-h-72 overflow-auto rounded-md bg-muted p-2 text-xs">{value === null || value === undefined ? "—" : JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}
