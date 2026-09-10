import { defineConfig } from "vitest/config";

/**
 * Tests for Convex functions themselves — the transactional layer that the
 * pure-logic Bun tests cannot reach. Runs the real queries and mutations
 * against an in-memory deployment, no network.
 */
export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
  },
});
