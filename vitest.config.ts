import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // One test file at a time.
    //
    // Locally each file starts its own container and this only costs time, but
    // in CI every file talks to the same Postgres. Running them in parallel put
    // two pools and two `CREATE TABLE IF NOT EXISTS` against one server, which
    // is both a connection-limit problem and a known race in pg_catalog.
    fileParallelism: false,
    // Containers are slow to start on a cold runner.
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
