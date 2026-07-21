import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    hookTimeout: 30_000,
    include: ['tests/integration/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 15_000,
  },
});
