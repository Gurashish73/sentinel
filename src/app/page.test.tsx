
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireActiveOrg, mockRedirect } = vi.hoisted(() => ({
  mockRequireActiveOrg: vi.fn(),
  mockRedirect: vi.fn(),
}));

vi.mock("@/lib/dal", () => ({
  requireActiveOrg: mockRequireActiveOrg,
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

import RootPage from "./page";

describe("root dashboard routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedirect.mockReturnValue(undefined);
  });

  it.each([
    ["COMMANDER", "/commander/dashboard"],
    ["ENGINEER", "/engineer/dashboard"],
    ["OBSERVER", "/observer/dashboard"],
  ])("routes the current database role %s to its dashboard", async (role, path) => {
    mockRequireActiveOrg.mockResolvedValue({
      membership: { role },
    });

    await RootPage();

    expect(mockRedirect).toHaveBeenCalledWith(path);
  });
});
