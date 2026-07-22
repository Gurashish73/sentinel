import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "@/lib/crypto";

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a plaintext value exactly", () => {
    const plaintext = "whsec_abc123supersecretvalue";
    expect(decryptSecret(encryptSecret(plaintext))).toBe(plaintext);
  });

  it("produces a different ciphertext each call for the same input (random IV)", () => {
    const plaintext = "same-input-both-times";
    const a = encryptSecret(plaintext);
    const b = encryptSecret(plaintext);
    expect(a).not.toBe(b);
    
    // Proves the random IV is working
    expect(decryptSecret(a)).toBe(plaintext);
    expect(decryptSecret(b)).toBe(plaintext);
  });

  it("stores as iv:authTag:ciphertext, all hex-encoded", () => {
    const parts = encryptSecret("test").split(":");
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(part).toMatch(/^[0-9a-f]+$/);
    }
  });

  it("throws on a malformed stored value instead of returning garbage", () => {
    expect(() => decryptSecret("not-the-right-format")).toThrow(/Malformed/);
  });

  it("throws if the ciphertext is tampered with — this is GCM's auth tag doing its job", () => {
    const encrypted = encryptSecret("original-secret-value");
    const [iv, authTag, ciphertext] = encrypted.split(":");
    
    // Flip the last byte of the ciphertext
    const flippedLastByte = ciphertext.slice(0, -2) + (ciphertext.slice(-2) === "00" ? "11" : "00");
    const tampered = [iv, authTag, flippedLastByte].join(":");
    
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("throws if the auth tag is tampered with, even if the ciphertext is untouched", () => {
    const encrypted = encryptSecret("original-secret-value");
    const [iv, authTag, ciphertext] = encrypted.split(":");
    
    // Flip the last byte of the auth tag
    const flippedTag = authTag.slice(0, -2) + (authTag.slice(-2) === "00" ? "11" : "00");
    const tampered = [iv, flippedTag, ciphertext].join(":");
    
    expect(() => decryptSecret(tampered)).toThrow();
  });
});