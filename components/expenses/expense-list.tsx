"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText, Loader2, Paperclip, Pencil, Plus, Receipt, Search, Trash2, X } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { DateRangeFilter } from "@/components/list/date-range-filter";
import { ListPagination } from "@/components/list/list-pagination";
import { usePager } from "@/components/list/list-prefs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { WalletSelect } from "@/components/wallets/wallet-select";
import {
  EXPENSE_KIND_LABELS,
  EXPENSE_KIND_VALUES,
  OPERATING_EXPENSE_FILTER,
  type ExpenseKindFilter,
  EXPENSE_NATURE_LABELS,
  EXPENSE_NATURE_VALUES,
  type ExpenseCategoryOption,
  type ExpenseKindValue,
  type ExpenseNatureValue,
} from "@/lib/expenses/constants";
import { dateRangeFromDays, dateRangeQuery, type DateRangeValue } from "@/lib/date-range";
import { formatDhakaDate, todayInDhaka } from "@/lib/inventory/constants";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import type { WalletOption } from "@/lib/wallets/constants";

type ExpenseItem = {
  id: string;
  expenseDate: string;
  categoryId: string;
  categoryName: string;
  kind: ExpenseKindValue;
  nature: ExpenseNatureValue;
  amount: string;
  walletId: string | null;
  walletName: string | null;
  note: string | null;
  source: string | null;
  attachmentPath: string | null;
  attachmentName: string | null;
  attachmentMime: string | null;
  createdByName: string | null;
};

const OPERATING_LABEL = "All but supplier payments";

const uploadUrl = (path: string) => `/uploads/${path}`;
const dhakaYmd = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(new Date(iso));

/** PRD §4.12 — daily expense entry: date, category, fixed/variable, amount, wallet paid from, note, receipt. */
export function ExpenseList({
  categories,
  wallets,
  canCreate,
  canEdit,
  canDelete,
  initialFilters = {},
}: {
  categories: ExpenseCategoryOption[];
  wallets: WalletOption[];
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** From a dashboard link (P4.3). */
  initialFilters?: { kind?: ExpenseKindFilter; from?: string; to?: string };
}) {
  const [data, setData] = useState<{ items: ExpenseItem[]; total: number; totalAmount: string } | null>(null);
  const pager = usePager("expenses");
  const { page, pageSize, setPage } = pager;
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [kind, setKind] = useState<ExpenseKindFilter | "all">(initialFilters.kind ?? "all");
  const [nature, setNature] = useState<ExpenseNatureValue | "all">("all");
  const [walletId, setWalletId] = useState("");
  const [range, setRange] = useState<DateRangeValue>(() => dateRangeFromDays(initialFilters.from, initialFilters.to));
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ExpenseItem | "new" | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const load = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (debouncedQ) params.set("q", debouncedQ);
    if (kind !== "all") params.set("kind", kind);
    if (nature !== "all") params.set("nature", nature);
    if (walletId) params.set("walletId", walletId);
    for (const [k, v] of Object.entries(dateRangeQuery(range))) params.set(k, v);
    fetchJson<{ items: ExpenseItem[]; total: number; totalAmount: string }>(`/api/expenses?${params.toString()}`)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load expenses."));
  }, [page, pageSize, debouncedQ, kind, nature, walletId, range]);
  useEffect(() => {
    load();
  }, [load, reloadKey]);

  function filter<T>(setter: (v: T) => void, v: T) {
    setter(v);
    pager.reset();
  }

  async function remove(id: string) {
    try {
      await fetchJson(`/api/expenses/${id}`, { method: "DELETE" });
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete.");
    }
  }

  const items = data?.items ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
        <div className="relative lg:w-60">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Note or category..." value={q} onChange={(e) => filter(setQ, e.target.value)} className="pl-8" />
        </div>
        <div className="grid grid-cols-2 gap-2 lg:flex">
          <Select value={kind} onValueChange={(v) => filter(setKind, v as ExpenseKindFilter | "all")}>
            <SelectTrigger className="w-full lg:w-48">
              <SelectValue>{(v: string) => (v === "all" ? "All categories" : v === OPERATING_EXPENSE_FILTER ? OPERATING_LABEL : EXPENSE_KIND_LABELS[v as ExpenseKindValue])}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              <SelectItem value={OPERATING_EXPENSE_FILTER}>{OPERATING_LABEL}</SelectItem>
              {EXPENSE_KIND_VALUES.map((k) => (
                <SelectItem key={k} value={k}>
                  {EXPENSE_KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={nature} onValueChange={(v) => filter(setNature, v as ExpenseNatureValue | "all")}>
            <SelectTrigger className="w-full lg:w-36">
              <SelectValue>{(v: string) => (v === "all" ? "Fixed & variable" : EXPENSE_NATURE_LABELS[v as ExpenseNatureValue])}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Fixed & variable</SelectItem>
              {EXPENSE_NATURE_VALUES.map((n) => (
                <SelectItem key={n} value={n}>
                  {EXPENSE_NATURE_LABELS[n]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <WalletSelect wallets={wallets} value={walletId} onChange={(v) => filter(setWalletId, v)} allowAll className="col-span-2 w-full lg:w-48" />
        </div>
        <DateRangeFilter value={range} onChange={(v) => filter(setRange, v)} />
        {canCreate ? (
          <Button className="lg:ml-auto" onClick={() => setEditing("new")}>
            <Plus />
            Add expense
          </Button>
        ) : null}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!items ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <Receipt className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No expenses found</p>
          <p className="text-sm text-muted-foreground">Record rent, salaries, packaging, transport — anything the business pays for.</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Note</TableHead>
              <TableHead>Paid from</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="whitespace-nowrap text-sm">{formatDhakaDate(e.expenseDate)}</TableCell>
                <TableCell className="text-sm">
                  {e.categoryName}
                  <div className="flex gap-1 text-xs text-muted-foreground">
                    {EXPENSE_KIND_LABELS[e.kind]} · {EXPENSE_NATURE_LABELS[e.nature]}
                  </div>
                </TableCell>
                <TableCell className="max-w-72 text-sm">
                  <span className="line-clamp-2">{e.note ?? ""}</span>
                  {e.source ? (
                    <Badge variant="outline" className="mt-0.5">
                      Posted by {e.source}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{e.walletName ?? (e.source ? "Not from a wallet" : "—")}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">{formatBDT(e.amount)}</TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {e.attachmentPath ? (
                    <Button variant="ghost" size="icon-sm" aria-label="Open receipt" render={<a href={uploadUrl(e.attachmentPath)} target="_blank" rel="noreferrer" />} nativeButton={false}>
                      <Paperclip />
                    </Button>
                  ) : null}
                  {!e.source && canEdit ? (
                    <Button variant="ghost" size="icon-sm" aria-label="Edit expense" onClick={() => setEditing(e)}>
                      <Pencil />
                    </Button>
                  ) : null}
                  {!e.source && canDelete ? (
                    <AlertDialog>
                      <AlertDialogTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Delete expense" />}>
                        <Trash2 />
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete this expense?</AlertDialogTitle>
                          <AlertDialogDescription>
                            {e.categoryName} · {formatBDT(e.amount)}. It moves to the trash and its wallet balance goes back up.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => remove(e.id)}>Delete</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {items && items.length > 0 ? (
        <ListPagination page={page} pageSize={pageSize} total={data!.total} noun="expenses" onPageChange={setPage} onPageSizeChange={pager.setPageSize}>
          {" "}
          · {formatBDT(data!.totalAmount)}
        </ListPagination>
      ) : null}

      {editing ? (
        <ExpenseDialog
          expense={editing === "new" ? null : editing}
          categories={categories.filter((c) => !c.isSystem)}
          wallets={wallets}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setReloadKey((k) => k + 1);
          }}
        />
      ) : null}
    </div>
  );
}

function ExpenseDialog({
  expense,
  categories,
  wallets,
  onClose,
  onSaved,
}: {
  expense: ExpenseItem | null;
  categories: ExpenseCategoryOption[];
  wallets: WalletOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [expenseDate, setExpenseDate] = useState(expense ? dhakaYmd(expense.expenseDate) : todayInDhaka());
  const [categoryId, setCategoryId] = useState(expense?.categoryId ?? categories[0]?.id ?? "");
  const [nature, setNature] = useState<ExpenseNatureValue>(expense?.nature ?? categories[0]?.defaultNature ?? "VARIABLE");
  const [amount, setAmount] = useState(expense?.amount ?? "");
  const [walletId, setWalletId] = useState(expense?.walletId ?? wallets.find((w) => w.type === "CASH")?.id ?? wallets[0]?.id ?? "");
  const [note, setNote] = useState(expense?.note ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [removeAttachment, setRemoveAttachment] = useState(false);
  // Set once a new expense is created, so a retry after a failed receipt upload edits it instead of adding another.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body = { expenseDate, categoryId, nature, amount: Number(amount), walletId, note: note.trim() || null };
      let id = expense?.id ?? createdId;
      if (id) await fetchJson(`/api/expenses/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      else {
        id = (await fetchJson<{ expense: { id: string } }>("/api/expenses", { method: "POST", body: JSON.stringify(body) })).expense.id;
        setCreatedId(id);
      }
      if (file) {
        const form = new FormData();
        form.append("file", file);
        await fetchJson(`/api/expenses/${id}/attachment`, { method: "POST", body: form }).catch((err) => {
          // The expense is saved; say so rather than losing it behind an upload error.
          throw new ApiError(`Expense saved, but the receipt didn't upload: ${err instanceof ApiError ? err.message : "try again"}`);
        });
      } else if (removeAttachment && expense?.attachmentPath) {
        await fetchJson(`/api/expenses/${id}/attachment`, { method: "DELETE" });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{expense ? "Edit expense" : "Add expense"}</DialogTitle>
          <DialogDescription>Ad spend is entered on the Ad spend tab, so it can be spread over the day&apos;s orders.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ex-date">Date</Label>
            <Input id="ex-date" type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Category</Label>
            <Select
              value={categoryId}
              onValueChange={(v) => {
                setCategoryId(v as string);
                const cat = categories.find((c) => c.id === v);
                if (cat && !expense) setNature(cat.defaultNature);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue>{(v: string) => categories.find((c) => c.id === v)?.name ?? "Pick a category"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Fixed or variable</Label>
            <Select value={nature} onValueChange={(v) => setNature(v as ExpenseNatureValue)}>
              <SelectTrigger className="w-full">
                <SelectValue>{(v: ExpenseNatureValue) => EXPENSE_NATURE_LABELS[v]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {EXPENSE_NATURE_VALUES.map((n) => (
                  <SelectItem key={n} value={n}>
                    {EXPENSE_NATURE_LABELS[n]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ex-amount">Amount (৳)</Label>
            <Input id="ex-amount" type="number" min={0} step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="ex-wallet">Paid from</Label>
            <WalletSelect id="ex-wallet" wallets={wallets} value={walletId} onChange={setWalletId} />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="ex-note">Note</Label>
            <Textarea id="ex-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="ex-file">Receipt (optional — photo or PDF)</Label>
            {expense?.attachmentPath && !removeAttachment && !file ? (
              <div className="flex items-center gap-2 text-sm">
                <FileText className="size-4 text-muted-foreground" />
                <a href={uploadUrl(expense.attachmentPath)} target="_blank" rel="noreferrer" className="truncate hover:underline">
                  {expense.attachmentName ?? "Receipt"}
                </a>
                <Button variant="ghost" size="icon-sm" aria-label="Remove receipt" onClick={() => setRemoveAttachment(true)}>
                  <X />
                </Button>
              </div>
            ) : null}
            <Input id="ex-file" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button disabled={saving || !categoryId || !walletId || !Number(amount)} onClick={save}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            {expense ? "Save" : "Add expense"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
