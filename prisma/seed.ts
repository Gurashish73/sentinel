import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from "dotenv";

// Load environment variables manually since this script runs outside the Next.js runtime.
dotenv.config();

// Initialize the Prisma Edge Driver Adapter pattern.
// This mirrors our application's exact database connection strategy,
// ensuring the seed script interacts with the DB identically to the Edge proxy.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  // 1. Identity Resolution
  // We pull the seed target from the environment to keep personal data out of version control.
  const targetEmail = process.env.SEED_USER_EMAIL;
  if (!targetEmail) {
    throw new Error("❌ Set SEED_USER_EMAIL in .env before running the seed script.");
  }

  console.log(`🚀 Finding user record for ${targetEmail}...`);
  const user = await prisma.user.findUnique({ where: { email: targetEmail } });

  if (!user) {
    throw new Error(`❌ User with email ${targetEmail} not found. Sign in via GitHub OAuth first to create the row.`);
  }

  // 2. Organization Provisioning
  // Using `upsert` ensures this script is completely idempotent. You can run it 100 times
  // and it will never crash due to a unique constraint violation on the org slug.
  console.log("🏢 Initializing Sentinel HQ Workspace...");
  const org = await prisma.organization.upsert({
    where: { slug: "sentinel-hq" },
    update: {},
    create: { name: "Sentinel HQ", slug: "sentinel-hq" },
  });

  // 3. Role-Based Access Control (RBAC) Assignment
  // Grants the highest operational tier to the seed user, unlocking all Phase 1 Server Actions.
  console.log("👑 Granting COMMANDER status to user...");
  await prisma.membership.upsert({
    where: { userId_orgId: { userId: user.id, orgId: org.id } },
    update: { role: "COMMANDER" },
    create: { userId: user.id, orgId: org.id, role: "COMMANDER" },
  });

  // 4. Data Hydration for Phase 1 Dashboards
  console.log("🔥 Seeding demo incidents...");
  const demoIncidents = [
    {
      title: "DB connection pool exhausted",
      description: "Postgres pool hit max connections during traffic spike.",
      severity: "HIGH" as const,
      status: "OPEN" as const,
    },
    {
      title: "Elevated 5xx rate on checkout service",
      description: "Error rate crossed 2% threshold for 5 consecutive minutes.",
      severity: "CRITICAL" as const,
      status: "INVESTIGATING" as const,
    },
    {
      title: "Stale cache entries on product pages",
      description: "Revalidation job silently failed for 6 hours.",
      severity: "LOW" as const,
      status: "RESOLVED" as const,
    },
  ];

  // We loop and catch existing records so the script remains idempotent
  // and doesn't duplicate incidents if run multiple times.
  for (const incident of demoIncidents) {
    const exists = await prisma.incident.findFirst({
      where: { title: incident.title, orgId: org.id }
    });
    
    if (!exists) {
      await prisma.incident.create({ data: { ...incident, orgId: org.id } });
    }
  }

  console.log("✅ Core configuration initialized. System ready.");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    // Cleanly sever the PostgreSQL connection pool to prevent script hanging
    await prisma.$disconnect();
    await pool.end();
  });