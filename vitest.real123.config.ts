import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['smoke/real123.smoke.test.ts'],
    setupFiles: [],
  },
});
