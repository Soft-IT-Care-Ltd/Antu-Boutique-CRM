"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Pencil, Tags, Trash2 } from "lucide-react";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProductForm } from "@/components/catalog/product-form";
import { ProductImages } from "@/components/catalog/product-images";
import { ProductPackaging } from "@/components/catalog/product-packaging";
import { VariantMatrix } from "@/components/catalog/variant-matrix";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/catalog/client";
import type { Category, ColorMaster, ProductDetail as ProductDetailType, ProductVariant, SizeMaster } from "@/lib/catalog/types";

export function ProductDetail({
  product: initialProduct,
  categories,
  sizes,
  colors,
  canEdit,
  canGenerateVariants,
  canDelete,
  hasCostView,
  canPrintTags = false,
}: {
  product: ProductDetailType;
  categories: Category[];
  sizes: SizeMaster[];
  colors: ColorMaster[];
  canEdit: boolean;
  canGenerateVariants: boolean;
  canDelete: boolean;
  hasCostView: boolean;
  canPrintTags?: boolean;
}) {
  const router = useRouter();
  const [product, setProduct] = useState(initialProduct);
  const [editing, setEditing] = useState(false);
  const [trashDialogOpen, setTrashDialogOpen] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);

  function handleVariantsChange(variants: ProductVariant[]) {
    setProduct((prev) => ({
      ...prev,
      variants,
      stockAvailable: variants.reduce((sum, v) => sum + v.available, 0),
    }));
  }

  async function handleTrash() {
    setTrashError(null);
    try {
      await fetchJson(`/api/catalog/products/${product.id}`, { method: "DELETE" });
      router.push("/catalog");
    } catch (err) {
      setTrashError(err instanceof ApiError ? err.message : "Could not move product to trash.");
    }
  }

  if (editing) {
    return (
      <ProductForm
        categories={categories}
        product={product}
        onSaved={(updated) => {
          setProduct((prev) => ({ ...prev, ...updated }));
          setEditing(false);
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-xl">{product.name}</CardTitle>
              <Badge variant="outline" className="font-mono">
                {product.code}
              </Badge>
              {!product.isActive ? <Badge variant="secondary">Inactive</Badge> : null}
              {product.kind === "COMPONENT_ONLY" ? <Badge variant="secondary">Packaging material</Badge> : null}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {product.category?.name ?? "Uncategorised"}
              {product.brand ? ` · ${product.brand}` : ""}
              {product.fabric ? ` · ${product.fabric}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 gap-1.5">
            {canPrintTags ? (
              <Button render={<Link href={`/catalog/price-tags?productId=${product.id}`} />} nativeButton={false} variant="outline" size="sm">
                <Tags />
                Print tags
              </Button>
            ) : null}
            {canEdit ? (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil />
                Edit
              </Button>
            ) : null}
            {canDelete ? (
              <AlertDialog
                open={trashDialogOpen}
                onOpenChange={(open) => {
                  setTrashDialogOpen(open);
                  if (open) setTrashError(null);
                }}
              >
                <AlertDialogTrigger render={<Button variant="destructive" size="sm" />}>
                  <Trash2 />
                  Delete
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Move &quot;{product.name}&quot; to trash?</AlertDialogTitle>
                    <AlertDialogDescription>
                      It can be restored from the Trash for 30 days. After that it is deleted — or, if it has been stocked or sold, kept for the records but no longer restorable. To stop selling it for now, mark it inactive instead.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  {trashError ? <p className="text-sm text-destructive">{trashError}</p> : null}
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleTrash}>Move to trash</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <div>
              <p className="text-muted-foreground">Base price</p>
              <p className="font-medium">{formatBDT(product.basePrice)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Total available</p>
              <p className="font-medium">{product.stockAvailable}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Variants</p>
              <p className="font-medium">{product.variants.length}</p>
            </div>
          </div>
          {product.description ? <p className="text-sm text-muted-foreground">{product.description}</p> : null}
          {product.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {product.tags.map((tag) => (
                <Badge key={tag} variant="secondary">
                  {tag}
                </Badge>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reference photos</CardTitle>
        </CardHeader>
        <CardContent>
          <ProductImages productId={product.id} initialImages={product.images} canEdit={canEdit} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sizes &amp; colours</CardTitle>
        </CardHeader>
        <CardContent>
          <VariantMatrix
            productId={product.id}
            basePrice={product.basePrice}
            initialVariants={product.variants}
            sizes={sizes}
            colors={colors}
            canGenerate={canGenerateVariants}
            canEdit={canEdit}
            hasCostView={hasCostView}
            onVariantsChange={handleVariantsChange}
            onProductCodeChange={(code) => setProduct((prev) => (prev.code === code ? prev : { ...prev, code }))}
          />
        </CardContent>
      </Card>
      {product.kind === "SELLABLE" ? <ProductPackaging productId={product.id} canEdit={canEdit} /> : null}
    </div>
  );
}
