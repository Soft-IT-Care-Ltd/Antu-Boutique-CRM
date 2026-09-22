import { CatalogWorkspace } from "@/components/catalog/catalog-workspace";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";

export default async function CatalogPage() {
  const user = await guardPage("/catalog");
  const [canCreateProduct, canManageMasters] = await Promise.all([
    can(user, "product.create"),
    can(user, "catalog.manage"),
  ]);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Catalog</h1>
        <p className="text-sm text-muted-foreground">Products, size/colour variants and category masters.</p>
      </div>
      <CatalogWorkspace canCreateProduct={canCreateProduct} canManageMasters={canManageMasters} />
    </div>
  );
}
