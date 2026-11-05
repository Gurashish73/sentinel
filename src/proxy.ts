import { NextResponse } from "next/server";
import { auth } from "@/auth";

export default auth((req) => {
  const isLoggedIn = !!req.auth;
  const isAuthPage = req.nextUrl.pathname.startsWith("/login");
  const isApiRoute = req.nextUrl.pathname.startsWith("/api");

  // API routes have their own authentication and authorization boundaries.
  if (isApiRoute) return NextResponse.next();

  if (isAuthPage) {
    if (isLoggedIn) {
      // Let server-side routing resolve the current database membership.
      return NextResponse.redirect(new URL("/", req.nextUrl));
    }

    return NextResponse.next();
  }

  if (!isLoggedIn) {
    return NextResponse.redirect(new URL("/login", req.nextUrl));
  }

  // Organization and role decisions belong to the database-backed DAL.
  // JWT organization and role claims may be stale.
  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|public).*)"],
};