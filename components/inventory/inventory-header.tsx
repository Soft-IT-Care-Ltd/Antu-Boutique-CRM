import type { ReactNode } from "react";

import { InventoryNav } from "@/components/inventory/inventory-nav";
import type { InventoryNavLink } from "@/lib/inventory/types";

export function InventoryHeader({ title, description, links, actions }: { title: string; description: string; links: InventoryNavLink[]; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl leading-tight font-semibold tracking-tight md:text-[28px]">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {actions}
      </div>
      <InventoryNav links={links} />
    </div>
  );
}
