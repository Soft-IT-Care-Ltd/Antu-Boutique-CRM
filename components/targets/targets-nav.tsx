"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";

const LINKS = [
  { href: "/targets", label: "Progress" },
  { href: "/targets/leaderboard", label: "Leaderboard" },
  { href: "/targets/rewards", label: "Rewards" },
];

/** Sub-navigation across the target screens; keeps the chosen month. */
export function TargetsNav() {
  const pathname = usePathname();
  const month = useSearchParams().get("month");
  return (
    <nav className="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:px-0" aria-label="Target sections">
      {LINKS.map((link) => (
        <Button
          key={link.href}
          size="sm"
          variant={pathname === link.href ? "secondary" : "ghost"}
          className="shrink-0"
          render={<Link href={month ? `${link.href}?month=${month}` : link.href} />}
          nativeButton={false}
        >
          {link.label}
        </Button>
      ))}
    </nav>
  );
}
