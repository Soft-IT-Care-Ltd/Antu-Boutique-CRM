import type { LucideIcon } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type PlaceholderPageProps = {
  title: string;
  description: string;
  icon: LucideIcon;
  phase?: string;
};

export function PlaceholderPage({ title, description, icon: Icon, phase }: PlaceholderPageProps) {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <div>
        <h1 className="text-2xl leading-tight font-semibold tracking-tight md:text-[28px]">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Card className="border-dashed">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex size-12 items-center justify-center rounded-full bg-muted">
            <Icon className="size-6 text-muted-foreground" />
          </div>
          <CardTitle>Coming soon</CardTitle>
          <CardDescription>
            {phase ?? "This module"} is not built yet — the nav item is a placeholder from the
            Phase 0 foundation.
          </CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </div>
  );
}
