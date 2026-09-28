"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarRange } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DATE_RANGE_LABELS, DATE_RANGE_PRESETS, dateRangeToParams, resolveDateRange, type DateRangePreset, type DateRangeValue } from "@/lib/date-range";
import { cn } from "@/lib/utils";

// CORRECTIONS.md item 16 — the one date filter: Today · Yesterday · Last 7
// days · This Month · Last Month · All Time · Custom range, in Dhaka days.
//
// Two ways to use it:
//  - controlled, in a client list: `value` + `onChange`, then send
//    dateRangeQuery(value) to the API;
//  - inside a server page's GET form: `defaultValue` + `inForm`. It writes
//    hidden `range` / `from` / `to` inputs (what dateRangeFromParams reads)
//    and submits the form as soon as a preset is picked.

type Props = {
  value?: DateRangeValue;
  onChange?: (value: DateRangeValue) => void;
  defaultValue?: DateRangeValue;
  inForm?: boolean;
  /** Presets to leave out (e.g. All Time on a report that needs an end). */
  exclude?: DateRangePreset[];
  className?: string;
  id?: string;
};

export function DateRangeFilter({ value, onChange, defaultValue, inForm, exclude = [], className, id }: Props) {
  const [own, setOwn] = useState<DateRangeValue>(defaultValue ?? { preset: "this_month" });
  const current = value ?? own;
  const rootRef = useRef<HTMLDivElement>(null);
  const submitNext = useRef(false);

  // After the render that wrote the new hidden inputs, submit the form.
  useEffect(() => {
    if (!submitNext.current) return;
    submitNext.current = false;
    rootRef.current?.closest("form")?.requestSubmit();
  });

  const update = (next: DateRangeValue, submit: boolean) => {
    if (inForm && submit) submitNext.current = true;
    if (value === undefined) setOwn(next);
    onChange?.(next);
  };

  const pickPreset = (preset: DateRangePreset) => {
    if (preset === "custom") {
      // Start the custom range from whatever was showing, so it can be nudged.
      const r = resolveDateRange(current);
      update({ preset: "custom", from: r.from, to: r.to }, false);
    } else {
      update({ preset }, true);
    }
  };

  const presets = DATE_RANGE_PRESETS.filter((p) => !exclude.includes(p));

  return (
    <div ref={rootRef} className={cn("flex flex-wrap items-center gap-2", className)}>
      <Select value={current.preset} onValueChange={(v) => pickPreset(v as DateRangePreset)}>
        <SelectTrigger id={id} aria-label="Date range" className="min-w-[9.5rem]">
          <CalendarRange className="text-muted-foreground" />
          <SelectValue>{(v: string) => DATE_RANGE_LABELS[v as DateRangePreset]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {presets.map((p) => (
            <SelectItem key={p} value={p}>
              {DATE_RANGE_LABELS[p]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {current.preset === "custom" ? (
        <div className="flex items-center gap-1">
          <Input
            type="date"
            aria-label="From date"
            className="w-[9.5rem]"
            value={current.from ?? ""}
            max={current.to || undefined}
            onChange={(e) => update({ ...current, from: e.target.value || undefined }, false)}
          />
          <span className="text-muted-foreground">–</span>
          <Input
            type="date"
            aria-label="To date"
            className="w-[9.5rem]"
            value={current.to ?? ""}
            min={current.from || undefined}
            onChange={(e) => update({ ...current, to: e.target.value || undefined }, false)}
          />
        </div>
      ) : null}
      {inForm
        ? Object.entries(dateRangeToParams(current)).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)
        : null}
    </div>
  );
}
