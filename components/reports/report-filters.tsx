import Link from "next/link";
import { Download, FileText } from "lucide-react";

import { DateRangeFilter } from "@/components/list/date-range-filter";
import { Button } from "@/components/ui/button";
import type { ReportDef, ReportFilterKey } from "@/lib/reports/catalog";
import { dateRangeFromDays } from "@/lib/date-range";
import type { FilterOptions, ReportFilters } from "@/lib/reports/filters";
import { cn } from "@/lib/utils";

// P4.4 — the date range (the shared filter, CORRECTIONS.md item 16) and the report's own filters, as a plain GET form
// (works without JavaScript, and the URL is the report — shareable and the
// same query the export links use). Server component.

const LABELS: Record<ReportFilterKey, string> = {
  person: "Person",
  team: "Team",
  status: "Status",
  channel: "Channel",
  category: "Category",
  groupBy: "Group by",
  source: "Source",
  courier: "Courier",
  kind: "Heading",
  stock: "Stock",
};

const ALL: Partial<Record<ReportFilterKey, string>> = { status: "Counted as sales", groupBy: "Automatic", stock: "All" };

const SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

const VALUE: Record<ReportFilterKey, (f: ReportFilters) => string | undefined> = {
  person: (f) => f.personId,
  team: (f) => f.teamId,
  status: (f) => f.status,
  channel: (f) => f.channel,
  category: (f) => f.categoryId,
  groupBy: (f) => f.groupBy,
  source: (f) => f.source,
  courier: (f) => f.courierId,
  kind: (f) => f.kind,
  stock: (f) => f.stock,
};

export function ReportFilterBar({ def, filters, options, exportQuery }: { def: ReportDef; filters: ReportFilters; options: FilterOptions; exportQuery: string | null }) {
  const shown = def.filters.filter((k) => options[k]?.length);
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-3 sm:p-4">
      <form method="get" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6 lg:items-end">
        <Field label="Dates" htmlFor="r-range" className="col-span-2">
          <DateRangeFilter id="r-range" defaultValue={filters.rangePreset ? { preset: filters.rangePreset } : dateRangeFromDays(filters.fromDay, filters.toDay)} inForm />
        </Field>
        {shown.map((k) => (
          <Field key={k} label={LABELS[k]} htmlFor={`r-${k}`}>
            <select id={`r-${k}`} name={k} defaultValue={VALUE[k](filters) ?? ""} className={SELECT_CLASS}>
              <option value="">{ALL[k] ?? "All"}</option>
              {options[k]!.filter((o) => !(k === "stock" && o.value === "all")).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        ))}
        <div className="col-span-2 flex gap-2 sm:col-span-1">
          <Button type="submit" className="flex-1">
            Show
          </Button>
          <Button variant="ghost" render={<Link href={`/reports/${def.key}`} />} nativeButton={false}>
            Reset
          </Button>
        </div>
      </form>
      {exportQuery !== null ? (
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <span className="text-xs text-muted-foreground">Export what&apos;s shown:</span>
          <Button size="sm" variant="outline" render={<a href={`/api/reports/${def.key}/export?format=csv&${exportQuery}`} download />} nativeButton={false}>
            <Download /> CSV
          </Button>
          <Button size="sm" variant="outline" render={<a href={`/api/reports/${def.key}/export?format=pdf&${exportQuery}`} download />} nativeButton={false}>
            <FileText /> PDF
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, htmlFor, className, children }: { label: string; htmlFor: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
