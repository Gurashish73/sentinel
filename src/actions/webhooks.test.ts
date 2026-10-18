
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireRole,
  mockIngestAlert,
  mockUpdateTag,
  mockEnv,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockIngestAlert: vi.fn(),
  mockUpdateTag: vi.fn(),
  mockEnv: { ENABLE_INJECTION_DEMO: false },
}));

vi.mock("@/lib/dal", () => ({
  requireRole: mockRequireRole,
}));

vi.mock("@/lib/ingest-alert", () => ({
  ingestAlert: mockIngestAlert,
}));

vi.mock("next/cache", () => ({
  updateTag: mockUpdateTag,
}));

vi.mock("@/lib/env", () => ({
  env: mockEnv,
}));

import { simulateAlert } from "@/actions/webhooks";

describe("simulateAlert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.ENABLE_INJECTION_DEMO = false;
    mockRequireRole.mockResolvedValue(undefined);
    mockIngestAlert.mockResolvedValue({ status: "created" });
  });

  it("uses a normal synthetic description when injection demos are disabled", async () => {
    await simulateAlert("org-1");

    expect(mockRequireRole).toHaveBeenCalledWith("org-1", ["COMMANDER"]);

    const payload = mockIngestAlert.mock.calls[0][1];

    expect(payload.description).not.toContain("<system_override>");
    expect(payload.description).not.toContain("Ignore previous instructions");
    expect(payload.source).toBe("synthetic");
    expect(payload.severity).toBe("CRITICAL");
  });

  it("includes the adversarial payload only when explicitly enabled", async () => {
    mockEnv.ENABLE_INJECTION_DEMO = true;

    await simulateAlert("org-1");

    const payload = mockIngestAlert.mock.calls[0][1];

    expect(payload.description).toContain("<system_override>");
    expect(payload.description).toContain("Ignore previous instructions");
  });

  it("does not ingest an alert when Commander authorization fails", async () => {
    mockRequireRole.mockRejectedValue(new Error("Forbidden"));

    await expect(simulateAlert("org-1")).rejects.toThrow("Forbidden");

    expect(mockIngestAlert).not.toHaveBeenCalled();
  });
});
