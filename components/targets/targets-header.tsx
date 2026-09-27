import type { ReactNode } from "react";
import { Suspense } from "react";

import { MonthPicker } from "@/components/targets/month-picker";
import { TargetsNav } from "@/components/targets/targets-nav";

export function TargetsHeader({ title, description, month, months, actions }: { title: string; description: string; month: string; months: string[]; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl leading-tight font-semibold tracking-tight md:text-[28px]">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {actions}
          <Suspense>
            <MonthPicker month={month} options={months} />
          </Suspense>
        </div>
      </div>
      <Suspense>
        <TargetsNav />
      </Suspense>
    </div>
  );
}
