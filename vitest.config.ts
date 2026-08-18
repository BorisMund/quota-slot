import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // One file at a time: in CI they all share one Postgres, and running them
    // in parallel puts two pools and two CREATE TABLE statements on one server.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
