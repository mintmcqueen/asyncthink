import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    exclude: ['__tests__.v1/**', 'src.v1/**', 'dist/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['__tests__/**', 'dist/**', 'src.v1/**', '__tests__.v1/**'],
    },
  },
});
