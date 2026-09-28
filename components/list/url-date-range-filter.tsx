"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { DateRangeFilter } from "@/components/list/date-range-filter";
import { dateRangeToParams, type DateRangeValue } from "@/lib/date-range";

/**
 * The shared date filter for a server-rendered screen with no form (the
 * dashboard): picking a range rewrites `range` / `from` / `to` in the URL
 * and the page re-renders with it. A custom range waits for both ends.
 */
export function UrlDateRangeFilter({ value }: { value: DateRangeValue }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const go = (next: DateRangeValue) => {
    if (next.preset === "custom" && (!next.from || !next.to)) return;
    const q = new URLSearchParams(params.toString());
    for (const k of ["range", "from", "to", "page"]) q.delete(k);
    for (const [k, v] of Object.entries(dateRangeToParams(next))) q.set(k, v);
    router.push(`${pathname}?${q.toString()}`, { scroll: false });
  };

  return <DateRangeFilter key={JSON.stringify(value)} defaultValue={value} onChange={go} />;
}
