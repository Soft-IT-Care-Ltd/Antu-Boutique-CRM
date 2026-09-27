"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Button } from "@/components/ui/button";

const LINKS = [
  { href: "/attendance", label: "Today" },
  { href: "/attendance/leave", label: "Leave" },
  { href: "/attendance/report", label: "Monthly report" },
];

export function AttendanceNav() {
  const pathname = usePathname();
  return (
    <nav className="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:px-0" aria-label="Attendance sections">
      {LINKS.map((link) => (
        <Button key={link.href} size="sm" variant={pathname === link.href ? "nav" : "ghost"} className="shrink-0" render={<Link href={link.href} />} nativeButton={false}>
          {link.label}
        </Button>
      ))}
    </nav>
  );
}
