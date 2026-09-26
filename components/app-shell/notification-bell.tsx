"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Bell, CheckCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// The top-bar bell: in-app alerts for the signed-in person (the daily
// low-stock summary so far — lib/inventory/low-stock-alert.ts). Checks on
// load, when opened, and every 10 minutes while the tab is visible.

type Item = { id: string; title: string; body: string; href: string | null; readAt: string | null; createdAt: string };

const REFRESH_MS = 10 * 60_000;

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dhaka" });
}

export function NotificationBell() {
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { items: Item[]; unread: number };
      setItems(data.items);
      setUnread(data.unread);
    } catch {
      // Offline or signed out — the bell just stays as it was.
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount, no data-fetching lib in this project yet
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  async function markAllRead() {
    setUnread(0);
    setItems((list) => list.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })));
    await fetch("/api/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ all: true }) }).catch(() => undefined);
  }

  async function markRead(id: string) {
    const target = items.find((n) => n.id === id);
    if (!target || target.readAt) return;
    setUnread((n) => Math.max(0, n - 1));
    setItems((list) => list.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)));
    await fetch("/api/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [id] }) }).catch(() => undefined);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void load();
      }}
    >
      <PopoverTrigger
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        className="relative inline-flex size-9 items-center justify-center rounded-md outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Bell className="size-4" />
        {unread > 0 ? (
          <span className="absolute top-1 right-1 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-4 font-semibold text-white tabular-nums">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-1.5rem))] gap-0 p-0">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <p className="font-medium">Notifications</p>
          {unread > 0 ? (
            <Button variant="ghost" size="sm" onClick={markAllRead}>
              <CheckCheck />
              Mark all read
            </Button>
          ) : null}
        </div>
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing yet. Daily alerts, like low stock, show up here.</p>
        ) : (
          <ul className="max-h-[min(24rem,60vh)] overflow-y-auto">
            {items.map((n) => {
              const content = (
                <>
                  <p className={cn("text-sm", !n.readAt && "font-medium")}>{n.title}</p>
                  <p className="mt-0.5 line-clamp-4 text-xs whitespace-pre-line text-muted-foreground">{n.body}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">{when(n.createdAt)}</p>
                </>
              );
              return (
                <li key={n.id} className={cn("border-b last:border-b-0", !n.readAt && "bg-primary/5")}>
                  {n.href ? (
                    <Link
                      href={n.href}
                      className="block px-3 py-2.5 hover:bg-muted"
                      onClick={() => {
                        void markRead(n.id);
                        setOpen(false);
                      }}
                    >
                      {content}
                    </Link>
                  ) : (
                    <button type="button" className="block w-full px-3 py-2.5 text-left hover:bg-muted" onClick={() => void markRead(n.id)}>
                      {content}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
