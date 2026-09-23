"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";

// Any client or render error below the root layout lands here instead of a
// blank screen (P3.0, Gift Valy CORRECTIONS Round 2 §2.8). Reload fetches
// fresh bundles; Try again re-renders just this part of the page.
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div role="alert" className="flex min-h-[60vh] flex-1 items-center justify-center px-4 py-12">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">This page hit an error. Reload to try again — nothing you saved is lost.</p>
        {error.digest ? <p className="font-mono text-xs text-muted-foreground">Ref: {error.digest}</p> : null}
        <div className="flex gap-2 pt-1">
          <Button size="lg" onClick={() => window.location.reload()}>
            Reload
          </Button>
          <Button size="lg" variant="outline" onClick={() => retry()}>
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
