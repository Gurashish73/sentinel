import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  membershipFindUnique: vi.fn(),
  membershipFindFirst: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({
  db: {
    membership: {
      findUnique: mocks.membershipFindUnique,
      findFirst: mocks.membershipFindFirst,
    },
  },
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    mocks.redirect(url);
    throw new Error(`REDIRECT:${url}`);
  },
}));

import { requireActiveOrg } from "@/lib/dal";

const commanderMembership = {
  id: "membership-1",
  userId: "user-1",
  orgId: "org-1",
  role: "COMMANDER",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({
    user: { id: "user-1", activeOrgId: "org-1", role: "COMMANDER" },
  });
  mocks.membershipFindUnique.mockResolvedValue(commanderMembership);
  mocks.membershipFindFirst.mockResolvedValue(commanderMembership);
});

describe("requireActiveOrg stale JWT recovery", () => {
  it("uses the active organization after confirming it still has a membership", async () => {
    const result = await requireActiveOrg();

    expect(result.orgId).toBe("org-1");
    expect(result.membership).toEqual(commanderMembership);
    expect(result.session.user.role).toBe("COMMANDER");
    expect(mocks.membershipFindUnique).toHaveBeenCalledWith({
      where: { userId_orgId: { userId: "user-1", orgId: "org-1" } },
    });
    expect(mocks.membershipFindFirst).not.toHaveBeenCalled();
  });

  it("recovers a membership created after the JWT was minted", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } });

    const result = await requireActiveOrg();

    expect(result.orgId).toBe("org-1");
    expect(result.membership).toEqual(commanderMembership);
    expect(result.session.user.activeOrgId).toBe("org-1");
    expect(result.session.user.role).toBe("COMMANDER");
    expect(mocks.membershipFindUnique).not.toHaveBeenCalled();
    expect(mocks.membershipFindFirst).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { id: "asc" },
    });
  });

  it("falls back when the JWT points to a membership that no longer exists", async () => {
    mocks.auth.mockResolvedValue({
      user: { id: "user-1", activeOrgId: "removed-org", role: "ENGINEER" },
    });
    mocks.membershipFindUnique.mockResolvedValue(null);
    mocks.membershipFindFirst.mockResolvedValue({
      ...commanderMembership,
      orgId: "org-current",
    });

    const result = await requireActiveOrg();

    expect(result.orgId).toBe("org-current");
    expect(result.session.user.activeOrgId).toBe("org-current");
    expect(result.session.user.role).toBe("COMMANDER");
  });

  it("redirects to onboarding when the user has no membership at all", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } });
    mocks.membershipFindFirst.mockResolvedValue(null);

    await expect(requireActiveOrg()).rejects.toThrow("REDIRECT:/onboarding");
    expect(mocks.redirect).toHaveBeenCalledWith("/onboarding");
  });
});
