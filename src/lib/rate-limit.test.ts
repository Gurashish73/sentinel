import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockLimit } = vi.hoisted(() => ({ mockLimit: vi.fn() }));

vi.mock("@upstash/redis", () => {
  class MockRedis {
    constructor() {}
  }

  return { Redis: MockRedis };
});

vi.mock("@upstash/ratelimit", () => {
  class MockRatelimit {
    limit = mockLimit;

    constructor(config: Record<string, unknown>) {
      Object.assign(this, config);
    }

    static slidingWindow(limit: number, window: string) {
      return { limit, window };
    }
  }

  return { Ratelimit: MockRatelimit };
});

vi.mock("@/lib/env", () => ({
  env: { UPSTASH_REDIS_REST_URL: "https://fake-redis.upstash.io", UPSTASH_REDIS_REST_TOKEN: "fake-token" },
}));

import { getClientIp, retryAfterSeconds } from "@/lib/rate-limit";

afterEach(() => vi.restoreAllMocks());

beforeEach(() => vi.clearAllMocks());

describe("Phase 6 rate-limit helpers", () => {
  it("extracts the first IP from x-forwarded-for", () => {
    const req = new Request("https://example.com", {
      headers: { "x-forwarded-for": "203.0.113.5, 70.41.3.18, 150.172.238.178" },
    });
    expect(getClientIp(req)).toBe("203.0.113.5");
  });

  it("falls back to x-real-ip", () => {
    const req = new Request("https://example.com", { headers: { "x-real-ip": "203.0.113.9" } });
    expect(getClientIp(req)).toBe("203.0.113.9");
  });

  it("falls back to unknown when proxy headers are absent", () => {
    expect(getClientIp(new Request("https://example.com"))).toBe("unknown");
  });

  it("converts reset milliseconds into a positive Retry-After value", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    expect(retryAfterSeconds(2_001)).toBe(2);
  });
});
