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
  const activeOrgId = req.auth?.user?.activeOrgId;
  const currentPath = req.nextUrl.pathname;

  // Intercept users without an active organization or role at the Edge.
  // Saves a full React render pass by bouncing them to onboarding instantly.
  // The !currentPath check prevents an infinite redirect loop.
  if ((!activeOrgId || !userRole) && !currentPath.startsWith("/onboarding")) {
    return NextResponse.redirect(new URL("/onboarding", req.nextUrl));
  }

  // Smart Root Routing: Send users to their highest-privileged dashboard automatically
  if (currentPath === "/") {
    if (userRole === "COMMANDER") return NextResponse.redirect(new URL("/commander/dashboard", req.nextUrl));
    if (userRole === "ENGINEER") return NextResponse.redirect(new URL("/engineer/dashboard", req.nextUrl));
    
    // Default fallback strictly for authenticated, fully-provisioned Observers
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