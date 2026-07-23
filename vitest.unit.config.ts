import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    environment: 'node',
    include: ['apps/**/*.spec.ts', 'packages/**/*.spec.ts', 'tests/readiness/**/*.spec.ts'],
    passWithNoTests: false,
  },
});
