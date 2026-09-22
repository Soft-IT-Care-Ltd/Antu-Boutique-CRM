"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CategoryManager } from "@/components/catalog/category-manager";
import { ColorManager } from "@/components/catalog/color-manager";
import { ProductList } from "@/components/catalog/product-list";
import { SizeManager } from "@/components/catalog/size-manager";

type CatalogWorkspaceProps = {
  canCreateProduct: boolean;
  canManageMasters: boolean;
};

export function CatalogWorkspace({ canCreateProduct, canManageMasters }: CatalogWorkspaceProps) {
  return (
    <Tabs defaultValue="products">
      <TabsList>
        <TabsTrigger value="products">Products</TabsTrigger>
        <TabsTrigger value="categories">Categories</TabsTrigger>
        <TabsTrigger value="sizes">Sizes</TabsTrigger>
        <TabsTrigger value="colors">Colours</TabsTrigger>
      </TabsList>
      <TabsContent value="products" className="pt-4">
        <ProductList canCreate={canCreateProduct} />
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
