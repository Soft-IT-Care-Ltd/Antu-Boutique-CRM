"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CategoryManager } from "@/components/catalog/category-manager";
import { ColorManager } from "@/components/catalog/color-manager";
import { PackagingManager } from "@/components/catalog/packaging-manager";
import { ProductList } from "@/components/catalog/product-list";
import { SetsManager } from "@/components/catalog/sets-manager";
import { SizeManager } from "@/components/catalog/size-manager";

type CatalogWorkspaceProps = {
  canCreateProduct: boolean;
  canManageMasters: boolean;
  canEditProduct: boolean;
  canDeleteProduct: boolean;
  hasCostAccess: boolean;
};

export function CatalogWorkspace({ canCreateProduct, canManageMasters, canEditProduct, canDeleteProduct, hasCostAccess }: CatalogWorkspaceProps) {
  return (
    <Tabs defaultValue="products">
      <TabsList className="h-auto flex-wrap">
        <TabsTrigger value="products">Products</TabsTrigger>
        <TabsTrigger value="sets">Outfit sets</TabsTrigger>
        <TabsTrigger value="packaging">Packaging</TabsTrigger>
        <TabsTrigger value="categories">Categories</TabsTrigger>
        <TabsTrigger value="sizes">Sizes</TabsTrigger>
        <TabsTrigger value="colors">Colours</TabsTrigger>
      </TabsList>
      <TabsContent value="products" className="pt-4">
        <ProductList canCreate={canCreateProduct} />
      </TabsContent>
      <TabsContent value="sets" className="pt-4">
        <SetsManager canCreate={canCreateProduct} canEdit={canEditProduct} canDelete={canDeleteProduct} hasCostAccess={hasCostAccess} />
      </TabsContent>
      <TabsContent value="packaging" className="pt-4">
        <PackagingManager canManage={canManageMasters} canCreateProduct={canCreateProduct} hasCostAccess={hasCostAccess} />
      </TabsContent>
      <TabsContent value="categories" className="pt-4">
        <CategoryManager canManage={canManageMasters} />
      </TabsContent>
      <TabsContent value="sizes" className="pt-4">
        <SizeManager canManage={canManageMasters} />
      </TabsContent>
      <TabsContent value="colors" className="pt-4">
        <ColorManager canManage={canManageMasters} />
      </TabsContent>
    </Tabs>
  );
}
