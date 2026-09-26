import { NextResponse } from "next/server";

import { auth } from "@/auth";

const PUBLIC_PATHS = ["/login"];

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const sessionUser = req.auth?.user;

  if (!sessionUser) {
    if (PUBLIC_PATHS.some((path) => pathname.startsWith(path))) return NextResponse.next();
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  const isChangePasswordPage = pathname === "/change-password";
  const isChangePasswordApi = pathname === "/api/auth/change-password";

  if (sessionUser.mustChangePassword && !isChangePasswordPage && !isChangePasswordApi) {
    return NextResponse.redirect(new URL("/change-password", req.url));
  }

  if (!sessionUser.mustChangePassword && isChangePasswordPage) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  if (PUBLIC_PATHS.some((path) => pathname.startsWith(path))) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  return NextResponse.next();
});

// api/webhooks and api/cron are machine-to-machine: Steadfast and the cron
// scheduler have no session, so the login redirect must never touch them.
// Each of those routes authenticates itself with its own Bearer secret
// (the Steadfast webhook token / CRON_SECRET) before reading anything.
// P5.1: the PWA files (manifest, service worker, offline page, icons) are
// fetched by the browser without cookies and hold nothing private.
export const config = {
  matcher: ["/((?!api/auth|api/webhooks|api/cron|_next/static|_next/image|favicon.ico|uploads|manifest.webmanifest|sw.js|offline.html|icons/).*)"],
};
