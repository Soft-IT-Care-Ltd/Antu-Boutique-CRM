"use client";

import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** `icon` is a rendered element: a component function can't cross from the server page to this client component. */
export type SettingsSectionLink = { id: string; label: string; icon: ReactNode };

// The Settings sections: a column on a wide screen, a row that scrolls
// sideways on a phone (the page itself never scrolls sideways), scrolled so
// the current section is in view.
export function SettingsNav({ sections, active }: { sections: SettingsSectionLink[]; active: string }) {
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navRef.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    // scrollLeft rather than scrollIntoView: it must not move the page vertically.
    if (nav && current && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = current.offsetLeft - nav.clientWidth / 2 + current.offsetWidth / 2;
  }, [active]);
  return (
    <nav ref={navRef} aria-label="Settings sections" className="-mx-4 overflow-x-auto px-4 md:mx-0 md:overflow-visible md:px-0">
      <ul className="flex gap-1 md:flex-col">
        {sections.map((s) => {
          const current = s.id === active;
          return (
            <li key={s.id} className="shrink-0">
              <Link
                href={`/settings?section=${s.id}`}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors",
                  current ? "bg-card font-semibold text-foreground shadow-xs ring-1 ring-border" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {s.icon}
                {s.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
