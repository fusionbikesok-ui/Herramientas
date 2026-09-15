import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/soporte/global-pg.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    include: ['test/**/*.test.ts'],
  },
});
