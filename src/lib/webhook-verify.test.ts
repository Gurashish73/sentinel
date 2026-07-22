import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyHmacSignature } from "@/lib/webhook-verify";

const SECRET = "test-webhook-secret";
const BODY = JSON.stringify({ title: "test incident", severity: "HIGH" });

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyHmacSignature", () => {
  it("accepts a correctly signed raw body with no prefix", () => {
    expect(verifyHmacSignature(BODY, sign(BODY, SECRET), SECRET)).toBe(true);
  });

  it("accepts a GitHub-style sha256= prefixed signature", () => {
    expect(verifyHmacSignature(BODY, `sha256=${sign(BODY, SECRET)}`, SECRET)).toBe(true);
  });

  it("accepts a Stripe-style v1= prefixed signature", () => {
    expect(verifyHmacSignature(BODY, `v1=${sign(BODY, SECRET)}`, SECRET)).toBe(true);
  });

  it("is case-insensitive on the prefix", () => {
    expect(verifyHmacSignature(BODY, `SHA256=${sign(BODY, SECRET)}`, SECRET)).toBe(true);
  });

  it("rejects a tampered body — this is the actual point of HMAC verification", () => {
    const validSig = sign(BODY, SECRET);
    const tamperedBody = BODY.replace("HIGH", "LOW");
    expect(verifyHmacSignature(tamperedBody, validSig, SECRET)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const sig = sign(BODY, SECRET);
    expect(verifyHmacSignature(BODY, sig, "a-different-secret")).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyHmacSignature(BODY, null, SECRET)).toBe(false);
  });

  it("rejects an empty secret rather than treating it as valid", () => {
    // This specifically tests the `!secret` fail-fast guard we added.
    // Without that guard, Node's createHmac would throw a fatal TypeError.
    expect(verifyHmacSignature(BODY, sign(BODY, SECRET), "")).toBe(false);
  });

  it("rejects a mismatched-length signature without throwing", () => {
    // node:crypto's timingSafeEqual throws on buffers of different lengths.
    // The length check inside verifyHmacSignature exists specifically to turn 
    // that into a clean `false` instead of an unhandled exception reaching the route handler.
    expect(() => verifyHmacSignature(BODY, "too-short", SECRET)).not.toThrow();
    expect(verifyHmacSignature(BODY, "too-short", SECRET)).toBe(false);
  });

  it("rejects an empty-string signature", () => {
    expect(verifyHmacSignature(BODY, "", SECRET)).toBe(false);
  });
});