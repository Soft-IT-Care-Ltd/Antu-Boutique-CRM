"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WALLET_TYPE_LABELS, type WalletOption } from "@/lib/wallets/constants";

/**
 * Picks one of the given (already filtered) wallets. With `allowAll`, the
 * empty value means "all wallets" — for list filters.
 */
export function WalletSelect({
  id,
  wallets,
  value,
  onChange,
  allowAll,
  placeholder = "Pick a wallet",
  className,
}: {
  id?: string;
  wallets: WalletOption[];
  value: string;
  onChange: (walletId: string) => void;
  allowAll?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const ALL = "__all";
  return (
    <Select value={value || (allowAll ? ALL : "")} onValueChange={(v) => onChange(v === ALL ? "" : ((v as string) ?? ""))}>
      <SelectTrigger id={id} className={className ?? "w-full"}>
        <SelectValue placeholder={placeholder}>
          {(v: string) => (v === ALL ? "All wallets" : (wallets.find((w) => w.id === v)?.name ?? placeholder))}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {allowAll ? <SelectItem value={ALL}>All wallets</SelectItem> : null}
        {wallets.map((w) => (
          <SelectItem key={w.id} value={w.id}>
            {w.name} <span className="text-xs text-muted-foreground">· {WALLET_TYPE_LABELS[w.type]}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
