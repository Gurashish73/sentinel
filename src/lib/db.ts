import "server-only";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "./env"; // Using the strictly validated environment variables

// Next.js dev's hot-reload re-executes this module on every save. Without
// stashing the client on `globalThis`, each reload opens a fresh pool of
// Postgres connections that never gets closed.

const prismaClientSingleton = () => {
  // Initialize the standard Postgres connection pool
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  
  // Wrap it in the Prisma Driver Adapter
  const adapter = new PrismaPg(pool);

  return new PrismaClient({
    adapter, // Pass the adapter explicitly as required by Prisma 7
    log: env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });
};

declare global {
  var prismaGlobal: undefined | ReturnType<typeof prismaClientSingleton>;
}

export const db = globalThis.prismaGlobal ?? prismaClientSingleton();

if (env.NODE_ENV !== "production") {
  globalThis.prismaGlobal = db;
}