import { NextResponse } from "next/server";
import { auth } from "@/auth";

export default auth((req) => {
  const isLoggedIn = !!req.auth;
  const isAuthPage = req.nextUrl.pathname.startsWith("/login");
  const isApiRoute = req.nextUrl.pathname.startsWith("/api");

  // Webhooks and API routes must bypass the browser login gate.
  if (isApiRoute) return NextResponse.next();

  if (isAuthPage) {
    if (isLoggedIn) {
      // The root page resolves the current database role.
      return NextResponse.redirect(new URL("/", req.nextUrl));
    }

    return NextResponse.next();
  }

  if (!isLoggedIn) {
    return NextResponse.redirect(new URL("/login", req.nextUrl));
  }

  const activeOrgId = req.auth?.user?.activeOrgId;
  const currentPath = req.nextUrl.pathname;

  // Require an organization selection, but do not make role decisions from
  // potentially stale JWT claims. DAL checks enforce current DB permissions.
  if (!activeOrgId && !currentPath.startsWith("/onboarding")) {
    return NextResponse.redirect(new URL("/onboarding", req.nextUrl));
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|public).*)"],
};
