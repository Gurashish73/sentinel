import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    // Tests run in a pure Node environment, completely bypassing the heavy 
    // Next.js React bundler for lightning-fast cryptographic unit tests.
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
  },
  resolve: {
    alias: {
      // Maps Next.js '@/' imports to the 'src/' directory
      "@": path.resolve(import.meta.dirname, "./src"),
      
      // Test-only shim: The real "server-only" package throws if imported 
      // outside Next's React Server bundler. This maps it to an empty file
      // so Vitest doesn't crash when testing server-side utilities.
      "server-only": path.resolve(import.meta.dirname, "./tests/empty-module.ts"),
    },
  },
});