import Link from "next/link";
import { ChevronLeft, ChevronRight, Search, Trash2 } from "lucide-react";

import { TrashRestoreButton } from "@/components/trash/trash-restore-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { guardPage } from "@/lib/auth/guard-page";
import { getEffectivePermissions } from "@/lib/auth/permissions";
import { formatDhakaDate, formatDhakaDateTime } from "@/lib/inventory/constants";
import { prisma } from "@/lib/prisma";
import { TRASH_KIND_LABELS, TRASH_RETENTION_DAYS, type TrashKind } from "@/lib/trash/policy";
import { listTrash, trashQuerySchema, visibleTrashKinds, type TrashQuery } from "@/lib/trash/queries";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// PRD §4.18 — deleted orders, customers, products and leads, restorable for
// 30 days before the nightly purge. Each tab needs that module's delete
// permission and is scoped like its own list (lib/trash/queries.ts).

function href(kind: TrashKind, q: string | undefined, page = 1): string {
  const p = new URLSearchParams({ kind });
  if (q) p.set("q", q);
  if (page > 1) p.set("page", String(page));
  return `/trash?${p}`;
}

export default async function TrashPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await guardPage("/trash");
  const raw = Object.fromEntries(Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v));
  const parsed = trashQuerySchema.safeParse(raw);
  const query: TrashQuery = parsed.success ? parsed.data : { page: 1 };
  const kinds = visibleTrashKinds(await getEffectivePermissions(user.id));
  const trash = await listTrash(prisma, user, kinds, query);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:mx-auto md:w-full md:max-w-4xl md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Trash</h1>
        <p className="text-sm text-muted-foreground">
          Deleted records stay here for {TRASH_RETENTION_DAYS} days and can be restored. Then the nightly purge removes them — anything with sales, stock or money behind it is kept for the records, just no longer restorable.
        </p>
      </div>

      {!trash ? (
        <Card>
          <CardContent>
            <p className="py-8 text-center text-sm text-muted-foreground">You can&apos;t delete records, so there is no trash to show.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <nav className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0" aria-label="Kind of record">
            {kinds.map((k) => (
              <Link
                key={k}
                href={href(k, undefined)}
                aria-current={k === trash.kind ? "page" : undefined}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors",
                  k === trash.kind ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted",
                )}
              >
                {TRASH_KIND_LABELS[k].many}
                <span className={cn("rounded-md px-1.5 text-xs tabular-nums", k === trash.kind ? "bg-primary-foreground/20" : "bg-muted text-muted-foreground")}>{trash.counts[k] ?? 0}</span>
              </Link>
            ))}
          </nav>

          <form method="get" className="flex gap-2">
            <input type="hidden" name="kind" value={trash.kind} />
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                name="q"
                defaultValue={query.q ?? ""}
                placeholder={trash.kind === "order" ? "Order no., customer name or phone" : trash.kind === "product" ? "Name or code" : "Name or phone"}
                className="pl-8"
                aria-label="Search the trash"
              />
            </div>
            <Button type="submit" variant="outline">
              Search
            </Button>
          </form>

          {trash.items.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
                <Trash2 className="size-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{query.q ? "Nothing in the trash matches that search." : `No deleted ${TRASH_KIND_LABELS[trash.kind].many.toLowerCase()}.`}</p>
              </CardContent>
            </Card>
          ) : (
            <ul className="flex flex-col gap-2">
              {trash.items.map((item) => (
                <li key={item.id} className="flex items-start justify-between gap-3 rounded-xl border bg-card p-3">
                  <div className="min-w-0">
                    <p className={cn("truncate font-medium", item.kind === "order" && "font-mono")}>{item.title}</p>
                    {item.subtitle ? <p className="truncate text-sm text-muted-foreground">{item.subtitle}</p> : null}
                    <p className="mt-1 text-xs text-muted-foreground">
                      Deleted {formatDhakaDateTime(item.deletedAt)}
                      {item.deletedBy ? ` by ${item.deletedBy}` : ""}
                    </p>
                    <Badge variant={item.daysLeft <= 3 ? "destructive" : "secondary"} className="mt-1.5 font-normal">
                      {item.daysLeft === 0 ? "Goes tonight" : `${item.daysLeft} day${item.daysLeft === 1 ? "" : "s"} left · until ${formatDhakaDate(item.purgeAt)}`}
                    </Badge>
                  </div>
                  <TrashRestoreButton kind={item.kind} id={item.id} />
                </li>
              ))}
            </ul>
          )}

          {trash.total > trash.pageSize ? (
            <div className="flex items-center justify-between gap-2">
              <Button variant="outline" size="sm" disabled={trash.page <= 1} render={trash.page > 1 ? <Link href={href(trash.kind, query.q, trash.page - 1)} /> : undefined} nativeButton={trash.page <= 1}>
                <ChevronLeft /> Newer
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {trash.page} of {Math.ceil(trash.total / trash.pageSize)}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={trash.page * trash.pageSize >= trash.total}
                render={trash.page * trash.pageSize < trash.total ? <Link href={href(trash.kind, query.q, trash.page + 1)} /> : undefined}
                nativeButton={trash.page * trash.pageSize >= trash.total}
              >
                Older <ChevronRight />
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
