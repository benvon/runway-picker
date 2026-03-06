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
      include: ['src/**/*.ts', 'workers/**/*.ts', 'functions/**/*.ts', 'scripts/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        'src/test/**',
        '**/*.d.ts',
        '**/*.config.*',
        'dist/**',
        'node_modules/**'
      ],
      reporter: ['text', 'lcov']
    }
  }
});
