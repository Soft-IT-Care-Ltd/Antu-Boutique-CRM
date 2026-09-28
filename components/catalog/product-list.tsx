"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AlertTriangle, PackageX, Plus, Search } from "lucide-react";

import { ListPagination } from "@/components/list/list-pagination";
import { usePager } from "@/components/list/list-prefs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/catalog/client";
import type { Category, ProductListItem, StockStatus } from "@/lib/catalog/types";
import { uploadUrl } from "@/lib/catalog/types";

const STOCK_LABEL: Record<StockStatus, string> = {
  IN_STOCK: "In stock",
  LOW_STOCK: "Low stock",
  OUT_OF_STOCK: "Out of stock",
};

const STOCK_VARIANT: Record<StockStatus, "success" | "warning" | "destructive"> = {
  IN_STOCK: "success",
  LOW_STOCK: "warning",
  OUT_OF_STOCK: "destructive",
};

export function ProductList({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const [categories, setCategories] = useState<Category[]>([]);
  const [items, setItems] = useState<ProductListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const pager = usePager("products");
  const { page, pageSize, setPage } = pager;
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [categoryId, setCategoryId] = useState<string>("all");
  const [stockStatus, setStockStatus] = useState<string>("all");
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchJson<{ categories: Category[] }>("/api/catalog/categories")
      .then((data) => setCategories(data.categories.filter((c) => c.isActive)))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedQ) params.set("q", debouncedQ);
    if (categoryId !== "all") params.set("categoryId", categoryId);
    if (stockStatus !== "all") params.set("stockStatus", stockStatus);
    if (lowStockOnly) params.set("lowStockOnly", "true");
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));

    fetchJson<{ items: ProductListItem[]; total: number }>(`/api/catalog/products?${params.toString()}`)
      .then((data) => {
        setItems(data.items);
        setTotal(data.total);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load products."));
  }, [debouncedQ, categoryId, stockStatus, lowStockOnly, page, pageSize]);

  // Any filter change jumps back to page 1 — set at the point of interaction
  // rather than in a derived effect, so filtering never renders twice.
  function updateFilter<T>(setter: (value: T) => void, value: T) {
    setter(value);
    pager.reset();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="relative flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search name, code, brand, SKU..."
              value={q}
              onChange={(e) => updateFilter(setQ, e.target.value)}
              className="pl-8"
            />
          </div>
          <Select value={categoryId} onValueChange={(v) => updateFilter(setCategoryId, v as string)}>
            <SelectTrigger className="w-full sm:w-44">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={stockStatus} onValueChange={(v) => updateFilter(setStockStatus, v as string)}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue placeholder="Stock status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All stock</SelectItem>
              <SelectItem value="IN_STOCK">In stock</SelectItem>
              <SelectItem value="LOW_STOCK">Low stock</SelectItem>
              <SelectItem value="OUT_OF_STOCK">Out of stock</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant={lowStockOnly ? "default" : "outline"}
            size="sm"
            onClick={() => updateFilter(setLowStockOnly, !lowStockOnly)}
            className="whitespace-nowrap"
          >
            <AlertTriangle />
            Low stock
          </Button>
        </div>
        {canCreate ? (
          <Button render={<Link href="/catalog/products/new" />} nativeButton={false}>
            <Plus />
            New product
          </Button>
        ) : null}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!items ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <PackageX className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No products found</p>
          <p className="text-sm text-muted-foreground">Try a different search or filter.</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Variants</TableHead>
              <TableHead className="text-right">Stock</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((product) => (
              <TableRow
                key={product.id}
                className="cursor-pointer"
                onClick={() => router.push(`/catalog/products/${product.id}`)}
              >
                <TableCell>
                  <div className="flex items-center gap-3">
                    <div className="flex h-12 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                      {product.images[0] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={uploadUrl(product.images[0].thumbPath)} alt="" className="size-full object-cover" />
                      ) : (
                        <PackageX className="size-4 text-muted-foreground" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate font-medium">{product.name}</p>
                      <p className="text-xs text-muted-foreground"><span className="font-mono">{product.code}</span>{product.brand ? ` · ${product.brand}` : ""}</p>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{product.category?.name ?? "—"}</TableCell>
                <TableCell className="text-right">{product.kind === "COMPONENT_ONLY" ? <span className="text-xs text-muted-foreground">Packaging</span> : formatBDT(product.basePrice)}</TableCell>
                <TableCell className="text-right">{product._count.variants}</TableCell>
                <TableCell className="text-right">{product.stock.available}</TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <Badge variant={STOCK_VARIANT[product.stock.status]}>{STOCK_LABEL[product.stock.status]}</Badge>
                    {!product.isActive ? <Badge variant="outline">Inactive</Badge> : null}
                    {product.kind === "COMPONENT_ONLY" ? <Badge variant="secondary">Packaging</Badge> : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {items && items.length > 0 ? (
        <ListPagination page={page} pageSize={pageSize} total={total} noun="products" onPageChange={setPage} onPageSizeChange={pager.setPageSize} />
      ) : null}
    </div>
  );
}
