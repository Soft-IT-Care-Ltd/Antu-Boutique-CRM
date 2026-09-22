import { redirect } from "next/navigation";

import { ProductForm } from "@/components/catalog/product-form";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";

export default async function NewProductPage() {
  const user = await guardPage("/catalog");
  if (!(await can(user, "product.create"))) redirect("/catalog");

  const categories = await prisma.category.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:mx-auto md:w-full md:max-w-2xl md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New product</h1>
        <p className="text-sm text-muted-foreground">Add sizes and colours from the product page after saving.</p>
      </div>
      <ProductForm categories={categories.map((c) => ({ ...c }))} />
    </div>
  );
}
