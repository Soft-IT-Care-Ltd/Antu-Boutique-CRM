"use client";

import { Printer } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Prints the page as it is (the page hides its own buttons with print:hidden). */
export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <Button variant="outline" onClick={() => window.print()}>
      <Printer />
      {label}
    </Button>
  );
}
