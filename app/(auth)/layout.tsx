import { ShoppingBag } from "lucide-react";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 p-4">
      <div className="flex items-center gap-2 text-lg font-semibold">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <ShoppingBag className="size-4" />
        </div>
        Antu Boutique CRM
      </div>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
