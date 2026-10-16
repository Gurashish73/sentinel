import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockOrgFindUnique, mockDecryptSecret, mockVerifyHmacSignature, mockIngestAlert,
  mockWebhookIpLimit, mockWebhookOrgLimit, mockGetClientIp, mockRetryAfterSeconds,
} = vi.hoisted(() => ({
  mockOrgFindUnique: vi.fn(), mockDecryptSecret: vi.fn(), mockVerifyHmacSignature: vi.fn(),
  mockIngestAlert: vi.fn(), mockWebhookIpLimit: vi.fn(), mockWebhookOrgLimit: vi.fn(),
  mockGetClientIp: vi.fn(), mockRetryAfterSeconds: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { organization: { findUnique: mockOrgFindUnique } } }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: mockDecryptSecret }));
vi.mock("@/lib/webhook-verify", () => ({ verifyHmacSignature: mockVerifyHmacSignature }));
vi.mock("@/lib/ingest-alert", () => ({
  ingestAlert: mockIngestAlert,
  alertSchema: {
    safeParse: vi.fn(() => ({
      success: true,
      data: { title: "DB pool exhausted", severity: "HIGH", source: "synthetic", externalId: "evt-1" },
    })),
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  webhookIpLimiter: { limit: mockWebhookIpLimit },
  webhookOrgLimiter: { limit: mockWebhookOrgLimit },
  getClientIp: mockGetClientIp,
  retryAfterSeconds: mockRetryAfterSeconds,
}));

import { POST } from "@/app/api/webhooks/alert/[orgSlug]/route";

function request(body = '{"title":"DB pool exhausted"}') {
  return new NextRequest("https://example.com/api/webhooks/alert/acme", {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": "sha256=test-signature" },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetClientIp.mockReturnValue("203.0.113.10");
  mockRetryAfterSeconds.mockReturnValue(7);
  mockWebhookIpLimit.mockResolvedValue({ success: true, reset: Date.now() + 7000 });
  mockWebhookOrgLimit.mockResolvedValue({ success: true, reset: Date.now() + 7000 });
  mockOrgFindUnique.mockResolvedValue({ id: "org-1", webhookSecret: "encrypted-secret" });
  mockDecryptSecret.mockReturnValue("plain-secret");
  mockVerifyHmacSignature.mockReturnValue(true);
  mockIngestAlert.mockResolvedValue({ status: "created", incidentId: "inc-1" });
});

describe("POST /api/webhooks/alert/[orgSlug] Phase 6 limits", () => {
  it("returns 429 before hitting the database when the IP limit is exceeded", async () => {
    mockWebhookIpLimit.mockResolvedValue({ success: false, reset: 12_000 });
    const response = await POST(request(), { params: Promise.resolve({ orgSlug: "acme" }) });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("7");
    expect(mockOrgFindUnique).not.toHaveBeenCalled();
    expect(mockWebhookOrgLimit).not.toHaveBeenCalled();
  });

  it("does not consume the org bucket when HMAC verification fails", async () => {
    mockVerifyHmacSignature.mockReturnValue(false);
    const response = await POST(request(), { params: Promise.resolve({ orgSlug: "acme" }) });
    expect(response.status).toBe(401);
    expect(mockWebhookOrgLimit).not.toHaveBeenCalled();
    expect(mockIngestAlert).not.toHaveBeenCalled();
  });

  it("returns 429 from the per-org limiter only after a signed request passes HMAC", async () => {
    mockWebhookOrgLimit.mockResolvedValue({ success: false, reset: 12_000 });
    const response = await POST(request(), { params: Promise.resolve({ orgSlug: "acme" }) });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("7");
    expect(mockWebhookOrgLimit).toHaveBeenCalledWith("org-1");
    expect(mockIngestAlert).not.toHaveBeenCalled();
  });

  it("continues to ingestion when both limiters allow the request", async () => {
    const response = await POST(request(), { params: Promise.resolve({ orgSlug: "acme" }) });
    expect(response.status).toBe(200);
    expect(mockWebhookIpLimit).toHaveBeenCalledWith("203.0.113.10");
    expect(mockWebhookOrgLimit).toHaveBeenCalledWith("org-1");
    expect(mockIngestAlert).toHaveBeenCalledWith("org-1", expect.objectContaining({ externalId: "evt-1" }));
  });
});
