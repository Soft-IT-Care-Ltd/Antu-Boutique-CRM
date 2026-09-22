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

export const config = {
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico|uploads).*)"],
};
