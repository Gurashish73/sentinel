import { NextResponse } from "next/server";
import { auth } from "@/auth";

export default auth((req) => {
  const isLoggedIn = !!req.auth;
  const isAuthPage = req.nextUrl.pathname.startsWith("/login");
  const isApiRoute = req.nextUrl.pathname.startsWith("/api");

  // Webhooks and API routes must bypass the browser login gate to function
  if (isApiRoute) return NextResponse.next();

  if (isAuthPage) {
    if (isLoggedIn) {
      // Send authenticated users to the root so the smart router below handles them
      return NextResponse.redirect(new URL("/", req.nextUrl));
    }
    return NextResponse.next();
  }

  if (!isLoggedIn) {
    return NextResponse.redirect(new URL("/login", req.nextUrl));
  }

  const userRole = req.auth?.user?.role;
  const currentPath = req.nextUrl.pathname;

  // Smart Root Routing: Send users to their highest-privileged dashboard automatically
  if (currentPath === "/") {
    if (userRole === "COMMANDER") return NextResponse.redirect(new URL("/commander/dashboard", req.nextUrl));
    if (userRole === "ENGINEER") return NextResponse.redirect(new URL("/engineer/dashboard", req.nextUrl));
    
    // Default fallback for Observers or users who just signed up and have no role yet
    return NextResponse.redirect(new URL("/observer/dashboard", req.nextUrl));
  }

  // Strict structural routing path enforcement based on current session permissions
  if (currentPath.startsWith("/commander") && userRole !== "COMMANDER") {
    return NextResponse.redirect(new URL("/engineer/dashboard", req.nextUrl));
  }

  if (currentPath.startsWith("/engineer") && !["COMMANDER", "ENGINEER"].includes(userRole ?? "")) {
    return NextResponse.redirect(new URL("/observer/dashboard", req.nextUrl));
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|public).*)"],
};