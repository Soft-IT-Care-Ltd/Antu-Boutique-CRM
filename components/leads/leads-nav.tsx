"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Button } from "@/components/ui/button";

const LINKS = [
  { href: "/leads", label: "Leads" },
  { href: "/leads/follow-ups", label: "Follow-ups" },
  { href: "/leads/daily-counts", label: "Daily counts" },
  { href: "/leads/report", label: "Conversion" },
];

/** Sub-navigation across the lead screens — every one is open to anyone who can see leads. */
export function LeadsNav() {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/leads" ? pathname === href || /^\/leads\/c[a-z0-9]{20,}/.test(pathname) : pathname.startsWith(href));

  return (
    <nav className="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:px-0" aria-label="Lead sections">
      {LINKS.map((link) => (
        <Button key={link.href} size="sm" variant={isActive(link.href) ? "nav" : "ghost"} className="shrink-0" render={<Link href={link.href} />} nativeButton={false}>
          {link.label}
        </Button>
      ))}
    </nav>
  );
}
