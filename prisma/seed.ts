import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from "dotenv";

// Load environment variables for the connection string
dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const targetEmail = "gurashishsingh227@gmail.com";

  console.log(`🚀 Finding user record for ${targetEmail}...`);
  const user = await prisma.user.findUnique({
    where: { email: targetEmail },
  });

  if (!user) {
    throw new Error(`User with email ${targetEmail} not found. Make sure you've clicked authorize first!`);
  }

  console.log("🏢 Initializing Sentinel HQ Workspace...");
  const org = await prisma.organization.upsert({
    where: { slug: "sentinel-hq" },
    update: {},
    create: {
      name: "Sentinel HQ",
      slug: "sentinel-hq",
    },
  });

  console.log("👑 Granting COMMANDER status to user...");
  await prisma.membership.upsert({
    where: {
      userId_orgId: {
        userId: user.id,
        orgId: org.id,
      },
    },
    update: {
      role: "COMMANDER",
    },
    create: {
      userId: user.id,
      orgId: org.id,
      role: "COMMANDER",
    },
  });

  console.log("✅ Core configuration initialized. System ready.");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });