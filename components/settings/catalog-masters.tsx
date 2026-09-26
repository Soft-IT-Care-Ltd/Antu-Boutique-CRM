"use client";

import { CategoryManager } from "@/components/catalog/category-manager";
import { ColorManager } from "@/components/catalog/color-manager";
import { SizeManager } from "@/components/catalog/size-manager";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// PRD §4.2 "Size and Colour are master lists in Settings" — the same
// managers the Catalog screen shows, so there is one place the rules live.
export function CatalogMasters({ canManage }: { canManage: boolean }) {
  return (
    <Card>
      <CardContent>
        <Tabs defaultValue="categories">
          <TabsList>
            <TabsTrigger value="categories">Categories</TabsTrigger>
            <TabsTrigger value="sizes">Sizes</TabsTrigger>
            <TabsTrigger value="colors">Colours</TabsTrigger>
          </TabsList>
          <TabsContent value="categories" className="pt-4">
            <CategoryManager canManage={canManage} />
          </TabsContent>
          <TabsContent value="sizes" className="pt-4">
            <SizeManager canManage={canManage} />
          </TabsContent>
          <TabsContent value="colors" className="pt-4">
            <ColorManager canManage={canManage} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
