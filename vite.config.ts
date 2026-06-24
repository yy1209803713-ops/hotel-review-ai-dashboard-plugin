import { defineConfig } from 'vite';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { semiTheming } from 'vite-plugin-semi-theming';
import { configDefaults } from 'vitest/config';

export default defineConfig(({ mode }) => {
  const backendEndpointUrl =
    mode === 'test' ? '' : loadEnv(mode, process.cwd(), 'VITE_').VITE_BACKEND_ENDPOINT_URL ?? '';

  return {
    base: './',
    plugins: [
      react(),
      semiTheming({
        theme: '@semi-bot/semi-theme-feishu-dashboard',
      }),
    ],
    define: {
      __HOTEL_REVIEW_AI_BACKEND_ENDPOINT_URL__: JSON.stringify(backendEndpointUrl),
    },
    server: {
      host: '0.0.0.0',
    },
    test: {
      environment: 'jsdom',
      globals: true,
      exclude: [...configDefaults.exclude, 'smoke/**', '.worktrees/**'],
      setupFiles: './src/test/setup.ts',
    },
  };
});
