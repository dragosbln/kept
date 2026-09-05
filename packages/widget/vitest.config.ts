import { defineConfig } from 'vitest/config';

// The widget is browser code; happy-dom provides the DOM (shadow roots,
// storage, fetch types) the suite renders into.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    setupFiles: ['./vitest.setup.ts'],
    // Only the sources; tsc also compiles tests into dist/, and running
    // those stale copies twice helps nobody.
    include: ['src/**/*.test.ts'],
  },
});
