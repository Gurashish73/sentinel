
import { describe, it, expect, vi, beforeEach } from "vitest";

// Model Next.js redirect behavior by throwing a recognizable signal.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    membership: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

import { auth } from "@/auth";
import { db } from "@/lib/db";
import {
  requireSession,
  requireActiveOrg,
  requireMembership,
  requireRole,
  requireRoleForActiveOrg,
} from "@/lib/dal";

const mockAuth = vi.mocked(auth);
const mockFindUnique = vi.mocked(db.membership.findUnique);
const mockFindFirst = vi.mocked(db.membership.findFirst);

beforeEach(() => {
  vi.clearAllMocks();

  // Default: there is no fallback membership.
  mockFindFirst.mockReset();
  mockFindFirst.mockResolvedValue(null as never);
});

describe("requireSession", () => {
  it("returns the session when signed in", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1" },
    } as never);

    const session = await requireSession();

    expect(session.user.id).toBe("user-1");
  });

  it("redirects to /login when there is no session", async () => {
    mockAuth.mockResolvedValue(null as never);

    await expect(requireSession()).rejects.toThrow("REDIRECT:/login");
  });
});

describe("requireActiveOrg", () => {
  it("redirects to onboarding when the user has no valid membership", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", activeOrgId: "org-1" },
    } as never);

    mockFindUnique.mockResolvedValue(null);

    await expect(requireActiveOrg()).rejects.toThrow(
      "REDIRECT:/onboarding",
    );

    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { id: "asc" },
    });
  });

  it("returns the active org and its authoritative membership", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", activeOrgId: "org-1" },
    } as never);

    mockFindUnique.mockResolvedValue({
      id: "m1",
      userId: "user-1",
      orgId: "org-1",
      role: "ENGINEER",
    } as never);

    const result = await requireActiveOrg();

    expect(result.orgId).toBe("org-1");
    expect(result.membership.role).toBe("ENGINEER");

    expect(mockFindUnique).toHaveBeenCalledWith({
      where: {
        userId_orgId: {
          userId: "user-1",
          orgId: "org-1",
        },
      },
    });

    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("recovers the organization when activeOrgId is missing from the session", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1" },
    } as never);

    mockFindFirst.mockResolvedValue({
      id: "m1",
      userId: "user-1",
      orgId: "org-2",
      role: "ENGINEER",
    } as never);

    const result = await requireActiveOrg();

    expect(result.orgId).toBe("org-2");
    expect(result.membership.role).toBe("ENGINEER");
    expect(result.session.user.activeOrgId).toBe("org-2");
    expect(result.session.user.role).toBe("ENGINEER");

    expect(mockFindUnique).not.toHaveBeenCalled();

    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { id: "asc" },
    });
  });

  it("recovers when the session references an obsolete organization", async () => {
    mockAuth.mockResolvedValue({
      user: {
        id: "user-1",
        activeOrgId: "deleted-org",
        role: "COMMANDER",
      },
    } as never);

    mockFindUnique.mockResolvedValue(null);

    mockFindFirst.mockResolvedValue({
      id: "m2",
      userId: "user-1",
      orgId: "org-2",
      role: "OBSERVER",
    } as never);

    const result = await requireActiveOrg();

    expect(result.orgId).toBe("org-2");
    expect(result.membership.role).toBe("OBSERVER");
    expect(result.session.user.activeOrgId).toBe("org-2");
    expect(result.session.user.role).toBe("OBSERVER");
  });

  it("redirects to onboarding when the session has no activeOrgId and no membership exists", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1" },
    } as never);

    mockFindFirst.mockResolvedValue(null);

    await expect(requireActiveOrg()).rejects.toThrow(
      "REDIRECT:/onboarding",
    );
  });
});

describe("requireMembership", () => {
  it("returns the membership when the user belongs to the organization", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1" },
    } as never);

    mockFindUnique.mockResolvedValue({
      id: "m1",
      userId: "user-1",
      orgId: "org-1",
      role: "ENGINEER",
    } as never);

    const result = await requireMembership("org-1");

    expect(result.membership.role).toBe("ENGINEER");

    expect(mockFindUnique).toHaveBeenCalledWith({
      where: {
        userId_orgId: {
          userId: "user-1",
          orgId: "org-1",
        },
      },
    });
  });

  it("throws when the user has no membership in the target organization", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1" },
    } as never);

    mockFindUnique.mockResolvedValue(null);

    await expect(
      requireMembership("someone-elses-org"),
    ).rejects.toThrow(
      "You are not a member of this organization.",
    );
  });
});

describe("requireRole", () => {
  it("allows a role included in the allowed list", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1" },
    } as never);

    mockFindUnique.mockResolvedValue({
      id: "m1",
      userId: "user-1",
      orgId: "org-1",
      role: "COMMANDER",
    } as never);

    const result = await requireRole("org-1", ["COMMANDER"]);

    expect(result.membership.role).toBe("COMMANDER");
  });

  it("rejects a role that is not in the allowed list", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1" },
    } as never);

    mockFindUnique.mockResolvedValue({
      id: "m1",
      userId: "user-1",
      orgId: "org-1",
      role: "OBSERVER",
    } as never);

    await expect(
      requireRole("org-1", ["COMMANDER"]),
    ).rejects.toThrow(
      "This action requires one of: COMMANDER.",
    );
  });

  it("rejects when the user has no membership in the target organization", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1" },
    } as never);

    mockFindUnique.mockResolvedValue(null);

    await expect(
      requireRole("some-other-org", ["COMMANDER"]),
    ).rejects.toThrow(
      "You are not a member of this organization.",
    );
  });

  it("accepts any one of multiple allowed roles", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1" },
    } as never);

    mockFindUnique.mockResolvedValue({
      id: "m1",
      userId: "user-1",
      orgId: "org-1",
      role: "ENGINEER",
    } as never);

    const result = await requireRole("org-1", [
      "COMMANDER",
      "ENGINEER",
    ]);

    expect(result.membership.role).toBe("ENGINEER");
  });
});

describe("requireRoleForActiveOrg", () => {
  it("redirects using the current database role when the session role is stale", async () => {
    mockAuth.mockResolvedValue({
      user: {
        id: "user-1",
        activeOrgId: "org-1",
        role: "COMMANDER",
      },
    } as never);

    mockFindUnique.mockResolvedValue({
      id: "m1",
      userId: "user-1",
      orgId: "org-1",
      role: "OBSERVER",
    } as never);

    await expect(
      requireRoleForActiveOrg(["COMMANDER"]),
    ).rejects.toThrow("REDIRECT:/observer/dashboard");
  });

  it("allows a role permitted by the database membership", async () => {
    mockAuth.mockResolvedValue({
      user: {
        id: "user-1",
        activeOrgId: "org-1",
        role: "OBSERVER",
      },
    } as never);

    mockFindUnique.mockResolvedValue({
      id: "m1",
      userId: "user-1",
      orgId: "org-1",
      role: "ENGINEER",
    } as never);

    const result = await requireRoleForActiveOrg([
      "COMMANDER",
      "ENGINEER",
    ]);

    expect(result.orgId).toBe("org-1");
    expect(result.userId).toBe("user-1");
    expect(result.membership.role).toBe("ENGINEER");
  });
});
