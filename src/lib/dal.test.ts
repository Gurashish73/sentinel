import { describe, it, expect, vi, beforeEach } from "vitest";

// next/navigation's redirect() only does anything meaningful inside a real
// Next.js request — outside that, mock it as a throw, which is actually an
// accurate model: Next's real redirect() also works by throwing an internal
// signal for the framework to catch, not by returning normally.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { membership: { findUnique: vi.fn() } },
}));

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { requireSession, requireActiveOrg, requireMembership, requireRole } from "@/lib/dal";

const mockAuth = vi.mocked(auth);
const mockFindUnique = vi.mocked(db.membership.findUnique);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireSession", () => {
  it("returns the session when signed in", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);
    const session = await requireSession();
    expect(session.user.id).toBe("user-1");
  });

  it("redirects to /login when there is no session", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(requireSession()).rejects.toThrow("REDIRECT:/login");
  });
});

describe("requireActiveOrg", () => {
  it("returns orgId when the session has one", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1", activeOrgId: "org-1" } } as never);
    const result = await requireActiveOrg();
    expect(result.orgId).toBe("org-1");
  });

  it("redirects to /onboarding when the session has no activeOrgId", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);
    await expect(requireActiveOrg()).rejects.toThrow("REDIRECT:/onboarding");
  });
});

describe("requireMembership", () => {
  it("returns the membership when the user actually belongs to the org", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);
    mockFindUnique.mockResolvedValue({ id: "m1", userId: "user-1", orgId: "org-1", role: "ENGINEER" } as never);

    const result = await requireMembership("org-1");
    expect(result.membership.role).toBe("ENGINEER");
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { userId_orgId: { userId: "user-1", orgId: "org-1" } },
    });
  });

  it("throws rather than silently passing when the user has no membership in that org", async () => {
    // This is the actual anti-IDOR guarantee under test: knowing or
    // guessing an orgId is never enough on its own to act on it.
    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);
    mockFindUnique.mockResolvedValue(null);

    await expect(requireMembership("someone-elses-org")).rejects.toThrow(
      "You are not a member of this organization."
    );
  });
});

describe("requireRole", () => {
  it("allows a role that's in the allowed list", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);
    mockFindUnique.mockResolvedValue({ id: "m1", userId: "user-1", orgId: "org-1", role: "COMMANDER" } as never);

    const result = await requireRole("org-1", ["COMMANDER"]);
    expect(result.membership.role).toBe("COMMANDER");
  });

  it("rejects a role outside the allowed list — the actual JWT-staleness defense", async () => {
    // Models the exact demoted-Commander scenario from the JWT LinkedIn
    // post: the database says OBSERVER now, and that's what governs the
    // outcome, regardless of what any session token still claims.
    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);
    mockFindUnique.mockResolvedValue({ id: "m1", userId: "user-1", orgId: "org-1", role: "OBSERVER" } as never);

    await expect(requireRole("org-1", ["COMMANDER"])).rejects.toThrow(
      "This action requires one of: COMMANDER."
    );
  });

  it("rejects when the user has no membership in the target org at all", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);
    mockFindUnique.mockResolvedValue(null);

    await expect(requireRole("some-other-org", ["COMMANDER"])).rejects.toThrow(
      "You are not a member of this organization."
    );
  });

  it("accepts any one of multiple allowed roles", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);
    mockFindUnique.mockResolvedValue({ id: "m1", userId: "user-1", orgId: "org-1", role: "ENGINEER" } as never);

    const result = await requireRole("org-1", ["COMMANDER", "ENGINEER"]);
    expect(result.membership.role).toBe("ENGINEER");
  });
});