"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ORDER_CHANNEL_LABELS, ORDER_CHANNEL_VALUES, type OrderChannelValue } from "@/lib/orders/constants";

export type ChannelFilterValue = OrderChannelValue | "all";

/** P3.1 — the Online / Walk-in filter every order-based list and report carries. */
export function ChannelSelect({ value, onChange, className }: { value: ChannelFilterValue; onChange: (value: ChannelFilterValue) => void; className?: string }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as ChannelFilterValue)}>
      <SelectTrigger className={className ?? "w-36"} aria-label="Channel">
        <SelectValue>{(v: string) => (v === "all" ? "All channels" : ORDER_CHANNEL_LABELS[v as OrderChannelValue])}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All channels</SelectItem>
        {ORDER_CHANNEL_VALUES.map((c) => (
          <SelectItem key={c} value={c}>
            {ORDER_CHANNEL_LABELS[c]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
