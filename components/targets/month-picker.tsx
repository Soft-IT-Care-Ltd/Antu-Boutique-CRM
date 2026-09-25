"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { monthLabel } from "@/lib/targets/month";

/** Picks the month in the URL (?month=YYYY-MM); the page re-renders on the server. */
export function MonthPicker({ month, options }: { month: string; options: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <Select
      value={month}
      onValueChange={(v) => {
        const next = new URLSearchParams(params.toString());
        next.set("month", v as string);
        router.push(`${pathname}?${next}`);
      }}
    >
      <SelectTrigger className="w-full sm:w-48" aria-label="Month">
        <SelectValue>{(v: string) => monthLabel(v)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((m) => (
          <SelectItem key={m} value={m}>
            {monthLabel(m)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
