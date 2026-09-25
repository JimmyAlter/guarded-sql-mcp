import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    // One database, shared fixtures: run files sequentially.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
