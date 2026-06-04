import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom gives the classic scripts a browser-like global scope
    // (document, localStorage, etc.) without a build step.
    environment: 'jsdom',
    setupFiles: ['frontend/tests/setup.js'],
    include: ['frontend/tests/**/*.test.js'],
  },
});
