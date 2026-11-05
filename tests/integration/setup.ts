import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env") });

const connectionString = process.env.TEST_DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "TEST_DATABASE_URL is missing. Configure it in .env before running integration tests.",
  );
}

let databaseUrl: URL;

try {
  databaseUrl = new URL(connectionString);
} catch {
  throw new Error("TEST_DATABASE_URL is not a valid PostgreSQL URL.");
}

const databaseName = databaseUrl.pathname.replace(/^\/+/, "");

if (
  !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
  !databaseUrl.hostname.endsWith(".neon.tech") ||
  databaseUrl.hostname.includes("-pooler") ||
  databaseName !== "sentinel_test"
) {
  throw new Error(
    "Integration tests aborted: expected a direct Neon connection to sentinel_test.",
  );
}
