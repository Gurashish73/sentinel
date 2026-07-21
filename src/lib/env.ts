import "server-only";
import { z } from "zod";

// Fail fast at boot if a critical Phase 0 or Phase 1 env var is missing. 
// Anything optional here is a Phase 2+ concern — keep this list growing 
// alongside the phases, don't front-load it.
const envSchema = z.object({
  // Phase 0: Database
  DATABASE_URL: z.string().url(),

  // Phase 0: Auth.js Core Infrastructure
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters (run `npx auth secret`)"),
  AUTH_GITHUB_ID: z.string().min(1),
  AUTH_GITHUB_SECRET: z.string().min(1),

  // Runtime Controls
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),

  // Phase 1: Cryptography
  // Used by src/lib/crypto.ts to encrypt/decrypt secrets at rest (e.g., webhook tokens)
  ENCRYPTION_KEY: z.string().min(1).optional(),
  
  // Phase 3+: Durable Agent Orchestration (Upstash Workflow & Redis)
  QSTASH_URL: z.string().url().optional(),
  QSTASH_TOKEN: z.string().min(1).optional(),
  QSTASH_CURRENT_SIGNING_KEY: z.string().min(1).optional(),
  QSTASH_NEXT_SIGNING_KEY: z.string().min(1).optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),

  // Phase 3+: AI / Stochastic Reasoning Layer
  OPENAI_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    "❌ System Initialization Failed. Invalid Environment Controls:\n",
    JSON.stringify(parsed.error.flatten().fieldErrors, null, 2)
  );
  throw new Error("Invalid environment variables — check .env against .env.example");
}

export const env = parsed.data;