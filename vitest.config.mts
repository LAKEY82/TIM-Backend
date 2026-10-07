import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Each file gets its own in-memory MongoDB; run files one at a time to keep memory low.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: "test",
      // Placeholder only: tests connect to an in-memory server (see tests/helpers.ts).
      MONGODB_URI: "mongodb://127.0.0.1:1/placeholder",
      JWT_ACCESS_SECRET: "test-access-secret-test-access-secret-0123456789",
      JWT_REFRESH_SECRET: "test-refresh-secret-test-refresh-secret-0123456789",
      CLIENT_URL: "http://localhost:3000",
      BCRYPT_ROUNDS: "10",
    },
  },
});
