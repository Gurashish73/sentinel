import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  next: vi.fn(() => ({ kind: "next" })),
  redirect: vi.fn((url: URL) => ({ kind: "redirect", url: url.toString() })),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: mocks.next,
    redirect: mocks.redirect,
  },
}));
vi.mock("@/auth", () => ({
  auth: (handler: (request: unknown) => unknown) => handler,
}));

import proxy from "@/proxy";

type ProxyRequest = {
  auth: { user?: Record<string, unknown> } | null;
  nextUrl: URL;
};

async function callProxy(path: string, user: Record<string, unknown> | null) {
  const request: ProxyRequest = {
    auth: user ? { user } : null,
    nextUrl: new URL(`https://sentinel.test${path}`),
  };
  return (proxy as unknown as (req: ProxyRequest) => unknown)(request);
}

beforeEach(() => vi.clearAllMocks());

describe("authentication proxy and stale organization claims", () => {
  it("lets a signed-in user with a stale empty JWT reach the server-side DAL", async () => {
    const result = await callProxy("/commander/dashboard", { id: "user-1" });

    expect(result).toEqual({ kind: "next" });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("lets the root page resolve the current database role instead of a stale JWT role", async () => {
    const result = await callProxy("/", {
      id: "user-1",
      activeOrgId: "stale-org",
      role: "ENGINEER",
    });

    expect(result).toEqual({ kind: "next" });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("redirects anonymous page requests to login", async () => {
    const result = await callProxy("/commander/dashboard", null);

    expect(result).toEqual({
      kind: "redirect",
      url: "https://sentinel.test/login",
    });
  });

  it("redirects a logged-in user away from the login page to the root resolver", async () => {
    const result = await callProxy("/login", { id: "user-1" });

    expect(result).toEqual({
      kind: "redirect",
      url: "https://sentinel.test/",
    });
  });

  it("does not intercept API routes", async () => {
    const result = await callProxy("/api/workflow/agent", null);

    expect(result).toEqual({ kind: "next" });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
