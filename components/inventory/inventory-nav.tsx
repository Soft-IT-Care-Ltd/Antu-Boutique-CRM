"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Button } from "@/components/ui/button";

import type { InventoryNavLink } from "@/lib/inventory/types";

/** Sub-navigation across the inventory screens. Links are pre-filtered by permission on the server. */
export function InventoryNav({ links }: { links: InventoryNavLink[] }) {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/inventory" ? pathname === href : pathname.startsWith(href));

  return (
    <nav className="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:px-0" aria-label="Inventory sections">
      {links.map((link) => (
        <Button
          key={link.href}
          size="sm"
          variant={isActive(link.href) ? "secondary" : "ghost"}
          className="shrink-0"
          render={<Link href={link.href} />}
          nativeButton={false}
        >
          {link.label}
        </Button>
      ))}
    </nav>
  );
}
