/**
 * Runs before any test file's imports execute. 
 * 
 * Several files under test import `src/lib/env.ts` transitively, which 
 * Zod-validates the full environment at module load. These are dummy values 
 * that explicitly satisfy that strict schema so tests can run isolated 
 * without needing a real .env file.
 */
process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/test";
process.env.AUTH_SECRET = "test-auth-secret-that-is-at-least-32-characters-long";
process.env.AUTH_GITHUB_ID = "test-github-client-id";
process.env.AUTH_GITHUB_SECRET = "test-github-client-secret";
process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters";

// These are dummy values that explicitly satisfy the strict schema in `src/lib/env.ts` so tests can run isolated without needing a real .env file.
process.env.QSTASH_URL = "https://qstash.upstash.io";
process.env.QSTASH_TOKEN = "test-qstash-token";
process.env.QSTASH_CURRENT_SIGNING_KEY = "test-current-signing-key";
process.env.QSTASH_NEXT_SIGNING_KEY = "test-next-signing-key";
process.env.GEMINI_API_KEY = "test-gemini-api-key";