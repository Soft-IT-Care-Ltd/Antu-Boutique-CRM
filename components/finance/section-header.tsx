"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

type SectionLink = { href: string; label: string };

/** Title + sub-navigation for the Payments and Expenses screens. The first link is the section root (exact match). */
export function SectionHeader({ title, description, links, actions }: { title: string; description: string; links: SectionLink[]; actions?: ReactNode }) {
  const pathname = usePathname();
  const root = links[0]?.href;
  const isActive = (href: string) => (href === root ? pathname === href : pathname.startsWith(href));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {actions}
      </div>
      <nav className="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:px-0" aria-label={`${title} sections`}>
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
    </div>
  );
}
