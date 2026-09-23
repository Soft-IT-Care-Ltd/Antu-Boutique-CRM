import type { Metadata } from "next";
import { Geist, Geist_Mono, Noto_Sans_Bengali } from "next/font/google";

import { BootMarker } from "@/components/boot-marker";
import { Providers } from "@/components/providers";
import { BOOT_GUARD_SCRIPT } from "@/lib/browser/boot-guard";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const notoSansBengali = Noto_Sans_Bengali({
  variable: "--font-bengali",
  subsets: ["bengali"],
});

export const metadata: Metadata = {
  title: "Antu Boutique CRM",
  description: "Internal CRM/ERP for Antu Boutique — leads, orders, stock, packing, courier and money in one place.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${notoSansBengali.variable} h-full antialiased`}
    >
      <head>
        {/* Must run before any bundle — see lib/browser/boot-guard.ts. */}
        <script dangerouslySetInnerHTML={{ __html: BOOT_GUARD_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
        <BootMarker />
      </body>
    </html>
  );
}
