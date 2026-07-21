import "server-only";
import { timingSafeEqual, createHmac } from "node:crypto";

/**
 * Cryptographically verifies incoming webhook payloads using HMAC SHA-256.
 * 
 * Security Architecture:
 * - Constant-time comparison (`timingSafeEqual`) prevents timing-based side-channel attacks.
 * - Strict length gating prevents Node.js runtime exceptions.
 * - Prefix normalization explicitly handles provider-specific formatting (e.g., GitHub's "sha256=").
 * 
 * @param rawBody The exact, unparsed raw string body of the HTTP request.
 * @param signatureHeader The signature provided in the request header.
 * @param secret The decrypted organization webhook secret.
 * @returns boolean True if the payload is authentic, false if tampered or invalid.
 */
export function verifyHmacSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): boolean {
  // Fail fast if the header is missing or the org has no secret configured
  if (!signatureHeader || !secret) return false;

  try {
    // Explicitly strip known provider prefixes (GitHub's sha256= or Stripe's v1=)
    // rather than relying on a generic string split. This prevents silent failures 
    // on complex signature headers.
    const normalizedHeader = signatureHeader.replace(/^(sha256|v1)=/i, "");

    // Generate the expected HMAC-SHA256 signature from the exact raw request bytes
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

    const expectedBuf = Buffer.from(expected, "utf8");
    const providedBuf = Buffer.from(normalizedHeader, "utf8");

    // timingSafeEqual throws a runtime error if buffer lengths do not match.
    // We explicitly gate this to return an unauthenticated status rather than a 500 error.
    if (expectedBuf.length !== providedBuf.length) {
      return false;
    }

    return timingSafeEqual(expectedBuf, providedBuf);
  } catch (error) {
    // Failsafe catch for bizarre edge cases (e.g., malformed encodings) to guarantee
    // the security boundary never leaks stack traces or crashes the process.
    return false;
  }
}