import "server-only";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { env } from "@/lib/env";

/**
 * CRYPTOGRAPHY LAYER
 * 
 * Handles encryption of sensitive data at rest (e.g., webhook secrets, 
 * GitHub tokens). We use AES-256-GCM (Galois/Counter Mode) because it 
 * provides both confidentiality and data authenticity. 
 */

const ALGORITHM = "aes-256-gcm";
// 12 bytes (96 bits) is the standard and most efficient IV length for GCM.
const IV_LENGTH = 12;

/**
 * Derives a strict 32-byte key from the environment secret.
 * Using scrypt ensures that even if the ENCRYPTION_KEY is of irregular 
 * length, the cipher receives the exact 256 bits it requires.
 * 
 * Computed exactly once at module load.
 * This eliminates the severe CPU penalty of running scryptSync on every single
 * webhook request, while maintaining the exact same cryptographic security.
 */
const KEY: Buffer = scryptSync(env.ENCRYPTION_KEY, "sentinel-org-secrets", 32);

/** 
 * Encrypts a plaintext string into an authenticated payload.
 * Returns a composite string: "iv:authTag:ciphertext", all in hex.
 * Safe to store as a single @db.Text column. 
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, KEY, iv);
  
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  
  return [iv.toString("hex"), authTag.toString("hex"), ciphertext.toString("hex")].join(":");
}

/** 
 * Decrypts a composite string back into plaintext.
 * Because we use GCM, if the ciphertext was tampered with in the database, 
 * the auth tag validation will fail and this function will securely throw.
 */
export function decryptSecret(stored: string): string {
  const [ivHex, authTagHex, ciphertextHex] = stored.split(":");
  
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error("Malformed encrypted secret — expected iv:authTag:ciphertext.");
  }
  
  const decipher = createDecipheriv(ALGORITHM, KEY, Buffer.from(ivHex, "hex"));
  
  // Set the authentication tag BEFORE finalizing decryption.
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  
  return plaintext.toString("utf8");
}