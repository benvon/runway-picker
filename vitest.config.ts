import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'scripts/**/*.test.ts',
      'functions/**/*.test.ts',
      'workers/**/*.test.ts'
    ],
    environmentMatchGlobs: [['src/test/**/*.test.ts', 'jsdom']],
    coverage: {
      reporter: ['text', 'lcov']
    }
  }
});
