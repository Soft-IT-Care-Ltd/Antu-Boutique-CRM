import type { ReactNode } from "react";

import { LeadsNav } from "@/components/leads/leads-nav";

export function LeadsHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl leading-tight font-semibold tracking-tight md:text-[28px]">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {actions}
      </div>
      <LeadsNav />
    </div>
  );
}
