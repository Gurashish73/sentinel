import { defineConfig } from "@prisma/config";
import { config } from "dotenv";

// 1. Explicitly load the .env file into memory
config();

// 2. Now process.env.DATABASE_URL will successfully resolve
export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL,
  },
});